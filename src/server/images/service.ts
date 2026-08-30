import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import OpenAI from "openai";
import { z } from "zod";

import {
  VISUAL_MODEL,
  type VisualAidAssetView,
  type VisualAidBrief,
  type VisualAidPreviewResponse,
} from "../../shared/visual.js";

const PREVIEW_TTL_MS = 15 * 60_000;
const MAX_IMAGE_BYTES = 24 * 1024 * 1024;
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_ASSETS = 200;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ASSET_ID_PATTERN = /^visual_[0-9a-f-]{36}$/;
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const OPENAI_API_BASE_URL = "https://api.openai.com/v1";

const visibleField = (label: string, max: number) => z
  .string()
  .trim()
  .min(1, `${label} is required`)
  .max(max)
  .refine((value) => !value.includes("\u0000"), `${label} contains an invalid character`);

export const visualAidBriefSchema = z
  .object({
    title: visibleField("Title", 160),
    pedagogicalPurpose: visibleField("Pedagogical purpose", 1_200),
    essentialRelationships: visibleField("Essential relationships", 2_400),
    factualConstraints: visibleField("Factual constraints", 2_400),
    exclusions: visibleField("Exclusions", 1_600),
    altText: visibleField("Alt text", 800),
    proseEquivalent: visibleField("Prose equivalent", 2_400),
  })
  .strict();

const assetMetadataSchema = z
  .object({
    schemaVersion: z.literal(1),
    assetId: z.string().regex(ASSET_ID_PATTERN),
    createdAt: z.iso.datetime({ offset: true }),
    model: z.literal(VISUAL_MODEL),
    size: z.literal("1024x1024"),
    quality: z.literal("low"),
    mimeType: z.literal("image/png"),
    byteLength: z.number().int().positive().max(MAX_IMAGE_BYTES),
    contentHash: z.string().regex(HASH_PATTERN),
    promptHash: z.string().regex(HASH_PATTERN),
    brief: visualAidBriefSchema,
  })
  .strict();

type StoredAssetMetadata = z.infer<typeof assetMetadataSchema>;

interface PendingPreview {
  readonly tokenHash: Buffer;
  readonly payloadHash: string;
  readonly expiresAtMs: number;
  readonly preview: VisualAidPreviewResponse;
}

export interface GeneratedVisualBytes {
  readonly bytes: Uint8Array;
  readonly mimeType: "image/png";
}

export interface VisualImageProvider {
  generate(prompt: string, signal?: AbortSignal): Promise<GeneratedVisualBytes>;
}

export class VisualAidServiceError extends Error {
  public constructor(
    public readonly code:
      | "invalid_request"
      | "unavailable"
      | "confirmation_expired"
      | "confirmation_mismatch"
      | "provider_failed"
      | "corrupt_store",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "VisualAidServiceError";
  }
}

export function renderVisualPrompt(brief: Readonly<VisualAidBrief>): string {
  const parsed = visualAidBriefSchema.parse(brief);
  return [
    "Create one clear educational visual for an experienced cybersecurity learner.",
    "Use a restrained editorial-diagram style on a warm off-white background, with cobalt blue only as a functional accent.",
    "Prefer spatial relationships and labelled shapes over decoration. Keep text sparse, large, and legible.",
    "Do not introduce facts, answers, source code, logos, people, interfaces, or decorative filler that are not requested below.",
    "",
    `Title: ${parsed.title}`,
    `Pedagogical purpose: ${parsed.pedagogicalPurpose}`,
    `Essential visual relationships: ${parsed.essentialRelationships}`,
    `Factual constraints: ${parsed.factualConstraints}`,
    `Exclude: ${parsed.exclusions}`,
    `Accessibility target: ${parsed.altText}`,
  ].join("\n");
}

export class OpenAIVisualImageProvider implements VisualImageProvider {
  readonly #client: OpenAI;

  public constructor(apiKey: string) {
    if (!apiKey.trim()) {
      throw new VisualAidServiceError("unavailable", "Image generation is not configured.");
    }
    this.#client = new OpenAI({
      apiKey,
      baseURL: OPENAI_API_BASE_URL,
      maxRetries: 0,
      organization: null,
      project: null,
    });
  }

  public async generate(prompt: string, signal?: AbortSignal): Promise<GeneratedVisualBytes> {
    try {
      const response = await this.#client.images.generate({
        model: VISUAL_MODEL,
        prompt,
        n: 1,
        size: "1024x1024",
        quality: "low",
        output_format: "png",
        background: "opaque",
        moderation: "auto",
        stream: false,
      }, signal === undefined ? undefined : { signal });
      const encoded = response.data?.[0]?.b64_json;
      if (typeof encoded !== "string" || encoded.length === 0) {
        throw new Error("The provider returned no image bytes");
      }
      const bytes = Buffer.from(encoded, "base64");
      if (!isPng(bytes) || bytes.byteLength > MAX_IMAGE_BYTES) {
        throw new Error("The provider returned an invalid image size");
      }
      return Object.freeze({ bytes, mimeType: "image/png" as const });
    } catch (error) {
      throw new VisualAidServiceError(
        "provider_failed",
        "No image could be confirmed. The request may have reached OpenAI, so it will not be retried automatically; review the brief again only if another generation is acceptable.",
        { cause: error },
      );
    }
  }
}

/**
 * Explicit two-step visual generation. Preview tokens bind one reviewed brief
 * to one provider call and are consumed before dispatch so double-clicks never
 * create duplicate billable jobs.
 */
export class VisualAidService {
  readonly #configuredStateRoot: string;
  readonly #pending = new Map<string, PendingPreview>();
  readonly #activeControllers = new Set<AbortController>();
  #closing = false;

  public constructor(
    stateRoot: string,
    private readonly provider: VisualImageProvider | null,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!isAbsolute(stateRoot)) {
      throw new VisualAidServiceError("corrupt_store", "The visual state root must be absolute.");
    }
    this.#configuredStateRoot = resolve(stateRoot);
  }

  public preview(input: Readonly<VisualAidBrief>): VisualAidPreviewResponse {
    if (this.provider === null || this.#closing) {
      throw new VisualAidServiceError("unavailable", "Image generation is not configured.");
    }
    const brief = visualAidBriefSchema.parse(input) as VisualAidBrief;
    const renderedPrompt = renderVisualPrompt(brief);
    const payloadHash = sha256(JSON.stringify({ brief, renderedPrompt, model: VISUAL_MODEL }));
    const token = randomBytes(32).toString("base64url");
    const expiresAtMs = this.now().getTime() + PREVIEW_TTL_MS;
    const preview: VisualAidPreviewResponse = Object.freeze({
      confirmationToken: token,
      payloadHash,
      expiresAt: new Date(expiresAtMs).toISOString(),
      model: VISUAL_MODEL,
      size: "1024x1024",
      quality: "low",
      brief: Object.freeze({ ...brief }),
      renderedPrompt,
    });
    this.#pruneExpired();
    this.#pending.set(payloadHash, {
      tokenHash: tokenDigest(token),
      payloadHash,
      expiresAtMs,
      preview,
    });
    return preview;
  }

  public async generate(input: Readonly<{
    confirmationToken: string;
    payloadHash: string;
  }>): Promise<VisualAidAssetView> {
    if (this.provider === null || this.#closing) {
      throw new VisualAidServiceError("unavailable", "Image generation is not configured.");
    }
    const pending = this.#pending.get(input.payloadHash);
    if (pending === undefined || pending.expiresAtMs <= this.now().getTime()) {
      this.#pending.delete(input.payloadHash);
      throw new VisualAidServiceError(
        "confirmation_expired",
        "That visual brief is no longer awaiting confirmation. Review it again before generating.",
      );
    }
    const supplied = tokenDigest(input.confirmationToken);
    if (
      supplied.byteLength !== pending.tokenHash.byteLength
      || !timingSafeEqual(supplied, pending.tokenHash)
    ) {
      throw new VisualAidServiceError(
        "confirmation_mismatch",
        "The confirmation does not match the reviewed visual brief.",
      );
    }

    // Validate owner-controlled storage before consuming a one-use token or
    // dispatching a potentially billable request.
    const roots = await this.#writeRoots();
    if (this.#closing) {
      throw new VisualAidServiceError("unavailable", "Image generation is shutting down.");
    }

    // One use even when the provider fails: a retry must be consciously
    // reviewed, rather than silently replaying a potentially billable request.
    this.#pending.delete(input.payloadHash);
    const controller = new AbortController();
    this.#activeControllers.add(controller);
    let generated: GeneratedVisualBytes;
    try {
      generated = await this.provider.generate(pending.preview.renderedPrompt, controller.signal);
      if (controller.signal.aborted) throw new Error("visual_generation_aborted");
    } catch (error) {
      if (error instanceof VisualAidServiceError) throw error;
      throw providerUncertainty(error);
    } finally {
      this.#activeControllers.delete(controller);
    }
    if (generated.mimeType !== "image/png") {
      throw new VisualAidServiceError("provider_failed", "The provider returned an unsupported image format.");
    }
    const bytes = Buffer.from(generated.bytes);
    if (!isPng(bytes) || bytes.byteLength > MAX_IMAGE_BYTES) {
      throw new VisualAidServiceError("provider_failed", "The provider returned an invalid image size.");
    }

    const assetId = `visual_${randomUUID()}`;
    const createdAt = this.now().toISOString();
    const metadata: StoredAssetMetadata = assetMetadataSchema.parse({
      schemaVersion: 1,
      assetId,
      createdAt,
      model: VISUAL_MODEL,
      size: "1024x1024",
      quality: "low",
      mimeType: "image/png",
      byteLength: bytes.byteLength,
      contentHash: sha256(bytes),
      promptHash: sha256(pending.preview.renderedPrompt),
      brief: pending.preview.brief,
    });
    await this.#writeAsset(roots.visualsRoot, metadata, bytes);
    return view(metadata);
  }

  /** Idempotent pre-drain hook: abort provider calls before the HTTP server drains. */
  public beginShutdown(): void {
    if (this.#closing) return;
    this.#closing = true;
    this.#pending.clear();
    for (const controller of this.#activeControllers) controller.abort();
  }

  public async list(): Promise<readonly VisualAidAssetView[]> {
    const roots = await this.#readRoots();
    if (roots === null) return [];
    let entries;
    try {
      entries = await readdir(roots.visualsRoot, { withFileTypes: true });
    } catch (error) {
      if (isErrno(error, "ENOENT")) return [];
      throw error;
    }
    const assets: VisualAidAssetView[] = [];
    for (const entry of entries) {
      if (!ASSET_ID_PATTERN.test(entry.name)) continue;
      assets.push(await this.#readMetadata(roots.visualsRoot, entry.name));
    }
    assets.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return Object.freeze(assets.slice(0, MAX_ASSETS));
  }

  public async readImage(assetId: string): Promise<Readonly<{
    bytes: Buffer;
    metadata: VisualAidAssetView;
  }>> {
    if (!ASSET_ID_PATTERN.test(assetId)) {
      throw new VisualAidServiceError("invalid_request", "The visual asset ID is invalid.");
    }
    try {
      const roots = await this.#readRoots();
      if (roots === null) {
        throw new VisualAidServiceError("corrupt_store", "The saved visual asset is unreadable.");
      }
      const assetRoot = await safeAssetDirectory(roots.visualsRoot, assetId);
      const metadata = await this.#readMetadata(roots.visualsRoot, assetId);
      const bytes = await readSafeFile(join(assetRoot, "image.png"), assetRoot, MAX_IMAGE_BYTES);
      if (!isPng(bytes) || bytes.byteLength !== metadata.byteLength || sha256(bytes) !== metadata.contentHash) {
        throw new VisualAidServiceError("corrupt_store", "The saved visual asset failed its integrity check.");
      }
      return Object.freeze({ bytes, metadata });
    } catch (error) {
      if (error instanceof VisualAidServiceError) throw error;
      throw new VisualAidServiceError("corrupt_store", "The saved visual asset is unreadable.", { cause: error });
    }
  }

  async #readMetadata(visualsRoot: string, assetId: string): Promise<VisualAidAssetView> {
    try {
      const assetRoot = await safeAssetDirectory(visualsRoot, assetId);
      const content = (await readSafeFile(
        join(assetRoot, "metadata.json"),
        assetRoot,
        MAX_METADATA_BYTES,
      )).toString("utf8");
      const metadata = assetMetadataSchema.parse(JSON.parse(content));
      if (metadata.assetId !== assetId) throw new Error("asset_id_mismatch");
      return view(metadata);
    } catch (error) {
      if (error instanceof VisualAidServiceError) throw error;
      throw new VisualAidServiceError("corrupt_store", "A saved visual asset is unreadable.", {
        cause: error,
      });
    }
  }

  async #writeAsset(visualsRoot: string, metadata: StoredAssetMetadata, bytes: Buffer): Promise<void> {
    await requireSafeDirectory(visualsRoot, visualsRoot);
    const temporary = join(visualsRoot, `.visual-${randomUUID()}.tmp`);
    const target = join(visualsRoot, metadata.assetId);
    await mkdir(temporary, { mode: 0o700 });
    try {
      await requireSafeDirectory(temporary, visualsRoot);
      await writePrivate(join(temporary, "image.png"), bytes, temporary);
      await writePrivate(
        join(temporary, "metadata.json"),
        Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`, "utf8"),
        temporary,
      );
      await syncDirectory(temporary);
      await rename(temporary, target);
      await requireSafeDirectory(target, visualsRoot);
      await syncDirectory(visualsRoot);
    } catch (error) {
      // The temporary directory is intentionally left private for forensic
      // recovery on a rare partial-write failure; it is never listed as an asset.
      throw error;
    }
  }

  #pruneExpired(): void {
    const nowMs = this.now().getTime();
    for (const [key, pending] of this.#pending) {
      if (pending.expiresAtMs <= nowMs) this.#pending.delete(key);
    }
  }

  async #writeRoots(): Promise<Readonly<{ stateRoot: string; visualsRoot: string }>> {
    try {
      await mkdir(this.#configuredStateRoot, { recursive: true, mode: 0o700 });
      const stateRoot = await safeStateRoot(this.#configuredStateRoot);
      const mediaRoot = await ensureSafeChildDirectory(stateRoot, "media", stateRoot);
      const visualsRoot = await ensureSafeChildDirectory(mediaRoot, "visuals", stateRoot);
      return Object.freeze({ stateRoot, visualsRoot });
    } catch (error) {
      if (error instanceof VisualAidServiceError) throw error;
      throw new VisualAidServiceError("corrupt_store", "Visual storage is not a safe owner-controlled directory.", { cause: error });
    }
  }

  async #readRoots(): Promise<Readonly<{ stateRoot: string; visualsRoot: string }> | null> {
    try {
      const stateRoot = await safeStateRoot(this.#configuredStateRoot);
      const mediaRoot = await existingSafeChildDirectory(stateRoot, "media", stateRoot);
      if (mediaRoot === null) return null;
      const visualsRoot = await existingSafeChildDirectory(mediaRoot, "visuals", stateRoot);
      return visualsRoot === null ? null : Object.freeze({ stateRoot, visualsRoot });
    } catch (error) {
      if (isErrno(error, "ENOENT")) return null;
      if (error instanceof VisualAidServiceError) throw error;
      throw new VisualAidServiceError("corrupt_store", "Visual storage is not a safe owner-controlled directory.", { cause: error });
    }
  }
}

async function writePrivate(target: string, bytes: Buffer, boundary: string): Promise<void> {
  await requireSafeDirectory(dirname(target), boundary);
  const handle = await open(target, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(target, 0o600);
  const stat = await lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Visual asset storage is unsafe");
}

function isWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child !== ".." && !child.startsWith(`..${sep}`) && !child.startsWith(sep);
}

async function safeStateRoot(configured: string): Promise<string> {
  const metadata = await lstat(configured);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error("unsafe_state_root");
  return await realpath(configured);
}

async function ensureSafeChildDirectory(parent: string, component: string, boundary: string): Promise<string> {
  const target = resolve(parent, component);
  if (!isWithin(boundary, target)) throw new Error("unsafe_directory_escape");
  try {
    await mkdir(target, { mode: 0o700 });
  } catch (error) {
    if (!isErrno(error, "EEXIST")) throw error;
  }
  await requireSafeDirectory(target, boundary);
  return target;
}

async function existingSafeChildDirectory(
  parent: string,
  component: string,
  boundary: string,
): Promise<string | null> {
  const target = resolve(parent, component);
  if (!isWithin(boundary, target)) throw new Error("unsafe_directory_escape");
  try {
    await requireSafeDirectory(target, boundary);
    return target;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return null;
    throw error;
  }
}

async function requireSafeDirectory(path: string, boundary: string): Promise<void> {
  if (!isWithin(boundary, path)) throw new Error("unsafe_directory_escape");
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error("unsafe_directory_type");
  const canonical = await realpath(path);
  if (canonical !== path || !isWithin(boundary, canonical)) throw new Error("unsafe_directory_resolution");
}

async function safeAssetDirectory(visualsRoot: string, assetId: string): Promise<string> {
  const target = resolve(visualsRoot, assetId);
  await requireSafeDirectory(target, visualsRoot);
  return target;
}

async function readSafeFile(path: string, boundary: string, maxBytes: number): Promise<Buffer> {
  if (!isWithin(boundary, path)) throw new Error("unsafe_file_escape");
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > maxBytes) {
    throw new Error("unsafe_file_type_or_size");
  }
  const canonical = await realpath(path);
  if (canonical !== path || !isWithin(boundary, canonical)) throw new Error("unsafe_file_resolution");
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function providerUncertainty(cause: unknown): VisualAidServiceError {
  return new VisualAidServiceError(
    "provider_failed",
    "No image completion could be confirmed. The request may have reached OpenAI and incurred usage, so it will not be retried automatically; review the brief again only if another generation is acceptable.",
    { cause },
  );
}

function view(metadata: StoredAssetMetadata): VisualAidAssetView {
  return Object.freeze({
    assetId: metadata.assetId,
    createdAt: metadata.createdAt,
    model: metadata.model,
    size: metadata.size,
    quality: metadata.quality,
    mimeType: metadata.mimeType,
    byteLength: metadata.byteLength,
    contentHash: metadata.contentHash,
    promptHash: metadata.promptHash,
    brief: Object.freeze({ ...metadata.brief }),
    imageUrl: `/api/visuals/${encodeURIComponent(metadata.assetId)}/image`,
  });
}

function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function tokenDigest(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { readonly code?: unknown }).code === code;
}

function isPng(bytes: Uint8Array): boolean {
  return bytes.byteLength >= PNG_SIGNATURE.byteLength
    && PNG_SIGNATURE.every((value, index) => bytes[index] === value);
}
