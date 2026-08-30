import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import { join, resolve } from "node:path";

import { z } from "zod";

const STORE_SCHEMA_VERSION = 1;
const MAX_MESSAGE_BYTES = 256 * 1024;
const MAX_CITATION_BYTES = 8 * 1024;
const MAX_CITATIONS = 64;

const SCOPE_KEY_PATTERN = /^[a-z][a-z0-9_-]{0,31}:[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/;
const RUNTIME_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,299}$/;
const CONFIG_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CONTEXT_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SAFE_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const CREDENTIAL_LIKE_PATTERN = /^(?:sk|sess|ghp|gho|github_pat|AIza)[-_]/i;

const scopeKeySchema = z.string().max(272).regex(SCOPE_KEY_PATTERN);
const runtimeIdSchema = z
  .string()
  .max(300)
  .regex(RUNTIME_ID_PATTERN)
  .refine((value) => !CREDENTIAL_LIKE_PATTERN.test(value), "credential-like values are forbidden");
const configIdSchema = z
  .string()
  .max(128)
  .regex(CONFIG_ID_PATTERN)
  .refine((value) => !CREDENTIAL_LIKE_PATTERN.test(value), "credential-like values are forbidden");
const contextHashSchema = z.string().regex(CONTEXT_HASH_PATTERN);
const safeCodeSchema = z.string().regex(SAFE_CODE_PATTERN);
const timestampSchema = z.iso.datetime({ offset: true });

function containsForbiddenControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f) {
      return true;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function visibleTextSchema(maxBytes: number) {
  return z
    .string()
    .refine((value) => value.trim().length > 0, "text must not be blank")
    .refine((value) => !containsForbiddenControl(value), "text contains forbidden control characters")
    .refine((value) => Buffer.byteLength(value, "utf8") <= maxBytes, "text is too large");
}

const messageTextSchema = visibleTextSchema(MAX_MESSAGE_BYTES);
const citationLabelSchema = visibleTextSchema(1024);
const citationUrlSchema = z
  .string()
  .refine((value) => !containsForbiddenControl(value), "citation URL contains forbidden controls")
  .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_CITATION_BYTES, "citation URL is too large")
  .refine((value) => {
    try {
      const parsed = new URL(value);
      return (
        (parsed.protocol === "http:" || parsed.protocol === "https:") &&
        parsed.username === "" &&
        parsed.password === ""
      );
    } catch {
      return false;
    }
  }, "citation URL must be credential-free HTTP(S)");
const citationSchema = z.object({ label: citationLabelSchema, url: citationUrlSchema }).strict();

const bindScopeSchema = z
  .object({
    scopeKey: scopeKeySchema,
    chatId: runtimeIdSchema,
    threadId: runtimeIdSchema,
    model: configIdSchema,
    permissionProfile: configIdSchema,
  })
  .strict();

const submissionSchema = z
  .object({
    scopeKey: scopeKeySchema,
    chatId: runtimeIdSchema,
    threadId: runtimeIdSchema,
    turnNonce: runtimeIdSchema,
    text: messageTextSchema,
    contextHash: contextHashSchema,
  })
  .strict();

const completionSchema = z
  .object({
    scopeKey: scopeKeySchema,
    chatId: runtimeIdSchema,
    threadId: runtimeIdSchema,
    turnNonce: runtimeIdSchema,
    turnId: runtimeIdSchema,
    text: messageTextSchema,
    citations: z.array(citationSchema).max(MAX_CITATIONS).optional(),
  })
  .strict();

const failureSchema = z
  .object({
    scopeKey: scopeKeySchema,
    chatId: runtimeIdSchema,
    threadId: runtimeIdSchema,
    turnNonce: runtimeIdSchema,
    safeCode: safeCodeSchema,
    text: messageTextSchema,
  })
  .strict();

const storedBaseSchema = z.object({
  schemaVersion: z.literal(STORE_SCHEMA_VERSION),
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  occurredAt: timestampSchema,
});
const storedBindingSchema = storedBaseSchema
  .extend({
    event: z.literal("scope_bound"),
    scopeKey: scopeKeySchema,
    chatId: runtimeIdSchema,
    threadId: runtimeIdSchema,
    model: configIdSchema,
    permissionProfile: configIdSchema,
  })
  .strict();
const storedSubmissionSchema = storedBaseSchema
  .extend({
    event: z.literal("submission"),
    scopeKey: scopeKeySchema,
    chatId: runtimeIdSchema,
    threadId: runtimeIdSchema,
    turnNonce: runtimeIdSchema,
    text: messageTextSchema,
    contextHash: contextHashSchema,
  })
  .strict();
const storedCompletionSchema = storedBaseSchema
  .extend({
    event: z.literal("completion"),
    scopeKey: scopeKeySchema,
    chatId: runtimeIdSchema,
    threadId: runtimeIdSchema,
    turnNonce: runtimeIdSchema,
    turnId: runtimeIdSchema,
    text: messageTextSchema,
    citations: z.array(citationSchema).max(MAX_CITATIONS),
  })
  .strict();
const storedFailureSchema = storedBaseSchema
  .extend({
    event: z.literal("failure"),
    scopeKey: scopeKeySchema,
    chatId: runtimeIdSchema,
    threadId: runtimeIdSchema,
    turnNonce: runtimeIdSchema,
    safeCode: safeCodeSchema,
    text: messageTextSchema,
  })
  .strict();
const storedEventSchema = z.discriminatedUnion("event", [
  storedBindingSchema,
  storedSubmissionSchema,
  storedCompletionSchema,
  storedFailureSchema,
]);

type StoredBinding = z.infer<typeof storedBindingSchema>;
type StoredSubmission = z.infer<typeof storedSubmissionSchema>;
type StoredCompletion = z.infer<typeof storedCompletionSchema>;
type StoredFailure = z.infer<typeof storedFailureSchema>;
type StoredEvent = z.infer<typeof storedEventSchema>;

export interface BindTutorSessionScopeInput {
  readonly scopeKey: string;
  readonly chatId: string;
  readonly threadId: string;
  readonly model: string;
  readonly permissionProfile: string;
}

export interface RecordTutorSubmissionInput {
  readonly scopeKey: string;
  readonly chatId: string;
  readonly threadId: string;
  readonly turnNonce: string;
  readonly text: string;
  readonly contextHash: string;
}

export interface RecordTutorCompletionInput {
  readonly scopeKey: string;
  readonly chatId: string;
  readonly threadId: string;
  readonly turnNonce: string;
  readonly turnId: string;
  readonly text: string;
  readonly citations?: readonly TutorSessionCitation[];
}

export interface TutorSessionCitation {
  readonly label: string;
  readonly url: string;
}

export interface RecordTutorFailureInput {
  readonly scopeKey: string;
  readonly chatId: string;
  readonly threadId: string;
  readonly turnNonce: string;
  readonly safeCode: string;
  readonly text: string;
}

export interface TutorSessionThreadSegment {
  readonly segmentSequence: number;
  readonly threadId: string;
  readonly model: string;
  readonly permissionProfile: string;
  readonly boundAt: string;
}

interface TutorSessionMessageBase {
  readonly sequence: number;
  readonly scopeKey: string;
  readonly chatId: string;
  readonly threadId: string;
  readonly turnNonce: string;
  readonly occurredAt: string;
}

export interface TutorSessionSubmissionMessage extends TutorSessionMessageBase {
  readonly kind: "submission";
  readonly role: "learner";
  readonly text: string;
  readonly contextHash: string;
}

export interface TutorSessionCompletionMessage extends TutorSessionMessageBase {
  readonly kind: "completion";
  readonly role: "tutor";
  readonly turnId: string;
  readonly text: string;
  readonly citations: readonly TutorSessionCitation[];
}

export interface TutorSessionFailureMessage extends TutorSessionMessageBase {
  readonly kind: "failure";
  readonly role: "tutor";
  readonly safeCode: string;
  readonly text: string;
}

export type TutorSessionVisibleMessage =
  | TutorSessionSubmissionMessage
  | TutorSessionCompletionMessage
  | TutorSessionFailureMessage;

export interface TutorSessionScopeLog {
  readonly scopeKey: string;
  readonly chatId: string;
  readonly currentThreadId: string;
  readonly currentModel: string;
  readonly currentPermissionProfile: string;
  readonly threadSegments: readonly TutorSessionThreadSegment[];
  readonly messages: readonly TutorSessionVisibleMessage[];
}

export interface TutorSessionExcerptMessage {
  readonly role: "learner" | "tutor" | "status";
  readonly text: string;
  readonly occurredAt: string;
  readonly truncated: boolean;
}

export interface TutorSessionScopeExcerpt {
  readonly scopeKey: string;
  readonly latestActivityAt: string;
  readonly messages: readonly TutorSessionExcerptMessage[];
}

export interface TutorSessionScopeExcerptListing {
  readonly scopes: readonly TutorSessionScopeExcerpt[];
  readonly truncated: boolean;
  readonly omittedScopeCount: number;
}

export interface TutorSessionScopeExcerptOptions {
  readonly maxScopes: number;
  readonly maxMessagesPerScope: number;
  readonly maxMessageBytes: number;
  readonly maxTotalBytes: number;
  readonly excludeScopeKeys?: readonly string[];
}

interface TutorSessionTurnBase {
  readonly scopeKey: string;
  readonly chatId: string;
  readonly threadId: string;
  readonly turnNonce: string;
  readonly learnerText: string;
  readonly contextHash: string;
  readonly submittedAt: string;
}

export type TutorSessionTurn =
  | (TutorSessionTurnBase & {
      readonly status: "submitted";
      readonly completion: null;
      readonly failure: null;
    })
  | (TutorSessionTurnBase & {
      readonly status: "completed";
      readonly completion: {
        readonly turnId: string;
        readonly assistantText: string;
        readonly citations: readonly TutorSessionCitation[];
        readonly completedAt: string;
      };
      readonly failure: null;
    })
  | (TutorSessionTurnBase & {
      readonly status: "failed";
      readonly completion: null;
      readonly failure: {
        readonly safeCode: string;
        readonly assistantText: string;
        readonly failedAt: string;
      };
    });

export type BindTutorSessionScopeResult =
  | { readonly status: "bound" | "rebound"; readonly segment: TutorSessionThreadSegment }
  | { readonly status: "unchanged"; readonly segment: TutorSessionThreadSegment };

export type RecordTutorSessionEventResult<TEvent extends TutorSessionVisibleMessage> =
  | { readonly status: "recorded"; readonly event: TEvent }
  | { readonly status: "unchanged"; readonly event: TEvent };

export type TutorSessionLogStoreErrorCode =
  | "invalid_request"
  | "scope_chat_conflict"
  | "unknown_binding"
  | "unknown_turn"
  | "conflicting_duplicate"
  | "closed"
  | "unsafe_path"
  | "corrupt_store"
  | "storage_error";

export class TutorSessionLogStoreError extends Error {
  public constructor(
    public readonly code: TutorSessionLogStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TutorSessionLogStoreError";
  }
}

export interface TutorSessionLogStoreDependencies {
  readonly now?: () => Date;
}

const scopeExcerptOptionsSchema = z.object({
  maxScopes: z.number().int().min(1).max(20),
  maxMessagesPerScope: z.number().int().min(1).max(20),
  maxMessageBytes: z.number().int().min(128).max(16 * 1024),
  maxTotalBytes: z.number().int().min(512).max(128 * 1024),
  excludeScopeKeys: z.array(scopeKeySchema).max(32).optional(),
}).strict();

interface ScopeProjection {
  readonly scopeKey: string;
  readonly chatId: string;
  readonly segments: readonly StoredBinding[];
}

interface TurnProjection {
  readonly submission: StoredSubmission;
  readonly terminal: StoredCompletion | StoredFailure | null;
}

interface LogProjection {
  readonly scopes: ReadonlyMap<string, ScopeProjection>;
  readonly scopeByChat: ReadonlyMap<string, string>;
  readonly turns: ReadonlyMap<string, TurnProjection>;
  readonly completionTurnIds: ReadonlySet<string>;
}

function turnKey(chatId: string, turnNonce: string): string {
  return `${chatId}\u0000${turnNonce}`;
}

function parsedRequest<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new TutorSessionLogStoreError("invalid_request", "Tutor session log request is invalid.");
  }
  return result.data;
}

function currentTimestamp(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TutorSessionLogStoreError("invalid_request", "Tutor session clock returned an invalid timestamp.");
  }
  return value.toISOString();
}

function normalizeStorageError(error: unknown): TutorSessionLogStoreError {
  if (error instanceof TutorSessionLogStoreError) return error;
  return new TutorSessionLogStoreError(
    "storage_error",
    "The durable tutor session log could not be updated.",
    { cause: error },
  );
}

function segmentFromBinding(binding: StoredBinding): TutorSessionThreadSegment {
  return Object.freeze({
    segmentSequence: binding.sequence,
    threadId: binding.threadId,
    model: binding.model,
    permissionProfile: binding.permissionProfile,
    boundAt: binding.occurredAt,
  });
}

function messageFromEvent(event: StoredSubmission): TutorSessionSubmissionMessage;
function messageFromEvent(event: StoredCompletion): TutorSessionCompletionMessage;
function messageFromEvent(event: StoredFailure): TutorSessionFailureMessage;
function messageFromEvent(
  event: StoredSubmission | StoredCompletion | StoredFailure,
): TutorSessionVisibleMessage;
function messageFromEvent(
  event: StoredSubmission | StoredCompletion | StoredFailure,
): TutorSessionVisibleMessage {
  const base = {
    sequence: event.sequence,
    scopeKey: event.scopeKey,
    chatId: event.chatId,
    threadId: event.threadId,
    turnNonce: event.turnNonce,
    occurredAt: event.occurredAt,
  };
  if (event.event === "submission") {
    return Object.freeze({
      ...base,
      kind: "submission",
      role: "learner",
      text: event.text,
      contextHash: event.contextHash,
    });
  }
  if (event.event === "completion") {
    return Object.freeze({
      ...base,
      kind: "completion",
      role: "tutor",
      turnId: event.turnId,
      text: event.text,
      citations: Object.freeze(event.citations.map((citation) => Object.freeze({ ...citation }))),
    });
  }
  return Object.freeze({
    ...base,
    kind: "failure",
    role: "tutor",
    safeCode: event.safeCode,
    text: event.text,
  });
}

function sameCitations(left: readonly TutorSessionCitation[], right: readonly TutorSessionCitation[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (value, index) => value.label === right[index]?.label && value.url === right[index]?.url,
    )
  );
}

function buildProjection(events: readonly StoredEvent[]): LogProjection {
  const scopes = new Map<string, ScopeProjection>();
  const scopeByChat = new Map<string, string>();
  const turns = new Map<string, TurnProjection>();
  const completionTurnIds = new Set<string>();

  for (const event of events) {
    if (event.event === "scope_bound") {
      const existingScope = scopes.get(event.scopeKey);
      const existingChatScope = scopeByChat.get(event.chatId);
      if (existingScope !== undefined && existingScope.chatId !== event.chatId) {
        throw new TutorSessionLogStoreError("corrupt_store", "A tutor scope has multiple chats.");
      }
      if (existingChatScope !== undefined && existingChatScope !== event.scopeKey) {
        throw new TutorSessionLogStoreError("corrupt_store", "A tutor chat has multiple scopes.");
      }
      scopes.set(event.scopeKey, {
        scopeKey: event.scopeKey,
        chatId: event.chatId,
        segments: Object.freeze([...(existingScope?.segments ?? []), event]),
      });
      scopeByChat.set(event.chatId, event.scopeKey);
      continue;
    }

    const scope = scopes.get(event.scopeKey);
    if (
      scope === undefined ||
      scope.chatId !== event.chatId ||
      !scope.segments.some((segment) => segment.threadId === event.threadId)
    ) {
      throw new TutorSessionLogStoreError(
        "corrupt_store",
        "A tutor message does not belong to a known thread segment.",
      );
    }
    const key = turnKey(event.chatId, event.turnNonce);
    if (event.event === "submission") {
      if (turns.has(key)) {
        throw new TutorSessionLogStoreError("corrupt_store", "A tutor turn has duplicate submissions.");
      }
      turns.set(key, { submission: event, terminal: null });
      continue;
    }
    const turn = turns.get(key);
    if (
      turn === undefined ||
      turn.terminal !== null ||
      turn.submission.scopeKey !== event.scopeKey ||
      turn.submission.threadId !== event.threadId
    ) {
      throw new TutorSessionLogStoreError(
        "corrupt_store",
        "A tutor terminal event does not match one submission.",
      );
    }
    if (event.event === "completion") {
      if (completionTurnIds.has(event.turnId)) {
        throw new TutorSessionLogStoreError("corrupt_store", "A Codex turn ID appears more than once.");
      }
      completionTurnIds.add(event.turnId);
    }
    turns.set(key, { submission: turn.submission, terminal: event });
  }
  return { scopes, scopeByChat, turns, completionTurnIds };
}

function turnView(turn: TurnProjection): TutorSessionTurn {
  const base = {
    scopeKey: turn.submission.scopeKey,
    chatId: turn.submission.chatId,
    threadId: turn.submission.threadId,
    turnNonce: turn.submission.turnNonce,
    learnerText: turn.submission.text,
    contextHash: turn.submission.contextHash,
    submittedAt: turn.submission.occurredAt,
  };
  if (turn.terminal === null) {
    return Object.freeze({ ...base, status: "submitted", completion: null, failure: null });
  }
  if (turn.terminal.event === "completion") {
    return Object.freeze({
      ...base,
      status: "completed",
      completion: Object.freeze({
        turnId: turn.terminal.turnId,
        assistantText: turn.terminal.text,
        citations: Object.freeze(
          turn.terminal.citations.map((citation) => Object.freeze({ ...citation })),
        ),
        completedAt: turn.terminal.occurredAt,
      }),
      failure: null,
    });
  }
  return Object.freeze({
    ...base,
    status: "failed",
    completion: null,
    failure: Object.freeze({
      safeCode: turn.terminal.safeCode,
      assistantText: turn.terminal.text,
      failedAt: turn.terminal.occurredAt,
    }),
  });
}

function truncateVisibleUtf8(value: string, maxBytes: number): string {
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

/**
 * Append-only, learner-visible tutor history. JSONL is the durable authority so
 * it stays inspectable and portable. It deliberately excludes frozen context,
 * tool traffic, reasoning, credentials, and note content.
 */
export class TutorSessionLogStore {
  readonly #stateRoot: string;
  readonly #tutorRoot: string;
  readonly #sessionsRoot: string;
  readonly #logPath: string;
  readonly #now: () => Date;
  readonly #ready: Promise<void>;
  #events: readonly StoredEvent[] = Object.freeze([]);
  #projection: LogProjection = buildProjection([]);
  #committedBytes = 0;
  #queue: Promise<void> = Promise.resolve();
  #closing = false;
  #closed = false;

  public constructor(
    stateRoot: string,
    dependencies: TutorSessionLogStoreDependencies = {},
  ) {
    if (typeof stateRoot !== "string" || stateRoot.length === 0 || stateRoot.includes("\u0000")) {
      throw new TutorSessionLogStoreError("invalid_request", "State root is invalid.");
    }
    this.#stateRoot = resolve(stateRoot);
    this.#tutorRoot = join(this.#stateRoot, "tutor");
    this.#sessionsRoot = join(this.#tutorRoot, "sessions");
    this.#logPath = join(this.#sessionsRoot, "sessions.jsonl");
    this.#now = dependencies.now ?? (() => new Date());
    this.#ready = this.#initialize();
  }

  public async bindScope(input: BindTutorSessionScopeInput): Promise<BindTutorSessionScopeResult> {
    const request = parsedRequest(bindScopeSchema, input);
    return this.#serialized(async () => {
      const existing = this.#projection.scopes.get(request.scopeKey);
      if (existing !== undefined && existing.chatId !== request.chatId) {
        throw new TutorSessionLogStoreError(
          "scope_chat_conflict",
          "A tutor scope cannot be moved to a different chat.",
        );
      }
      const existingChatScope = this.#projection.scopeByChat.get(request.chatId);
      if (existingChatScope !== undefined && existingChatScope !== request.scopeKey) {
        throw new TutorSessionLogStoreError(
          "scope_chat_conflict",
          "A tutor chat cannot be bound to more than one scope.",
        );
      }
      const current = existing?.segments.at(-1);
      if (
        current !== undefined &&
        current.threadId === request.threadId &&
        current.model === request.model &&
        current.permissionProfile === request.permissionProfile
      ) {
        return Object.freeze({ status: "unchanged", segment: segmentFromBinding(current) });
      }
      const event: StoredBinding = {
        schemaVersion: STORE_SCHEMA_VERSION,
        sequence: this.#events.length + 1,
        event: "scope_bound",
        ...request,
        occurredAt: currentTimestamp(this.#now),
      };
      await this.#append(event);
      return Object.freeze({
        status: existing === undefined ? "bound" : "rebound",
        segment: segmentFromBinding(event),
      });
    });
  }

  public async recordSubmission(
    input: RecordTutorSubmissionInput,
  ): Promise<RecordTutorSessionEventResult<TutorSessionSubmissionMessage>> {
    const request = parsedRequest(submissionSchema, input);
    return this.#serialized(async () => {
      this.#requireKnownBinding(request.scopeKey, request.chatId, request.threadId);
      const key = turnKey(request.chatId, request.turnNonce);
      const existing = this.#projection.turns.get(key);
      if (existing !== undefined) {
        const submission = existing.submission;
        if (
          submission.scopeKey === request.scopeKey &&
          submission.threadId === request.threadId &&
          submission.text === request.text &&
          submission.contextHash === request.contextHash
        ) {
          return Object.freeze({ status: "unchanged", event: messageFromEvent(submission) });
        }
        throw new TutorSessionLogStoreError(
          "conflicting_duplicate",
          "This tutor turn nonce already has a different learner submission.",
        );
      }
      const event: StoredSubmission = {
        schemaVersion: STORE_SCHEMA_VERSION,
        sequence: this.#events.length + 1,
        event: "submission",
        ...request,
        occurredAt: currentTimestamp(this.#now),
      };
      await this.#append(event);
      return Object.freeze({ status: "recorded", event: messageFromEvent(event) });
    });
  }

  public async recordCompletion(
    input: RecordTutorCompletionInput,
  ): Promise<RecordTutorSessionEventResult<TutorSessionCompletionMessage>> {
    const request = parsedRequest(completionSchema, input);
    const citations = [...(request.citations ?? [])];
    return this.#serialized(async () => {
      const turn = this.#requireTurn(request);
      if (turn.terminal !== null) {
        if (
          turn.terminal.event === "completion" &&
          turn.terminal.turnId === request.turnId &&
          turn.terminal.text === request.text &&
          sameCitations(turn.terminal.citations, citations)
        ) {
          return Object.freeze({ status: "unchanged", event: messageFromEvent(turn.terminal) });
        }
        throw new TutorSessionLogStoreError(
          "conflicting_duplicate",
          "This tutor turn already has a different terminal result.",
        );
      }
      if (this.#projection.completionTurnIds.has(request.turnId)) {
        throw new TutorSessionLogStoreError(
          "conflicting_duplicate",
          "This Codex turn ID is already associated with another tutor turn.",
        );
      }
      const event: StoredCompletion = {
        schemaVersion: STORE_SCHEMA_VERSION,
        sequence: this.#events.length + 1,
        event: "completion",
        scopeKey: request.scopeKey,
        chatId: request.chatId,
        threadId: request.threadId,
        turnNonce: request.turnNonce,
        turnId: request.turnId,
        text: request.text,
        citations,
        occurredAt: currentTimestamp(this.#now),
      };
      await this.#append(event);
      return Object.freeze({ status: "recorded", event: messageFromEvent(event) });
    });
  }

  public async recordFailure(
    input: RecordTutorFailureInput,
  ): Promise<RecordTutorSessionEventResult<TutorSessionFailureMessage>> {
    const request = parsedRequest(failureSchema, input);
    return this.#serialized(async () => {
      const turn = this.#requireTurn(request);
      if (turn.terminal !== null) {
        if (
          turn.terminal.event === "failure" &&
          turn.terminal.safeCode === request.safeCode &&
          turn.terminal.text === request.text
        ) {
          return Object.freeze({ status: "unchanged", event: messageFromEvent(turn.terminal) });
        }
        throw new TutorSessionLogStoreError(
          "conflicting_duplicate",
          "This tutor turn already has a different terminal result.",
        );
      }
      const event: StoredFailure = {
        schemaVersion: STORE_SCHEMA_VERSION,
        sequence: this.#events.length + 1,
        event: "failure",
        ...request,
        occurredAt: currentTimestamp(this.#now),
      };
      await this.#append(event);
      return Object.freeze({ status: "recorded", event: messageFromEvent(event) });
    });
  }

  public async readScope(scopeKey: string): Promise<TutorSessionScopeLog | null> {
    const parsedScopeKey = parsedRequest(scopeKeySchema, scopeKey);
    return this.#serialized(async () => {
      const scope = this.#projection.scopes.get(parsedScopeKey);
      if (scope === undefined) return null;
      const current = scope.segments.at(-1);
      if (current === undefined) {
        throw new TutorSessionLogStoreError("corrupt_store", "A tutor scope has no thread segment.");
      }
      const messages = this.#events
        .filter(
          (event): event is StoredSubmission | StoredCompletion | StoredFailure =>
            event.event !== "scope_bound" && event.scopeKey === parsedScopeKey,
        )
        .map((event) => messageFromEvent(event));
      return Object.freeze({
        scopeKey: scope.scopeKey,
        chatId: scope.chatId,
        currentThreadId: current.threadId,
        currentModel: current.model,
        currentPermissionProfile: current.permissionProfile,
        threadSegments: Object.freeze(scope.segments.map(segmentFromBinding)),
        messages: Object.freeze(messages),
      });
    });
  }

  /**
   * Returns a bounded learner-visible projection for cross-session continuity.
   * Provider IDs, models, permission profiles, context hashes, citations, and
   * recovery metadata never leave this method.
   */
  public async listScopeExcerpts(
    options: TutorSessionScopeExcerptOptions,
  ): Promise<TutorSessionScopeExcerptListing> {
    const parsed = parsedRequest(scopeExcerptOptionsSchema, options);
    return this.#serialized(async () => {
      const excluded = new Set(parsed.excludeScopeKeys ?? []);
      const candidates = [...this.#projection.scopes.values()]
        .filter(({ scopeKey }) => !excluded.has(scopeKey))
        .map((scope) => {
          const messages = this.#events.filter(
            (event): event is StoredSubmission | StoredCompletion | StoredFailure =>
              event.event !== "scope_bound" && event.scopeKey === scope.scopeKey,
          );
          return { scopeKey: scope.scopeKey, messages, latest: messages.at(-1) };
        })
        .filter((candidate): candidate is typeof candidate & {
          readonly latest: StoredSubmission | StoredCompletion | StoredFailure;
        } => candidate.latest !== undefined)
        .sort((left, right) => right.latest.sequence - left.latest.sequence);

      const selectedCandidates = candidates.slice(0, parsed.maxScopes);
      const scopes: TutorSessionScopeExcerpt[] = [];
      let remainingBytes = parsed.maxTotalBytes;
      let truncated = selectedCandidates.length < candidates.length;

      for (const candidate of selectedCandidates) {
        if (remainingBytes <= 0) {
          truncated = true;
          break;
        }
        const rawMessages = candidate.messages.slice(-parsed.maxMessagesPerScope);
        if (rawMessages.length < candidate.messages.length) truncated = true;
        const messages: TutorSessionExcerptMessage[] = [];
        for (const event of rawMessages) {
          if (remainingBytes <= 0) {
            truncated = true;
            break;
          }
          const perMessageLimit = Math.min(parsed.maxMessageBytes, remainingBytes);
          const text = truncateVisibleUtf8(event.text, perMessageLimit);
          const originalBytes = Buffer.byteLength(event.text, "utf8");
          const bytes = Buffer.byteLength(text, "utf8");
          if (bytes === 0) {
            truncated = true;
            continue;
          }
          const messageTruncated = bytes < originalBytes;
          truncated ||= messageTruncated;
          remainingBytes -= bytes;
          messages.push(Object.freeze({
            role: event.event === "submission"
              ? "learner" as const
              : event.event === "completion"
                ? "tutor" as const
                : "status" as const,
            text,
            occurredAt: event.occurredAt,
            truncated: messageTruncated,
          }));
        }
        if (messages.length === 0) {
          truncated = true;
          continue;
        }
        scopes.push(Object.freeze({
          scopeKey: candidate.scopeKey,
          latestActivityAt: candidate.latest.occurredAt,
          messages: Object.freeze(messages),
        }));
      }

      return Object.freeze({
        scopes: Object.freeze(scopes),
        truncated,
        omittedScopeCount: Math.max(0, candidates.length - scopes.length),
      });
    });
  }

  public async readTurn(chatId: string, turnNonce: string): Promise<TutorSessionTurn | null> {
    const parsedChatId = parsedRequest(runtimeIdSchema, chatId);
    const parsedTurnNonce = parsedRequest(runtimeIdSchema, turnNonce);
    return this.#serialized(async () => {
      const turn = this.#projection.turns.get(turnKey(parsedChatId, parsedTurnNonce));
      return turn === undefined ? null : turnView(turn);
    });
  }

  public async close(): Promise<void> {
    if (this.#closed || this.#closing) {
      await this.#queue;
      return;
    }
    this.#closing = true;
    const prior = this.#queue;
    let release!: () => void;
    this.#queue = new Promise<void>((resolveQueue) => {
      release = resolveQueue;
    });
    try {
      await prior;
      await this.#ready;
      this.#closed = true;
    } catch (error) {
      throw normalizeStorageError(error);
    } finally {
      release();
    }
  }

  async #initialize(): Promise<void> {
    try {
      await mkdir(this.#stateRoot, { recursive: true, mode: 0o700 });
      await this.#requireRealDirectory(this.#stateRoot);
      await this.#ensureRealDirectory(this.#tutorRoot);
      await this.#ensureRealDirectory(this.#sessionsRoot);
      await this.#rejectUnsafeLogTarget();
      const creationHandle = await open(
        this.#logPath,
        fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
        0o600,
      );
      try {
        await creationHandle.sync();
      } finally {
        await creationHandle.close();
      }
      if (process.platform !== "win32") await chmod(this.#logPath, 0o600);
      await this.#rejectUnsafeLogTarget();
      await this.#syncDirectory();

      const readHandle = await open(this.#logPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      let bytes: Buffer;
      try {
        bytes = await readHandle.readFile();
      } finally {
        await readHandle.close();
      }
      const finalNewline = bytes.lastIndexOf(0x0a);
      const committedBytes =
        bytes.length === 0 || bytes.at(-1) === 0x0a ? bytes.length : finalNewline + 1;
      if (committedBytes !== bytes.length) {
        const recoveryHandle = await open(
          this.#logPath,
          fsConstants.O_RDWR | fsConstants.O_NOFOLLOW,
        );
        try {
          await recoveryHandle.truncate(committedBytes);
          await recoveryHandle.sync();
        } finally {
          await recoveryHandle.close();
        }
      }

      const committed = bytes.subarray(0, committedBytes);
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(committed);
      } catch (error) {
        throw new TutorSessionLogStoreError(
          "corrupt_store",
          "Tutor session log contains invalid UTF-8 before its final record.",
          { cause: error },
        );
      }
      const lines = text.length === 0 ? [] : text.slice(0, -1).split("\n");
      const events = lines.map((line, index) => {
        if (line.length === 0) {
          throw new TutorSessionLogStoreError("corrupt_store", "Tutor session log contains an empty record.");
        }
        let decoded: unknown;
        try {
          decoded = JSON.parse(line);
        } catch (error) {
          throw new TutorSessionLogStoreError(
            "corrupt_store",
            `Tutor session log record ${index + 1} is not valid JSON.`,
            { cause: error },
          );
        }
        const parsed = storedEventSchema.safeParse(decoded);
        if (!parsed.success || parsed.data.sequence !== index + 1) {
          throw new TutorSessionLogStoreError(
            "corrupt_store",
            `Tutor session log record ${index + 1} is malformed or out of sequence.`,
          );
        }
        return parsed.data;
      });
      this.#events = Object.freeze(events);
      this.#projection = buildProjection(events);
      this.#committedBytes = committedBytes;
    } catch (error) {
      throw normalizeStorageError(error);
    }
  }

  async #serialized<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#closing || this.#closed) {
      throw new TutorSessionLogStoreError("closed", "Tutor session log store is closed.");
    }
    const prior = this.#queue;
    let release!: () => void;
    this.#queue = new Promise<void>((resolveQueue) => {
      release = resolveQueue;
    });
    try {
      await prior;
      await this.#ready;
      return await operation();
    } catch (error) {
      throw normalizeStorageError(error);
    } finally {
      release();
    }
  }

  async #append(event: StoredEvent): Promise<void> {
    const candidateEvents = Object.freeze([...this.#events, event]);
    const candidateProjection = buildProjection(candidateEvents);
    const encoded = Buffer.from(`${JSON.stringify(event)}\n`, "utf8");
    await this.#rejectUnsafeLogTarget();
    const handle = await open(this.#logPath, fsConstants.O_RDWR | fsConstants.O_NOFOLLOW);
    try {
      // A failed append in this process may have left a partial suffix. Always
      // restore the last fsynced boundary before attempting the next record.
      await handle.truncate(this.#committedBytes);
      let written = 0;
      while (written < encoded.byteLength) {
        const result = await handle.write(
          encoded,
          written,
          encoded.byteLength - written,
          this.#committedBytes + written,
        );
        if (result.bytesWritten <= 0) {
          throw new TutorSessionLogStoreError("storage_error", "Tutor session append made no progress.");
        }
        written += result.bytesWritten;
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    this.#events = candidateEvents;
    this.#projection = candidateProjection;
    this.#committedBytes += encoded.byteLength;
    if (process.platform !== "win32") await chmod(this.#logPath, 0o600);
  }

  #requireKnownBinding(scopeKey: string, chatId: string, threadId: string): void {
    const scope = this.#projection.scopes.get(scopeKey);
    if (
      scope === undefined ||
      scope.chatId !== chatId ||
      !scope.segments.some((segment) => segment.threadId === threadId)
    ) {
      throw new TutorSessionLogStoreError(
        "unknown_binding",
        "The tutor scope, chat, and thread segment are not bound.",
      );
    }
  }

  #requireTurn(request: {
    readonly scopeKey: string;
    readonly chatId: string;
    readonly threadId: string;
    readonly turnNonce: string;
  }): TurnProjection {
    const turn = this.#projection.turns.get(turnKey(request.chatId, request.turnNonce));
    if (turn === undefined) {
      throw new TutorSessionLogStoreError(
        "unknown_turn",
        "A completion or failure requires a recorded learner submission.",
      );
    }
    if (
      turn.submission.scopeKey !== request.scopeKey ||
      turn.submission.threadId !== request.threadId
    ) {
      throw new TutorSessionLogStoreError(
        "conflicting_duplicate",
        "Tutor terminal metadata does not match the recorded submission.",
      );
    }
    return turn;
  }

  async #ensureRealDirectory(path: string): Promise<void> {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await this.#requireRealDirectory(path);
  }

  async #requireRealDirectory(path: string): Promise<void> {
    const details = await lstat(path);
    if (details.isSymbolicLink() || !details.isDirectory()) {
      throw new TutorSessionLogStoreError(
        "unsafe_path",
        "Tutor session storage directories must be real directories, not links.",
      );
    }
    if (process.platform !== "win32") await chmod(path, 0o700);
  }

  async #rejectUnsafeLogTarget(): Promise<void> {
    try {
      const details = await lstat(this.#logPath);
      if (details.isSymbolicLink() || !details.isFile()) {
        throw new TutorSessionLogStoreError(
          "unsafe_path",
          "Tutor session history must be a regular file, not a link.",
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async #syncDirectory(): Promise<void> {
    if (process.platform === "win32") return;
    const directory = await open(this.#sessionsRoot, "r");
    try {
      await directory.sync();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EBADF") throw error;
    } finally {
      await directory.close();
    }
  }
}
