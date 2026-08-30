import { isAbsolute, normalize, resolve } from "node:path";

import type { ReasoningEffort } from "./generated/ReasoningEffort.js";
import type { JsonValue } from "./generated/serde_json/JsonValue.js";
import type { DynamicToolSpec } from "./generated/v2/DynamicToolSpec.js";
import type { Model } from "./generated/v2/Model.js";
import type { ModelListParams } from "./generated/v2/ModelListParams.js";
import type { ModelListResponse } from "./generated/v2/ModelListResponse.js";
import type { PermissionProfileListParams } from "./generated/v2/PermissionProfileListParams.js";
import type { PermissionProfileListResponse } from "./generated/v2/PermissionProfileListResponse.js";
import type { ThreadReadParams } from "./generated/v2/ThreadReadParams.js";
import type { ThreadReadResponse } from "./generated/v2/ThreadReadResponse.js";
import type { ThreadItemsListParams } from "./generated/v2/ThreadItemsListParams.js";
import type { ThreadItemsListResponse } from "./generated/v2/ThreadItemsListResponse.js";
import type { ThreadResumeParams } from "./generated/v2/ThreadResumeParams.js";
import type { ThreadResumeResponse } from "./generated/v2/ThreadResumeResponse.js";
import type { ThreadStartParams } from "./generated/v2/ThreadStartParams.js";
import type { ThreadStartResponse } from "./generated/v2/ThreadStartResponse.js";
import type { ThreadTurnsListParams } from "./generated/v2/ThreadTurnsListParams.js";
import type { ThreadTurnsListResponse } from "./generated/v2/ThreadTurnsListResponse.js";
import type { Turn } from "./generated/v2/Turn.js";
import type { TurnInterruptParams } from "./generated/v2/TurnInterruptParams.js";
import type { TurnInterruptResponse } from "./generated/v2/TurnInterruptResponse.js";
import type { TurnStartParams } from "./generated/v2/TurnStartParams.js";
import type { TurnStartResponse } from "./generated/v2/TurnStartResponse.js";
import {
  AppServerRequestError,
  type AppServerNotification,
  type AppServerPolicyFault,
} from "./app-server-client.js";

const DEFAULT_TURN_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_INTERRUPT_COMPLETION_TIMEOUT_MS = 15_000;
const DEFAULT_CATALOG_PAGE_LIMIT = 100;
const MAX_CATALOG_PAGES = 20;
const RECOVERY_PAGE_LIMIT = 100;
const MAX_RECOVERY_PAGES = 100;

interface InstructionSourceRequirement {
  readonly label: string;
  readonly alternatives: readonly string[];
}

/** The AppServerClient surface consumed by the gateway, kept fake-friendly. */
export interface TutorGatewayClient {
  listModels(params?: Readonly<ModelListParams>): Promise<ModelListResponse>;
  permissionProfileList(
    params?: Readonly<PermissionProfileListParams>,
  ): Promise<PermissionProfileListResponse>;
  startThread(params: Readonly<ThreadStartParams>): Promise<ThreadStartResponse>;
  resumeThread(params: Readonly<ThreadResumeParams>): Promise<ThreadResumeResponse>;
  readThread(params: Readonly<ThreadReadParams>): Promise<ThreadReadResponse>;
  listThreadTurns(params: Readonly<ThreadTurnsListParams>): Promise<ThreadTurnsListResponse>;
  listThreadItems(params: Readonly<ThreadItemsListParams>): Promise<ThreadItemsListResponse>;
  startTurn(params: Readonly<TurnStartParams>): Promise<TurnStartResponse>;
  interruptTurn(params: Readonly<TurnInterruptParams>): Promise<TurnInterruptResponse>;
  onNotification(listener: (notification: AppServerNotification) => void): () => void;
  onPolicyFault(listener: (fault: AppServerPolicyFault) => void): () => void;
}

export interface TutorGatewayOptions {
  /** Validated absolute AISB root; applied to every thread and turn. */
  readonly aisbRoot: string;
  /** Reviewed named profile selected on every thread and turn; no sandbox fallback exists. */
  readonly permissionsProfile: string;
  readonly requiredInstructionSources?: readonly string[];
  readonly baseInstructions?: string;
  readonly developerInstructions?: string;
  readonly defaultModel?: string;
  readonly defaultEffort?: ReasoningEffort;
  readonly turnTimeoutMs?: number;
  /** Bound after an acknowledged interrupt while waiting for terminal truth. */
  readonly interruptCompletionTimeoutMs?: number;
  /** Application-owned tools fixed for the lifetime of each new thread. */
  readonly dynamicTools?: readonly DynamicToolSpec[];
}

export interface TutorThreadStartInput {
  readonly model?: string;
  readonly ephemeral?: boolean;
  readonly baseInstructions?: string;
  readonly developerInstructions?: string;
}

export interface TutorThreadResumeInput {
  readonly threadId: string;
  readonly model?: string;
  readonly baseInstructions?: string;
  readonly developerInstructions?: string;
}

export interface TutorTurnInput {
  readonly threadId: string;
  /** The already frozen developer/page-context/user envelope for this send. */
  readonly text: string;
  readonly clientUserMessageId?: string;
  readonly model?: string;
  readonly effort?: ReasoningEffort;
  /** JSON Schema applied only to this ordinary `turn/start` request. */
  readonly outputSchema?: JsonValue;
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: TutorTurnEvent) => void;
}

export interface RecoveredTutorTurn {
  readonly turn: Turn;
  readonly text: string;
}

export type TutorTurnEvent =
  | {
      readonly type: "turn-started";
      readonly threadId: string;
      readonly turnId: string;
    }
  | {
      readonly type: "text-delta";
      readonly threadId: string;
      readonly turnId: string;
      readonly itemId: string;
      readonly delta: string;
    }
  | {
      readonly type: "turn-error";
      readonly threadId: string;
      readonly turnId: string;
      readonly message: string;
      readonly willRetry: boolean;
    }
  | {
      readonly type: "policy-fault";
      readonly method: string;
      readonly message: string;
    }
  | {
      readonly type: "turn-completed";
      readonly threadId: string;
      readonly turnId: string;
      readonly status: Turn["status"];
      readonly text: string;
    };

export interface TutorTurnResult {
  readonly threadId: string;
  readonly turnId: string;
  readonly status: Turn["status"];
  readonly text: string;
  readonly turn: Turn;
}

export class TutorGatewayError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class TutorThreadNotFoundError extends TutorGatewayError {
  public constructor(
    public readonly threadId: string,
    options?: ErrorOptions,
  ) {
    super(`Codex has no persisted rollout for tutor thread ${threadId}`, options);
  }
}

export function isAuthoritativeMissingThreadResume(
  error: unknown,
  expectedThreadId: string,
): error is AppServerRequestError {
  return error instanceof AppServerRequestError
    && error.method === "thread/resume"
    && error.code === -32600
    && error.detail === `no rollout found for thread id ${expectedThreadId}`;
}

export class InstructionSourceVerificationError extends TutorGatewayError {
  public constructor(
    public readonly missingSources: readonly string[],
    public readonly observedSources: readonly string[],
  ) {
    super(
      `Codex did not load required AISB instruction sources: ${missingSources.join(", ")}`,
    );
  }
}

export class PermissionProfileVerificationError extends TutorGatewayError {
  public constructor(
    public readonly permissionsProfile: string,
    public readonly reason: "missing" | "not_allowed" | "not_applied" | "pagination",
    public readonly observedProfile: string | null = null,
  ) {
    const detail =
      reason === "missing"
        ? "was not advertised"
        : reason === "not_allowed"
          ? "is present but forbidden by effective requirements"
          : reason === "not_applied"
            ? `was not applied by Codex (observed ${observedProfile ?? "none"})`
            : "could not be verified because profile pagination was invalid";
    super(`Required Codex permission profile ${permissionsProfile} ${detail}`);
  }
}

export class TutorPolicyFaultError extends TutorGatewayError {
  public constructor(public readonly fault: Readonly<AppServerPolicyFault>) {
    super(fault.message);
  }
}

export class TutorTurnTimeoutError extends TutorGatewayError {
  public constructor(
    public readonly threadId: string,
    public readonly turnId: string,
    public readonly timeoutMs: number,
  ) {
    super(`Tutor turn ${turnId} timed out after ${timeoutMs} ms`);
  }
}

export class TutorTurnAbortedError extends TutorGatewayError {
  public constructor(
    public readonly threadId: string,
    public readonly turnId: string,
  ) {
    super(`Tutor turn ${turnId} was interrupted by the caller`);
  }
}

export class TutorTurnInterruptedError extends TutorGatewayError {
  public constructor(
    public readonly threadId: string,
    public readonly turnId: string,
    public readonly turn: Turn,
  ) {
    super(`Tutor turn ${turnId} was interrupted`);
  }
}

export class TutorTurnFailedError extends TutorGatewayError {
  public constructor(
    public readonly threadId: string,
    public readonly turnId: string,
    message: string,
  ) {
    super(`Tutor turn ${turnId} failed: ${message}`);
  }
}

/**
 * Safe, Fastify-friendly operations over the raw App Server protocol.
 *
 * Threads are named-profile constrained and approval-free. A turn is allowed
 * only after its start/resume response proves that both the requested profile
 * and the AISB instruction source were loaded.
 */
export class TutorGateway {
  readonly #client: TutorGatewayClient;
  readonly #aisbRoot: string;
  readonly #permissionsProfile: string;
  readonly #instructionSourceRequirements: readonly InstructionSourceRequirement[];
  readonly #baseInstructions: string | undefined;
  readonly #developerInstructions: string | undefined;
  readonly #defaultModel: string | undefined;
  readonly #defaultEffort: ReasoningEffort | undefined;
  readonly #turnTimeoutMs: number;
  readonly #interruptCompletionTimeoutMs: number;
  readonly #dynamicTools: readonly DynamicToolSpec[];
  readonly #verifiedThreads = new Set<string>();
  readonly #activeThreads = new Set<string>();

  public constructor(client: TutorGatewayClient, options: Readonly<TutorGatewayOptions>) {
    if (!isAbsolute(options.aisbRoot)) {
      throw new TutorGatewayError("aisbRoot must be an absolute path");
    }
    this.#client = client;
    this.#aisbRoot = normalize(resolve(options.aisbRoot));
    this.#permissionsProfile = requireNonEmptyValue(
      options.permissionsProfile,
      "permissionsProfile",
    );
    const configuredSources = options.requiredInstructionSources;
    this.#instructionSourceRequirements = Object.freeze(
      configuredSources === undefined
        ? [
            {
              label: normalizeExpectedSource("AGENTS.md", this.#aisbRoot),
              // The AISB checkout intentionally symlinks AGENTS.md to CLAUDE.md;
              // app-server may expose either the discovered or canonical path.
              alternatives: Object.freeze([
                normalizeExpectedSource("AGENTS.md", this.#aisbRoot),
                normalizeExpectedSource("CLAUDE.md", this.#aisbRoot),
              ]),
            },
          ]
        : configuredSources.map((source) => {
            const normalized = normalizeExpectedSource(source, this.#aisbRoot);
            return { label: normalized, alternatives: Object.freeze([normalized]) };
          }),
    );
    this.#baseInstructions = options.baseInstructions;
    this.#developerInstructions = options.developerInstructions;
    this.#defaultModel = options.defaultModel;
    this.#defaultEffort = options.defaultEffort;
    this.#dynamicTools = Object.freeze([...(options.dynamicTools ?? [])]);
    this.#turnTimeoutMs = positiveInteger(
      options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
      "turnTimeoutMs",
    );
    this.#interruptCompletionTimeoutMs = positiveInteger(
      options.interruptCompletionTimeoutMs ?? DEFAULT_INTERRUPT_COMPLETION_TIMEOUT_MS,
      "interruptCompletionTimeoutMs",
    );
  }

  /** Retrieve the bounded, paginated picker catalog. */
  public async listModels(): Promise<readonly Model[]> {
    const models: Model[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;

    for (let page = 0; page < MAX_CATALOG_PAGES; page += 1) {
      const response = await this.#client.listModels({
        limit: DEFAULT_CATALOG_PAGE_LIMIT,
        ...(cursor === null ? {} : { cursor }),
      });
      models.push(...response.data);
      if (response.nextCursor === null) return Object.freeze(models);
      if (seenCursors.has(response.nextCursor)) {
        throw new TutorGatewayError("Codex model pagination repeated a cursor");
      }
      seenCursors.add(response.nextCursor);
      cursor = response.nextCursor;
    }
    throw new TutorGatewayError(`Codex model pagination exceeded ${MAX_CATALOG_PAGES} pages`);
  }

  public async startThread(
    input: Readonly<TutorThreadStartInput> = {},
  ): Promise<ThreadStartResponse> {
    await this.#verifyPermissionProfileAllowed();
    const response = await this.#client.startThread({
      cwd: this.#aisbRoot,
      runtimeWorkspaceRoots: [this.#aisbRoot],
      approvalPolicy: "never",
      approvalsReviewer: "user",
      permissions: this.#permissionsProfile,
      ephemeral: input.ephemeral ?? false,
      ...(this.#dynamicTools.length === 0 ? {} : { dynamicTools: [...this.#dynamicTools] }),
      ...optionalString("model", input.model ?? this.#defaultModel),
      ...optionalString("baseInstructions", input.baseInstructions ?? this.#baseInstructions),
      ...optionalString(
        "developerInstructions",
        input.developerInstructions ?? this.#developerInstructions,
      ),
    });
    this.#verifyThreadResponse(response);
    this.#verifiedThreads.add(response.thread.id);
    return response;
  }

  public async resumeThread(
    input: Readonly<TutorThreadResumeInput>,
  ): Promise<ThreadResumeResponse> {
    requireNonEmpty(input.threadId, "threadId");
    await this.#verifyPermissionProfileAllowed();
    let response: ThreadResumeResponse;
    try {
      response = await this.#client.resumeThread({
        threadId: input.threadId,
        cwd: this.#aisbRoot,
        runtimeWorkspaceRoots: [this.#aisbRoot],
        approvalPolicy: "never",
        approvalsReviewer: "user",
        permissions: this.#permissionsProfile,
        ...optionalString("model", input.model ?? this.#defaultModel),
        ...optionalString("baseInstructions", input.baseInstructions ?? this.#baseInstructions),
        ...optionalString(
          "developerInstructions",
          input.developerInstructions ?? this.#developerInstructions,
        ),
      });
    } catch (error) {
      if (isAuthoritativeMissingThreadResume(error, input.threadId)) {
        throw new TutorThreadNotFoundError(input.threadId, { cause: error });
      }
      throw error;
    }
    this.#verifyThreadResponse(response);
    this.#verifiedThreads.add(response.thread.id);
    return response;
  }

  public readThread(threadId: string, includeTurns = true): Promise<ThreadReadResponse> {
    requireNonEmpty(threadId, "threadId");
    return this.#client.readThread({ threadId, includeTurns });
  }

  /**
   * Finds one persisted turn by the browser idempotency ID without trusting the
   * frozen user envelope. Both turn and item pagination are exhausted so a
   * summary/not-loaded view can never be mistaken for a missing or empty turn.
   */
  public async recoverTurnByClientMessageId(
    threadId: string,
    clientUserMessageId: string,
  ): Promise<RecoveredTutorTurn | null> {
    requireNonEmpty(threadId, "threadId");
    requireNonEmpty(clientUserMessageId, "clientUserMessageId");
    let cursor: string | null | undefined;
    const seenCursors = new Set<string>();

    for (let pageNumber = 0; pageNumber < MAX_RECOVERY_PAGES; pageNumber += 1) {
      const page = await this.#client.listThreadTurns({
        threadId,
        ...(cursor === undefined ? {} : { cursor }),
        limit: RECOVERY_PAGE_LIMIT,
        sortDirection: "desc",
        itemsView: "full",
      });
      for (const turn of page.data) {
        const items = turn.itemsView === "full"
          ? turn.items
          : await this.#readAllTurnItems(threadId, turn.id);
        if (
          !items.some(
            (item) => item.type === "userMessage" && item.clientId === clientUserMessageId,
          )
        ) {
          continue;
        }
        const recoveredTurn: Turn = {
          ...turn,
          items: [...items],
          itemsView: "full",
        };
        return Object.freeze({ turn: recoveredTurn, text: finalAgentText(recoveredTurn) });
      }

      cursor = page.nextCursor;
      if (cursor === null) return null;
      if (seenCursors.has(cursor)) {
        throw new TutorGatewayError("Codex repeated a tutor-turn recovery cursor");
      }
      seenCursors.add(cursor);
    }
    throw new TutorGatewayError("Tutor-turn recovery exceeded its bounded turn-page limit");
  }

  public isInstructionVerified(threadId: string): boolean {
    return this.#verifiedThreads.has(threadId);
  }

  async #readAllTurnItems(threadId: string, turnId: string): Promise<Turn["items"]> {
    let cursor: string | null | undefined;
    const seenCursors = new Set<string>();
    const items: Turn["items"] = [];
    for (let pageNumber = 0; pageNumber < MAX_RECOVERY_PAGES; pageNumber += 1) {
      const page = await this.#client.listThreadItems({
        threadId,
        turnId,
        ...(cursor === undefined ? {} : { cursor }),
        limit: RECOVERY_PAGE_LIMIT,
        sortDirection: "asc",
      });
      for (const entry of page.data) {
        if (entry.turnId !== turnId) {
          throw new TutorGatewayError("Codex returned an item for the wrong recovered turn");
        }
        items.push(entry.item);
      }
      cursor = page.nextCursor;
      if (cursor === null) return items;
      if (seenCursors.has(cursor)) {
        throw new TutorGatewayError("Codex repeated a tutor-item recovery cursor");
      }
      seenCursors.add(cursor);
    }
    throw new TutorGatewayError("Tutor-turn recovery exceeded its bounded item-page limit");
  }

  public async runTurn(input: Readonly<TutorTurnInput>): Promise<TutorTurnResult> {
    requireNonEmpty(input.threadId, "threadId");
    requireNonEmpty(input.text, "text");
    if (!this.#verifiedThreads.has(input.threadId)) {
      throw new TutorGatewayError(
        "Resume this Codex thread through the tutor gateway before sending a turn",
      );
    }
    if (this.#activeThreads.has(input.threadId)) {
      throw new TutorGatewayError("Only one active tutor turn is allowed per thread");
    }
    if (input.signal?.aborted === true) {
      throw new TutorTurnAbortedError(input.threadId, "not-started");
    }

    this.#activeThreads.add(input.threadId);
    let expectedTurnId: string | null = null;
    let completionTimer: NodeJS.Timeout | undefined;
    let interruptCompletionTimer: NodeJS.Timeout | undefined;
    let interruptReason: TutorTurnAbortedError | TutorTurnTimeoutError | null = null;
    let interruptRequest: Promise<void> | null = null;
    let terminal = false;
    let startedDelivered = false;
    const earlyNotifications: AppServerNotification[] = [];
    let resolveCompletion!: (turn: Turn) => void;
    let rejectCompletion!: (error: Error) => void;
    const completion = new Promise<Turn>((resolvePromise, rejectPromise) => {
      resolveCompletion = resolvePromise;
      rejectCompletion = rejectPromise;
    });

    const rejectOnce = (error: Error): void => {
      if (terminal) return;
      terminal = true;
      rejectCompletion(error);
    };
    const resolveOnce = (turn: Turn): void => {
      if (terminal) return;
      terminal = true;
      resolveCompletion(turn);
    };
    const deliver = (event: TutorTurnEvent): void => {
      try {
        input.onEvent?.(event);
      } catch (error) {
        rejectOnce(
          new TutorGatewayError("Tutor event consumer failed", {
            cause: error,
          }),
        );
      }
    };

    const handleNotification = (notification: AppServerNotification): void => {
      const identity = notificationIdentity(notification);
      if (identity === null || identity.threadId !== input.threadId) return;
      if (expectedTurnId === null) {
        earlyNotifications.push(notification);
        return;
      }
      if (identity.turnId !== expectedTurnId) return;

      const params = asObject(notification.params);
      switch (notification.method) {
        case "turn/started":
          if (!startedDelivered) {
            startedDelivered = true;
            deliver({
              type: "turn-started",
              threadId: input.threadId,
              turnId: expectedTurnId,
            });
          }
          break;
        case "item/agentMessage/delta": {
          const delta = typeof params?.delta === "string" ? params.delta : null;
          const itemId = typeof params?.itemId === "string" ? params.itemId : null;
          if (delta === null || itemId === null) return;
          deliver({
            type: "text-delta",
            threadId: input.threadId,
            turnId: expectedTurnId,
            itemId,
            delta,
          });
          break;
        }
        case "error": {
          const error = asObject(params?.error);
          const message = typeof error?.message === "string" ? error.message : "Codex turn error";
          deliver({
            type: "turn-error",
            threadId: input.threadId,
            turnId: expectedTurnId,
            message,
            willRetry: params?.willRetry === true,
          });
          break;
        }
        case "turn/completed": {
          const turn = params?.turn;
          if (!isTurn(turn) || turn.id !== expectedTurnId) return;
          resolveOnce(turn);
          break;
        }
      }
    };

    const removeNotification = this.#client.onNotification(handleNotification);
    const removePolicyFault = this.#client.onPolicyFault((fault) => {
      deliver({ type: "policy-fault", method: fault.method, message: fault.message });
      rejectOnce(new TutorPolicyFaultError(fault));
    });

    const interrupt = (
      error: TutorTurnAbortedError | TutorTurnTimeoutError,
    ): Promise<void> => {
      if (expectedTurnId === null) {
        interruptReason ??= error;
        return Promise.resolve();
      }
      if (interruptRequest !== null) return interruptRequest;
      interruptReason = error;
      interruptRequest = (async () => {
        if (terminal) return;
        try {
          await this.#client.interruptTurn({
            threadId: input.threadId,
            turnId: expectedTurnId,
          });
        } catch {
          // Without an acknowledged interrupt or terminal notification the
          // turn remains uncertain; preserve the initiating failure.
          rejectOnce(error);
          return;
        }
        if (terminal) return;
        if (error instanceof TutorTurnTimeoutError) {
          rejectOnce(error);
          return;
        }
        interruptCompletionTimer = setTimeout(() => {
          rejectOnce(error);
        }, this.#interruptCompletionTimeoutMs);
        interruptCompletionTimer.unref?.();
      })();
      return interruptRequest;
    };

    const handleAbort = (): void => {
      const turnId = expectedTurnId ?? "starting";
      void interrupt(new TutorTurnAbortedError(input.threadId, turnId));
    };
    input.signal?.addEventListener("abort", handleAbort, { once: true });

    try {
      const startResponse = await this.#client.startTurn({
        threadId: input.threadId,
        input: [{ type: "text", text: input.text, text_elements: [] }],
        cwd: this.#aisbRoot,
        runtimeWorkspaceRoots: [this.#aisbRoot],
        approvalPolicy: "never",
        approvalsReviewer: "user",
        permissions: this.#permissionsProfile,
        ...optionalString("clientUserMessageId", input.clientUserMessageId),
        ...optionalString("model", input.model ?? this.#defaultModel),
        ...optionalValue("effort", input.effort ?? this.#defaultEffort),
        ...optionalValue("outputSchema", input.outputSchema),
      });
      expectedTurnId = startResponse.turn.id;
      if (!startedDelivered) {
        startedDelivered = true;
        deliver({
          type: "turn-started",
          threadId: input.threadId,
          turnId: expectedTurnId,
        });
      }
      for (const notification of earlyNotifications) handleNotification(notification);

      completionTimer = setTimeout(() => {
        if (expectedTurnId === null) return;
        void interrupt(
          new TutorTurnTimeoutError(input.threadId, expectedTurnId, this.#turnTimeoutMs),
        );
      }, this.#turnTimeoutMs);
      completionTimer.unref?.();
      if (isAborted(input.signal) && !terminal) handleAbort();

      const turn = await completion;
      // Delta notifications are transient presentation events and do not carry
      // the agent-message phase. Persist only the completed turn's final items
      // so normal completion and restart recovery project identical text and
      // never leak interim commentary into the learner-visible transcript.
      const text = finalAgentText(turn);
      if (turn.status === "interrupted") {
        // TypeScript does not observe assignments made by the interrupt
        // callback across the await above. Widen explicitly before inspecting
        // the caller-owned terminal reason.
        const terminalReason = interruptReason as Error | null;
        if (terminalReason instanceof TutorTurnTimeoutError) throw terminalReason;
        if (terminalReason instanceof TutorTurnAbortedError) {
          throw new TutorTurnInterruptedError(input.threadId, turn.id, turn);
        }
        throw new TutorTurnInterruptedError(input.threadId, turn.id, turn);
      }
      if (turn.status !== "completed") {
        const message = turn.error?.message ?? `turn ended with status ${turn.status}`;
        deliver({
          type: "turn-error",
          threadId: input.threadId,
          turnId: turn.id,
          message,
          willRetry: false,
        });
        throw new TutorTurnFailedError(input.threadId, turn.id, message);
      }
      const result: TutorTurnResult = {
        threadId: input.threadId,
        turnId: turn.id,
        status: turn.status,
        text,
        turn,
      };
      deliver({
        type: "turn-completed",
        threadId: result.threadId,
        turnId: result.turnId,
        status: result.status,
        text: result.text,
      });
      return result;
    } finally {
      if (completionTimer !== undefined) clearTimeout(completionTimer);
      if (interruptCompletionTimer !== undefined) clearTimeout(interruptCompletionTimer);
      input.signal?.removeEventListener("abort", handleAbort);
      removeNotification();
      removePolicyFault();
      this.#activeThreads.delete(input.threadId);
    }
  }

  public interruptTurn(threadId: string, turnId: string): Promise<TurnInterruptResponse> {
    requireNonEmpty(threadId, "threadId");
    requireNonEmpty(turnId, "turnId");
    return this.#client.interruptTurn({ threadId, turnId });
  }

  #verifyThreadResponse(response: ThreadStartResponse | ThreadResumeResponse): void {
    const responseCwd = normalize(resolve(String(response.cwd)));
    if (responseCwd !== this.#aisbRoot) {
      throw new TutorGatewayError(
        `Codex thread cwd escaped the AISB root: ${String(response.cwd)}`,
      );
    }
    if (response.activePermissionProfile?.id !== this.#permissionsProfile) {
      throw new PermissionProfileVerificationError(
        this.#permissionsProfile,
        "not_applied",
        response.activePermissionProfile?.id ?? null,
      );
    }
    const observed = response.instructionSources.map((source) =>
      normalizeExpectedSource(String(source), this.#aisbRoot),
    );
    const observedSet = new Set(observed);
    const missing = this.#instructionSourceRequirements
      .filter(
        (requirement) =>
          !requirement.alternatives.some((alternative) => observedSet.has(alternative)),
      )
      .map(
        (requirement) => requirement.label,
    );
    if (missing.length > 0) {
      throw new InstructionSourceVerificationError(
        Object.freeze(missing),
        Object.freeze(observed),
      );
    }
  }

  async #verifyPermissionProfileAllowed(): Promise<void> {
    const seenCursors = new Set<string>();
    let cursor: string | null = null;

    for (let page = 0; page < MAX_CATALOG_PAGES; page += 1) {
      const response = await this.#client.permissionProfileList({
        cwd: this.#aisbRoot,
        limit: DEFAULT_CATALOG_PAGE_LIMIT,
        ...(cursor === null ? {} : { cursor }),
      });
      const profile = response.data.find(
        (candidate) => candidate.id === this.#permissionsProfile,
      );
      if (profile !== undefined) {
        if (!profile.allowed) {
          throw new PermissionProfileVerificationError(
            this.#permissionsProfile,
            "not_allowed",
          );
        }
        return;
      }
      if (response.nextCursor === null) {
        throw new PermissionProfileVerificationError(this.#permissionsProfile, "missing");
      }
      if (seenCursors.has(response.nextCursor)) {
        throw new PermissionProfileVerificationError(
          this.#permissionsProfile,
          "pagination",
        );
      }
      seenCursors.add(response.nextCursor);
      cursor = response.nextCursor;
    }
    throw new PermissionProfileVerificationError(this.#permissionsProfile, "pagination");
  }
}

function notificationIdentity(
  notification: Readonly<AppServerNotification>,
): { threadId: string; turnId: string } | null {
  const params = asObject(notification.params);
  if (params === null || typeof params.threadId !== "string") return null;
  if (typeof params.turnId === "string") {
    return { threadId: params.threadId, turnId: params.turnId };
  }
  const turn = asObject(params.turn);
  if (turn !== null && typeof turn.id === "string") {
    return { threadId: params.threadId, turnId: turn.id };
  }
  return null;
}

function isTurn(value: unknown): value is Turn {
  const turn = asObject(value);
  return (
    turn !== null &&
    typeof turn.id === "string" &&
    Array.isArray(turn.items) &&
    (turn.status === "completed" ||
      turn.status === "interrupted" ||
      turn.status === "failed" ||
      turn.status === "inProgress")
  );
}

function finalAgentText(turn: Readonly<Turn>): string {
  return turn.items
    // Older providers may omit phase, so retain unknown-phase assistant text
    // for compatibility while never projecting explicit interim commentary.
    .flatMap((item) =>
      item.type === "agentMessage" && item.phase !== "commentary" ? [item.text] : [],
    )
    .join("\n\n");
}

function normalizeExpectedSource(source: string, aisbRoot: string): string {
  requireNonEmpty(source, "instruction source");
  return normalize(isAbsolute(source) ? resolve(source) : resolve(aisbRoot, source));
}

function optionalString<Key extends string>(
  key: Key,
  value: string | undefined,
): { [Property in Key]?: string } {
  return value === undefined ? {} : ({ [key]: value } as { [Property in Key]: string });
}

function optionalValue<Key extends string, Value>(
  key: Key,
  value: Value | undefined,
): { [Property in Key]?: Value } {
  return value === undefined ? {} : ({ [key]: value } as { [Property in Key]: Value });
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requireNonEmpty(value: string, name: string): void {
  if (value.trim().length === 0) throw new TutorGatewayError(`${name} must not be empty`);
}

function requireNonEmptyValue(value: string, name: string): string {
  requireNonEmpty(value, name);
  return value.trim();
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TutorGatewayError(`${name} must be a positive safe integer`);
  }
  return value;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
