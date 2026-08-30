import { createHash } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import {
  lstat,
  open,
  readdir,
  realpath,
} from "node:fs/promises";
import {
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

import { z } from "zod";

import {
  BACKUP_CATEGORIES,
  BACKUP_FORMAT,
  BACKUP_MAX_BROWSER_STATE_BYTES,
  BACKUP_MAX_ENTRIES,
  BACKUP_MAX_FILE_BYTES,
  BACKUP_MAX_TOTAL_BYTES,
  BACKUP_SCHEMA_VERSION,
  backupContentDigestInput,
  canonicalJson,
  type BackupCategory,
  type BackupEnvelope,
  type BackupExportRequest,
  type BackupFilePayload,
  type BackupManifest,
  type BackupManifestEntry,
  type BrowserRecoverySnapshot,
} from "../../shared/backup.js";

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const NOTE_ID_PATTERN = /^[A-Za-z0-9._-]{1,180}$/u;
const BASE_HASH_PATTERN = /^(?:|[a-f0-9]{64})$/u;
const MAX_LOCAL_STORAGE_ENTRIES = 512;
const MAX_LOCAL_STORAGE_VALUE_BYTES = 2 * 1024 * 1024;
const MAX_NOTE_DRAFTS = 2_000;
const MAX_DRAFT_BYTES = 2 * 1024 * 1024;
const MAX_WRITER_STATES = 4_000;

const allowedLocalStorageKey = (key: string): boolean =>
  key === "aisb-companion:layout:v1"
  || key === "aisb-companion:manager-composer:v1"
  || key.startsWith("aisb-companion:tutor-composer:")
  || key.startsWith("aisb-companion:review-session:")
  || key.startsWith("aisb-companion:review-response:");

const localStorageEntrySchema = z.object({
  key: z.string().min(1).max(2_048).refine(allowedLocalStorageKey, "Unsupported browser storage key"),
  value: z.string().refine(
    (value) => Buffer.byteLength(value, "utf8") <= MAX_LOCAL_STORAGE_VALUE_BYTES,
    "Browser storage value is too large",
  ),
}).strict();

const noteDraftSchema = z.object({
  noteId: z.string().regex(NOTE_ID_PATTERN),
  content: z.string().refine(
    (value) => Buffer.byteLength(value, "utf8") <= MAX_DRAFT_BYTES,
    "Note recovery draft is too large",
  ),
  baseRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  baseContentHash: z.string().regex(BASE_HASH_PATTERN),
  updatedAt: z.iso.datetime({ offset: true }),
  writerEpoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  editSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();

const noteWriterStateSchema = z.object({
  noteId: z.string().regex(NOTE_ID_PATTERN),
  writerEpoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();

const browserRecoverySchema = z.object({
  schemaVersion: z.literal(1),
  localStorage: z.array(localStorageEntrySchema).max(MAX_LOCAL_STORAGE_ENTRIES),
  noteDrafts: z.array(noteDraftSchema).max(MAX_NOTE_DRAFTS),
  noteWriterStates: z.array(noteWriterStateSchema).max(MAX_WRITER_STATES),
}).strict();

const requestSchema = z.object({ browserRecovery: browserRecoverySchema }).strict();

interface ExportPolicy {
  readonly logicalRoot: string;
  readonly category: BackupCategory;
  readonly extensions: ReadonlySet<string>;
}

const EXPORT_POLICIES: readonly ExportPolicy[] = Object.freeze([
  { logicalRoot: "notes", category: "notes", extensions: new Set([".md", ".jsonl"]) },
  { logicalRoot: "schedule", category: "schedule", extensions: new Set([".json"]) },
  { logicalRoot: "progress", category: "progress", extensions: new Set([".json"]) },
  { logicalRoot: "curriculum", category: "curriculum-bindings", extensions: new Set([".json"]) },
  { logicalRoot: "continuity", category: "continuity", extensions: new Set([".md"]) },
  { logicalRoot: "tutor/sessions", category: "tutor-and-manager", extensions: new Set([".jsonl"]) },
  { logicalRoot: "tutor/thread-bindings", category: "tutor-and-manager", extensions: new Set([".json"]) },
  { logicalRoot: "review/sessions", category: "review", extensions: new Set([".json"]) },
  {
    logicalRoot: "preparation",
    category: "preparation",
    extensions: new Set([".json", ".html", ".pdf", ".md"]),
  },
  { logicalRoot: "media/visuals", category: "visuals", extensions: new Set([".json", ".png"]) },
]);

interface Fingerprint {
  readonly dev: number;
  readonly ino: number;
  readonly nlink: number;
  readonly size: number;
  readonly mtimeMs: number;
}

interface CandidateFile {
  readonly absolutePath: string;
  readonly logicalPath: string;
  readonly category: BackupCategory;
  readonly fingerprint: Fingerprint;
}

interface ExportedBytes {
  readonly path: string;
  readonly category: BackupCategory;
  readonly bytes: Buffer;
}

export type BackupExportErrorCode =
  | "invalid_request"
  | "state_unavailable"
  | "unsafe_path"
  | "unsupported_file"
  | "size_limit"
  | "state_changed"
  | "credential_detected"
  | "corrupt_export";

export class BackupExportError extends Error {
  public constructor(
    public readonly code: BackupExportErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BackupExportError";
  }
}

export interface BackupExportLimits {
  readonly maxTotalBytes: number;
  readonly maxFileBytes: number;
  readonly maxEntries: number;
  readonly maxBrowserStateBytes: number;
}

const DEFAULT_LIMITS: BackupExportLimits = Object.freeze({
  maxTotalBytes: BACKUP_MAX_TOTAL_BYTES,
  maxFileBytes: BACKUP_MAX_FILE_BYTES,
  maxEntries: BACKUP_MAX_ENTRIES,
  maxBrowserStateBytes: BACKUP_MAX_BROWSER_STATE_BYTES,
});

function byteLengthWithin(maximum: number) {
  return z.number().int().positive().max(maximum);
}

const limitsSchema = z.object({
  maxTotalBytes: byteLengthWithin(BACKUP_MAX_TOTAL_BYTES),
  maxFileBytes: byteLengthWithin(BACKUP_MAX_FILE_BYTES),
  maxEntries: z.number().int().positive().max(BACKUP_MAX_ENTRIES),
  maxBrowserStateBytes: byteLengthWithin(BACKUP_MAX_BROWSER_STATE_BYTES),
}).strict().refine(
  ({ maxFileBytes, maxTotalBytes }) => maxFileBytes <= maxTotalBytes,
  "A single-file limit cannot exceed the total backup limit",
);

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function logicalPath(value: string): string {
  return value.split(sep).join("/");
}

function fingerprint(stats: Stats): Fingerprint {
  return {
    dev: stats.dev,
    ino: stats.ino,
    nlink: stats.nlink,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
  };
}

function sameFingerprint(left: Fingerprint, right: Fingerprint): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs;
}

function sha256(bytes: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function isTemporaryName(name: string): boolean {
  const lower = name.toLowerCase();
  return name.startsWith(".")
    || lower.endsWith(".tmp")
    || lower.endsWith(".part")
    || lower.endsWith(".lock")
    || lower.endsWith(".swp")
    || lower.endsWith("~")
    || lower === "thumbs.db";
}

function mediaType(path: string): string {
  switch (extname(path)) {
    case ".md": return "text/markdown; charset=utf-8";
    case ".json": return "application/json";
    case ".jsonl": return "application/x-ndjson";
    case ".html": return "text/html; charset=utf-8";
    case ".pdf": return "application/pdf";
    case ".png": return "image/png";
    default: throw new BackupExportError("unsupported_file", `Unsupported backup media type at ${path}`);
  }
}

const CREDENTIAL_PATTERNS = [
  /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/u,
  /\bsess-[A-Za-z0-9_-]{20,}/u,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/u,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/u,
  /\bAIza[0-9A-Za-z_-]{30,}/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
] as const;

function containsCredential(bytes: Uint8Array): boolean {
  const text = Buffer.from(bytes).toString("latin1");
  return CREDENTIAL_PATTERNS.some((pattern) => pattern.test(text));
}

function assertUniqueSorted<T>(
  values: readonly T[],
  key: (value: T) => string,
  label: string,
  code: "invalid_request" | "corrupt_export" = "invalid_request",
): void {
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1];
    const current = values[index];
    if (previous === undefined || current === undefined) continue;
    if (compareText(key(previous), key(current)) >= 0) {
      throw new BackupExportError(code, `${label} must be unique and sorted`);
    }
  }
}

function normalizeBrowserRecovery(input: unknown, limit: number): BrowserRecoverySnapshot {
  const parsed = browserRecoverySchema.safeParse(input);
  if (!parsed.success) {
    throw new BackupExportError("invalid_request", "Browser recovery state is malformed", {
      cause: parsed.error,
    });
  }
  const normalized: BrowserRecoverySnapshot = {
    schemaVersion: 1,
    localStorage: [...parsed.data.localStorage].sort((left, right) => compareText(left.key, right.key)),
    noteDrafts: [...parsed.data.noteDrafts].sort((left, right) => compareText(left.noteId, right.noteId)),
    noteWriterStates: [...parsed.data.noteWriterStates].sort((left, right) => compareText(left.noteId, right.noteId)),
  };
  assertUniqueSorted(normalized.localStorage, ({ key }) => key, "Browser storage keys");
  assertUniqueSorted(normalized.noteDrafts, ({ noteId }) => noteId, "Note recovery draft IDs");
  assertUniqueSorted(normalized.noteWriterStates, ({ noteId }) => noteId, "Note writer-state IDs");
  const serializedBytes = Buffer.byteLength(canonicalJson(normalized), "utf8");
  if (serializedBytes > limit) {
    throw new BackupExportError("size_limit", "Browser recovery state exceeds the backup limit");
  }
  return normalized;
}

function browserEntries(snapshot: BrowserRecoverySnapshot): readonly ExportedBytes[] {
  const records = [
    {
      path: "browser/local-storage.json",
      value: { schemaVersion: 1, entries: snapshot.localStorage },
    },
    {
      path: "browser/note-drafts.json",
      value: { schemaVersion: 1, drafts: snapshot.noteDrafts },
    },
    {
      path: "browser/note-writer-state.json",
      value: { schemaVersion: 1, writers: snapshot.noteWriterStates },
    },
  ] as const;
  return records.map(({ path, value }) => ({
    path,
    category: "browser-recovery" as const,
    bytes: Buffer.from(`${canonicalJson(value)}\n`, "utf8"),
  }));
}

function strictBase64Decode(value: string): Buffer {
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new BackupExportError("corrupt_export", "A backup payload is not canonical base64");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new BackupExportError("corrupt_export", "A backup payload is not canonical base64");
  }
  return decoded;
}

/** Recomputes every hash and aggregate before an envelope is offered for download. */
export function verifyBackupEnvelope(envelope: Readonly<BackupEnvelope>): void {
  if (
    envelope.schemaVersion !== BACKUP_SCHEMA_VERSION
    || envelope.format !== BACKUP_FORMAT
    || envelope.manifest.schemaVersion !== BACKUP_SCHEMA_VERSION
    || envelope.manifest.format !== BACKUP_FORMAT
  ) {
    throw new BackupExportError("corrupt_export", "The backup envelope version is unsupported");
  }
  if (envelope.files.length !== envelope.manifest.entries.length) {
    throw new BackupExportError("corrupt_export", "The backup manifest and payload counts differ");
  }
  assertUniqueSorted(envelope.manifest.entries, ({ path }) => path, "Manifest paths", "corrupt_export");
  assertUniqueSorted(envelope.files, ({ path }) => path, "Payload paths", "corrupt_export");

  let totalBytes = 0;
  for (let index = 0; index < envelope.manifest.entries.length; index += 1) {
    const entry = envelope.manifest.entries[index];
    const payload = envelope.files[index];
    if (entry === undefined || payload === undefined || entry.path !== payload.path || payload.encoding !== "base64") {
      throw new BackupExportError("corrupt_export", "The backup payload order does not match its manifest");
    }
    const bytes = strictBase64Decode(payload.content);
    if (bytes.byteLength !== entry.byteLength || sha256(bytes) !== entry.sha256) {
      throw new BackupExportError("corrupt_export", `Backup payload verification failed at ${entry.path}`);
    }
    totalBytes += bytes.byteLength;
  }
  if (
    totalBytes !== envelope.manifest.totalBytes
    || envelope.manifest.entryCount !== envelope.manifest.entries.length
    || sha256(backupContentDigestInput(envelope.manifest.entries)) !== envelope.manifest.contentSha256
    || sha256(canonicalJson(envelope.manifest)) !== envelope.manifestSha256
  ) {
    throw new BackupExportError("corrupt_export", "The backup aggregate manifest failed verification");
  }
}

/**
 * Read-only, allowlisted export of companion-owned recovery state. It never
 * traverses the AISB repository or the isolated Codex home.
 */
export class BackupExportService {
  readonly #configuredStateRoot: string;
  readonly #limits: BackupExportLimits;

  public constructor(
    stateRoot: string,
    limits: Partial<BackupExportLimits> = {},
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!isAbsolute(stateRoot)) {
      throw new BackupExportError("state_unavailable", "The backup state root must be absolute");
    }
    this.#configuredStateRoot = resolve(stateRoot);
    const parsed = limitsSchema.safeParse({ ...DEFAULT_LIMITS, ...limits });
    if (!parsed.success) {
      throw new BackupExportError("invalid_request", "Backup limits are invalid", { cause: parsed.error });
    }
    this.#limits = parsed.data;
  }

  public async export(input: BackupExportRequest | unknown): Promise<BackupEnvelope> {
    const parsed = requestSchema.safeParse(input);
    if (!parsed.success) {
      throw new BackupExportError("invalid_request", "Backup request is malformed", { cause: parsed.error });
    }
    const browserRecovery = normalizeBrowserRecovery(
      parsed.data.browserRecovery,
      this.#limits.maxBrowserStateBytes,
    );
    const stateRoot = await this.#canonicalStateRoot();
    const initial = await this.#collectCandidates(stateRoot);
    this.#assertHardlinksContained(initial);

    const exported: ExportedBytes[] = [...browserEntries(browserRecovery)];
    for (const entry of exported) {
      if (containsCredential(entry.bytes)) {
        throw new BackupExportError(
          "credential_detected",
          `A credential-like value was detected in ${entry.path}; no backup was created`,
        );
      }
    }
    let totalBytes = exported.reduce((total, entry) => total + entry.bytes.byteLength, 0);
    if (exported.length > this.#limits.maxEntries || totalBytes > this.#limits.maxTotalBytes) {
      throw new BackupExportError("size_limit", "Browser recovery state exceeds the backup limits");
    }

    for (const candidate of initial) {
      if (candidate.fingerprint.size > this.#limits.maxFileBytes) {
        throw new BackupExportError("size_limit", `Backup file exceeds the per-file limit: ${candidate.logicalPath}`);
      }
      if (exported.length >= this.#limits.maxEntries) {
        throw new BackupExportError("size_limit", "The backup contains too many files");
      }
      if (totalBytes + candidate.fingerprint.size > this.#limits.maxTotalBytes) {
        throw new BackupExportError("size_limit", "The backup exceeds its total byte limit");
      }
      const bytes = await this.#readStableCandidate(candidate);
      exported.push({ path: candidate.logicalPath, category: candidate.category, bytes });
      totalBytes += bytes.byteLength;
    }

    const final = await this.#collectCandidates(stateRoot);
    this.#assertUnchanged(initial, final);
    exported.sort((left, right) => compareText(left.path, right.path));

    const entries: BackupManifestEntry[] = exported.map((entry) => ({
      path: entry.path,
      category: entry.category,
      mediaType: mediaType(entry.path),
      byteLength: entry.bytes.byteLength,
      sha256: sha256(entry.bytes),
    }));
    const timestamp = this.now();
    if (!Number.isFinite(timestamp.getTime())) {
      throw new BackupExportError("state_unavailable", "The backup clock is invalid");
    }
    const exportedAt = timestamp.toISOString();
    const manifest: BackupManifest = {
      schemaVersion: BACKUP_SCHEMA_VERSION,
      format: BACKUP_FORMAT,
      exportedAt,
      contentSha256: sha256(backupContentDigestInput(entries)),
      totalBytes,
      entryCount: entries.length,
      entries,
      includedCategories: BACKUP_CATEGORIES,
      exclusions: [
        "AISB repository and Git objects",
        "Codex homes, authentication, and caches",
        "credentials and process environment",
        "temporary and lock files",
      ],
      restore: {
        mode: "manual-fresh-state-only",
        automaticRestoreAvailable: false,
        guidance: "Verify the manifest, stop the companion, and recover into a fresh empty state root. Do not merge this export into a live or populated state directory.",
      },
    };
    const files: BackupFilePayload[] = exported.map((entry) => ({
      path: entry.path,
      encoding: "base64",
      content: entry.bytes.toString("base64"),
    }));
    const envelope: BackupEnvelope = {
      schemaVersion: BACKUP_SCHEMA_VERSION,
      format: BACKUP_FORMAT,
      manifest,
      manifestSha256: sha256(canonicalJson(manifest)),
      files,
    };
    verifyBackupEnvelope(envelope);
    return envelope;
  }

  async #canonicalStateRoot(): Promise<string> {
    try {
      const stats = await lstat(this.#configuredStateRoot);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new BackupExportError("unsafe_path", "The backup state root is not a real directory");
      }
      const canonical = await realpath(this.#configuredStateRoot);
      return canonical;
    } catch (error) {
      if (error instanceof BackupExportError) throw error;
      throw new BackupExportError("state_unavailable", "The local companion state could not be read", {
        cause: error,
      });
    }
  }

  async #collectCandidates(stateRoot: string): Promise<readonly CandidateFile[]> {
    const candidates: CandidateFile[] = [];
    for (const policy of EXPORT_POLICIES) {
      const policyRoot = resolve(stateRoot, ...policy.logicalRoot.split("/"));
      if (!isWithin(stateRoot, policyRoot)) {
        throw new BackupExportError("unsafe_path", "A backup policy escapes the local state root");
      }
      let rootStats: Stats;
      try {
        rootStats = await lstat(policyRoot);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw new BackupExportError("state_unavailable", `Could not inspect ${policy.logicalRoot}`, { cause: error });
      }
      if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
        throw new BackupExportError("unsafe_path", `Backup root is not a real directory: ${policy.logicalRoot}`);
      }
      await this.#walk(policyRoot, policy, stateRoot, candidates);
    }
    candidates.sort((left, right) => compareText(left.logicalPath, right.logicalPath));
    assertUniqueSorted(candidates, ({ logicalPath: path }) => path, "State file paths");
    if (candidates.length + 3 > this.#limits.maxEntries) {
      throw new BackupExportError("size_limit", "The backup contains too many files");
    }
    return candidates;
  }

  async #walk(
    directory: string,
    policy: ExportPolicy,
    stateRoot: string,
    candidates: CandidateFile[],
  ): Promise<void> {
    const canonical = await realpath(directory);
    if (canonical !== directory || !isWithin(stateRoot, canonical)) {
      throw new BackupExportError("unsafe_path", `Backup directory resolves outside local state: ${logicalPath(relative(stateRoot, directory))}`);
    }
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      if (isTemporaryName(entry.name)) continue;
      const target = resolve(directory, entry.name);
      if (!isWithin(stateRoot, target)) {
        throw new BackupExportError("unsafe_path", "A backup entry escapes the local state root");
      }
      const stats = await lstat(target);
      const relativePath = logicalPath(relative(stateRoot, target));
      if (stats.isSymbolicLink()) {
        throw new BackupExportError("unsafe_path", `Symbolic links are not exportable: ${relativePath}`);
      }
      if (stats.isDirectory()) {
        await this.#walk(target, policy, stateRoot, candidates);
        continue;
      }
      if (!stats.isFile()) {
        throw new BackupExportError("unsafe_path", `Non-regular backup entry: ${relativePath}`);
      }
      if (!policy.extensions.has(extname(entry.name))) {
        throw new BackupExportError("unsupported_file", `Unexpected state file type: ${relativePath}`);
      }
      candidates.push({
        absolutePath: target,
        logicalPath: `state/${relativePath}`,
        category: policy.category,
        fingerprint: fingerprint(stats),
      });
    }
  }

  #assertHardlinksContained(candidates: readonly CandidateFile[]): void {
    const counts = new Map<string, number>();
    for (const candidate of candidates) {
      const key = `${candidate.fingerprint.dev}:${candidate.fingerprint.ino}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const candidate of candidates) {
      const key = `${candidate.fingerprint.dev}:${candidate.fingerprint.ino}`;
      if ((counts.get(key) ?? 0) !== candidate.fingerprint.nlink) {
        throw new BackupExportError(
          "unsafe_path",
          `A state file has a hard link outside the export boundary: ${candidate.logicalPath}`,
        );
      }
    }
  }

  async #readStableCandidate(candidate: CandidateFile): Promise<Buffer> {
    let handle;
    try {
      handle = await open(candidate.absolutePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const before = await handle.stat();
      if (!before.isFile() || !sameFingerprint(candidate.fingerprint, fingerprint(before))) {
        throw new BackupExportError("state_changed", `State changed during backup: ${candidate.logicalPath}`);
      }
      const bytes = await handle.readFile();
      const after = await handle.stat();
      if (!sameFingerprint(candidate.fingerprint, fingerprint(after)) || bytes.byteLength !== after.size) {
        throw new BackupExportError("state_changed", `State changed during backup: ${candidate.logicalPath}`);
      }
      if (containsCredential(bytes)) {
        throw new BackupExportError(
          "credential_detected",
          `A credential-like value was detected in ${candidate.logicalPath}; no backup was created`,
        );
      }
      return bytes;
    } catch (error) {
      if (error instanceof BackupExportError) throw error;
      throw new BackupExportError("state_changed", `Could not read a stable snapshot of ${candidate.logicalPath}`, {
        cause: error,
      });
    } finally {
      await handle?.close();
    }
  }

  #assertUnchanged(initial: readonly CandidateFile[], final: readonly CandidateFile[]): void {
    if (initial.length !== final.length) {
      throw new BackupExportError("state_changed", "Local state changed while the backup was being created");
    }
    for (let index = 0; index < initial.length; index += 1) {
      const before = initial[index];
      const after = final[index];
      if (
        before === undefined
        || after === undefined
        || before.logicalPath !== after.logicalPath
        || !sameFingerprint(before.fingerprint, after.fingerprint)
      ) {
        throw new BackupExportError("state_changed", "Local state changed while the backup was being created");
      }
    }
  }
}

export function isBackupManifestHash(value: string): boolean {
  return SHA256_PATTERN.test(value);
}
