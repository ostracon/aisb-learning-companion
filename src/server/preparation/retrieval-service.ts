import type {
  DayPreparedReferenceSource,
  PreparedReferenceInventoryItem,
  PreparedReferenceProjection,
} from "../manager/prepared-context-source.js";

const MAX_INVENTORY_ITEMS = 256;
const MAX_SEARCH_RESULTS = 12;
const MAX_SEARCH_BYTES_PER_PROJECTION = 16 * 1024 * 1024;
const MAX_SEARCH_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_READ_BYTES = 16 * 1024;
const DEFAULT_READ_BYTES = 8 * 1024;

export interface PreparedReferenceSearchResult {
  readonly sourceId: string;
  readonly title: string;
  readonly citation: string;
  readonly status: "ready" | "unavailable";
  readonly mediaType: "html" | "pdf" | null;
  readonly pageCount: number | null;
  readonly excerpt: string | null;
  readonly cursor: number | null;
  readonly detail: string;
}

export interface PreparedReferenceReadResult {
  readonly sourceId: string;
  readonly title: string;
  readonly citation: string;
  readonly text: string;
  readonly cursor: number;
  readonly nextCursor: number | null;
  readonly provenance: Readonly<Record<string, unknown>>;
}

/**
 * Searches and reads only verified projections whose manifest origins overlap
 * the fresh section scope supplied by TutorService. Paths and URLs are never
 * accepted from a model tool call.
 */
export class PreparedReferenceRetrievalService {
  public constructor(private readonly source: DayPreparedReferenceSource) {}

  public async search(input: {
    readonly sectionIds: readonly string[];
    readonly query: string;
    readonly limit?: number;
  }): Promise<readonly PreparedReferenceSearchResult[]> {
    const query = input.query.replace(/\s+/gu, " ").trim();
    if (query.length < 2 || query.length > 500) {
      throw new Error("Prepared reference search query is invalid");
    }
    const limit = Math.max(1, Math.min(input.limit ?? 8, MAX_SEARCH_RESULTS));
    const inventory = (await this.source.listForSections(input.sectionIds))
      .slice(0, MAX_INVENTORY_ITEMS);
    const normalizedQuery = query.toLocaleLowerCase("en-GB");
    const terms = [...new Set(
      normalizedQuery.match(/[\p{L}\p{N}_-]{2,}/gu) ?? [],
    )];
    const results: Array<PreparedReferenceSearchResult & { readonly score: number }> = [];
    let searchedBytes = 0;

    for (const item of inventory) {
      const title = item.title.toLocaleLowerCase("en-GB");
      let projection: PreparedReferenceProjection | null = null;
      let searchable = "";
      if (item.projectionStatus === "complete" && searchedBytes < MAX_SEARCH_TOTAL_BYTES) {
        projection = await this.source.readProjectionForSections(item.sourceId, input.sectionIds);
        if (projection !== null) {
          const available = Math.min(
            MAX_SEARCH_BYTES_PER_PROJECTION,
            MAX_SEARCH_TOTAL_BYTES - searchedBytes,
          );
          searchable = truncateUtf8(projection.markdown, available);
          searchedBytes += Buffer.byteLength(searchable, "utf8");
        }
      }

      const normalizedText = searchable.toLocaleLowerCase("en-GB");
      const haystack = `${title}\n${normalizedText}`;
      let score = title.includes(normalizedQuery) ? 32 : 0;
      for (const term of terms) {
        if (title.includes(term)) score += 8;
        score += Math.min(haystack.split(term).length - 1, 8);
      }
      if (score === 0 && !haystack.includes(normalizedQuery)) continue;

      const matchIndex = normalizedText.indexOf(normalizedQuery);
      const fallbackIndex = bestMatchIndex(normalizedText, terms);
      const excerpt = searchable.length === 0
        ? null
        : excerptAround(searchable, matchIndex >= 0 ? matchIndex : fallbackIndex, 1_600);
      results.push(Object.freeze({
        ...searchResult(item, projection, excerpt),
        score,
      }));
    }

    return Object.freeze(results
      .sort((left, right) => right.score - left.score || left.citation.localeCompare(right.citation))
      .slice(0, limit)
      .map(({ score: _score, ...result }) => Object.freeze(result)));
  }

  public async read(input: {
    readonly sectionIds: readonly string[];
    readonly sourceId: string;
    readonly cursor?: number;
    readonly maxBytes?: number;
  }): Promise<PreparedReferenceReadResult | null> {
    if (!/^source_[a-f0-9]{64}$/u.test(input.sourceId)) {
      throw new Error("Prepared reference ID is invalid");
    }
    const cursor = Math.max(0, Math.min(input.cursor ?? 0, Number.MAX_SAFE_INTEGER));
    const maxBytes = Math.max(
      512,
      Math.min(input.maxBytes ?? DEFAULT_READ_BYTES, MAX_READ_BYTES),
    );
    const projection = await this.source.readProjectionForSections(
      input.sourceId,
      input.sectionIds,
    );
    if (projection === null || cursor > projection.markdown.length) return null;
    const text = truncateUtf8(projection.markdown.slice(cursor), maxBytes);
    const nextCursor = cursor + text.length < projection.markdown.length
      ? cursor + text.length
      : null;
    return Object.freeze({
      sourceId: projection.sourceId,
      title: projection.title,
      citation: citationForProjection(projection),
      text,
      cursor,
      nextCursor,
      provenance: Object.freeze({
        requestedUrl: projection.requestedUrl,
        finalUrl: projection.finalUrl,
        mediaType: projection.mediaType,
        pageCount: projection.pageCount,
        sourceContentHash: projection.sourceContentHash,
        projectionContentHash: projection.projectionContentHash,
        sectionIds: projection.sectionIds,
      }),
    });
  }
}

function searchResult(
  item: PreparedReferenceInventoryItem,
  projection: PreparedReferenceProjection | null,
  excerpt: Readonly<{ readonly text: string; readonly cursor: number }> | null,
): PreparedReferenceSearchResult {
  const ready = projection !== null;
  return Object.freeze({
    sourceId: item.sourceId,
    title: item.title,
    citation: ready
      ? citationForProjection(projection)
      : `${item.finalUrl ?? item.requestedUrl} · ${item.sourceContentHash ?? "not cached"}`,
    status: ready ? "ready" : "unavailable",
    mediaType: item.mediaType,
    pageCount: item.pageCount,
    excerpt: excerpt?.text ?? null,
    cursor: excerpt?.cursor ?? null,
    detail: item.detail,
  });
}

function citationForProjection(projection: PreparedReferenceProjection): string {
  return [
    projection.finalUrl,
    projection.sourceContentHash,
    projection.pageCount === null ? null : `${projection.pageCount} pages`,
    projection.projectionContentHash,
  ].filter((value): value is string => value !== null).join(" · ");
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

function excerptAround(
  value: string,
  index: number,
  maxCharacters: number,
): Readonly<{ readonly text: string; readonly cursor: number }> {
  if (value.length <= maxCharacters) return Object.freeze({ text: value, cursor: 0 });
  const start = Math.max(0, index - Math.floor(maxCharacters * 0.35));
  const end = Math.min(value.length, start + maxCharacters);
  return Object.freeze({
    text: `${start > 0 ? "…" : ""}${value.slice(start, end).trim()}${end < value.length ? "…" : ""}`,
    cursor: start,
  });
}

function bestMatchIndex(value: string, terms: readonly string[]): number {
  const candidates: number[] = [];
  for (const term of [...terms]
    .sort((left, right) => right.length - left.length || left.localeCompare(right))) {
    let fromIndex = 0;
    for (let count = 0; count < 24; count += 1) {
      const index = value.indexOf(term, fromIndex);
      if (index < 0) break;
      candidates.push(index);
      fromIndex = index + Math.max(1, term.length);
    }
  }
  let bestIndex = 0;
  let bestScore = -1;
  for (const index of candidates) {
    const start = Math.max(0, index - 560);
    const window = value.slice(start, Math.min(value.length, start + 1_600));
    const coverage = terms.filter((term) => window.includes(term)).length;
    const occurrences = terms.reduce(
      (total, term) => total + Math.min(window.split(term).length - 1, 4),
      0,
    );
    const score = coverage * 100 + occurrences;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }
  return bestIndex;
}
