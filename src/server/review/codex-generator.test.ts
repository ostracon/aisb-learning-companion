import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  CodexReviewCoachGenerator,
  CodexReviewGeneratorError,
  DurableReviewThreadResolver,
  REVIEW_MODEL,
  RuntimeReviewCodexGatewayProvider,
  type ReviewCodexGatewayPort,
  type ReviewCodexGatewayProvider,
  type ReviewThreadBindingStorePort,
} from "./codex-generator.js";
import type { RuntimeConfig } from "../config.js";
import type { RecoveredTutorTurn } from "../codex/tutor-gateway.js";
import type { ReviewGenerationRequest } from "./service.js";

class FakeBindingStore implements ReviewThreadBindingStorePort {
  version = 0;
  binding: {
    scopeKey: string;
    chatId: string;
    threadId: string;
    model: string;
    permissionProfile: string;
  } | null = null;

  async readScope(scopeKey: string) {
    return {
      version: `version-${this.version}`,
      binding: this.binding?.scopeKey === scopeKey ? { ...this.binding } : null,
      recovered: false,
    };
  }

  async upsert(input: Parameters<ReviewThreadBindingStorePort["upsert"]>[0]) {
    if (input.expectedVersion !== `version-${this.version}`) {
      return { status: "conflict" as const };
    }
    this.version += 1;
    this.binding = { scopeKey: input.scopeKey, ...input.binding };
    return { status: "saved" as const, binding: { ...input.binding } };
  }
}

class FakeGateway implements ReviewCodexGatewayPort {
  readonly verified = new Set<string>();
  readonly startCalls: unknown[] = [];
  readonly resumeCalls: unknown[] = [];
  readonly recoveryCalls: Array<{ readonly threadId: string; readonly clientUserMessageId: string }> = [];
  readonly turnCalls: Array<Record<string, unknown>> = [];
  recoveredTurn: RecoveredTutorTurn | null = null;
  startVerified = true;
  resumeVerified = true;

  isInstructionVerified(threadId: string): boolean {
    return this.verified.has(threadId);
  }

  async startThread(input: { readonly ephemeral: boolean; readonly model: string }) {
    this.startCalls.push(input);
    if (this.startVerified) this.verified.add("review-thread-1");
    return { thread: { id: "review-thread-1" } };
  }

  async resumeThread(input: { readonly threadId: string; readonly model: string }) {
    this.resumeCalls.push(input);
    if (this.resumeVerified) this.verified.add(input.threadId);
    return { thread: { id: input.threadId } };
  }

  async recoverTurnByClientMessageId(threadId: string, clientUserMessageId: string) {
    this.recoveryCalls.push({ threadId, clientUserMessageId });
    return this.recoveredTurn;
  }

  async runTurn(input: Parameters<ReviewCodexGatewayPort["runTurn"]>[0]) {
    this.turnCalls.push({ ...input });
    return {
      threadId: input.threadId,
      turnId: `turn-${this.turnCalls.length}`,
      text: JSON.stringify({
        kind: "question",
        question: {
          mode: "free_recall",
          prompt: "Explain the boundary.",
          outcome_ids: ["1.1:security:0"],
        },
      }),
    };
  }
}

class FakeProvider implements ReviewCodexGatewayProvider {
  readonly getGateway = vi.fn(async () => this.gateway);
  readonly close = vi.fn(async () => {});

  constructor(readonly gateway: FakeGateway) {}
}

function request(
  overrides: Partial<ReviewGenerationRequest> = {},
): ReviewGenerationRequest {
  const payload = overrides.payload ?? {
    prompt: "Process the server-owned canonical outcome envelope.",
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["kind"],
      properties: { kind: { const: "question" } },
    },
  };
  const hash = `sha256:${createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex")}`;
  return {
    sessionId: "session-1",
    threadId: null,
    reconcileOnly: false,
    disclosure: {
      decision: "allow_once",
      disclosureId: "disclosure-1",
      payloadHash: hash,
    },
    payload,
    ...overrides,
  };
}

describe("CodexReviewCoachGenerator", () => {
  it("uses an ordinary schema-constrained turn on a durable verified Sol thread", async () => {
    const gateway = new FakeGateway();
    const provider = new FakeProvider(gateway);
    const store = new FakeBindingStore();
    const generator = new CodexReviewCoachGenerator(provider, store);
    const input = request();

    const result = await generator.generate(input);

    expect(gateway.startCalls).toEqual([{ ephemeral: false, model: REVIEW_MODEL }]);
    expect(gateway.turnCalls).toEqual([
      expect.objectContaining({
        threadId: "review-thread-1",
        clientUserMessageId: "disclosure-1",
        text: input.payload.prompt,
        model: "gpt-5.6-sol",
        effort: "medium",
        outputSchema: input.payload.outputSchema,
      }),
    ]);
    expect(result).toMatchObject({
      threadId: "review-thread-1",
      turnId: "turn-1",
      provenance: {
        engine: "codex-app-server",
        transport: "turn/start",
        model: "gpt-5.6-sol",
        permissionProfile: "aisb-review",
        disclosureId: "disclosure-1",
        payloadHash: input.disclosure.payloadHash,
        outputSchemaApplied: true,
      },
    });
    expect(store.binding).toMatchObject({
      scopeKey: "review:session-1",
      model: "gpt-5.6-sol",
      permissionProfile: "aisb-review",
    });
  });

  it("keeps later response turns on the same persisted session thread", async () => {
    const gateway = new FakeGateway();
    const store = new FakeBindingStore();
    const generator = new CodexReviewCoachGenerator(new FakeProvider(gateway), store);
    const first = await generator.generate(request());

    await generator.generate(
      request({
        threadId: first.threadId,
        disclosure: {
          decision: "allow_once",
          disclosureId: "disclosure-2",
          payloadHash: request().disclosure.payloadHash,
        },
      }),
    );

    expect(gateway.startCalls).toHaveLength(1);
    expect(gateway.resumeCalls).toHaveLength(0);
    expect(gateway.turnCalls.map((call) => call.threadId)).toEqual([
      "review-thread-1",
      "review-thread-1",
    ]);
  });

  it("recovers a completed stable client message after restart without dispatching again", async () => {
    const gateway = new FakeGateway();
    gateway.recoveredTurn = {
      turn: { id: "recovered-turn-1", status: "completed" } as RecoveredTutorTurn["turn"],
      text: JSON.stringify({
        kind: "question",
        question: {
          mode: "free_recall",
          prompt: "Recovered question.",
          outcome_ids: ["1.1:security:0"],
        },
      }),
    };
    const store = new FakeBindingStore();
    store.binding = {
      scopeKey: "review:session-1",
      chatId: "review-chat:1",
      threadId: "review-thread-1",
      model: REVIEW_MODEL,
      permissionProfile: "aisb-review",
    };
    const generator = new CodexReviewCoachGenerator(new FakeProvider(gateway), store);

    const result = await generator.generate(request({ reconcileOnly: true }));

    expect(gateway.recoveryCalls).toEqual([{
      threadId: "review-thread-1",
      clientUserMessageId: "disclosure-1",
    }]);
    expect(gateway.turnCalls).toHaveLength(0);
    expect(result).toMatchObject({
      threadId: "review-thread-1",
      turnId: "recovered-turn-1",
      provenance: {
        disclosureId: "disclosure-1",
        outputSchemaApplied: true,
      },
    });
  });

  it("fails closed when an attempted operation is not yet visible", async () => {
    const gateway = new FakeGateway();
    const store = new FakeBindingStore();
    store.binding = {
      scopeKey: "review:session-1",
      chatId: "review-chat:1",
      threadId: "review-thread-1",
      model: REVIEW_MODEL,
      permissionProfile: "aisb-review",
    };
    const generator = new CodexReviewCoachGenerator(new FakeProvider(gateway), store);

    await expect(generator.generate(request({ reconcileOnly: true }))).rejects.toThrow(
      /No duplicate turn was sent/u,
    );
    expect(gateway.recoveryCalls).toHaveLength(1);
    expect(gateway.turnCalls).toHaveLength(0);
  });

  it("re-verifies a persisted review binding after process restart", async () => {
    const store = new FakeBindingStore();
    store.binding = {
      scopeKey: "review:session-1",
      chatId: "review-chat:1",
      threadId: "persisted-thread-1",
      model: "gpt-5.6-sol",
      permissionProfile: "aisb-review",
    };
    const gateway = new FakeGateway();
    const resolver = new DurableReviewThreadResolver(store, () => "review-chat:new");

    await expect(
      resolver.resolve(gateway, "session-1", "persisted-thread-1"),
    ).resolves.toMatchObject({ threadId: "persisted-thread-1" });
    expect(gateway.resumeCalls).toEqual([
      { threadId: "persisted-thread-1", model: "gpt-5.6-sol" },
    ]);
  });

  it("rejects disclosure drift and persisted thread drift before starting a turn", async () => {
    const gateway = new FakeGateway();
    const store = new FakeBindingStore();
    const provider = new FakeProvider(gateway);
    const generator = new CodexReviewCoachGenerator(provider, store);
    const original = request();
    const drifted = {
      ...original,
      payload: {
        ...original.payload,
        outputSchema: { type: "object", properties: {} },
      },
    };

    await expect(generator.generate(drifted)).rejects.toBeInstanceOf(
      CodexReviewGeneratorError,
    );
    expect(provider.getGateway).not.toHaveBeenCalled();

    store.binding = {
      scopeKey: "review:session-1",
      chatId: "review-chat:1",
      threadId: "another-thread",
      model: "gpt-5.6-sol",
      permissionProfile: "aisb-review",
    };
    await expect(
      generator.generate(request({ threadId: "expected-thread" })),
    ).rejects.toThrow(/does not match/u);
    expect(gateway.turnCalls).toHaveLength(0);
  });

  it("refuses to publish an unverified review thread", async () => {
    const gateway = new FakeGateway();
    gateway.startVerified = false;
    const generator = new CodexReviewCoachGenerator(
      new FakeProvider(gateway),
      new FakeBindingStore(),
    );

    await expect(generator.generate(request())).rejects.toThrow(/did not verify/u);
    expect(gateway.turnCalls).toHaveLength(0);
  });

  it("closes its provider without persisting any disclosed content", async () => {
    const provider = new FakeProvider(new FakeGateway());
    const generator = new CodexReviewCoachGenerator(provider, new FakeBindingStore());
    await generator.close();
    expect(provider.close).toHaveBeenCalledOnce();
  });

  it("closes a client whose connection finishes after shutdown starts", async () => {
    let finishConnection!: (stack: {
      readonly client: { close(): void };
      readonly gateway: ReviewCodexGatewayPort;
    }) => void;
    const connection = new Promise<{
      readonly client: { close(): void };
      readonly gateway: ReviewCodexGatewayPort;
    }>((resolve) => {
      finishConnection = resolve;
    });
    const closeClient = vi.fn();
    const connector = vi.fn(() => connection);
    const config: RuntimeConfig = {
      companionRoot: process.cwd(),
      aisbRoot: process.cwd(),
      stateRoot: process.cwd(),
      host: "127.0.0.1",
      port: 7_575,
      mode: "test",
      imageGenerationAvailable: false,
      codexExecutable: "codex",
    };
    const provider = new RuntimeReviewCodexGatewayProvider(config, connector);
    const gatewayRequest = provider.getGateway();
    const gatewayRejected = expect(gatewayRequest).rejects.toThrow(/shutting down/u);
    await vi.waitFor(() => expect(connector).toHaveBeenCalledOnce());

    const closing = provider.close();
    expect(provider.close()).toBe(closing);
    finishConnection({ client: { close: closeClient }, gateway: new FakeGateway() });

    await Promise.all([closing, gatewayRejected]);
    expect(closeClient).toHaveBeenCalledOnce();
    await expect(provider.getGateway()).rejects.toThrow(/shutting down/u);
  });
});
