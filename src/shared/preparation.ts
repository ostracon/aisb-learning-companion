export const PREPARATION_SCHEMA_VERSION = 1 as const;

export type PreparationRunStatus = "complete" | "partial" | "failed";

export type PreparationSourceStatus =
  | "cached"
  | "not_fetched"
  | "unsupported"
  | "failed";

export type PreparationFailureCode =
  | "dns_unavailable"
  | "private_address"
  | "insecure_redirect"
  | "redirect_limit"
  | "redirect_loop"
  | "request_timeout"
  | "network_error"
  | "response_too_large"
  | "total_limit"
  | "unsupported_media_type"
  | "http_error"
  | "invalid_response";

export interface PreparationLimitsView {
  readonly maxInventorySources: number;
  /** Maximum number contacted in one explicit cache run. */
  readonly maxSources: number;
  readonly maxSourceBytes: number;
  readonly maxTotalBytes: number;
  readonly maxRedirects: number;
  readonly requestTimeoutMs: number;
}

export interface PreparationSourceOriginView {
  readonly sectionId: string;
  readonly manifestRevision: string;
  readonly documentId: string;
  readonly documentContentHash: string;
  readonly label: string;
}

export interface PreparationRedirectView {
  readonly from: string;
  readonly to: string;
  readonly status: 301 | 302 | 303 | 307 | 308;
}

export interface PreparationSourceView {
  readonly sourceId: string;
  readonly requestedUrl: string;
  readonly finalUrl: string | null;
  /** Distinct manifest/document/label origins found before record bounding. */
  readonly originCount: number;
  readonly originsTruncated: boolean;
  readonly origins: readonly PreparationSourceOriginView[];
  readonly status: PreparationSourceStatus;
  readonly mediaType: "html" | "pdf" | null;
  readonly fetchedAt: string | null;
  readonly byteLength: number | null;
  readonly contentHash: string | null;
  /** State-root-relative path. Never a browser-authored or absolute path. */
  readonly cachePath: string | null;
  /** Present when a verified inert text projection was published. */
  readonly markdownPath: string | null;
  /** Additive metadata; absent only on preparation records written before text indexing. */
  readonly textProjection?: {
    readonly status: "complete" | "failed";
    readonly extractor: "html-inert-v1" | "poppler-pdftotext";
    readonly pageCount: number | null;
    readonly byteLength: number | null;
    readonly contentHash: string | null;
    readonly detail: string;
  };
  readonly redirects: readonly PreparationRedirectView[];
  readonly failureCode: PreparationFailureCode | null;
  readonly detail: string;
}

export interface PreparationRunView {
  readonly schemaVersion: typeof PREPARATION_SCHEMA_VERSION;
  readonly runId: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly status: PreparationRunStatus;
  readonly inventoryTruncated: boolean;
  readonly discoveredCount: number;
  readonly cachedCount: number;
  readonly failedCount: number;
  /** Bytes occupied by inert Markdown projections; defaults to zero for legacy runs. */
  readonly generatedMarkdownBytes?: number;
  /** Raw source bytes plus generated Markdown bytes actually published by this run. */
  readonly totalCachedBytes: number;
  readonly limits: PreparationLimitsView;
  readonly sources: readonly PreparationSourceView[];
}

export interface PreparationStateResponse {
  readonly latestRun: PreparationRunView | null;
  readonly externalNetworkIsUserStartedOnly: true;
  readonly enrichment: "disabled";
  readonly transcription: "public-captions-only-not-enabled";
}

export interface StartPreparationRequest {
  readonly fetch: boolean;
}
