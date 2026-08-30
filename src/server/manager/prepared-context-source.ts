import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

import type { PreparationStateResponse } from "../../shared/preparation.js";
import type {
  ScopedPreparedReference,
  ScopedPreparedReferenceContextSource,
} from "../preparation/context-source.js";
import type {
  ManagerPreparationContextSource,
  ManagerPreparedReference,
} from "./context-service.js";

const MAX_REFERENCES = 24;
const MAX_TEXT_REFERENCES = 8;
const MAX_EXCERPT_BYTES = 6 * 1024;
const MAX_TOTAL_EXCERPT_BYTES = 48 * 1024;
export const MAX_TUTOR_PREPARED_REFERENCES = 6;
export const MAX_TUTOR_PREPARED_REFERENCE_BYTES = 6 * 1024;
export const MAX_TUTOR_PREPARED_TOTAL_BYTES = 32 * 1024;
const MARKDOWN_PATH = /^preparation\/cache\/sha256\/[a-f0-9]{2}\/[a-f0-9]{64}\.md$/;
const SECTION_ID = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

export interface PreparationStateSource {
  state(): Promise<PreparationStateResponse>;
}

interface VerifiedMarkdown {
  readonly markdown: string;
  readonly contentHash: string;
}

/** Safely exposes cached inert Markdown—not raw HTML/PDF—to manager context. */
export class FilePreparedReferenceContextSource implements
  ManagerPreparationContextSource,
  ScopedPreparedReferenceContextSource {
  readonly #stateRoot: string;
  readonly #cacheRoot: string;

  public constructor(
    stateRoot: string,
    private readonly preparation: PreparationStateSource,
  ) {
    this.#stateRoot = resolve(stateRoot);
    this.#cacheRoot = resolve(this.#stateRoot, "preparation", "cache");
  }

  public async read(): Promise<readonly ManagerPreparedReference[]> {
    const run = (await this.preparation.state()).latestRun;
    if (run === null) return [];
    const references: ManagerPreparedReference[] = [];
    let textReferences = 0;
    let totalExcerptBytes = 0;

    for (const source of run.sources.slice(0, MAX_REFERENCES)) {
      let excerpt: string | null = null;
      let truncated = false;
      if (
        source.status === "cached"
        && source.markdownPath !== null
        && textReferences < MAX_TEXT_REFERENCES
        && totalExcerptBytes < MAX_TOTAL_EXCERPT_BYTES
      ) {
        const remaining = Math.min(MAX_EXCERPT_BYTES, MAX_TOTAL_EXCERPT_BYTES - totalExcerptBytes);
        const { markdown } = await this.#readVerifiedMarkdown(source.markdownPath);
        excerpt = truncateUtf8(markdown, remaining);
        truncated = Buffer.byteLength(excerpt, "utf8") < Buffer.byteLength(markdown, "utf8");
        totalExcerptBytes += Buffer.byteLength(excerpt, "utf8");
        textReferences += 1;
      }
      references.push(Object.freeze({
        sourceId: source.sourceId,
        title: source.origins[0]?.label ?? new URL(source.requestedUrl).hostname,
        url: source.finalUrl ?? source.requestedUrl,
        status: source.status,
        contentHash: source.contentHash,
        excerpt,
        truncated,
        detail: source.detail,
      }));
    }
    return Object.freeze(references);
  }

  /**
   * Returns only verified inert Markdown whose recorded manifest origins overlap
   * the fresh server-resolved tutor section set. Raw HTML and PDF bytes never
   * cross this boundary.
   */
  public async readForSections(
    sectionIds: readonly string[],
  ): Promise<readonly ScopedPreparedReference[]> {
    if (!Array.isArray(sectionIds) || sectionIds.length > 32) {
      throw new Error("Prepared reference section scope is invalid");
    }
    const requestedSections = new Set<string>();
    for (const sectionId of sectionIds) {
      if (typeof sectionId !== "string" || !SECTION_ID.test(sectionId)) {
        throw new Error("Prepared reference section scope is invalid");
      }
      requestedSections.add(sectionId);
    }
    if (requestedSections.size === 0) return Object.freeze([]);

    const run = (await this.preparation.state()).latestRun;
    if (run === null) return Object.freeze([]);

    const references: ScopedPreparedReference[] = [];
    let totalMarkdownBytes = 0;
    for (const source of run.sources) {
      if (references.length >= MAX_TUTOR_PREPARED_REFERENCES) break;
      if (
        source.status !== "cached"
        || source.mediaType !== "html"
        || source.markdownPath === null
        || source.contentHash === null
        || source.fetchedAt === null
      ) {
        continue;
      }
      const matchingOrigins = source.origins.filter(({ sectionId }) =>
        requestedSections.has(sectionId),
      );
      if (matchingOrigins.length === 0) continue;

      const remaining = MAX_TUTOR_PREPARED_TOTAL_BYTES - totalMarkdownBytes;
      if (remaining <= 0) break;
      const verified = await this.#readVerifiedMarkdown(source.markdownPath);
      const markdown = truncateUtf8(
        verified.markdown,
        Math.min(MAX_TUTOR_PREPARED_REFERENCE_BYTES, remaining),
      );
      const markdownBytes = Buffer.byteLength(markdown, "utf8");
      if (markdownBytes === 0) continue;
      totalMarkdownBytes += markdownBytes;

      references.push(Object.freeze({
        sourceId: source.sourceId,
        title: matchingOrigins[0]?.label ?? new URL(source.requestedUrl).hostname,
        requestedUrl: source.requestedUrl,
        finalUrl: source.finalUrl ?? source.requestedUrl,
        fetchedAt: source.fetchedAt,
        sourceContentHash: source.contentHash,
        projectionContentHash: verified.contentHash,
        markdown,
        truncated: markdownBytes < Buffer.byteLength(verified.markdown, "utf8"),
        origins: Object.freeze(matchingOrigins.map((origin) => Object.freeze({
          sectionId: origin.sectionId,
          manifestRevision: origin.manifestRevision,
          documentId: origin.documentId,
          documentContentHash: origin.documentContentHash,
          label: origin.label,
        }))),
      }));
    }
    return Object.freeze(references);
  }

  async #readVerifiedMarkdown(logicalPath: string): Promise<VerifiedMarkdown> {
    if (!MARKDOWN_PATH.test(logicalPath)) {
      throw new Error("Prepared reference path is invalid");
    }
    const target = resolve(this.#stateRoot, ...logicalPath.split("/"));
    if (!isWithin(this.#cacheRoot, target)) throw new Error("Prepared reference escaped cache storage");
    const metadata = await lstat(target);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("Prepared reference is not a regular file");
    }
    const [canonicalRoot, canonicalTarget] = await Promise.all([
      realpath(this.#cacheRoot),
      realpath(target),
    ]);
    if (!isWithin(canonicalRoot, canonicalTarget)) {
      throw new Error("Prepared reference resolves outside cache storage");
    }
    const bytes = await readFile(target);
    const expectedHash = basename(target, ".md");
    const actualHash = createHash("sha256").update(bytes).digest("hex");
    if (actualHash !== expectedHash) throw new Error("Prepared reference failed its integrity check");
    return Object.freeze({
      markdown: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      contentHash: `sha256:${actualHash}`,
    });
  }
}

function isWithin(root: string, target: string): boolean {
  const child = relative(root, target);
  return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let lower = 0;
  let upper = value.length;
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= maxBytes) lower = middle;
    else upper = middle - 1;
  }
  return value.slice(0, lower).trimEnd();
}
