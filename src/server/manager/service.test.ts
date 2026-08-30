import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { ManagerContextProjection } from "../../shared/manager.js";
import type { RuntimeConfig } from "../config.js";
import { TutorSessionLogStore } from "../tutor/session-log-store.js";
import {
  MANAGER_MODEL,
  ManagerService,
  type ManagerGatewayPort,
} from "./service.js";

const context: ManagerContextProjection = {
  schema: "aisb-learning-companion.manager-context.v1",
  generatedAt: "2026-08-30T10:00:00.000Z",
  schedule: { revision: "schedule:r1", events: [] },
  outcomes: [{
    outcomeId: "outcome:1",
    versionId: "version:1",
    sectionId: "1.1",
    category: "security",
    text: "Explain a trust boundary.",
    checked: false,
  }],
  notes: [],
  approvedContinuity: [],
  preparedReferences: [],
  priorTutorChats: [],
  reviewSummaries: [],
  omissions: [],
};

describe("ManagerService", () => {
  it("persists a bounded context-only turn and resumes its manager scope", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "aisb-manager-"));
    const sessionStore = new TutorSessionLogStore(stateRoot);
    const gateway: ManagerGatewayPort = {
      isInstructionVerified: () => true,
      startThread: vi.fn(async () => ({ thread: { id: "manager-thread:1" } })),
      resumeThread: vi.fn(async ({ threadId }) => ({ thread: { id: threadId } })),
      recoverTurnByClientMessageId: vi.fn(async () => null),
      runTurn: vi.fn(async (input) => ({
        threadId: input.threadId,
        turnId: "manager-turn:1",
        text: "Revisit the trust-boundary outcome, then explain it in your own words. [Outcome: 1.1]",
      })),
    };
    const config: RuntimeConfig = {
      companionRoot: "/companion",
      aisbRoot: "/aisb",
      stateRoot,
      host: "127.0.0.1",
      port: 7575,
      mode: "test",
      imageGenerationAvailable: false,
      codexExecutable: "/codex",
    };
    const service = new ManagerService(
      config,
      { build: async () => context } as never,
      sessionStore,
      undefined,
      async () => ({ client: { close: vi.fn() }, gateway }),
    );

    const response = await service.runTurn({
      clientUserMessageId: "manager-message:1",
      message: "What should I revisit next?",
    });
    expect(response.message).toContain("trust-boundary outcome");
    expect(response.contextHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(gateway.runTurn).toHaveBeenCalledWith(expect.objectContaining({
      model: MANAGER_MODEL,
      effort: "medium",
      text: expect.stringContaining("aisb-learning-companion.manager-context.v1"),
    }));

    const history = await service.readSession();
    expect(history.messages.map((entry) => entry.role)).toEqual(["user", "assistant"]);
    expect(history.messages[0]?.text).toBe("What should I revisit next?");
    expect(history.unresolvedTurn).toBeNull();
    await service.close();
  });

  it("refuses a concurrent manager send", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "aisb-manager-"));
    const sessionStore = new TutorSessionLogStore(stateRoot);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const gateway: ManagerGatewayPort = {
      isInstructionVerified: () => true,
      startThread: async () => ({ thread: { id: "manager-thread:1" } }),
      resumeThread: async ({ threadId }) => ({ thread: { id: threadId } }),
      recoverTurnByClientMessageId: async () => null,
      runTurn: async (input) => {
        await pending;
        return { threadId: input.threadId, turnId: "manager-turn:1", text: "Done." };
      },
    };
    const config = {
      companionRoot: "/companion",
      aisbRoot: "/aisb",
      stateRoot,
      host: "127.0.0.1",
      port: 7575,
      mode: "test",
      imageGenerationAvailable: false,
      codexExecutable: "/codex",
    } satisfies RuntimeConfig;
    const service = new ManagerService(
      config,
      { build: async () => context } as never,
      sessionStore,
      undefined,
      async () => ({ client: { close() {} }, gateway }),
    );
    const first = service.runTurn({ clientUserMessageId: "message:1", message: "First" });
    await expect(service.runTurn({ clientUserMessageId: "message:2", message: "Second" }))
      .rejects.toMatchObject({ statusCode: 409 });
    release();
    await first;
    await service.close();
  });

  it("fails closed after restart while a durable manager submission is unresolved", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "aisb-manager-"));
    const sessionStore = new TutorSessionLogStore(stateRoot);
    await sessionStore.bindScope({
      scopeKey: "manager:overall",
      chatId: "manager-chat:1",
      threadId: "manager-thread:1",
      model: MANAGER_MODEL,
      permissionProfile: "aisb-review",
    });
    await sessionStore.recordSubmission({
      scopeKey: "manager:overall",
      chatId: "manager-chat:1",
      threadId: "manager-thread:1",
      turnNonce: "manager-message:pending",
      text: "This may still be running",
      contextHash: `sha256:${"a".repeat(64)}`,
    });
    const gateway: ManagerGatewayPort = {
      isInstructionVerified: () => true,
      startThread: vi.fn(async () => ({ thread: { id: "manager-thread:2" } })),
      resumeThread: vi.fn(async ({ threadId }) => ({ thread: { id: threadId } })),
      recoverTurnByClientMessageId: vi.fn(async () => null),
      runTurn: vi.fn(async (input) => ({
        threadId: input.threadId,
        turnId: "manager-turn:new",
        text: "Should not run",
      })),
    };
    const config = {
      companionRoot: "/companion",
      aisbRoot: "/aisb",
      stateRoot,
      host: "127.0.0.1",
      port: 7575,
      mode: "test",
      imageGenerationAvailable: false,
      codexExecutable: "/codex",
    } satisfies RuntimeConfig;
    const service = new ManagerService(
      config,
      { build: async () => context } as never,
      sessionStore,
      undefined,
      async () => ({ client: { close() {} }, gateway }),
    );

    const pendingSession = await service.readSession();
    expect(pendingSession.unresolvedTurn).toEqual({ submittedAt: expect.any(String) });

    await expect(service.runTurn({
      clientUserMessageId: "manager-message:new",
      message: "Can I send another?",
    })).rejects.toMatchObject({ statusCode: 409 });
    expect(gateway.recoverTurnByClientMessageId).toHaveBeenCalledWith(
      "manager-thread:1",
      "manager-message:pending",
    );
    expect(gateway.runTurn).not.toHaveBeenCalled();
    await service.close();
  });

  it("keeps each whole-day review in a distinct durable scope and native thread", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "aisb-day-manager-"));
    const sessionStore = new TutorSessionLogStore(stateRoot);
    let threadSequence = 0;
    const gateway: ManagerGatewayPort = {
      isInstructionVerified: () => true,
      startThread: vi.fn(async () => ({ thread: { id: `day-thread:${++threadSequence}` } })),
      resumeThread: vi.fn(async ({ threadId }) => ({ thread: { id: threadId } })),
      recoverTurnByClientMessageId: vi.fn(async () => null),
      runTurn: vi.fn(async (input) => ({
        threadId: input.threadId,
        turnId: `turn:${input.threadId}`,
        text: "One focused review move.",
      })),
    };
    const config = {
      companionRoot: "/companion",
      aisbRoot: "/aisb",
      stateRoot,
      host: "127.0.0.1",
      port: 7575,
      mode: "test",
      imageGenerationAvailable: false,
      codexExecutable: "/codex",
    } satisfies RuntimeConfig;
    const connect = async () => ({ client: { close() {} }, gateway });
    const dayRetrieval = {} as never;
    const day1 = new ManagerService(
      config,
      { build: async () => ({ schema: "day1-map" }) },
      sessionStore,
      undefined,
      connect,
      null,
      { dayId: "day1", dayReviewRetrieval: dayRetrieval },
    );
    const day2 = new ManagerService(
      config,
      { build: async () => ({ schema: "day2-map" }) },
      sessionStore,
      undefined,
      connect,
      null,
      { dayId: "day2", dayReviewRetrieval: dayRetrieval },
    );

    const first = await day1.runTurn({ clientUserMessageId: "day1:message:1", message: "Review Day 1" });
    const second = await day2.runTurn({ clientUserMessageId: "day2:message:1", message: "Review Day 2" });
    expect(first.threadId).not.toBe(second.threadId);
    expect((await sessionStore.readScope("manager:day:day1"))?.messages).toHaveLength(2);
    expect((await sessionStore.readScope("manager:day:day2"))?.messages).toHaveLength(2);
    expect(await sessionStore.readScope("manager:overall")).toBeNull();
    await day1.close();
    await day2.close();
  });
});
