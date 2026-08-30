import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import * as nodeFsPromises from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { z } from "zod";

export const CONTINUITY_SUMMARY_MAX_TEXT_BYTES = 8 * 1024;
export const CONTINUITY_SELECTION_MAX_SUMMARIES = 3;
export const CONTINUITY_SELECTION_MAX_TEXT_BYTES = 16 * 1024;

const MAX_FILE_BYTES = 64 * 1024;
const DAY_IDS = ["day0", "day1", "day2", "day3", "day4", "day5", "day6", "day7"] as const;
const DAY_ID_PATTERN = /^day([0-7])$/;
const SUMMARY_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,78}[A-Za-z0-9])?$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,298}[A-Za-z0-9])?$/;
const SCOPE_KEY_PATTERN = /^[a-z][a-z0-9_-]{0,31}:[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const MARKDOWN_PREFIX = "<!-- aisb-continuity-summary:v1\n";
const MARKDOWN_SEPARATOR = "\n-->\n\n# Approved continuity summary\n\n";
const credentialLikePattern = /^(?:sk|sess|ghp|gho|github_pat|AIza)[-_]/i;

const dayIdSchema = z.enum(DAY_IDS);
const summaryIdSchema = z.string().min(1).max(80).regex(SUMMARY_ID_PATTERN);
const canonicalIdentifierSchema = z
  .string()
  .min(1)
  .max(300)
  .regex(IDENTIFIER_PATTERN)
  .refine((value) => !value.includes(".."), "path-like identifiers are forbidden")
  .refine((value) => !credentialLikePattern.test(value), "credential-like identifiers are forbidden");
const scopeKeySchema = z
  .string()
  .min(3)
  .max(272)
  .regex(SCOPE_KEY_PATTERN)
  .refine((value) => !value.includes(".."), "path-like scope keys are forbidden");
const identifierListSchema = z
  .array(canonicalIdentifierSchema)
  .max(64)
  .refine((values) => new Set(values).size === values.length, "identifiers must be unique");

const summaryTextSchema = z
  .string()
  .min(1)
  .max(CONTINUITY_SUMMARY_MAX_TEXT_BYTES)
  .refine((value) => value.trim().length > 0, "summary text must not be blank")
  .refine((value) => !value.includes("\u0000"), "summary text must not contain NUL bytes")
  .refine(
    (value) => Buffer.byteLength(value, "utf8") <= CONTINUITY_SUMMARY_MAX_TEXT_BYTES,
    `summary text must be at most ${CONTINUITY_SUMMARY_MAX_TEXT_BYTES} UTF-8 bytes`,
  );

const saveRequestSchema = z
  .object({
    summaryId: summaryIdSchema.optional(),
    sourceDayId: dayIdSchema,
    sourceScopeKey: scopeKeySchema,
    sourceChatId: canonicalIdentifierSchema,
    sourceTurnId: canonicalIdentifierSchema,
    sectionIds: identifierListSchema,
    outcomeVersionIds: identifierListSchema,
    text: summaryTextSchema,
  })
  .strict();

const storedMetadataSchema = z
  .object({
    schema_version: z.literal(1),
    status: z.literal("approved"),
    authored_by: z.literal("learner"),
    summary_id: summaryIdSchema,
    source_day_id: dayIdSchema,
    source_scope_key: scopeKeySchema,
    source_chat_id: canonicalIdentifierSchema,
    source_turn_id: canonicalIdentifierSchema,
    section_ids: identifierListSchema,
    outcome_version_ids: identifierListSchema,
    approved_at: z.iso.datetime({ offset: true }),
    content_sha256: z.string().regex(HASH_PATTERN),
  })
  .strict();

type StoredMetadata = z.infer<typeof storedMetadataSchema>;

export interface SaveContinuitySummaryRequest {
  /** Omit to have the store create a safe opaque identifier. */
  readonly summaryId?: string;
  readonly sourceDayId: string;
  readonly sourceScopeKey: string;
  readonly sourceChatId: string;
  readonly sourceTurnId: string;
  readonly sectionIds: readonly string[];
  readonly outcomeVersionIds: readonly string[];
  /** Explicit learner-authored summary text. No transcript, note, or model-ingestion input exists. */
  readonly text: string;
}

export interface ApprovedContinuitySummary {
  readonly schemaVersion: 1;
  readonly status: "approved";
  readonly authoredBy: "learner";
  readonly summaryId: string;
  readonly sourceDayId: string;
  readonly sourceScopeKey: string;
  readonly sourceChatId: string;
  readonly sourceTurnId: string;
  readonly sectionIds: readonly string[];
  readonly outcomeVersionIds: readonly string[];
  readonly approvedAt: string;
  readonly contentHash: string;
  readonly text: string;
}

export interface ContinuitySummarySelection {
  readonly targetDayId: string;
  readonly summaries: readonly ApprovedContinuitySummary[];
  readonly totalTextBytes: number;
}

export type ContinuityStoreAtomicStep =
  | "temporary_file_synced"
  | "before_publish"
  | "published"
  | "directory_synced";

export interface ContinuityStoreDependencies {
  readonly now?: () => Date;
  readonly create_id?: () => string;
  /** Deterministic crash-injection seam; production callers should omit it. */
  readonly on_atomic_step?: (
    step: ContinuityStoreAtomicStep,
    details: Readonly<{ target: string; mode: "create" | "replace" }>,
  ) => void | Promise<void>;
}

export type ContinuityStoreErrorCode = "invalid_request" | "unsafe_path" | "corrupt_store";

export class ContinuityStoreError extends Error {
  constructor(
    readonly code: ContinuityStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ContinuityStoreError";
  }
}

interface StoreRoots {
  readonly stateRoot: string;
  readonly continuityRoot: string;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

function isWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function dayNumber(dayId: string): number {
  const match = DAY_ID_PATTERN.exec(dayId);
  if (match === null) throw new ContinuityStoreError("invalid_request", "The continuity day ID is invalid");
  return Number.parseInt(match[1] ?? "", 10);
}

function freezeSummary(metadata: StoredMetadata, text: string): ApprovedContinuitySummary {
  return Object.freeze({
    schemaVersion: 1 as const,
    status: "approved" as const,
    authoredBy: "learner" as const,
    summaryId: metadata.summary_id,
    sourceDayId: metadata.source_day_id,
    sourceScopeKey: metadata.source_scope_key,
    sourceChatId: metadata.source_chat_id,
    sourceTurnId: metadata.source_turn_id,
    sectionIds: Object.freeze([...metadata.section_ids]),
    outcomeVersionIds: Object.freeze([...metadata.outcome_version_ids]),
    approvedAt: metadata.approved_at,
    contentHash: metadata.content_sha256,
    text,
  });
}

function serializeSummary(metadata: StoredMetadata, text: string): string {
  return `${MARKDOWN_PREFIX}${JSON.stringify(metadata, null, 2)}${MARKDOWN_SEPARATOR}${text}`;
}

function chronologicalOrder(left: ApprovedContinuitySummary, right: ApprovedContinuitySummary): number {
  const dayOrder = dayNumber(left.sourceDayId) - dayNumber(right.sourceDayId);
  if (dayOrder !== 0) return dayOrder;
  const timeOrder = left.approvedAt.localeCompare(right.approvedAt);
  return timeOrder === 0 ? left.summaryId.localeCompare(right.summaryId) : timeOrder;
}

function newestFirst(left: ApprovedContinuitySummary, right: ApprovedContinuitySummary): number {
  return -chronologicalOrder(left, right);
}

/**
 * Selects bounded, approved continuity from days before `targetDayId`. Ranking
 * is newest curriculum day first; the selected records are returned in stable
 * chronological order so they can be placed directly into a context block.
 */
export function selectContinuitySummariesForDay(
  summaries: readonly ApprovedContinuitySummary[],
  targetDayId: string | unknown,
): ContinuitySummarySelection {
  const parsedTarget = dayIdSchema.safeParse(targetDayId);
  if (!parsedTarget.success) {
    throw new ContinuityStoreError("invalid_request", "The target continuity day ID is invalid");
  }
  const targetNumber = dayNumber(parsedTarget.data);
  const candidates = summaries
    .filter(
      (summary) =>
        summary.schemaVersion === 1 &&
        summary.status === "approved" &&
        summary.authoredBy === "learner" &&
        dayIdSchema.safeParse(summary.sourceDayId).success &&
        dayNumber(summary.sourceDayId) < targetNumber,
    )
    .sort(newestFirst);

  const selected: ApprovedContinuitySummary[] = [];
  let totalTextBytes = 0;
  for (const summary of candidates) {
    if (selected.length >= CONTINUITY_SELECTION_MAX_SUMMARIES) break;
    const textBytes = Buffer.byteLength(summary.text, "utf8");
    if (textBytes > CONTINUITY_SELECTION_MAX_TEXT_BYTES - totalTextBytes) continue;
    selected.push(summary);
    totalTextBytes += textBytes;
  }
  selected.sort(chronologicalOrder);
  return Object.freeze({
    targetDayId: parsedTarget.data,
    summaries: Object.freeze(selected),
    totalTextBytes,
  });
}

/**
 * Durable, learner-approved continuity summaries. Each record is an ordinary
 * Markdown file; the strict front matter intentionally has no place for raw
 * Codex envelopes, transcripts, notes, tool output, reasoning, or credentials.
 */
export class ContinuitySummaryStore {
  readonly #configuredStateRoot: string;
  readonly #now: () => Date;
  readonly #createId: () => string;
  readonly #onAtomicStep: ContinuityStoreDependencies["on_atomic_step"];
  #rootsPromise: Promise<StoreRoots> | undefined;
  #operationTail: Promise<void> = Promise.resolve();

  constructor(stateRoot: string, dependencies: ContinuityStoreDependencies = {}) {
    if (!isAbsolute(stateRoot)) {
      throw new ContinuityStoreError("invalid_request", "The continuity state root must be absolute");
    }
    this.#configuredStateRoot = resolve(stateRoot);
    this.#now = dependencies.now ?? (() => new Date());
    this.#createId = dependencies.create_id ?? randomUUID;
    this.#onAtomicStep = dependencies.on_atomic_step;
  }

  async save(input: SaveContinuitySummaryRequest | unknown): Promise<ApprovedContinuitySummary> {
    const parsed = saveRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new ContinuityStoreError(
        "invalid_request",
        "The approved continuity summary contains invalid or non-summary fields",
      );
    }
    return this.#serializeOperation(async () => {
      const summaryId = parsed.data.summaryId ?? this.#safeGeneratedSummaryId();
      const approvedAt = this.#approvedTimestamp();
      const text = parsed.data.text;
      const metadata = storedMetadataSchema.parse({
        schema_version: 1,
        status: "approved",
        authored_by: "learner",
        summary_id: summaryId,
        source_day_id: parsed.data.sourceDayId,
        source_scope_key: parsed.data.sourceScopeKey,
        source_chat_id: parsed.data.sourceChatId,
        source_turn_id: parsed.data.sourceTurnId,
        section_ids: [...parsed.data.sectionIds].sort((left, right) => left.localeCompare(right)),
        outcome_version_ids: [...parsed.data.outcomeVersionIds].sort((left, right) => left.localeCompare(right)),
        approved_at: approvedAt,
        content_sha256: sha256(text),
      });
      const roots = await this.#roots();
      const dayRoot = await this.#dayRoot(roots, metadata.source_day_id, true);
      if (dayRoot === null) throw new ContinuityStoreError("unsafe_path", "The continuity day directory is absent");
      const target = resolve(dayRoot, `${metadata.summary_id}.md`);
      if (!isWithin(dayRoot, target)) {
        throw new ContinuityStoreError("unsafe_path", "The continuity summary path escapes its day directory");
      }

      const existing = await this.#readFileIfPresent(target);
      if (existing !== undefined) this.#parseSummary(existing, metadata.source_day_id, metadata.summary_id);
      await this.#atomicWrite(target, serializeSummary(metadata, text), existing === undefined ? "create" : "replace", roots, dayRoot);
      return freezeSummary(metadata, text);
    });
  }

  async read(sourceDayId: string | unknown, summaryId: string | unknown): Promise<ApprovedContinuitySummary | null> {
    const day = dayIdSchema.safeParse(sourceDayId);
    const id = summaryIdSchema.safeParse(summaryId);
    if (!day.success || !id.success) {
      throw new ContinuityStoreError("invalid_request", "The continuity summary locator is invalid");
    }
    return this.#serializeOperation(async () => {
      const roots = await this.#roots();
      const dayRoot = await this.#dayRoot(roots, day.data, false);
      if (dayRoot === null) return null;
      const target = resolve(dayRoot, `${id.data}.md`);
      const raw = await this.#readFileIfPresent(target);
      return raw === undefined ? null : this.#parseSummary(raw, day.data, id.data);
    });
  }

  /** Lists every approved summary, or only the requested source day. */
  async list(sourceDayId?: string | unknown): Promise<readonly ApprovedContinuitySummary[]> {
    const parsedDay = sourceDayId === undefined ? undefined : dayIdSchema.safeParse(sourceDayId);
    if (parsedDay !== undefined && !parsedDay.success) {
      throw new ContinuityStoreError("invalid_request", "The continuity source day ID is invalid");
    }
    return this.#serializeOperation(async () => {
      const roots = await this.#roots();
      const days = parsedDay === undefined ? DAY_IDS : [parsedDay.data];
      const summaries: ApprovedContinuitySummary[] = [];
      for (const day of days) summaries.push(...(await this.#listDay(roots, day)));
      summaries.sort(chronologicalOrder);
      return Object.freeze(summaries);
    });
  }

  async selectForDay(targetDayId: string | unknown): Promise<ContinuitySummarySelection> {
    const parsedTarget = dayIdSchema.safeParse(targetDayId);
    if (!parsedTarget.success) {
      throw new ContinuityStoreError("invalid_request", "The target continuity day ID is invalid");
    }
    return this.#serializeOperation(async () => {
      const roots = await this.#roots();
      const summaries: ApprovedContinuitySummary[] = [];
      for (const day of DAY_IDS) {
        if (dayNumber(day) >= dayNumber(parsedTarget.data)) break;
        summaries.push(...(await this.#listDay(roots, day)));
      }
      return selectContinuitySummariesForDay(summaries, parsedTarget.data);
    });
  }

  #parseSummary(raw: string, expectedDayId: string, expectedSummaryId: string): ApprovedContinuitySummary {
    if (Buffer.byteLength(raw, "utf8") > MAX_FILE_BYTES || !raw.startsWith(MARKDOWN_PREFIX)) {
      throw new ContinuityStoreError("corrupt_store", "The continuity summary Markdown is invalid");
    }
    const separatorIndex = raw.indexOf(MARKDOWN_SEPARATOR, MARKDOWN_PREFIX.length);
    if (separatorIndex < 0) {
      throw new ContinuityStoreError("corrupt_store", "The continuity summary metadata is incomplete");
    }
    try {
      const metadataRaw = raw.slice(MARKDOWN_PREFIX.length, separatorIndex);
      const metadata = storedMetadataSchema.parse(JSON.parse(metadataRaw) as unknown);
      const text = raw.slice(separatorIndex + MARKDOWN_SEPARATOR.length);
      if (metadata.source_day_id !== expectedDayId || metadata.summary_id !== expectedSummaryId) {
        throw new ContinuityStoreError("corrupt_store", "The continuity summary metadata does not match its path");
      }
      if (!summaryTextSchema.safeParse(text).success || sha256(text) !== metadata.content_sha256) {
        throw new ContinuityStoreError("corrupt_store", "The continuity summary content hash does not match");
      }
      return freezeSummary(metadata, text);
    } catch (error) {
      if (error instanceof ContinuityStoreError) throw error;
      throw new ContinuityStoreError("corrupt_store", "The continuity summary metadata is invalid");
    }
  }

  async #listDay(roots: StoreRoots, dayId: (typeof DAY_IDS)[number]): Promise<ApprovedContinuitySummary[]> {
    const dayRoot = await this.#dayRoot(roots, dayId, false);
    if (dayRoot === null) return [];
    const entries = (await nodeFsPromises.readdir(dayRoot, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    const summaries: ApprovedContinuitySummary[] = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        throw new ContinuityStoreError("unsafe_path", "A continuity summary directory entry is a symbolic link");
      }
      if (!entry.name.endsWith(".md")) continue;
      if (!entry.isFile()) {
        throw new ContinuityStoreError("unsafe_path", "A continuity Markdown entry is not a regular file");
      }
      const summaryId = entry.name.slice(0, -3);
      if (!summaryIdSchema.safeParse(summaryId).success) {
        throw new ContinuityStoreError("corrupt_store", "A continuity summary filename is invalid");
      }
      const target = resolve(dayRoot, entry.name);
      const raw = await this.#readFileIfPresent(target);
      if (raw === undefined) throw new ContinuityStoreError("corrupt_store", "A continuity summary disappeared while reading");
      summaries.push(this.#parseSummary(raw, dayId, summaryId));
    }
    summaries.sort(chronologicalOrder);
    return summaries;
  }

  #safeGeneratedSummaryId(): string {
    const id = this.#createId();
    if (!summaryIdSchema.safeParse(id).success) {
      throw new ContinuityStoreError("invalid_request", "The generated continuity summary ID is unsafe");
    }
    return id;
  }

  #approvedTimestamp(): string {
    const value = this.#now();
    if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
      throw new ContinuityStoreError("invalid_request", "The continuity-store clock returned an invalid date");
    }
    const timestamp = value.toISOString();
    if (!z.iso.datetime({ offset: true }).safeParse(timestamp).success) {
      throw new ContinuityStoreError("invalid_request", "The continuity approval time is invalid");
    }
    return timestamp;
  }

  async #roots(): Promise<StoreRoots> {
    this.#rootsPromise ??= (async () => {
      await nodeFsPromises.mkdir(this.#configuredStateRoot, { recursive: true, mode: 0o700 });
      const configuredStats = await nodeFsPromises.lstat(this.#configuredStateRoot);
      if (configuredStats.isSymbolicLink() || !configuredStats.isDirectory()) {
        throw new ContinuityStoreError("unsafe_path", "The continuity state root is unsafe");
      }
      const stateRoot = await nodeFsPromises.realpath(this.#configuredStateRoot);
      const continuityRoot = await this.#ensureDirectory(stateRoot, "continuity", stateRoot);
      return Object.freeze({ stateRoot, continuityRoot });
    })();
    const roots = await this.#rootsPromise;
    await this.#assertSafeDirectory(roots.continuityRoot, roots.stateRoot);
    return roots;
  }

  async #dayRoot(
    roots: StoreRoots,
    dayId: (typeof DAY_IDS)[number],
    create: boolean,
  ): Promise<string | null> {
    const target = resolve(roots.continuityRoot, dayId);
    if (!isWithin(roots.continuityRoot, target)) {
      throw new ContinuityStoreError("unsafe_path", "The continuity day path escapes its root");
    }
    if (create) return this.#ensureDirectory(roots.continuityRoot, dayId, roots.continuityRoot);
    try {
      await this.#assertSafeDirectory(target, roots.continuityRoot);
      return target;
    } catch (error) {
      if (isErrno(error, "ENOENT")) return null;
      throw error;
    }
  }

  async #ensureDirectory(parent: string, component: string, boundary: string): Promise<string> {
    const target = resolve(parent, component);
    if (!isWithin(boundary, target)) {
      throw new ContinuityStoreError("unsafe_path", "A continuity directory escapes its state boundary");
    }
    let created = false;
    try {
      await nodeFsPromises.mkdir(target, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
    }
    await this.#assertSafeDirectory(target, boundary);
    if (created) await this.#syncDirectory(parent);
    return target;
  }

  async #assertSafeDirectory(path: string, boundary: string): Promise<void> {
    if (!isWithin(boundary, path)) {
      throw new ContinuityStoreError("unsafe_path", "A continuity directory escapes its state boundary");
    }
    const stats = await nodeFsPromises.lstat(path);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new ContinuityStoreError("unsafe_path", "A continuity directory is unsafe");
    }
    const canonical = await nodeFsPromises.realpath(path);
    if (canonical !== path || !isWithin(boundary, canonical)) {
      throw new ContinuityStoreError("unsafe_path", "A continuity directory resolves outside its boundary");
    }
  }

  async #readFileIfPresent(path: string): Promise<string | undefined> {
    let stats: Stats;
    try {
      stats = await nodeFsPromises.lstat(path);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return undefined;
      throw error;
    }
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new ContinuityStoreError("unsafe_path", "A continuity summary path is not a regular file");
    }
    const canonical = await nodeFsPromises.realpath(path);
    if (canonical !== path) {
      throw new ContinuityStoreError("unsafe_path", "A continuity summary resolves through a link");
    }
    const handle = await nodeFsPromises.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const openedStats = await handle.stat();
      if (!openedStats.isFile() || openedStats.size > MAX_FILE_BYTES) {
        throw new ContinuityStoreError("corrupt_store", "The continuity summary file is invalid");
      }
      return (await handle.readFile()).toString("utf8");
    } finally {
      await handle.close();
    }
  }

  async #atomicWrite(
    target: string,
    value: string,
    mode: "create" | "replace",
    roots: StoreRoots,
    dayRoot: string,
  ): Promise<void> {
    if (!isWithin(dayRoot, target) || !isWithin(roots.continuityRoot, target)) {
      throw new ContinuityStoreError("unsafe_path", "The continuity write escapes its day directory");
    }
    await this.#assertSafeDirectory(dayRoot, roots.continuityRoot);
    await this.#assertSafeTargetOrAbsent(target);
    const temporaryId = this.#createId();
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(temporaryId)) {
      throw new ContinuityStoreError("invalid_request", "The temporary continuity-file identifier is unsafe");
    }
    const temporary = resolve(dayRoot, `.continuity-${temporaryId}.tmp`);
    if (!isWithin(dayRoot, temporary)) {
      throw new ContinuityStoreError("unsafe_path", "The temporary continuity path is unsafe");
    }
    let temporaryExists = false;
    try {
      const handle = await nodeFsPromises.open(
        temporary,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
        0o600,
      );
      temporaryExists = true;
      try {
        await handle.writeFile(value);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.#step("temporary_file_synced", target, mode, roots);
      await this.#assertSafeDirectory(dayRoot, roots.continuityRoot);
      await this.#assertSafeTargetOrAbsent(target);
      await this.#step("before_publish", target, mode, roots);
      await nodeFsPromises.rename(temporary, target);
      temporaryExists = false;
      await this.#step("published", target, mode, roots);
      await this.#syncDirectory(dayRoot);
      await this.#step("directory_synced", target, mode, roots);
    } finally {
      if (temporaryExists) {
        try {
          await nodeFsPromises.unlink(temporary);
        } catch (error) {
          if (!isErrno(error, "ENOENT")) throw error;
        }
      }
    }
  }

  async #assertSafeTargetOrAbsent(target: string): Promise<void> {
    try {
      const stats = await nodeFsPromises.lstat(target);
      if (stats.isSymbolicLink() || !stats.isFile()) {
        throw new ContinuityStoreError("unsafe_path", "The continuity target is unsafe");
      }
    } catch (error) {
      if (isErrno(error, "ENOENT")) return;
      throw error;
    }
  }

  async #syncDirectory(path: string): Promise<void> {
    const handle = await nodeFsPromises.open(path, fsConstants.O_RDONLY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async #step(
    step: ContinuityStoreAtomicStep,
    target: string,
    mode: "create" | "replace",
    roots: StoreRoots,
  ): Promise<void> {
    await this.#onAtomicStep?.(
      step,
      Object.freeze({ target: relative(roots.stateRoot, target).split(sep).join("/"), mode }),
    );
  }

  #serializeOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operationTail.then(operation, operation);
    this.#operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
