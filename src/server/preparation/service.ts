import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as nodeFs from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { z } from "zod";

import type {
  PreparationFailureCode,
  PreparationLimitsView,
  PreparationRunView,
  PreparationSourceOriginView,
  PreparationSourceView,
  PreparationStateResponse,
} from "../../shared/preparation.js";
import { PREPARATION_SCHEMA_VERSION } from "../../shared/preparation.js";
import type { CurriculumMaterialManifest } from "../materials/service.js";
import type { PublicWebFetchLimits, PublicWebFetchResult } from "./public-web-fetcher.js";
import {
  pdfToReferenceMarkdown,
  type PdfTextExtractor,
} from "./pdf-text-extractor.js";

const HASH = /^sha256:[a-f0-9]{64}$/u;
const SAFE_RUN_ID = /^[a-z0-9][a-z0-9_-]{0,79}$/u;
const CACHE_PATH = /^preparation\/cache\/sha256\/[a-f0-9]{2}\/[a-f0-9]{64}\.(?:html|pdf)$/u;
const MARKDOWN_PATH = /^preparation\/cache\/sha256\/[a-f0-9]{2}\/[a-f0-9]{64}\.md$/u;

const DEFAULT_LIMITS: PreparationLimitsView = Object.freeze({
  maxInventorySources: 256,
  maxSources: 256,
  maxSourceBytes: 16 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
  maxRedirects: 3,
  requestTimeoutMs: 15_000,
});
const FETCH_CONCURRENCY = 6;

const originSchema = z.object({
  sectionId: z.string().min(1).max(80),
  manifestRevision: z.string().min(1).max(160),
  documentId: z.string().min(1).max(160),
  documentContentHash: z.string().min(1).max(160),
  label: z.string().min(1).max(240),
}).strict();

const canonicalHttpsUrlSchema = z.string().max(4_096).refine(
  (value) => canonicalExternalUrl(value) === value,
  { message: "Expected a canonical, credential-free HTTPS URL on port 443" },
);

const redirectSchema = z.object({
  from: canonicalHttpsUrlSchema,
  to: canonicalHttpsUrlSchema,
  status: z.union([z.literal(301), z.literal(302), z.literal(303), z.literal(307), z.literal(308)]),
}).strict();

const failureCodeSchema = z.enum([
  "dns_unavailable",
  "private_address",
  "insecure_redirect",
  "redirect_limit",
  "redirect_loop",
  "request_timeout",
  "network_error",
  "response_too_large",
  "total_limit",
  "unsupported_media_type",
  "http_error",
  "invalid_response",
] satisfies readonly PreparationFailureCode[]);

const sourceSchema = z.object({
  sourceId: z.string().min(1).max(96),
  requestedUrl: canonicalHttpsUrlSchema,
  finalUrl: canonicalHttpsUrlSchema.nullable(),
  originCount: z.number().int().positive().max(131_072),
  originsTruncated: z.boolean(),
  origins: z.array(originSchema).min(1).max(512),
  status: z.enum(["cached", "not_fetched", "unsupported", "failed"]),
  mediaType: z.enum(["html", "pdf"]).nullable(),
  fetchedAt: z.iso.datetime({ offset: true }).nullable(),
  byteLength: z.number().int().nonnegative().nullable(),
  contentHash: z.string().regex(HASH).nullable(),
  cachePath: z.string().regex(CACHE_PATH).nullable(),
  markdownPath: z.string().regex(MARKDOWN_PATH).nullable(),
  textProjection: z.object({
    status: z.enum(["complete", "failed"]),
    extractor: z.enum(["html-inert-v1", "poppler-pdftotext"]),
    pageCount: z.number().int().positive().max(100_000).nullable(),
    byteLength: z.number().int().nonnegative().nullable(),
    contentHash: z.string().regex(HASH).nullable(),
    detail: z.string().min(1).max(1_000),
  }).strict().optional(),
  redirects: z.array(redirectSchema).max(16),
  failureCode: failureCodeSchema.nullable(),
  detail: z.string().min(1).max(1_000),
}).strict().superRefine((source, context) => {
  if (source.originCount < source.origins.length
    || source.originsTruncated !== (source.originCount > source.origins.length)) {
    context.addIssue({ code: "custom", message: "Origin truncation must match the recorded origin count" });
  }
  if (source.status === "cached") {
    const required = [source.finalUrl, source.mediaType, source.fetchedAt, source.byteLength, source.contentHash, source.cachePath];
    if (required.some((value) => value === null) || source.failureCode !== null) {
      context.addIssue({ code: "custom", message: "Cached sources require complete success provenance" });
    }
    if (source.textProjection === undefined) {
      if ((source.mediaType === "html") !== (source.markdownPath !== null)) {
        context.addIssue({ code: "custom", message: "Legacy cached HTML requires a Markdown projection" });
      }
      return;
    }
    const projectionComplete = source.textProjection.status === "complete";
    if (projectionComplete !== (source.markdownPath !== null)) {
      context.addIssue({ code: "custom", message: "Completed text projections require a Markdown object" });
    }
    if (projectionComplete !== (
      source.textProjection.byteLength !== null
      && source.textProjection.contentHash !== null
    )) {
      context.addIssue({ code: "custom", message: "Text projection provenance is incomplete" });
    }
    if (
      (projectionComplete && source.mediaType === "pdf" && source.textProjection.pageCount === null)
      || ((source.mediaType === "html" || !projectionComplete) && source.textProjection.pageCount !== null)
    ) {
      context.addIssue({ code: "custom", message: "Completed PDF text projections alone record page counts" });
    }
    if (
      (source.mediaType === "html" && source.textProjection.extractor !== "html-inert-v1")
      || (source.mediaType === "pdf" && source.textProjection.extractor !== "poppler-pdftotext")
    ) {
      context.addIssue({ code: "custom", message: "Text projection extractor does not match the source media type" });
    }
    return;
  }
  if (
    source.mediaType !== null
    || source.fetchedAt !== null
    || source.byteLength !== null
    || source.contentHash !== null
    || source.cachePath !== null
    || source.markdownPath !== null
    || source.textProjection !== undefined
  ) {
    context.addIssue({ code: "custom", message: "Uncached sources cannot claim cache provenance" });
  }
  if ((source.status === "not_fetched") !== (source.failureCode === null)) {
    context.addIssue({ code: "custom", message: "Only failed or unsupported sources carry failure codes" });
  }
  if (source.status === "not_fetched" && (source.finalUrl !== null || source.redirects.length > 0)) {
    context.addIssue({ code: "custom", message: "Inventory-only sources cannot claim network provenance" });
  }
  if ((source.status === "unsupported") !== (source.failureCode === "unsupported_media_type")) {
    context.addIssue({ code: "custom", message: "Unsupported status requires the matching media-type failure" });
  }
});

const limitsSchema = z.object({
  maxInventorySources: z.number().int().positive().max(256),
  maxSources: z.number().int().positive().max(256),
  maxSourceBytes: z.number().int().positive().max(32 * 1024 * 1024),
  maxTotalBytes: z.number().int().positive().max(128 * 1024 * 1024),
  maxRedirects: z.number().int().nonnegative().max(10),
  requestTimeoutMs: z.number().int().positive().max(120_000),
}).strict().refine(
  ({ maxInventorySources, maxSources }) => maxSources <= maxInventorySources,
  { message: "The network-source limit cannot exceed the inventory limit", path: ["maxSources"] },
);

const runSchema = z.object({
  schemaVersion: z.literal(PREPARATION_SCHEMA_VERSION),
  runId: z.string().regex(SAFE_RUN_ID),
  startedAt: z.iso.datetime({ offset: true }),
  completedAt: z.iso.datetime({ offset: true }),
  status: z.enum(["complete", "partial", "failed"]),
  inventoryTruncated: z.boolean(),
  discoveredCount: z.number().int().nonnegative(),
  cachedCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
  generatedMarkdownBytes: z.number().int().nonnegative().default(0),
  totalCachedBytes: z.number().int().nonnegative(),
  limits: limitsSchema,
  sources: z.array(sourceSchema).max(256),
}).strict().superRefine((run, context) => {
  const cachedCount = run.sources.filter(({ status }) => status === "cached").length;
  const failedCount = run.sources.filter(({ status }) => status === "failed" || status === "unsupported").length;
  const notFetchedCount = run.sources.filter(({ status }) => status === "not_fetched").length;
  const projectionFailed = run.sources.some(({ textProjection }) => textProjection?.status === "failed");
  const rawCachedBytes = run.sources.reduce((total, source) =>
    total + (source.status === "cached" ? source.byteLength ?? 0 : 0), 0);
  const cachedBytes = rawCachedBytes + run.generatedMarkdownBytes;
  if (cachedCount !== run.cachedCount || failedCount !== run.failedCount || cachedBytes !== run.totalCachedBytes) {
    context.addIssue({ code: "custom", message: "Run totals do not match immutable source records" });
  }
  if (run.sources.length > run.discoveredCount) {
    context.addIssue({ code: "custom", message: "A run cannot record more sources than it discovered" });
  }
  if (run.sources.length > run.limits.maxInventorySources) {
    context.addIssue({ code: "custom", message: "A run cannot exceed its inventory record limit" });
  }
  if (run.cachedCount > run.limits.maxSources) {
    context.addIssue({ code: "custom", message: "A run cannot exceed its network-source limit" });
  }
  if (run.totalCachedBytes > run.limits.maxTotalBytes) {
    context.addIssue({ code: "custom", message: "A run cannot exceed its total cache byte limit" });
  }
  if (run.sources.some((source) =>
    source.redirects.length > run.limits.maxRedirects
    || (source.byteLength ?? 0) > run.limits.maxSourceBytes)) {
    context.addIssue({ code: "custom", message: "A source exceeds the run's redirect or byte limits" });
  }
  if (run.inventoryTruncated !== (run.discoveredCount > run.sources.length)) {
    context.addIssue({ code: "custom", message: "Inventory truncation must match the recorded source count" });
  }
  // A run with no attempted source is an inventory-only (or empty) run. Once a
  // network result exists, remaining not-fetched/truncated sources make a cache
  // run partial rather than falsely complete.
  const inferredCacheRun = cachedCount + failedCount > 0;
  const incompleteCacheRun = inferredCacheRun && (notFetchedCount > 0 || run.inventoryTruncated);
  const expectedStatus = failedCount === 0 && !incompleteCacheRun && !projectionFailed
    ? "complete"
    : cachedCount > 0
      ? "partial"
      : "failed";
  if (run.status !== expectedStatus) {
    context.addIssue({ code: "custom", message: "Run status does not match its source results" });
  }
  if (run.completedAt < run.startedAt) {
    context.addIssue({ code: "custom", message: "A run cannot complete before it starts" });
  }
});

export interface PreparationManifestSource {
  readManifests(): Promise<readonly CurriculumMaterialManifest[]>;
}

export interface PreparationFetcher {
  fetch(url: string, limits: PublicWebFetchLimits): Promise<PublicWebFetchResult>;
}

export interface PreparationRunStore {
  latest(): Promise<PreparationRunView | null>;
  putObject(contentHash: string, extension: "html" | "pdf" | "md", bytes: Uint8Array): Promise<string>;
  saveRun(run: PreparationRunView): Promise<void>;
}

export interface PreparationServiceDependencies {
  readonly manifests: PreparationManifestSource;
  readonly fetcher: PreparationFetcher;
  readonly store: PreparationRunStore;
  readonly pdfTextExtractor?: PdfTextExtractor;
  readonly limits?: Partial<PreparationLimitsView>;
  readonly now?: () => Date;
  readonly createId?: () => string;
}

export class PreparationRunInProgressError extends Error {
  public readonly code = "preparation_in_progress" as const;

  public constructor() {
    super("A preparation run is already in progress.");
    this.name = "PreparationRunInProgressError";
  }
}

export class PreparationShuttingDownError extends Error {
  public readonly code = "preparation_shutting_down" as const;

  public constructor() {
    super("The active preparation run was cancelled because the companion is shutting down.");
    this.name = "AbortError";
  }
}

function throwIfPreparationAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new PreparationShuttingDownError();
}

interface InventorySource {
  readonly sourceId: string;
  readonly requestedUrl: string;
  readonly originCount: number;
  readonly originsTruncated: boolean;
  readonly origins: readonly PreparationSourceOriginView[];
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function sourceId(url: string): string {
  return `source_${sha256(`reference-source-v1\0${url}`)}`;
}

function canonicalExternalUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:"
      || (url.port !== "" && url.port !== "443")
      || url.username !== ""
      || url.password !== ""
    ) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Turn a learner-visible reference into the resource preparation should fetch.
 *
 * arXiv abstract pages expose only metadata and an abstract. For retrieval, the
 * useful immutable source is the corresponding paper PDF, so normalize both
 * `/abs/...` and `/pdf/...` spellings before inventory deduplication. Keep this
 * separate from canonicalExternalUrl: old immutable run records legitimately
 * contain abstract URLs and must continue to pass schema validation.
 */
function preparationTargetUrl(value: string): string | null {
  const canonical = canonicalExternalUrl(value);
  if (canonical === null) return null;

  const url = new URL(canonical);
  if (url.hostname !== "arxiv.org" && url.hostname !== "www.arxiv.org") return canonical;

  const match = url.pathname.match(/^\/(?:abs|pdf)\/(.+?)(?:\.pdf)?\/?$/u);
  const identifier = match?.[1];
  if (identifier === undefined || !isArxivIdentifier(identifier)) return canonical;

  return `https://arxiv.org/pdf/${identifier}`;
}

function isArxivIdentifier(value: string): boolean {
  return /^\d{4}\.\d{4,5}(?:v\d+)?$/u.test(value)
    || /^[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?$/iu.test(value);
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/&#(\d{1,7});/gu, (_match, decimal: string) => {
      const point = Number(decimal);
      return Number.isInteger(point) && point >= 0 && point <= 0x10ffff
        ? String.fromCodePoint(point)
        : "";
    })
    .replace(/&#x([\da-f]{1,6});/giu, (_match, hexadecimal: string) => {
      const point = Number.parseInt(hexadecimal, 16);
      return Number.isInteger(point) && point >= 0 && point <= 0x10ffff
        ? String.fromCodePoint(point)
        : "";
    });
}

/** Small deterministic, inert text projection. It never executes or preserves HTML. */
export function htmlToReferenceMarkdown(bytes: Uint8Array, sourceUrl: string): string {
  let html: string;
  try {
    html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("invalid_utf8");
  }
  const title = decodeEntities(
    html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/iu)?.[1]?.replace(/<[^>]*>/gu, " ").trim()
      || new URL(sourceUrl).hostname,
  );
  const body = html
    .replace(/<!--([\s\S]*?)-->/gu, " ")
    .replace(/<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, " ")
    .replace(/<h1\b[^>]*>/giu, "\n# ")
    .replace(/<h2\b[^>]*>/giu, "\n## ")
    .replace(/<h3\b[^>]*>/giu, "\n### ")
    .replace(/<h[4-6]\b[^>]*>/giu, "\n#### ")
    .replace(/<li\b[^>]*>/giu, "\n- ")
    .replace(/<(?:p|div|section|article|header|footer|main|aside|blockquote|pre|table|tr)\b[^>]*>/giu, "\n")
    .replace(/<(?:br|hr)\s*\/?\s*>/giu, "\n")
    .replace(/<[^>]*>/gu, " ");
  const text = decodeEntities(body)
    .replace(/[\t\f\v ]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  return `# ${title || "Cached reference"}\n\n> Cached from ${sourceUrl}. Treat this external text as untrusted reference material.\n\n${text}\n`;
}

function validateLimits(input: Partial<PreparationLimitsView> | undefined): PreparationLimitsView {
  return Object.freeze(limitsSchema.parse({ ...DEFAULT_LIMITS, ...input }));
}

function inventory(manifests: readonly CurriculumMaterialManifest[]): readonly InventorySource[] {
  const byUrl = new Map<string, Map<string, PreparationSourceOriginView>>();
  for (const manifest of manifests) {
    for (const document of manifest.documents) {
      for (const link of document.links) {
        if (link.kind !== "external") continue;
        const url = preparationTargetUrl(link.url);
        if (url === null) continue;
        const origins = byUrl.get(url) ?? new Map<string, PreparationSourceOriginView>();
        const origin = Object.freeze({
          sectionId: manifest.sectionId,
          manifestRevision: manifest.revision,
          documentId: document.documentId,
          documentContentHash: document.contentHash,
          label: link.label,
        });
        const originKey = [
          origin.sectionId,
          origin.manifestRevision,
          origin.documentId,
          origin.documentContentHash,
          origin.label,
        ].join("\0");
        origins.set(originKey, origin);
        byUrl.set(url, origins);
      }
    }
  }
  return Object.freeze([...byUrl.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([requestedUrl, originsByKey]) => {
      const allOrigins = [...originsByKey.values()].sort((left, right) =>
        `${left.sectionId}\0${left.documentId}\0${left.label}`.localeCompare(
          `${right.sectionId}\0${right.documentId}\0${right.label}`,
        ));
      const origins = allOrigins.slice(0, 512);
      return Object.freeze({
        sourceId: sourceId(requestedUrl),
        requestedUrl,
        originCount: allOrigins.length,
        originsTruncated: allOrigins.length > origins.length,
        origins: Object.freeze(origins),
      });
    }));
}

function unfetched(source: InventorySource, detail = "Discovered from the current verified curriculum material manifest; not fetched in this inventory-only run."): PreparationSourceView {
  return Object.freeze({
    ...source,
    finalUrl: null,
    status: "not_fetched" as const,
    mediaType: null,
    fetchedAt: null,
    byteLength: null,
    contentHash: null,
    cachePath: null,
    markdownPath: null,
    redirects: Object.freeze([]),
    failureCode: null,
    detail,
  });
}

function failedSource(
  source: InventorySource,
  result: Extract<PublicWebFetchResult, { ok: false }>,
): PreparationSourceView {
  return Object.freeze({
    ...source,
    finalUrl: result.finalUrl,
    status: result.failureCode === "unsupported_media_type" ? "unsupported" as const : "failed" as const,
    mediaType: null,
    fetchedAt: null,
    byteLength: null,
    contentHash: null,
    cachePath: null,
    markdownPath: null,
    redirects: result.redirects,
    failureCode: result.failureCode,
    detail: result.detail,
  });
}

export class PreparationService {
  readonly #limits: PreparationLimitsView;
  readonly #now: () => Date;
  readonly #createId: () => string;
  #active = false;
  #activeController: AbortController | null = null;
  #closing = false;

  public constructor(private readonly dependencies: PreparationServiceDependencies) {
    this.#limits = validateLimits(dependencies.limits);
    this.#now = dependencies.now ?? (() => new Date());
    this.#createId = dependencies.createId ?? (() => `prep_${randomUUID().replaceAll("-", "")}`);
  }

  public async state(): Promise<PreparationStateResponse> {
    return Object.freeze({
      latestRun: await this.dependencies.store.latest(),
      externalNetworkIsUserStartedOnly: true as const,
      enrichment: "disabled" as const,
      transcription: "public-captions-only-not-enabled" as const,
    });
  }

  public async start(fetchSources: boolean): Promise<PreparationRunView> {
    if (this.#closing) throw new PreparationShuttingDownError();
    if (this.#active) throw new PreparationRunInProgressError();
    this.#active = true;
    const controller = new AbortController();
    this.#activeController = controller;
    try {
      return await this.#execute(fetchSources, controller.signal);
    } finally {
      if (this.#activeController === controller) this.#activeController = null;
      this.#active = false;
    }
  }

  /** Idempotent pre-drain hook: stop external work before Fastify waits on it. */
  public beginShutdown(): void {
    if (this.#closing) return;
    this.#closing = true;
    this.#activeController?.abort();
  }

  async #execute(fetchSources: boolean, signal: AbortSignal): Promise<PreparationRunView> {
    const startedAt = this.#now().toISOString();
    const allSources = inventory(await this.dependencies.manifests.readManifests());
    throwIfPreparationAborted(signal);
    const recorded = allSources.slice(0, this.#limits.maxInventorySources);
    const sources: PreparationSourceView[] = [];
    let totalCachedBytes = 0;
    let generatedMarkdownBytes = 0;

    type FetchCompletion =
      | { readonly ok: true; readonly result: PublicWebFetchResult }
      | { readonly ok: false; readonly error: unknown };
    const fetchableCount = fetchSources
      ? Math.min(recorded.length, this.#limits.maxSources)
      : 0;
    const pending = new Map<number, Promise<FetchCompletion>>();
    let nextFetchIndex = 0;
    const scheduleNextFetch = () => {
      if (nextFetchIndex >= fetchableCount) return;
      const index = nextFetchIndex;
      const source = recorded[index];
      nextFetchIndex += 1;
      if (source === undefined) return;
      const completion: Promise<FetchCompletion> = Promise.resolve()
        .then(async () => await this.dependencies.fetcher.fetch(source.requestedUrl, {
          maxSourceBytes: Math.min(this.#limits.maxSourceBytes, this.#limits.maxTotalBytes),
          maxRedirects: this.#limits.maxRedirects,
          requestTimeoutMs: this.#limits.requestTimeoutMs,
          signal,
        }))
        .then(
          (result): FetchCompletion => ({ ok: true, result }),
          (error: unknown): FetchCompletion => ({ ok: false, error }),
        );
      pending.set(index, completion);
    };
    for (let worker = 0; worker < Math.min(FETCH_CONCURRENCY, fetchableCount); worker += 1) {
      scheduleNextFetch();
    }

    for (const [index, source] of recorded.entries()) {
      throwIfPreparationAborted(signal);
      if (!fetchSources) {
        sources.push(unfetched(source));
        continue;
      }
      if (index >= this.#limits.maxSources) {
        sources.push(unfetched(
          source,
          `Inventoried but not fetched because this run is limited to ${this.#limits.maxSources} network sources.`,
        ));
        continue;
      }
      const completion = await pending.get(index);
      pending.delete(index);
      scheduleNextFetch();
      if (completion === undefined) throw new Error("preparation_fetch_queue_invariant");
      if (!completion.ok) {
        if (signal.aborted) throw new PreparationShuttingDownError();
        throw completion.error;
      }
      const result = completion.result;
      throwIfPreparationAborted(signal);
      if (!result.ok) {
        sources.push(failedSource(source, result));
        continue;
      }
      if (totalCachedBytes >= this.#limits.maxTotalBytes) {
        sources.push(failedSource(source, {
          ok: false,
          requestedUrl: source.requestedUrl,
          finalUrl: result.finalUrl,
          failureCode: "total_limit",
          detail: "The run reached its total cache byte limit before this source could be stored.",
          redirects: result.redirects,
        }));
        continue;
      }
      let markdownBytes: Buffer | null = null;
      let textProjection: PreparationSourceView["textProjection"];
      if (result.mediaType === "html") {
        try {
          markdownBytes = Buffer.from(
            htmlToReferenceMarkdown(result.bytes, result.finalUrl),
            "utf8",
          );
          textProjection = Object.freeze({
            status: "complete" as const,
            extractor: "html-inert-v1" as const,
            pageCount: null,
            byteLength: markdownBytes.byteLength,
            contentHash: `sha256:${sha256(markdownBytes)}`,
            detail: "Published an inert Markdown projection of the fetched HTML.",
          });
        } catch (error) {
          if (signal.aborted) throw new PreparationShuttingDownError();
          sources.push(failedSource(source, {
            ok: false,
            requestedUrl: source.requestedUrl,
            finalUrl: result.finalUrl,
            failureCode: "invalid_response",
            detail: error instanceof Error && error.message === "invalid_utf8"
              ? "The HTML source was not valid UTF-8 and was not published to the cache."
              : "The fetched HTML could not be projected safely.",
            redirects: result.redirects,
          }));
          continue;
        }
      } else if (this.dependencies.pdfTextExtractor !== undefined) {
        try {
          const extraction = await this.dependencies.pdfTextExtractor.extract(result.bytes, signal);
          markdownBytes = Buffer.from(pdfToReferenceMarkdown(
            extraction,
            result.finalUrl,
            result.contentHash,
            source.origins[0]?.label ?? new URL(result.finalUrl).hostname,
          ), "utf8");
          textProjection = Object.freeze({
            status: "complete" as const,
            extractor: extraction.extractor,
            pageCount: extraction.pages.length,
            byteLength: markdownBytes.byteLength,
            contentHash: `sha256:${sha256(markdownBytes)}`,
            detail: `Published deterministic page-aware text for ${extraction.pages.length} PDF page${extraction.pages.length === 1 ? "" : "s"}.`,
          });
        } catch (error) {
          if (signal.aborted || error instanceof PreparationShuttingDownError) {
            throw new PreparationShuttingDownError();
          }
          textProjection = Object.freeze({
            status: "failed" as const,
            extractor: "poppler-pdftotext" as const,
            pageCount: null,
            byteLength: null,
            contentHash: null,
            detail: "The PDF bytes were cached, but deterministic text extraction failed safely.",
          });
        }
      }
      const storedByteLength = result.bytes.byteLength + (markdownBytes?.byteLength ?? 0);
      if (totalCachedBytes + storedByteLength > this.#limits.maxTotalBytes) {
        sources.push(failedSource(source, {
          ok: false,
          requestedUrl: source.requestedUrl,
          finalUrl: result.finalUrl,
          failureCode: "total_limit",
          detail: "The source would exceed this run's total cache byte limit.",
          redirects: result.redirects,
        }));
        continue;
      }

      let cachePath: string;
      let markdownPath: string | null = null;
      try {
        throwIfPreparationAborted(signal);
        cachePath = await this.dependencies.store.putObject(
          result.contentHash,
          result.mediaType,
          result.bytes,
        );
        if (markdownBytes !== null) {
          throwIfPreparationAborted(signal);
          markdownPath = await this.dependencies.store.putObject(
            `sha256:${sha256(markdownBytes)}`,
            "md",
            markdownBytes,
          );
        }
      } catch (error) {
        if (signal.aborted || error instanceof PreparationShuttingDownError) {
          throw new PreparationShuttingDownError();
        }
        const detail = error instanceof Error && error.message === "invalid_utf8"
          ? "The HTML source was not valid UTF-8 and was not published to the cache."
          : "The fetched source could not be published to owner-only cache storage.";
        sources.push(failedSource(source, {
          ok: false,
          requestedUrl: source.requestedUrl,
          finalUrl: result.finalUrl,
          failureCode: "invalid_response",
          detail,
          redirects: result.redirects,
        }));
        continue;
      }

      const fetchedAt = this.#now().toISOString();
      totalCachedBytes += storedByteLength;
      generatedMarkdownBytes += markdownBytes?.byteLength ?? 0;
      sources.push(Object.freeze({
        ...source,
        finalUrl: result.finalUrl,
        status: "cached" as const,
        mediaType: result.mediaType,
        fetchedAt,
        byteLength: result.bytes.byteLength,
        contentHash: result.contentHash,
        cachePath,
        markdownPath,
        ...(textProjection === undefined ? {} : { textProjection }),
        redirects: result.redirects,
        failureCode: null,
        detail: textProjection?.status === "complete"
          ? result.mediaType === "html"
            ? "Cached immutable source bytes and an inert Markdown text projection."
            : `Cached immutable PDF bytes and indexed ${textProjection.pageCount ?? 0} pages of deterministic text.`
          : result.mediaType === "pdf"
            ? "Cached immutable PDF bytes; deterministic text extraction failed safely."
            : "Cached immutable source bytes.",
      }));
    }

    const cachedCount = sources.filter(({ status }) => status === "cached").length;
    const failedCount = sources.filter(({ status }) => status === "failed" || status === "unsupported").length;
    const notFetchedCount = sources.filter(({ status }) => status === "not_fetched").length;
    const projectionFailed = sources.some(({ textProjection }) => textProjection?.status === "failed");
    const incompleteCacheRun = fetchSources
      && (notFetchedCount > 0 || allSources.length > recorded.length);
    const run: PreparationRunView = Object.freeze({
      schemaVersion: PREPARATION_SCHEMA_VERSION,
      runId: this.#createId(),
      startedAt,
      completedAt: this.#now().toISOString(),
      status: failedCount === 0 && !incompleteCacheRun && !projectionFailed
        ? "complete"
        : cachedCount > 0
          ? "partial"
          : "failed",
      inventoryTruncated: allSources.length > recorded.length,
      discoveredCount: allSources.length,
      cachedCount,
      failedCount,
      generatedMarkdownBytes,
      totalCachedBytes,
      limits: this.#limits,
      sources: Object.freeze(sources),
    });
    const validated = runSchema.parse(run) as PreparationRunView;
    await this.dependencies.store.saveRun(validated);
    return Object.freeze(validated);
  }
}

function isWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child !== ".." && !child.startsWith(`..${sep}`) && !child.startsWith(sep);
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await nodeFs.open(path, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class FilePreparationRunStore implements PreparationRunStore {
  readonly #configuredStateRoot: string;

  public constructor(stateRoot: string) {
    if (!isAbsolute(stateRoot)) throw new Error("state_root_must_be_absolute");
    this.#configuredStateRoot = resolve(stateRoot);
  }

  public async latest(): Promise<PreparationRunView | null> {
    const roots = await this.#ensureRoots();
    const entries = (await nodeFs.readdir(roots.runsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .sort()
      .reverse()
      .slice(0, 512);
    let latest: PreparationRunView | null = null;
    for (const name of entries) {
      const path = resolve(roots.runsRoot, name);
      if (!isWithin(roots.runsRoot, path)) continue;
      try {
        const raw = (await readSafeRegularFile(path, roots.runsRoot)).toString("utf8");
        const parsed = runSchema.safeParse(JSON.parse(raw));
        if (!parsed.success) continue;
        if (latest === null || parsed.data.completedAt > latest.completedAt) {
          latest = parsed.data as PreparationRunView;
        }
      } catch {
        // A malformed external file never replaces the last valid immutable run.
      }
    }
    return latest === null ? null : Object.freeze(latest);
  }

  public async putObject(
    contentHash: string,
    extension: "html" | "pdf" | "md",
    bytes: Uint8Array,
  ): Promise<string> {
    if (!HASH.test(contentHash)) throw new Error("invalid_object_hash");
    const actual = `sha256:${sha256(bytes)}`;
    if (actual !== contentHash) throw new Error("object_hash_mismatch");
    const roots = await this.#ensureRoots();
    const digest = contentHash.slice("sha256:".length);
    const prefixRoot = await ensureSafeChildDirectory(
      roots.objectsRoot,
      digest.slice(0, 2),
      roots.objectsRoot,
    );
    const target = join(prefixRoot, `${digest}.${extension}`);
    await this.#publishExclusive(target, bytes, roots.objectsRoot);
    return relative(roots.stateRoot, target).split(sep).join("/");
  }

  public async saveRun(run: PreparationRunView): Promise<void> {
    const parsed = runSchema.parse(run);
    if (!SAFE_RUN_ID.test(parsed.runId)) throw new Error("invalid_run_id");
    const roots = await this.#ensureRoots();
    const timestamp = parsed.completedAt.replace(/[^0-9]/gu, "").slice(0, 17);
    const target = join(roots.runsRoot, `${timestamp}-${parsed.runId}.json`);
    await this.#publishExclusive(
      target,
      Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`, "utf8"),
      roots.runsRoot,
    );
  }

  async #ensureRoots(): Promise<Readonly<{
    stateRoot: string;
    runsRoot: string;
    objectsRoot: string;
  }>> {
    await nodeFs.mkdir(this.#configuredStateRoot, { recursive: true, mode: 0o700 });
    const configured = await nodeFs.lstat(this.#configuredStateRoot);
    if (configured.isSymbolicLink() || !configured.isDirectory()) {
      throw new Error("unsafe_state_root");
    }
    const stateRoot = await nodeFs.realpath(this.#configuredStateRoot);
    const preparationRoot = await ensureSafeChildDirectory(
      stateRoot,
      "preparation",
      stateRoot,
    );
    const runsRoot = await ensureSafeChildDirectory(
      preparationRoot,
      "runs",
      stateRoot,
    );
    const cacheRoot = await ensureSafeChildDirectory(
      preparationRoot,
      "cache",
      stateRoot,
    );
    const objectsRoot = await ensureSafeChildDirectory(
      cacheRoot,
      "sha256",
      stateRoot,
    );
    return Object.freeze({ stateRoot, runsRoot, objectsRoot });
  }

  async #publishExclusive(target: string, bytes: Uint8Array, boundary: string): Promise<void> {
    const directory = dirname(target);
    await requireSafeDirectory(directory, boundary);
    const temporary = join(directory, `.${basename(target)}.${randomUUID()}.tmp`);
    let temporaryCreated = false;
    try {
      const handle = await nodeFs.open(temporary, "wx", 0o600);
      temporaryCreated = true;
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await nodeFs.link(temporary, target);
        await syncDirectory(directory);
      } catch (error) {
        if (!isErrno(error, "EEXIST")) throw error;
        const existing = await readSafeRegularFile(target, boundary);
        if (`sha256:${sha256(existing)}` !== `sha256:${sha256(bytes)}`) {
          throw new Error("immutable_target_conflict");
        }
      }
    } finally {
      if (temporaryCreated) await nodeFs.unlink(temporary).catch(() => undefined);
    }
  }
}

async function ensureSafeChildDirectory(
  parent: string,
  component: string,
  boundary: string,
): Promise<string> {
  if (!component || component.includes(sep) || component === "." || component === "..") {
    throw new Error("unsafe_directory_component");
  }
  const target = resolve(parent, component);
  if (!isWithin(boundary, target)) throw new Error("unsafe_directory_escape");
  try {
    await nodeFs.mkdir(target, { mode: 0o700 });
  } catch (error) {
    if (!isErrno(error, "EEXIST")) throw error;
  }
  await requireSafeDirectory(target, boundary);
  return target;
}

async function requireSafeDirectory(path: string, boundary: string): Promise<void> {
  if (!isWithin(boundary, path)) throw new Error("unsafe_directory_escape");
  const metadata = await nodeFs.lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("unsafe_directory_type");
  }
  const canonical = await nodeFs.realpath(path);
  if (canonical !== path || !isWithin(boundary, canonical)) {
    throw new Error("unsafe_directory_resolution");
  }
}

async function readSafeRegularFile(path: string, boundary: string): Promise<Buffer> {
  if (!isWithin(boundary, path)) throw new Error("unsafe_file_escape");
  const metadata = await nodeFs.lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error("unsafe_file_type");
  const canonical = await nodeFs.realpath(path);
  if (canonical !== path || !isWithin(boundary, canonical)) throw new Error("unsafe_file_resolution");
  const handle = await nodeFs.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { readonly code?: unknown }).code === code;
}
