import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as nodeFsPromises from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { z } from "zod";

import type { CanonicalOutcomeRecord } from "../../shared/page-context.js";
import {
  REVIEW_QUESTION_MODES,
  type ReviewCoachFeedback,
  type ReviewCoachQuestion,
  type ReviewQuestionMode,
} from "../../shared/review.js";

// Worst-case UTF-8 expansion for the bounded canonical outcomes and recorded
// responses is below this ceiling; the limit guards corrupt/unbounded files
// without rejecting otherwise valid Unicode session content.
const MAX_SESSION_BYTES = 16 * 1024 * 1024;
const MAX_LISTED_SESSION_FILES = 10_000;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/u;

const SafeIdentifierSchema = z.string().min(1).max(256).regex(SAFE_IDENTIFIER_PATTERN);
const OutcomeSchema = z
  .object({
    outcomeId: SafeIdentifierSchema,
    outcomeVersionId: SafeIdentifierSchema,
    sectionId: SafeIdentifierSchema,
    category: z.enum(["engineering", "ml", "security", "theory"]),
    ordinal: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    text: z.string().min(1).max(64 * 1024),
    sourcePath: z.string().min(1).max(1_024),
    sourceCommit: SafeIdentifierSchema,
  })
  .strict();
const ProvenanceSchema = z
  .object({
    engine: z.enum(["codex-app-server", "local-template"]),
    transport: z.enum(["turn/start", "in-process"]),
    model: SafeIdentifierSchema.nullable(),
    permissionProfile: SafeIdentifierSchema.nullable(),
    threadId: SafeIdentifierSchema,
    turnId: SafeIdentifierSchema,
    disclosureId: SafeIdentifierSchema,
    payloadHash: z.string().regex(HASH_PATTERN),
    outputSchemaApplied: z.boolean(),
  })
  .strict();
const CitationSchema = z
  .object({
    outcomeId: SafeIdentifierSchema,
    outcomeVersionId: SafeIdentifierSchema,
    category: z.enum(["engineering", "ml", "security", "theory"]),
    label: z.string().min(1).max(256),
    sourcePath: z.string().min(1).max(1_024),
    sourceCommit: SafeIdentifierSchema,
  })
  .strict();
const QuestionSchema = z
  .object({
    questionId: SafeIdentifierSchema,
    number: z.number().int().min(1).max(20),
    total: z.number().int().min(1).max(20),
    mode: z.enum(REVIEW_QUESTION_MODES),
    prompt: z.string().min(1).max(4_000),
    outcomeIds: z.array(SafeIdentifierSchema).min(1).max(32),
    citations: z.array(CitationSchema).min(1).max(32),
    provenance: ProvenanceSchema,
  })
  .strict();
const FeedbackSchema = z
  .object({
    feedbackId: SafeIdentifierSchema,
    questionId: SafeIdentifierSchema,
    responseId: SafeIdentifierSchema,
    text: z.string().min(1).max(8_000),
    outcomeIds: z.array(SafeIdentifierSchema).min(1).max(32),
    citations: z.array(CitationSchema).min(1).max(32),
    assessmentAuthority: z.literal("advisory"),
    provenance: ProvenanceSchema,
  })
  .strict();
const RecordedResponseSchema = z
  .object({
    responseId: SafeIdentifierSchema,
    questionId: SafeIdentifierSchema,
    text: z.string().min(1).max(64 * 1024),
    learnerConfidence: z.union([
      z.literal(1),
      z.literal(2),
      z.literal(3),
      z.literal(4),
      z.literal(5),
    ]).nullable(),
    recordedAt: z.iso.datetime({ offset: true }),
  })
  .strict();
const PendingOperationSchema = z
  .object({
    operation: z.enum(["question", "feedback"]),
    disclosureId: SafeIdentifierSchema,
    payloadHash: z.string().regex(HASH_PATTERN),
    dispatchAttempted: z.boolean(),
  })
  .strict();

const ReviewSessionSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    sessionId: SafeIdentifierSchema,
    outcomes: z.array(OutcomeSchema).min(1).max(32),
    modes: z.array(z.enum(REVIEW_QUESTION_MODES)).min(1).max(REVIEW_QUESTION_MODES.length),
    questionLimit: z.number().int().min(1).max(20),
    responses: z.array(RecordedResponseSchema).max(20),
    threadId: SafeIdentifierSchema.nullable(),
    questionsAsked: z.number().int().nonnegative().max(20),
    currentQuestion: QuestionSchema.nullable(),
    lastFeedback: FeedbackSchema.nullable(),
    pendingResponseId: SafeIdentifierSchema.nullable(),
    pendingOperation: PendingOperationSchema.nullable(),
    complete: z.boolean(),
  })
  .strict();

export interface PersistedReviewResponse {
  readonly responseId: string;
  readonly questionId: string;
  readonly text: string;
  readonly learnerConfidence: 1 | 2 | 3 | 4 | 5 | null;
  readonly recordedAt: string;
}

export interface ReviewSessionSnapshot {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly sessionId: string;
  readonly outcomes: readonly CanonicalOutcomeRecord[];
  readonly modes: readonly ReviewQuestionMode[];
  readonly questionLimit: number;
  readonly responses: readonly PersistedReviewResponse[];
  readonly threadId: string | null;
  readonly questionsAsked: number;
  readonly currentQuestion: ReviewCoachQuestion | null;
  readonly lastFeedback: ReviewCoachFeedback | null;
  readonly pendingResponseId: string | null;
  readonly pendingOperation: {
    readonly operation: "question" | "feedback";
    readonly disclosureId: string;
    readonly payloadHash: string;
    readonly dispatchAttempted: boolean;
  } | null;
  readonly complete: boolean;
}

export interface ReviewSessionStorePort {
  create(snapshot: Readonly<ReviewSessionSnapshot>): Promise<ReviewSessionSnapshot>;
  save(snapshot: Readonly<ReviewSessionSnapshot>): Promise<ReviewSessionSnapshot>;
  read(sessionId: string): Promise<ReviewSessionSnapshot | null>;
}

export interface ReviewSessionSummaryOutcome {
  readonly outcomeId: string;
  readonly sectionId: string;
  readonly category: "engineering" | "ml" | "security" | "theory";
  readonly text: string;
  readonly truncated: boolean;
}

export interface ReviewSessionAdvisoryFeedbackSummary {
  readonly text: string;
  readonly outcomeIds: readonly string[];
  readonly assessmentAuthority: "advisory";
  readonly truncated: boolean;
}

export interface ReviewSessionSummary {
  readonly sessionId: string;
  readonly updatedAt: string | null;
  readonly outcomes: readonly ReviewSessionSummaryOutcome[];
  readonly questionsAsked: number;
  readonly questionLimit: number;
  readonly responsesRecorded: number;
  readonly complete: boolean;
  readonly recentFeedback: ReviewSessionAdvisoryFeedbackSummary | null;
}

export interface ReviewSessionSummaryListing {
  readonly sessions: readonly ReviewSessionSummary[];
  readonly truncated: boolean;
  readonly omittedSessionCount: number;
}

export interface ReviewSessionSummaryOptions {
  readonly maxSessions: number;
  readonly maxOutcomesPerSession: number;
  readonly maxOutcomeBytes: number;
  readonly maxFeedbackBytes: number;
  readonly maxTotalBytes: number;
}

export type ReviewSessionStoreErrorCode =
  | "invalid_request"
  | "conflict"
  | "corrupt_store"
  | "filesystem_error";

export class ReviewSessionStoreError extends Error {
  public constructor(
    public readonly code: ReviewSessionStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ReviewSessionStoreError";
  }
}

const summaryOptionsSchema = z.object({
  maxSessions: z.number().int().min(1).max(20),
  maxOutcomesPerSession: z.number().int().min(1).max(16),
  maxOutcomeBytes: z.number().int().min(128).max(4 * 1024),
  maxFeedbackBytes: z.number().int().min(128).max(8 * 1024),
  maxTotalBytes: z.number().int().min(512).max(128 * 1024),
}).strict();

function cloneSnapshot(value: unknown): ReviewSessionSnapshot {
  const parsed = ReviewSessionSnapshotSchema.safeParse(value);
  if (!parsed.success) {
    throw new ReviewSessionStoreError("corrupt_store", "The saved review session is malformed.");
  }
  return parsed.data as ReviewSessionSnapshot;
}

function validateSessionId(value: string): string {
  const parsed = SafeIdentifierSchema.safeParse(value);
  if (!parsed.success) {
    throw new ReviewSessionStoreError("invalid_request", "The review session ID is invalid.");
  }
  return parsed.data;
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { readonly code?: unknown }).code === code
  );
}

function isWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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

interface ReviewSummaryCandidate {
  readonly snapshot: ReviewSessionSnapshot;
  readonly updatedAt: string | null;
  readonly activitySequence: number;
}

function projectReviewSummaries(
  candidates: readonly ReviewSummaryCandidate[],
  input: ReviewSessionSummaryOptions,
): ReviewSessionSummaryListing {
  const parsed = summaryOptionsSchema.safeParse(input);
  if (!parsed.success) {
    throw new ReviewSessionStoreError("invalid_request", "Review summary limits are invalid.");
  }
  const selected = [...candidates]
    .sort((left, right) =>
      right.activitySequence - left.activitySequence
      || compareText(right.updatedAt ?? "", left.updatedAt ?? "")
      || compareText(left.snapshot.sessionId, right.snapshot.sessionId))
    .slice(0, parsed.data.maxSessions);
  const sessions: ReviewSessionSummary[] = [];
  let remainingBytes = parsed.data.maxTotalBytes;
  let truncated = selected.length < candidates.length;

  for (const candidate of selected) {
    const rawOutcomes = candidate.snapshot.outcomes.slice(0, parsed.data.maxOutcomesPerSession);
    if (rawOutcomes.length < candidate.snapshot.outcomes.length) truncated = true;
    const outcomes: ReviewSessionSummaryOutcome[] = [];
    for (const outcome of rawOutcomes) {
      if (remainingBytes <= 0) {
        truncated = true;
        break;
      }
      const limit = Math.min(parsed.data.maxOutcomeBytes, remainingBytes);
      const text = truncateUtf8(outcome.text, limit);
      const bytes = Buffer.byteLength(text, "utf8");
      if (bytes === 0) {
        truncated = true;
        continue;
      }
      const outcomeTruncated = bytes < Buffer.byteLength(outcome.text, "utf8");
      truncated ||= outcomeTruncated;
      remainingBytes -= bytes;
      outcomes.push(Object.freeze({
        outcomeId: outcome.outcomeId,
        sectionId: outcome.sectionId,
        category: outcome.category,
        text,
        truncated: outcomeTruncated,
      }));
    }

    let recentFeedback: ReviewSessionAdvisoryFeedbackSummary | null = null;
    if (candidate.snapshot.lastFeedback !== null && remainingBytes > 0) {
      const limit = Math.min(parsed.data.maxFeedbackBytes, remainingBytes);
      const text = truncateUtf8(candidate.snapshot.lastFeedback.text, limit);
      const bytes = Buffer.byteLength(text, "utf8");
      if (bytes > 0) {
        const feedbackTruncated = bytes < Buffer.byteLength(candidate.snapshot.lastFeedback.text, "utf8");
        truncated ||= feedbackTruncated;
        remainingBytes -= bytes;
        recentFeedback = Object.freeze({
          text,
          outcomeIds: Object.freeze([...candidate.snapshot.lastFeedback.outcomeIds]),
          assessmentAuthority: "advisory" as const,
          truncated: feedbackTruncated,
        });
      } else {
        truncated = true;
      }
    } else if (candidate.snapshot.lastFeedback !== null) {
      truncated = true;
    }

    sessions.push(Object.freeze({
      sessionId: candidate.snapshot.sessionId,
      updatedAt: candidate.updatedAt,
      outcomes: Object.freeze(outcomes),
      questionsAsked: candidate.snapshot.questionsAsked,
      questionLimit: candidate.snapshot.questionLimit,
      responsesRecorded: candidate.snapshot.responses.length,
      complete: candidate.snapshot.complete,
      recentFeedback,
    }));
  }

  return Object.freeze({
    sessions: Object.freeze(sessions),
    truncated,
    omittedSessionCount: Math.max(0, candidates.length - sessions.length),
  });
}

export class MemoryReviewSessionStore implements ReviewSessionStorePort {
  readonly #snapshots = new Map<string, ReviewSessionSnapshot>();
  readonly #activity = new Map<string, number>();
  #sequence = 0;

  public async create(snapshot: Readonly<ReviewSessionSnapshot>): Promise<ReviewSessionSnapshot> {
    if (snapshot.revision !== 0) {
      throw new ReviewSessionStoreError("invalid_request", "A new review session must start at revision zero.");
    }
    if (this.#snapshots.has(snapshot.sessionId)) {
      throw new ReviewSessionStoreError("conflict", "The review session already exists.");
    }
    const saved = cloneSnapshot({ ...snapshot, revision: 1 });
    this.#snapshots.set(saved.sessionId, saved);
    this.#activity.set(saved.sessionId, ++this.#sequence);
    return cloneSnapshot(saved);
  }

  public async save(snapshot: Readonly<ReviewSessionSnapshot>): Promise<ReviewSessionSnapshot> {
    const current = this.#snapshots.get(snapshot.sessionId);
    if (current === undefined || current.revision !== snapshot.revision) {
      throw new ReviewSessionStoreError("conflict", "The review session changed before it could be saved.");
    }
    const saved = cloneSnapshot({ ...snapshot, revision: snapshot.revision + 1 });
    this.#snapshots.set(saved.sessionId, saved);
    this.#activity.set(saved.sessionId, ++this.#sequence);
    return cloneSnapshot(saved);
  }

  public async read(sessionId: string): Promise<ReviewSessionSnapshot | null> {
    const current = this.#snapshots.get(validateSessionId(sessionId));
    return current === undefined ? null : cloneSnapshot(current);
  }

  public async listRecentSummaries(
    options: ReviewSessionSummaryOptions,
  ): Promise<ReviewSessionSummaryListing> {
    const candidates = [...this.#snapshots.values()].map((snapshot) => ({
      snapshot: cloneSnapshot(snapshot),
      updatedAt: snapshot.responses.at(-1)?.recordedAt ?? null,
      activitySequence: this.#activity.get(snapshot.sessionId) ?? 0,
    }));
    return projectReviewSummaries(candidates, options);
  }
}

/** Owner-only, one-file-per-session atomic persistence under companion state. */
export class FileReviewSessionStore implements ReviewSessionStorePort {
  readonly #sessionRoot: string;
  readonly #tails = new Map<string, Promise<void>>();

  public constructor(stateRoot: string) {
    this.#sessionRoot = resolve(stateRoot, "review", "sessions");
  }

  public create(snapshot: Readonly<ReviewSessionSnapshot>): Promise<ReviewSessionSnapshot> {
    return this.#withLock(snapshot.sessionId, async () => {
      if (snapshot.revision !== 0) {
        throw new ReviewSessionStoreError("invalid_request", "A new review session must start at revision zero.");
      }
      const saved = cloneSnapshot({ ...snapshot, revision: 1 });
      await this.#writeAtomic(saved, "create");
      return saved;
    });
  }

  public save(snapshot: Readonly<ReviewSessionSnapshot>): Promise<ReviewSessionSnapshot> {
    return this.#withLock(snapshot.sessionId, async () => {
      const current = await this.#read(snapshot.sessionId);
      if (current === null || current.revision !== snapshot.revision) {
        throw new ReviewSessionStoreError("conflict", "The review session changed before it could be saved.");
      }
      const saved = cloneSnapshot({ ...snapshot, revision: snapshot.revision + 1 });
      await this.#writeAtomic(saved, "replace");
      return saved;
    });
  }

  public read(sessionId: string): Promise<ReviewSessionSnapshot | null> {
    return this.#read(validateSessionId(sessionId));
  }

  public async listRecentSummaries(
    options: ReviewSessionSummaryOptions,
  ): Promise<ReviewSessionSummaryListing> {
    const parsed = summaryOptionsSchema.safeParse(options);
    if (!parsed.success) {
      throw new ReviewSessionStoreError("invalid_request", "Review summary limits are invalid.");
    }
    const root = await this.#canonicalRoot();
    let entries;
    try {
      entries = await nodeFsPromises.readdir(root, { withFileTypes: true });
    } catch (error) {
      throw new ReviewSessionStoreError("filesystem_error", "Review sessions could not be listed.", { cause: error });
    }
    if (entries.length > MAX_LISTED_SESSION_FILES) {
      throw new ReviewSessionStoreError("filesystem_error", "The review session directory is too large to list safely.");
    }
    const fileCandidates: {
      readonly sessionId: string;
      readonly updatedAt: string;
      readonly activitySequence: number;
    }[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name.endsWith(".tmp")) continue;
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".json")) {
        throw new ReviewSessionStoreError("corrupt_store", "The review session directory contains an unsafe entry.");
      }
      const sessionId = validateSessionId(entry.name.slice(0, -".json".length));
      const target = resolve(root, entry.name);
      if (!isWithin(root, target)) {
        throw new ReviewSessionStoreError("corrupt_store", "A review session path escapes its directory.");
      }
      const details = await nodeFsPromises.lstat(target);
      if (!details.isFile() || details.isSymbolicLink() || details.size > MAX_SESSION_BYTES) {
        throw new ReviewSessionStoreError("corrupt_store", "A saved review session has an unsafe size or type.");
      }
      fileCandidates.push({
        sessionId,
        updatedAt: details.mtime.toISOString(),
        activitySequence: Math.floor(details.mtimeMs),
      });
    }
    fileCandidates.sort((left, right) =>
      right.activitySequence - left.activitySequence || compareText(left.sessionId, right.sessionId));
    const selected = fileCandidates.slice(0, parsed.data.maxSessions);
    const candidates: ReviewSummaryCandidate[] = [];
    for (const candidate of selected) {
      const snapshot = await this.#read(candidate.sessionId);
      if (snapshot === null) {
        throw new ReviewSessionStoreError("corrupt_store", "A listed review session disappeared during reading.");
      }
      candidates.push({ snapshot, ...candidate });
    }
    const listing = projectReviewSummaries(candidates, parsed.data);
    return Object.freeze({
      ...listing,
      truncated: listing.truncated || selected.length < fileCandidates.length,
      omittedSessionCount: listing.omittedSessionCount + (fileCandidates.length - selected.length),
    });
  }

  async #read(sessionId: string): Promise<ReviewSessionSnapshot | null> {
    const target = await this.#target(sessionId);
    let handle: nodeFsPromises.FileHandle | undefined;
    try {
      const stat = await nodeFsPromises.lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new ReviewSessionStoreError("corrupt_store", "The saved review session is not a regular file.");
      }
      handle = await nodeFsPromises.open(
        target,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
      );
      const openedStat = await handle.stat();
      if (!openedStat.isFile() || openedStat.size > MAX_SESSION_BYTES) {
        throw new ReviewSessionStoreError("corrupt_store", "The saved review session has an unsafe size or type.");
      }
      const raw = await handle.readFile({ encoding: "utf8" });
      return cloneSnapshot(JSON.parse(raw) as unknown);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return null;
      if (error instanceof ReviewSessionStoreError) throw error;
      if (error instanceof SyntaxError) {
        throw new ReviewSessionStoreError("corrupt_store", "The saved review session is not valid JSON.", { cause: error });
      }
      throw new ReviewSessionStoreError("filesystem_error", "The saved review session could not be read.", { cause: error });
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async #target(sessionId: string): Promise<string> {
    validateSessionId(sessionId);
    const canonicalRoot = await this.#canonicalRoot();
    const target = resolve(canonicalRoot, `${sessionId}.json`);
    if (!isWithin(canonicalRoot, target)) {
      throw new ReviewSessionStoreError("invalid_request", "The review session path is unsafe.");
    }
    return target;
  }

  async #canonicalRoot(): Promise<string> {
    try {
      await nodeFsPromises.mkdir(this.#sessionRoot, { recursive: true, mode: 0o700 });
      const canonicalRoot = await nodeFsPromises.realpath(this.#sessionRoot);
      const details = await nodeFsPromises.lstat(canonicalRoot);
      if (!details.isDirectory() || details.isSymbolicLink()) {
        throw new ReviewSessionStoreError("filesystem_error", "The review session directory is unsafe.");
      }
      return canonicalRoot;
    } catch (error) {
      if (error instanceof ReviewSessionStoreError) throw error;
      throw new ReviewSessionStoreError("filesystem_error", "The review session directory is unavailable.", { cause: error });
    }
  }

  async #writeAtomic(
    snapshot: Readonly<ReviewSessionSnapshot>,
    mode: "create" | "replace",
  ): Promise<void> {
    const target = await this.#target(snapshot.sessionId);
    const directory = dirname(target);
    const temporary = resolve(directory, `.${snapshot.sessionId}.${randomUUID()}.tmp`);
    const serialized = `${JSON.stringify(cloneSnapshot(snapshot), null, 2)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_SESSION_BYTES) {
      throw new ReviewSessionStoreError("invalid_request", "The review session is too large to save safely.");
    }

    let handle: nodeFsPromises.FileHandle | undefined;
    try {
      handle = await nodeFsPromises.open(
        temporary,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0),
        0o600,
      );
      await handle.writeFile(serialized, { encoding: "utf8" });
      await handle.sync();
      await handle.close();
      handle = undefined;

      if (mode === "create") {
        await nodeFsPromises.link(temporary, target);
        await nodeFsPromises.unlink(temporary);
      } else {
        await nodeFsPromises.rename(temporary, target);
      }
      const directoryHandle = await nodeFsPromises.open(directory, fsConstants.O_RDONLY);
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch (error) {
      if (isErrno(error, "EEXIST")) {
        throw new ReviewSessionStoreError("conflict", "The review session already exists.");
      }
      if (error instanceof ReviewSessionStoreError) throw error;
      throw new ReviewSessionStoreError("filesystem_error", "The review session could not be saved atomically.", { cause: error });
    } finally {
      await handle?.close().catch(() => undefined);
      await nodeFsPromises.unlink(temporary).catch(() => undefined);
    }
  }

  #withLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    const queued = previous.catch(() => undefined).then(() => current);
    this.#tails.set(sessionId, queued);
    return previous
      .catch(() => undefined)
      .then(operation)
      .finally(() => {
        release();
        if (this.#tails.get(sessionId) === queued) this.#tails.delete(sessionId);
      });
  }
}
