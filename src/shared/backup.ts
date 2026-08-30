export const BACKUP_SCHEMA_VERSION = 1 as const;
export const BACKUP_FORMAT = "aisb-learning-companion-backup" as const;
export const BACKUP_MAX_TOTAL_BYTES = 128 * 1024 * 1024;
export const BACKUP_MAX_FILE_BYTES = 32 * 1024 * 1024;
// Stays below the server's existing 9 MiB request-body ceiling after the
// request wrapper is added.
export const BACKUP_MAX_BROWSER_STATE_BYTES = 8 * 1024 * 1024;
export const BACKUP_MAX_ENTRIES = 4_096;

export const BACKUP_CATEGORIES = [
  "browser-recovery",
  "notes",
  "schedule",
  "progress",
  "curriculum-bindings",
  "continuity",
  "tutor-and-manager",
  "review",
  "preparation",
  "visuals",
] as const;

export type BackupCategory = (typeof BACKUP_CATEGORIES)[number];

export interface BackupLocalStorageEntry {
  readonly key: string;
  readonly value: string;
}

export interface BackupNoteDraft {
  readonly noteId: string;
  readonly content: string;
  readonly baseRevision: number;
  readonly baseContentHash: string;
  readonly updatedAt: string;
  readonly writerEpoch: number;
  readonly editSequence: number;
}

export interface BackupNoteWriterState {
  readonly noteId: string;
  readonly writerEpoch: number;
}

export interface BrowserRecoverySnapshot {
  readonly schemaVersion: 1;
  readonly localStorage: readonly BackupLocalStorageEntry[];
  readonly noteDrafts: readonly BackupNoteDraft[];
  readonly noteWriterStates: readonly BackupNoteWriterState[];
}

export interface BackupExportRequest {
  readonly browserRecovery: BrowserRecoverySnapshot;
}

export interface BackupManifestEntry {
  readonly path: string;
  readonly category: BackupCategory;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface BackupManifest {
  readonly schemaVersion: 1;
  readonly format: typeof BACKUP_FORMAT;
  readonly exportedAt: string;
  readonly contentSha256: string;
  readonly totalBytes: number;
  readonly entryCount: number;
  readonly entries: readonly BackupManifestEntry[];
  readonly includedCategories: readonly BackupCategory[];
  readonly exclusions: readonly [
    "AISB repository and Git objects",
    "Codex homes, authentication, and caches",
    "credentials and process environment",
    "temporary and lock files",
  ];
  readonly restore: {
    readonly mode: "manual-fresh-state-only";
    readonly automaticRestoreAvailable: false;
    readonly guidance: string;
  };
}

export interface BackupFilePayload {
  readonly path: string;
  readonly encoding: "base64";
  readonly content: string;
}

export interface BackupEnvelope {
  readonly schemaVersion: 1;
  readonly format: typeof BACKUP_FORMAT;
  readonly manifest: BackupManifest;
  readonly manifestSha256: string;
  readonly files: readonly BackupFilePayload[];
}

/** Canonical JSON for hashes. Undefined, non-finite numbers, and sparse values fail closed. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Backup JSON contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => {
      if (item === undefined) throw new Error("Backup JSON contains an undefined array value");
      return canonicalJson(item);
    }).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => {
      const item = record[key];
      if (item === undefined) throw new Error("Backup JSON contains an undefined object value");
      return `${JSON.stringify(key)}:${canonicalJson(item)}`;
    }).join(",")}}`;
  }
  throw new Error("Backup JSON contains an unsupported value");
}

export function backupContentDigestInput(entries: readonly BackupManifestEntry[]): string {
  return entries
    .map((entry) => `${entry.path}\u0000${entry.byteLength}\u0000${entry.sha256}`)
    .join("\n");
}
