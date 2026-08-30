import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { JsonValue } from "../codex/generated/serde_json/JsonValue.js";
import { AppServerClient } from "../codex/app-server-client.js";
import {
  ensureTutorCodexHome,
  REVIEW_PERMISSION_PROFILE,
  ensureReviewCodexWorkspace,
} from "../codex/runtime-profile.js";
import { TutorGateway, type RecoveredTutorTurn } from "../codex/tutor-gateway.js";
import { sanitizedChildEnvironment, type RuntimeConfig } from "../config.js";
import { TutorThreadBindingStore } from "../tutor/thread-binding-store.js";
import type {
  ReviewCoachGenerator,
  ReviewGenerationRequest,
  ReviewGenerationResult,
} from "./service.js";

export const REVIEW_MODEL = "gpt-5.6-sol";
const REVIEW_EFFORT = "medium" as const;
const REVIEW_BINDING_CAS_ATTEMPTS = 4;

interface ReviewBinding {
  readonly chatId: string;
  readonly threadId: string;
  readonly model: string;
  readonly permissionProfile: string;
}

export interface ReviewCodexGatewayPort {
  isInstructionVerified(threadId: string): boolean;
  startThread(input: {
    readonly ephemeral: boolean;
    readonly model: string;
  }): Promise<{ readonly thread: { readonly id: string } }>;
  resumeThread(input: {
    readonly threadId: string;
    readonly model: string;
  }): Promise<{ readonly thread: { readonly id: string } }>;
  recoverTurnByClientMessageId(
    threadId: string,
    clientUserMessageId: string,
  ): Promise<RecoveredTutorTurn | null>;
  runTurn(input: {
    readonly threadId: string;
    readonly text: string;
    readonly clientUserMessageId: string;
    readonly model: string;
    readonly effort: typeof REVIEW_EFFORT;
    readonly outputSchema: JsonValue;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly threadId: string;
    readonly turnId: string;
    readonly text: string;
  }>;
}

export interface ReviewThreadBindingStorePort {
  readScope(scopeKey: string): Promise<{
    readonly version: string;
    readonly binding: (ReviewBinding & { readonly scopeKey: string }) | null;
    readonly recovered: boolean;
  }>;
  upsert(input: {
    readonly scopeKey: string;
    readonly expectedVersion: string;
    readonly binding: ReviewBinding;
  }): Promise<
    | { readonly status: "saved" | "unchanged"; readonly binding: ReviewBinding }
    | { readonly status: "conflict" }
  >;
}

export interface ReviewCodexGatewayProvider {
  getGateway(): Promise<ReviewCodexGatewayPort>;
  close(): Promise<void>;
}

export class CodexReviewGeneratorError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CodexReviewGeneratorError";
  }
}

function bindingIdentity(
  binding: (ReviewBinding & { readonly scopeKey: string }) | null,
  expectedThreadId: string | null,
): string {
  return JSON.stringify([
    expectedThreadId,
    binding?.scopeKey ?? null,
    binding?.chatId ?? null,
    binding?.threadId ?? null,
    binding?.model ?? null,
    binding?.permissionProfile ?? null,
  ]);
}

/**
 * Resolve a review session to durable metadata for one verified App Server
 * thread. Prompt, response, outcome, and learner-answer bytes are never stored.
 */
export class DurableReviewThreadResolver {
  public constructor(
    private readonly bindingStore: ReviewThreadBindingStorePort,
    private readonly createChatId: () => string = () => `review-chat:${randomUUID()}`,
  ) {}

  public async resolve(
    gateway: ReviewCodexGatewayPort,
    sessionId: string,
    expectedThreadId: string | null,
  ): Promise<ReviewBinding> {
    const scopeKey = `review:${sessionId}`;
    let candidate:
      | { readonly sourceIdentity: string; readonly binding: ReviewBinding }
      | undefined;

    for (let attempt = 0; attempt < REVIEW_BINDING_CAS_ATTEMPTS; attempt += 1) {
      const current = await this.bindingStore.readScope(scopeKey);
      if (
        expectedThreadId !== null &&
        current.binding !== null &&
        current.binding.threadId !== expectedThreadId
      ) {
        throw new CodexReviewGeneratorError(
          "The persisted review thread does not match this active review session.",
        );
      }

      const sourceIdentity = bindingIdentity(current.binding, expectedThreadId);
      if (candidate === undefined || candidate.sourceIdentity !== sourceIdentity) {
        candidate = {
          sourceIdentity,
          binding: await this.#verifiedCandidate(
            gateway,
            current.binding,
            expectedThreadId,
          ),
        };
      }

      const result = await this.bindingStore.upsert({
        scopeKey,
        expectedVersion: current.version,
        binding: candidate.binding,
      });
      if (result.status === "conflict") continue;
      this.#requireVerified(gateway, result.binding.threadId);
      if (expectedThreadId !== null && result.binding.threadId !== expectedThreadId) {
        throw new CodexReviewGeneratorError(
          "The review thread changed before the structured turn could start.",
        );
      }
      return Object.freeze({ ...result.binding });
    }

    throw new CodexReviewGeneratorError(
      "Review continuity changed repeatedly. No review turn was sent; please retry.",
    );
  }

  async #verifiedCandidate(
    gateway: ReviewCodexGatewayPort,
    existing: (ReviewBinding & { readonly scopeKey: string }) | null,
    expectedThreadId: string | null,
  ): Promise<ReviewBinding> {
    const threadId = expectedThreadId ?? existing?.threadId ?? null;
    const chatId = existing?.chatId ?? this.createChatId();
    if (threadId !== null) {
      const metadataMatches =
        existing?.threadId === threadId &&
        existing.model === REVIEW_MODEL &&
        existing.permissionProfile === REVIEW_PERMISSION_PROFILE;
      if (metadataMatches && gateway.isInstructionVerified(threadId)) {
        return this.#binding(chatId, threadId);
      }
      try {
        const resumed = await gateway.resumeThread({ threadId, model: REVIEW_MODEL });
        this.#requireVerified(gateway, resumed.thread.id);
        if (resumed.thread.id !== threadId) {
          throw new CodexReviewGeneratorError(
            "Codex resumed a different review thread than requested.",
          );
        }
        return this.#binding(chatId, threadId);
      } catch (error) {
        if (expectedThreadId !== null) {
          throw new CodexReviewGeneratorError(
            "The active review thread could not be resumed safely. No turn was sent.",
            { cause: error },
          );
        }
        // A stale persisted binding from a session that has not emitted a turn
        // may be replaced under the same local chat identity.
      }
    }

    const started = await gateway.startThread({ ephemeral: false, model: REVIEW_MODEL });
    this.#requireVerified(gateway, started.thread.id);
    return this.#binding(chatId, started.thread.id);
  }

  #binding(chatId: string, threadId: string): ReviewBinding {
    return Object.freeze({
      chatId,
      threadId,
      model: REVIEW_MODEL,
      permissionProfile: REVIEW_PERMISSION_PROFILE,
    });
  }

  #requireVerified(gateway: ReviewCodexGatewayPort, threadId: string): void {
    if (!gateway.isInstructionVerified(threadId)) {
      throw new CodexReviewGeneratorError(
        "Codex did not verify the AISB instructions and review permission profile. No turn was sent.",
      );
    }
  }
}

function payloadHash(payload: ReviewGenerationRequest["payload"]): string {
  try {
    return `sha256:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`;
  } catch (error) {
    throw new CodexReviewGeneratorError(
      "The authorized review disclosure payload is not valid JSON.",
      { cause: error },
    );
  }
}

function asJsonSchema(value: Readonly<Record<string, unknown>>): JsonValue {
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch (error) {
    throw new CodexReviewGeneratorError("The review output schema is not valid JSON.", {
      cause: error,
    });
  }
}

/**
 * Adapter from the review state machine to ordinary App Server `turn/start`.
 * It sends only the exact, authorized prompt and its one-turn output schema.
 */
export class CodexReviewCoachGenerator implements ReviewCoachGenerator {
  readonly #threadResolver: DurableReviewThreadResolver;

  public constructor(
    private readonly provider: ReviewCodexGatewayProvider,
    bindingStore: ReviewThreadBindingStorePort,
  ) {
    this.#threadResolver = new DurableReviewThreadResolver(bindingStore);
  }

  public async generate(
    request: Readonly<ReviewGenerationRequest>,
  ): Promise<ReviewGenerationResult> {
    if (payloadHash(request.payload) !== request.disclosure.payloadHash) {
      throw new CodexReviewGeneratorError(
        "The authorized review disclosure no longer matches its payload.",
      );
    }
    const gateway = await this.provider.getGateway();
    const binding = await this.#threadResolver.resolve(
      gateway,
      request.sessionId,
      request.threadId,
    );
    let turn: { readonly threadId: string; readonly turnId: string; readonly text: string };
    if (request.reconcileOnly) {
      const recovered = await gateway.recoverTurnByClientMessageId(
        binding.threadId,
        request.disclosure.disclosureId,
      );
      if (recovered === null) {
        throw new CodexReviewGeneratorError(
          "The earlier review turn is not yet visible in Codex history. No duplicate turn was sent.",
        );
      }
      if (recovered.turn.status === "inProgress") {
        throw new CodexReviewGeneratorError(
          "The earlier review turn is still running. No duplicate turn was sent.",
        );
      }
      if (recovered.turn.status !== "completed" || recovered.text.trim().length === 0) {
        throw new CodexReviewGeneratorError(
          "The earlier review turn did not produce usable final output. No duplicate turn was sent.",
        );
      }
      turn = {
        threadId: binding.threadId,
        turnId: recovered.turn.id,
        text: recovered.text,
      };
    } else {
      turn = await gateway.runTurn({
        threadId: binding.threadId,
        clientUserMessageId: request.disclosure.disclosureId,
        text: request.payload.prompt,
        model: REVIEW_MODEL,
        effort: REVIEW_EFFORT,
        outputSchema: asJsonSchema(request.payload.outputSchema),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
    }
    if (turn.threadId !== binding.threadId || turn.text.trim().length === 0) {
      throw new CodexReviewGeneratorError(
        "Codex returned no usable structured review response.",
      );
    }
    return Object.freeze({
      threadId: turn.threadId,
      turnId: turn.turnId,
      text: turn.text,
      provenance: Object.freeze({
        engine: "codex-app-server",
        transport: "turn/start",
        model: REVIEW_MODEL,
        permissionProfile: REVIEW_PERMISSION_PROFILE,
        threadId: turn.threadId,
        turnId: turn.turnId,
        disclosureId: request.disclosure.disclosureId,
        payloadHash: request.disclosure.payloadHash,
        outputSchemaApplied: true,
      }),
    });
  }

  public close(): Promise<void> {
    return this.provider.close();
  }
}

interface RuntimeReviewCodexStack {
  readonly client: Pick<AppServerClient, "close">;
  readonly gateway: ReviewCodexGatewayPort;
}

type RuntimeReviewCodexConnector = () => Promise<RuntimeReviewCodexStack>;

export class RuntimeReviewCodexGatewayProvider implements ReviewCodexGatewayProvider {
  #stack: RuntimeReviewCodexStack | null = null;
  #connecting: Promise<RuntimeReviewCodexStack> | null = null;
  #closing = false;
  #closePromise: Promise<void> | null = null;
  readonly #connector: RuntimeReviewCodexConnector;

  public constructor(
    private readonly config: RuntimeConfig,
    connector?: RuntimeReviewCodexConnector,
  ) {
    this.#connector = connector ?? (() => this.#connectLive());
  }

  public async getGateway(): Promise<ReviewCodexGatewayPort> {
    if (this.#closing) {
      throw new CodexReviewGeneratorError("The review service is shutting down.");
    }
    if (this.#stack !== null) return this.#stack.gateway;
    if (this.#connecting === null) this.#connecting = this.#connect();
    const connecting = this.#connecting;
    try {
      const stack = await connecting;
      if (this.#closing) {
        throw new CodexReviewGeneratorError("The review service is shutting down.");
      }
      if (!this.#isPublished(stack)) {
        throw new CodexReviewGeneratorError("The protected review process is unavailable.");
      }
      return stack.gateway;
    } finally {
      if (this.#connecting === connecting) this.#connecting = null;
    }
  }

  public close(): Promise<void> {
    if (this.#closePromise !== null) return this.#closePromise;
    this.#closing = true;
    this.#closePromise = (async () => {
      const clients = new Set<Pick<AppServerClient, "close">>();
      if (this.#stack !== null) clients.add(this.#stack.client);
      if (this.#connecting !== null) {
        try {
          clients.add((await this.#connecting).client);
        } catch {
          // A connection that observes shutdown closes its own child process.
        }
      }
      for (const client of clients) client.close();
      this.#stack = null;
    })();
    return this.#closePromise;
  }

  async #connect(): Promise<RuntimeReviewCodexStack> {
    try {
      const stack = await this.#connector();
      if (this.#closing) {
        stack.client.close();
        throw new CodexReviewGeneratorError("The review service is shutting down.");
      }
      this.#stack = stack;
      return stack;
    } catch (error) {
      if (error instanceof CodexReviewGeneratorError) throw error;
      throw new CodexReviewGeneratorError(
        "The protected review process is unavailable.",
        { cause: error },
      );
    }
  }

  #isPublished(stack: RuntimeReviewCodexStack): boolean {
    return this.#stack === stack;
  }

  async #connectLive(): Promise<RuntimeReviewCodexStack> {
    const [codexHome, reviewWorkspace, developerInstructions] = await Promise.all([
      ensureTutorCodexHome({
        companionRoot: this.config.companionRoot,
        aisbRoot: this.config.aisbRoot,
        stateRoot: this.config.stateRoot,
      }),
      ensureReviewCodexWorkspace({ aisbRoot: this.config.aisbRoot }),
      readFile(
        join(
          this.config.companionRoot,
          "config",
          "prompts",
          "review",
          "developer-prompt.md",
        ),
        "utf8",
      ),
    ]);
    const client = await AppServerClient.connect({
      executable: this.config.codexExecutable,
      cwd: reviewWorkspace.path,
      env: sanitizedChildEnvironment(process.env, { CODEX_HOME: codexHome.path }),
    });
    try {
      const gateway = new TutorGateway(client, {
        aisbRoot: reviewWorkspace.path,
        developerInstructions,
        permissionsProfile: REVIEW_PERMISSION_PROFILE,
        defaultModel: REVIEW_MODEL,
        defaultEffort: REVIEW_EFFORT,
      });
      const stack = { client, gateway };
      client.onFault((fault) => {
        if (fault.kind !== "policy" && this.#stack?.client === client) {
          client.close();
          this.#stack = null;
        }
      });
      return stack;
    } catch (error) {
      client.close();
      throw error;
    }
  }
}

/** Production factory; tests should construct `CodexReviewCoachGenerator` with fakes. */
export function createLiveCodexReviewCoachGenerator(
  config: RuntimeConfig,
  bindingStore: ReviewThreadBindingStorePort = new TutorThreadBindingStore(config.stateRoot),
): CodexReviewCoachGenerator {
  return new CodexReviewCoachGenerator(
    new RuntimeReviewCodexGatewayProvider(config),
    bindingStore,
  );
}
