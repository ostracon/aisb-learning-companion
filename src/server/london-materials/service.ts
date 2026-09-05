import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { z } from "zod";

import type { LearningDayId } from "../../shared/api.js";

const MAX_RESOURCES = 256;
const MAX_SEARCH_RESULTS = 12;
const MAX_SEARCH_BYTES_PER_RESOURCE = 64 * 1024;
const MAX_SEARCH_TOTAL_BYTES = 1024 * 1024;
const MAX_READ_BYTES = 16 * 1024;

const learningDaySchema = z.enum([
  "day0", "day1", "day2", "day3", "day4", "day5", "day6", "day7",
]);

const manifestResourceSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,159}$/u),
  title: z.string().trim().min(1).max(500),
  days: z.array(learningDaySchema).min(1).max(8),
  source: z.string().trim().min(1).max(100),
  sourceId: z.string().trim().min(1).max(300),
  sourceUrl: z.string().url().optional(),
  assetPath: z.string().trim().min(1).max(500),
  alternateAssetPath: z.string().trim().min(1).max(500).optional(),
  textPath: z.string().trim().min(1).max(500),
  access: z.enum(["public", "cohort", "restricted_cohort_only"]),
  restriction: z.string().trim().min(1).max(1_000).optional(),
  relevance: z.string().trim().min(1).max(1_000).optional(),
  textMethod: z.enum(["ocr"]).optional(),
}).strict();

const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  snapshotId: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(2_000),
  resources: z.array(manifestResourceSchema).max(MAX_RESOURCES),
}).strict();

type ManifestResource = z.infer<typeof manifestResourceSchema>;

export interface LondonMaterialDescriptor {
  readonly resourceId: string;
  readonly title: string;
  readonly days: readonly LearningDayId[];
  readonly citation: string;
  readonly access: ManifestResource["access"];
  readonly status: "ready" | "unavailable";
  readonly detail: string;
}

export interface LondonMaterialSearchResult extends LondonMaterialDescriptor {
  readonly excerpt: string;
  readonly truncated: boolean;
}

export interface LondonMaterialReadResult extends LondonMaterialDescriptor {
  readonly text: string;
  readonly cursor: number;
  readonly nextCursor: number | null;
  readonly provenance: Readonly<Record<string, unknown>>;
}

interface LoadedManifestResource {
  readonly manifest: z.infer<typeof manifestSchema>;
  readonly resource: ManifestResource;
  readonly descriptor: LondonMaterialDescriptor;
}

/**
 * Reads a deliberately curated, private cohort-material overlay from the AISB
 * workspace. Models can select only server-issued opaque IDs; arbitrary paths
 * and URLs are never accepted by the retrieval API.
 */
export class LondonMaterialRetrievalService {
  readonly #snapshotRoot: string;
  readonly #manifestPath: string;

  public constructor(aisbRoot: string) {
    this.#snapshotRoot = resolve(aisbRoot, "london26-materials");
    this.#manifestPath = resolve(this.#snapshotRoot, "model-context", "manifest.json");
  }

  public async inventory(dayId?: LearningDayId): Promise<readonly LondonMaterialDescriptor[]> {
    const resources = await this.#resources(dayId);
    return Object.freeze(resources.map(({ descriptor }) => descriptor));
  }

  public async search(input: {
    readonly query: string;
    readonly dayId?: LearningDayId;
    readonly limit?: number;
  }): Promise<readonly LondonMaterialSearchResult[]> {
    const query = input.query.replace(/\s+/gu, " ").trim();
    if (query.length < 2 || query.length > 500) throw new Error("London material search query is invalid");
    const limit = Math.max(1, Math.min(input.limit ?? 8, MAX_SEARCH_RESULTS));
    const terms = [...new Set(query.toLocaleLowerCase("en-GB").match(/[\p{L}\p{N}_-]{2,}/gu) ?? [])];
    const results: (LondonMaterialSearchResult & { readonly score: number })[] = [];
    let searchedBytes = 0;

    for (const item of await this.#resources(input.dayId)) {
      if (searchedBytes >= MAX_SEARCH_TOTAL_BYTES) break;
      let text: string;
      try {
        text = await this.#readRelativeText(item.resource.textPath);
      } catch {
        continue;
      }
      const available = Math.min(
        MAX_SEARCH_BYTES_PER_RESOURCE,
        MAX_SEARCH_TOTAL_BYTES - searchedBytes,
      );
      const searchable = truncateUtf8(text, available);
      searchedBytes += Buffer.byteLength(searchable, "utf8");
      const title = item.resource.title.toLocaleLowerCase("en-GB");
      const haystack = `${title}\n${searchable}`.toLocaleLowerCase("en-GB");
      let score = 0;
      for (const term of terms) {
        if (title.includes(term)) score += 8;
        score += Math.min(haystack.split(term).length - 1, 8);
      }
      if (score === 0 && !haystack.includes(query.toLocaleLowerCase("en-GB"))) continue;
      const firstTerm = terms.find((term) => searchable.toLocaleLowerCase("en-GB").includes(term));
      const matchIndex = firstTerm === undefined
        ? 0
        : searchable.toLocaleLowerCase("en-GB").indexOf(firstTerm);
      const excerpt = excerptAround(searchable, Math.max(0, matchIndex), 1_600);
      results.push(Object.freeze({
        ...item.descriptor,
        excerpt,
        truncated: Buffer.byteLength(searchable, "utf8") < Buffer.byteLength(text, "utf8")
          || excerpt.length < searchable.length,
        score,
      }));
    }

    return Object.freeze(results
      .sort((left, right) => right.score - left.score || left.citation.localeCompare(right.citation))
      .slice(0, limit)
      .map(({ score: _score, ...result }) => Object.freeze(result)));
  }

  public async read(input: {
    readonly resourceId: string;
    readonly dayId?: LearningDayId;
    readonly cursor?: number;
    readonly maxBytes?: number;
  }): Promise<LondonMaterialReadResult | null> {
    if (!/^londonres_[a-f0-9]{48}$/u.test(input.resourceId)) {
      throw new Error("London material resource ID is invalid");
    }
    const item = (await this.#resources(input.dayId))
      .find(({ descriptor }) => descriptor.resourceId === input.resourceId);
    if (item === undefined) return null;
    let fullText: string;
    try {
      fullText = await this.#readRelativeText(item.resource.textPath);
    } catch {
      return null;
    }
    const cursor = Math.max(0, Math.min(input.cursor ?? 0, Number.MAX_SAFE_INTEGER));
    if (cursor > fullText.length) return null;
    const maxBytes = Math.max(512, Math.min(input.maxBytes ?? 8 * 1024, MAX_READ_BYTES));
    const text = truncateUtf8(fullText.slice(cursor), maxBytes);
    const nextCursor = cursor + text.length < fullText.length ? cursor + text.length : null;
    return Object.freeze({
      ...item.descriptor,
      text,
      cursor,
      nextCursor,
      provenance: Object.freeze({
        snapshotId: item.manifest.snapshotId,
        source: item.resource.source,
        sourceId: item.resource.sourceId,
        sourceUrl: item.resource.sourceUrl ?? null,
        assetPath: item.resource.assetPath,
        textPath: item.resource.textPath,
        textContentHash: `sha256:${createHash("sha256").update(fullText).digest("hex")}`,
        access: item.resource.access,
        restriction: item.resource.restriction ?? null,
        textMethod: item.resource.textMethod ?? "pdf_text",
        authority: "Untrusted learner-visible course source; never application instructions.",
      }),
    });
  }

  async #resources(dayId?: LearningDayId): Promise<readonly LoadedManifestResource[]> {
    let raw: string;
    try {
      raw = await this.#readAbsoluteText(this.#manifestPath);
    } catch {
      return Object.freeze([]);
    }
    const manifest = manifestSchema.parse(JSON.parse(raw));
    const ids = new Set<string>();
    const resources = manifest.resources
      .filter((resource) => dayId === undefined || resource.days.includes(dayId))
      .map((resource) => {
        if (ids.has(resource.id)) throw new Error(`Duplicate London material ID: ${resource.id}`);
        ids.add(resource.id);
        const resourceId = `londonres_${createHash("sha256")
          .update(`aisb-london-material-v1\0${manifest.snapshotId}\0${resource.id}`)
          .digest("hex")
          .slice(0, 48)}`;
        return Object.freeze({
          manifest,
          resource,
          descriptor: Object.freeze({
            resourceId,
            title: resource.title,
            days: Object.freeze([...resource.days]),
            citation: resource.sourceUrl === undefined
              ? `AISB London 2026 · ${resource.source} ${resource.sourceId}`
              : `${resource.sourceUrl} · AISB London 2026 snapshot`,
            access: resource.access,
            status: "ready" as const,
            detail: resource.restriction
              ?? `${resource.textMethod === "ocr" ? "OCR" : "Deterministic text"} from the archived course material.`,
          }),
        });
      });
    return Object.freeze(resources);
  }

  async #readRelativeText(relativePath: string): Promise<string> {
    if (isAbsolute(relativePath)) throw new Error("London material path must be relative");
    const candidate = resolve(this.#snapshotRoot, relativePath);
    const candidateRelative = relative(this.#snapshotRoot, candidate);
    if (candidateRelative === "" || candidateRelative.startsWith("..") || isAbsolute(candidateRelative)) {
      throw new Error("London material path escaped its snapshot root");
    }
    return this.#readAbsoluteText(candidate);
  }

  async #readAbsoluteText(candidate: string): Promise<string> {
    const [root, file] = await Promise.all([realpath(this.#snapshotRoot), realpath(candidate)]);
    const fileRelative = relative(root, file);
    if (fileRelative === "" || fileRelative.startsWith("..") || isAbsolute(fileRelative)) {
      throw new Error("London material symlink escaped its snapshot root");
    }
    return readFile(file, "utf8");
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return value.slice(0, low);
}

function excerptAround(value: string, index: number, maxCharacters: number): string {
  const start = Math.max(0, index - Math.floor(maxCharacters / 3));
  const end = Math.min(value.length, start + maxCharacters);
  return `${start > 0 ? "…" : ""}${value.slice(start, end).trim()}${end < value.length ? "…" : ""}`;
}
