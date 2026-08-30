import { useRef, useState } from "react";
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
  type BackupEnvelope,
  type BackupExportRequest,
  type BackupManifest,
  type BrowserRecoverySnapshot,
} from "../../shared/backup.js";
import { readDraftRecoverySnapshotForBackup } from "../storage/drafts.js";
import { UtilityBackLink } from "./UtilityBackLink.js";
import "../styles/backup.css";

const HASH = /^sha256:[a-f0-9]{64}$/u;
const BACKUP_LOCAL_STORAGE_KEYS = [
  "aisb-companion:layout:v1",
  "aisb-companion:manager-composer:v1",
] as const;
const BACKUP_LOCAL_STORAGE_PREFIXES = [
  "aisb-companion:tutor-composer:",
  "aisb-companion:tutor-pending:",
  "aisb-companion:review-session:",
  "aisb-companion:review-response:",
] as const;
const MAX_BASE64_FILE_LENGTH = 4 * Math.ceil(BACKUP_MAX_FILE_BYTES / 3);

function isSafeBackupPath(path: string): boolean {
  if ((!path.startsWith("browser/") && !path.startsWith("state/")) || path.includes("\\")) return false;
  const components = path.split("/");
  return components.every((component) => component !== "" && component !== "." && component !== "..");
}

const categorySchema = z.enum(BACKUP_CATEGORIES);
const manifestEntrySchema = z.object({
  path: z.string().min(1).max(2_048).refine(isSafeBackupPath),
  category: categorySchema,
  mediaType: z.string().min(1).max(128),
  byteLength: z.number().int().nonnegative().max(BACKUP_MAX_FILE_BYTES),
  sha256: z.string().regex(HASH),
}).strict();
const manifestSchema = z.object({
  schemaVersion: z.literal(BACKUP_SCHEMA_VERSION),
  format: z.literal(BACKUP_FORMAT),
  exportedAt: z.iso.datetime({ offset: true }),
  contentSha256: z.string().regex(HASH),
  totalBytes: z.number().int().nonnegative().max(BACKUP_MAX_TOTAL_BYTES),
  entryCount: z.number().int().nonnegative().max(BACKUP_MAX_ENTRIES),
  entries: z.array(manifestEntrySchema).max(BACKUP_MAX_ENTRIES),
  includedCategories: z.array(categorySchema).max(BACKUP_CATEGORIES.length),
  exclusions: z.tuple([
    z.literal("AISB repository and Git objects"),
    z.literal("Codex homes, authentication, and caches"),
    z.literal("credentials and process environment"),
    z.literal("temporary and lock files"),
  ]),
  restore: z.object({
    mode: z.literal("manual-fresh-state-only"),
    automaticRestoreAvailable: z.literal(false),
    guidance: z.string().min(1).max(1_000),
  }).strict(),
}).strict();
const envelopeSchema = z.object({
  schemaVersion: z.literal(BACKUP_SCHEMA_VERSION),
  format: z.literal(BACKUP_FORMAT),
  manifest: manifestSchema,
  manifestSha256: z.string().regex(HASH),
  files: z.array(z.object({
    path: z.string().min(1).max(2_048).refine(isSafeBackupPath),
    encoding: z.literal("base64"),
    content: z.string().max(MAX_BASE64_FILE_LENGTH),
  }).strict()).max(BACKUP_MAX_ENTRIES),
}).strict();

export interface BackupPageProps {
  readonly fetchImpl?: typeof fetch;
  readonly collectBrowserRecovery?: () => Promise<BrowserRecoverySnapshot>;
  readonly download?: (envelope: Readonly<BackupEnvelope>) => void;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isKnownLocalStorageKey(key: string): boolean {
  return BACKUP_LOCAL_STORAGE_KEYS.some((candidate) => candidate === key)
    || BACKUP_LOCAL_STORAGE_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** Read-only collection of browser recovery data; no backup starts on page load. */
export async function collectBrowserRecoverySnapshot(): Promise<BrowserRecoverySnapshot> {
  const localEntries: { key: string; value: string }[] = [];
  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key === null) continue;
      if (key.startsWith("aisb-companion:") && !isKnownLocalStorageKey(key)) {
        throw new Error(`Unrecognised companion browser state (${key}); update backup support before exporting.`);
      }
      if (!isKnownLocalStorageKey(key)) continue;
      const value = window.localStorage.getItem(key);
      if (value !== null) localEntries.push({ key, value });
    }
  } catch (reason) {
    throw reason instanceof Error
      ? reason
      : new Error("Browser recovery storage could not be read safely.");
  }

  const draftRecovery = await readDraftRecoverySnapshotForBackup();
  const snapshot: BrowserRecoverySnapshot = {
    schemaVersion: 1,
    localStorage: localEntries.sort((left, right) => compareText(left.key, right.key)),
    noteDrafts: draftRecovery.noteDrafts,
    noteWriterStates: draftRecovery.noteWriterStates,
  };
  if (utf8Length(canonicalJson(snapshot)) > BACKUP_MAX_BROWSER_STATE_BYTES) {
    throw new Error("Browser recovery state is larger than the verified backup limit.");
  }
  return snapshot;
}

function strictBase64(value: string): Uint8Array {
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new Error("The local backup service returned non-canonical file bytes.");
  }
  const binary = window.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function browserSha256(value: string | Uint8Array): Promise<string> {
  if (window.crypto.subtle === undefined) {
    throw new Error("This browser cannot verify backup hashes, so no download was created.");
  }
  const source = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const copy = new Uint8Array(source.byteLength);
  copy.set(source);
  const digest = await window.crypto.subtle.digest("SHA-256", copy.buffer);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function parseBackupEnvelope(value: unknown): BackupEnvelope {
  const parsed = envelopeSchema.safeParse(value);
  if (!parsed.success) throw new Error("The local backup service returned a malformed export.");
  if (
    parsed.data.manifest.entryCount !== parsed.data.manifest.entries.length
    || parsed.data.files.length !== parsed.data.manifest.entries.length
  ) {
    throw new Error("The local backup service returned an incomplete export.");
  }
  if (
    parsed.data.manifest.includedCategories.length !== BACKUP_CATEGORIES.length
    || parsed.data.manifest.includedCategories.some(
      (category, index) => category !== BACKUP_CATEGORIES[index],
    )
  ) {
    throw new Error("The local backup service did not cover every recovery category.");
  }
  return parsed.data as BackupEnvelope;
}

/** Browser-side verification prevents a truncated or mismatched response from downloading. */
export async function verifyBackupEnvelopeForDownload(
  envelope: Readonly<BackupEnvelope>,
): Promise<void> {
  let totalBytes = 0;
  let previousPath = "";
  for (let index = 0; index < envelope.manifest.entries.length; index += 1) {
    const entry = envelope.manifest.entries[index];
    const payload = envelope.files[index];
    if (
      entry === undefined
      || payload === undefined
      || payload.path !== entry.path
      || (index > 0 && compareText(previousPath, entry.path) >= 0)
    ) {
      throw new Error("The local backup service returned an unordered or mismatched manifest.");
    }
    previousPath = entry.path;
    const bytes = strictBase64(payload.content);
    if (bytes.byteLength !== entry.byteLength || await browserSha256(bytes) !== entry.sha256) {
      throw new Error(`Backup verification failed for ${entry.path}. No download was created.`);
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > BACKUP_MAX_TOTAL_BYTES) {
      throw new Error("The backup payload exceeds the verified download limit.");
    }
  }
  if (
    totalBytes !== envelope.manifest.totalBytes
    || await browserSha256(backupContentDigestInput(envelope.manifest.entries))
      !== envelope.manifest.contentSha256
    || await browserSha256(canonicalJson(envelope.manifest)) !== envelope.manifestSha256
  ) {
    throw new Error("The backup manifest failed verification. No download was created.");
  }
}

export function downloadBackupEnvelope(envelope: Readonly<BackupEnvelope>): void {
  const content = `${JSON.stringify(envelope, null, 2)}\n`;
  const blob = new Blob([content], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const date = envelope.manifest.exportedAt.slice(0, 10);
  const digest = envelope.manifest.contentSha256.slice("sha256:".length, "sha256:".length + 12);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `aisb-companion-backup-${date}-${digest}.json`;
  anchor.hidden = true;
  document.body.append(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

async function responseError(response: Response): Promise<Error> {
  try {
    const value: unknown = await response.json();
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const message = (value as Record<string, unknown>).error;
      if (typeof message === "string" && message.length > 0) return new Error(message);
    }
  } catch {
    // Use the fixed local fallback below.
  }
  return new Error("The local backup could not be created safely.");
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes.toLocaleString()} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

export function BackupPage({
  fetchImpl = fetch,
  collectBrowserRecovery = collectBrowserRecoverySnapshot,
  download = downloadBackupEnvelope,
}: BackupPageProps) {
  const activeExport = useRef(false);
  const [working, setWorking] = useState(false);
  const [verifiedManifest, setVerifiedManifest] = useState<BackupManifest | null>(null);
  const [error, setError] = useState<string | null>(null);

  const createBackup = async () => {
    if (activeExport.current) return;
    activeExport.current = true;
    setWorking(true);
    setError(null);
    try {
      const browserRecovery = await collectBrowserRecovery();
      const request: BackupExportRequest = { browserRecovery };
      const response = await fetchImpl("/api/backup/export", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });
      if (!response.ok) throw await responseError(response);
      const envelope = parseBackupEnvelope(await response.json());
      await verifyBackupEnvelopeForDownload(envelope);
      download(envelope);
      setVerifiedManifest(envelope.manifest);
    } catch (reason) {
      setVerifiedManifest(null);
      setError(reason instanceof Error ? reason.message : "The local backup could not be created safely.");
    } finally {
      activeExport.current = false;
      setWorking(false);
    }
  };

  return (
    <main className="backup-page">
      <header className="backup-header">
        <div>
          <p className="backup-eyebrow">Local recovery</p>
          <h1>Back up the learning record</h1>
          <p>
            Download notes, schedule, progress, chats, reviews, prepared references, and saved
            visuals as one locally verified file.
          </p>
        </div>
        <UtilityBackLink />
      </header>

      <section className="backup-action" aria-labelledby="backup-action-heading">
        <div>
          <h2 id="backup-action-heading">Create a verified export</h2>
          <p>
            The snapshot is capped at 128 MB. If anything changes mid-read, exceeds a bound, or
            looks unsafe, the export stops without downloading a partial file.
          </p>
        </div>
        <button type="button" disabled={working} onClick={() => void createBackup()}>
          {working ? "Verifying local state…" : verifiedManifest ? "Export a fresh backup" : "Download verified backup"}
        </button>
      </section>

      <div className="backup-boundary" aria-label="Backup boundaries">
        <span>State-root allowlist</span>
        <span>SHA-256 per file</span>
        <span>No AISB repository</span>
        <span>No Codex auth or cache</span>
      </div>

      {error ? <p className="backup-error" role="alert">{error}</p> : null}

      {verifiedManifest ? (
        <section className="backup-ledger" aria-labelledby="backup-ledger-heading" role="status">
          <div className="backup-ledger-heading">
            <div>
              <p className="backup-eyebrow">Verified before download</p>
              <h2 id="backup-ledger-heading">Manifest ready</h2>
            </div>
            <span>SHA-256 verified</span>
          </div>
          <dl className="backup-totals">
            <div><dt>Files</dt><dd>{verifiedManifest.entryCount.toLocaleString()}</dd></div>
            <div><dt>Source bytes</dt><dd>{formatBytes(verifiedManifest.totalBytes)}</dd></div>
            <div><dt>Content digest</dt><dd><code>{verifiedManifest.contentSha256.slice(7, 23)}…</code></dd></div>
          </dl>
          <div className="backup-scope">
            <section aria-labelledby="backup-included-heading">
              <h3 id="backup-included-heading">Included</h3>
              <p>
                Browser draft recovery, Markdown notes, edited schedule, outcome progress,
                curriculum links, continuity summaries, tutor and manager history, review sessions,
                prepared source bytes, and visual metadata with image bytes.
              </p>
            </section>
            <section aria-labelledby="backup-excluded-heading">
              <h3 id="backup-excluded-heading">Always excluded</h3>
              <p>{verifiedManifest.exclusions.join("; ")}.</p>
            </section>
          </div>
          <p className="backup-private-note">
            This file contains private notes and conversations. Store it accordingly.
          </p>
        </section>
      ) : null}

      <section className="backup-restore" aria-labelledby="backup-restore-heading">
        <p className="backup-eyebrow">Recovery boundary</p>
        <h2 id="backup-restore-heading">Restore only into fresh state</h2>
        <p>
          Automatic restore and ambiguous merging are intentionally unavailable in v1. Keep the
          JSON intact; recovery is a manual, manifest-verified operation performed while the
          companion is stopped and only into a new empty state root. Saved transcripts and recovery
          records are preserved, but Codex authentication and its isolated home are deliberately
          excluded. On another environment, the companion may therefore start replacement native
          threads without the prior threads&apos; hidden model context.
        </p>
      </section>
    </main>
  );
}
