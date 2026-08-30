import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import type {
  AppServerNotification,
  AppServerPolicyFault,
} from "./app-server-client.js";
import { AppServerRequestError } from "./app-server-client.js";
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
import type { ThreadItem } from "./generated/v2/ThreadItem.js";
import type { Turn } from "./generated/v2/Turn.js";
import type { TurnInterruptParams } from "./generated/v2/TurnInterruptParams.js";
import type { TurnInterruptResponse } from "./generated/v2/TurnInterruptResponse.js";
import type { TurnStartParams } from "./generated/v2/TurnStartParams.js";
import type { TurnStartResponse } from "./generated/v2/TurnStartResponse.js";
import {
  InstructionSourceVerificationError,
  PermissionProfileVerificationError,
  TutorGateway,
  TutorGatewayError,
  TutorThreadNotFoundError,
  TutorPolicyFaultError,
  TutorTurnFailedError,
  TutorTurnInterruptedError,
  TutorTurnTimeoutError,
  isAuthoritativeMissingThreadResume,
  type TutorGatewayClient,
  type TutorTurnEvent,
} from "./tutor-gateway.js";

const AISB_ROOT = "/workspace/aisb";
const AGENTS_PATH = `${AISB_ROOT}/AGENTS.md`;
const PERMISSIONS_PROFILE = "aisb-tutor";

class FakeGatewayClient implements TutorGatewayClient {
  readonly events = new EventEmitter();
  readonly listModelsCalls: ModelListParams[] = [];
  readonly permissionProfileListCalls: PermissionProfileListParams[] = [];
  readonly startThreadCalls: ThreadStartParams[] = [];
  readonly resumeThreadCalls: ThreadResumeParams[] = [];
  readonly listThreadTurnsCalls: ThreadTurnsListParams[] = [];
  readonly listThreadItemsCalls: ThreadItemsListParams[] = [];
  readonly startTurnCalls: TurnStartParams[] = [];
  readonly interruptTurnCalls: TurnInterruptParams[] = [];
  modelPages: ModelListResponse[] = [{ data: [], nextCursor: null }];
  permissionProfilePages: PermissionProfileListResponse[] = [
    {
      data: [{ id: PERMISSIONS_PROFILE, description: "AISB tutor", allowed: true }],
      nextCursor: null,
    },
  ];
  threadTurnPages: ThreadTurnsListResponse[] = [
    { data: [], nextCursor: null, backwardsCursor: null },
  ];
  threadItemPages: ThreadItemsListResponse[] = [
    { data: [], nextCursor: null, backwardsCursor: null },
  ];
  threadStartResponse = makeThreadStartResponse([AGENTS_PATH]);
  threadResumeResponse = makeThreadResumeResponse([AGENTS_PATH]);
  resumeThreadImpl: (params: Readonly<ThreadResumeParams>) => Promise<ThreadResumeResponse> =
    async () => this.threadResumeResponse;
  startTurnImpl: (params: Readonly<TurnStartParams>) => Promise<TurnStartResponse> = async () => ({
    turn: makeTurn("turn-1", "inProgress"),
  });

  public async listModels(params: Readonly<ModelListParams> = {}): Promise<ModelListResponse> {
    this.listModelsCalls.push({ ...params });
    const page = this.modelPages.shift();
    if (page === undefined) throw new Error("no fake model page");
    return page;
  }

  public async permissionProfileList(
    params: Readonly<PermissionProfileListParams> = {},
  ): Promise<PermissionProfileListResponse> {
    this.permissionProfileListCalls.push({ ...params });
    const page = this.permissionProfilePages.shift();
    if (page === undefined) throw new Error("no fake permission profile page");
    return page;
  }

  public async startThread(params: Readonly<ThreadStartParams>): Promise<ThreadStartResponse> {
    this.startThreadCalls.push({ ...params });
    return this.threadStartResponse;
  }

  public async resumeThread(params: Readonly<ThreadResumeParams>): Promise<ThreadResumeResponse> {
    this.resumeThreadCalls.push({ ...params });
    return this.resumeThreadImpl(params);
  }

  public async readThread(_params: Readonly<ThreadReadParams>): Promise<ThreadReadResponse> {
    return { thread: this.threadStartResponse.thread };
  }

  public async listThreadTurns(
    params: Readonly<ThreadTurnsListParams>,
  ): Promise<ThreadTurnsListResponse> {
    this.listThreadTurnsCalls.push({ ...params });
    const page = this.threadTurnPages.shift();
    if (page === undefined) throw new Error("no fake tutor-turn page");
    return page;
  }

  public async listThreadItems(
    params: Readonly<ThreadItemsListParams>,
  ): Promise<ThreadItemsListResponse> {
    this.listThreadItemsCalls.push({ ...params });
    const page = this.threadItemPages.shift();
    if (page === undefined) throw new Error("no fake tutor-item page");
    return page;
  }

  public async startTurn(params: Readonly<TurnStartParams>): Promise<TurnStartResponse> {
    this.startTurnCalls.push({ ...params });
    return this.startTurnImpl(params);
  }

  public async interruptTurn(
    params: Readonly<TurnInterruptParams>,
  ): Promise<TurnInterruptResponse> {
    this.interruptTurnCalls.push({ ...params });
    return {};
  }

  public onNotification(listener: (notification: AppServerNotification) => void): () => void {
    this.events.on("notification", listener);
    return () => this.events.off("notification", listener);
  }

  public onPolicyFault(listener: (fault: AppServerPolicyFault) => void): () => void {
    this.events.on("policy", listener);
    return () => this.events.off("policy", listener);
  }

  public notify(method: string, params: unknown): void {
    this.events.emit("notification", { method, params } satisfies AppServerNotification);
  }

  public policyFault(method: string): void {
    this.events.emit("policy", {
      kind: "policy",
      method,
      requestId: "approval-1",
      message: `disallowed ${method}`,
    } satisfies AppServerPolicyFault);
  }
}

function makeThreadStartResponse(instructionSources: string[]): ThreadStartResponse {
  return {
    thread: makeThread("thread-1"),
    model: "gpt-5.6-sol",
    modelProvider: "openai",
    serviceTier: null,
    cwd: AISB_ROOT,
    runtimeWorkspaceRoots: [AISB_ROOT],
    instructionSources,
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "readOnly", networkAccess: false },
    activePermissionProfile: { id: PERMISSIONS_PROFILE, extends: ":read-only" },
    reasoningEffort: "high",
    multiAgentMode: "explicitRequestOnly",
  } as unknown as ThreadStartResponse;
}

function makeThreadResumeResponse(instructionSources: string[]): ThreadResumeResponse {
  return {
    ...makeThreadStartResponse(instructionSources),
    initialTurnsPage: null,
  } as unknown as ThreadResumeResponse;
}

function makeThread(id: string): ThreadStartResponse["thread"] {
  return {
    id,
    sessionId: `session-${id}`,
    forkedFromId: null,
    parentThreadId: null,
    preview: "",
    ephemeral: false,
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 1,
    recencyAt: 1,
    status: { type: "idle" },
    path: null,
    cwd: AISB_ROOT,
    cliVersion: "0.151.0",
    source: { custom: "aisb-learning-companion" },
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
  } as unknown as ThreadStartResponse["thread"];
}

function makeTurn(id: string, status: Turn["status"], text?: string): Turn {
  return {
    id,
    items:
      text === undefined
        ? []
        : [{
            type: "agentMessage",
            id: "message-1",
            text,
            phase: null,
            memoryCitation: null,
            delivery: null,
          }],
    itemsView: "full",
    status,
    error: null,
    startedAt: 1,
    completedAt: status === "inProgress" ? null : 2,
    durationMs: status === "inProgress" ? null : 1_000,
  };
}

function makeTurnWithItems(
  id: string,
  status: Turn["status"],
  items: ThreadItem[],
  itemsView: Turn["itemsView"] = "full",
): Turn {
  return {
    ...makeTurn(id, status),
    items,
    itemsView,
  };
}

function makeUserMessage(
  id: string,
  clientId: string,
  text = "frozen context and learner message",
): ThreadItem {
  return {
    type: "userMessage",
    id,
    clientId,
    content: [{ type: "text", text, text_elements: [] }],
  };
}

function makeAgentMessage(
  id: string,
  text: string,
  phase: "commentary" | "final_answer" | null = "final_answer",
): ThreadItem {
  return {
    type: "agentMessage",
    id,
    text,
    phase,
    memoryCitation: null,
    delivery: null,
  };
}

describe("TutorGateway thread safety", () => {
  it("classifies only the exact observed missing-rollout resume response", () => {
    const exact = new AppServerRequestError(
      "thread/resume",
      -32600,
      "no rollout found for thread id thread-1",
      undefined,
    );
    expect(isAuthoritativeMissingThreadResume(exact, "thread-1")).toBe(true);
    expect(isAuthoritativeMissingThreadResume(exact, "thread-2")).toBe(false);
    expect(isAuthoritativeMissingThreadResume(
      new AppServerRequestError("thread/read", -32600, exact.detail, undefined),
      "thread-1",
    )).toBe(false);
    expect(isAuthoritativeMissingThreadResume(
      new AppServerRequestError("thread/resume", -32600, "thread not loaded: thread-1", undefined),
      "thread-1",
    )).toBe(false);
    expect(isAuthoritativeMissingThreadResume(
      new AppServerRequestError("thread/resume", -32000, exact.detail, undefined),
      "thread-1",
    )).toBe(false);
  });

  it("starts a named-profile thread rooted at AISB and verifies AGENTS.md", async () => {
    const client = new FakeGatewayClient();
    const gateway = new TutorGateway(client, {
      aisbRoot: AISB_ROOT,
      permissionsProfile: PERMISSIONS_PROFILE,
      developerInstructions: "Teach with progressive help.",
      defaultModel: "gpt-5.6-sol",
    });

    const response = await gateway.startThread();

    expect(response.thread.id).toBe("thread-1");
    expect(gateway.isInstructionVerified("thread-1")).toBe(true);
    expect(client.startThreadCalls).toEqual([
      expect.objectContaining({
        cwd: AISB_ROOT,
        runtimeWorkspaceRoots: [AISB_ROOT],
        approvalPolicy: "never",
        approvalsReviewer: "user",
        permissions: PERMISSIONS_PROFILE,
        model: "gpt-5.6-sol",
        developerInstructions: "Teach with progressive help.",
      }),
    ]);
    expect(client.startThreadCalls[0]).not.toHaveProperty("sandbox");
    expect(client.permissionProfileListCalls).toEqual([
      { cwd: AISB_ROOT, limit: 100 },
    ]);
  });

  it("refuses to mark a thread usable when required instruction sources are absent", async () => {
    const client = new FakeGatewayClient();
    client.threadStartResponse = makeThreadStartResponse([`${AISB_ROOT}/UNRELATED.md`]);
    const gateway = new TutorGateway(client, {
      aisbRoot: AISB_ROOT,
      permissionsProfile: PERMISSIONS_PROFILE,
    });

    await expect(gateway.startThread()).rejects.toBeInstanceOf(
      InstructionSourceVerificationError,
    );
    expect(gateway.isInstructionVerified("thread-1")).toBe(false);
  });

  it("accepts the canonical CLAUDE.md target of the AISB AGENTS.md symlink", async () => {
    const client = new FakeGatewayClient();
    client.threadStartResponse = makeThreadStartResponse([`${AISB_ROOT}/CLAUDE.md`]);
    const gateway = new TutorGateway(client, {
      aisbRoot: AISB_ROOT,
      permissionsProfile: PERMISSIONS_PROFILE,
    });

    await gateway.startThread();

    expect(gateway.isInstructionVerified("thread-1")).toBe(true);
  });

  it("re-verifies instruction sources when resuming a persisted thread", async () => {
    const client = new FakeGatewayClient();
    const gateway = new TutorGateway(client, {
      aisbRoot: AISB_ROOT,
      permissionsProfile: PERMISSIONS_PROFILE,
    });

    await gateway.resumeThread({ threadId: "thread-1" });

    expect(gateway.isInstructionVerified("thread-1")).toBe(true);
    expect(client.resumeThreadCalls[0]).toMatchObject({
      threadId: "thread-1",
      cwd: AISB_ROOT,
      approvalPolicy: "never",
      permissions: PERMISSIONS_PROFILE,
    });
    expect(client.resumeThreadCalls[0]).not.toHaveProperty("sandbox");
  });

  it("maps only an exact missing rollout to the dedicated replacement signal", async () => {
    const client = new FakeGatewayClient();
    client.resumeThreadImpl = async ({ threadId }) => {
      throw new AppServerRequestError(
        "thread/resume",
        -32600,
        `no rollout found for thread id ${threadId}`,
        undefined,
      );
    };
    const gateway = new TutorGateway(client, {
      aisbRoot: AISB_ROOT,
      permissionsProfile: PERMISSIONS_PROFILE,
    });

    await expect(gateway.resumeThread({ threadId: "thread-1" })).rejects.toMatchObject({
      name: "TutorThreadNotFoundError",
      threadId: "thread-1",
    } satisfies Partial<TutorThreadNotFoundError>);

    client.permissionProfilePages = [
      {
        data: [{ id: PERMISSIONS_PROFILE, description: "AISB tutor", allowed: true }],
        nextCursor: null,
      },
    ];
    client.resumeThreadImpl = async () => {
      throw new AppServerRequestError(
        "thread/resume",
        -32600,
        "failed to load configuration",
        undefined,
      );
    };
    await expect(gateway.resumeThread({ threadId: "thread-1" })).rejects.toBeInstanceOf(
      AppServerRequestError,
    );
  });

  it("collects every bounded model page", async () => {
    const client = new FakeGatewayClient();
    client.modelPages = [
      { data: [{ id: "model-1" } as never], nextCursor: "page-2" },
      { data: [{ id: "model-2" } as never], nextCursor: null },
    ];
    const gateway = new TutorGateway(client, {
      aisbRoot: AISB_ROOT,
      permissionsProfile: PERMISSIONS_PROFILE,
    });

    await expect(gateway.listModels()).resolves.toEqual([
      expect.objectContaining({ id: "model-1" }),
      expect.objectContaining({ id: "model-2" }),
    ]);
    expect(client.listModelsCalls).toEqual([
      { limit: 100 },
      { limit: 100, cursor: "page-2" },
    ]);
  });

  it.each([
    ["missing", { data: [], nextCursor: null }],
    [
      "not allowed",
      {
        data: [{ id: PERMISSIONS_PROFILE, description: null, allowed: false }],
        nextCursor: null,
      },
    ],
  ])("denies thread start when the required profile is %s", async (_label, page) => {
    const client = new FakeGatewayClient();
    client.permissionProfilePages = [page as PermissionProfileListResponse];
    const gateway = new TutorGateway(client, {
      aisbRoot: AISB_ROOT,
      permissionsProfile: PERMISSIONS_PROFILE,
    });

    await expect(gateway.startThread()).rejects.toBeInstanceOf(
      PermissionProfileVerificationError,
    );
    expect(client.startThreadCalls).toHaveLength(0);
  });

  it("denies a server response that silently applies another permission profile", async () => {
    const client = new FakeGatewayClient();
    client.threadStartResponse = {
      ...makeThreadStartResponse([AGENTS_PATH]),
      activePermissionProfile: { id: ":workspace", extends: null },
    };
    const gateway = new TutorGateway(client, {
      aisbRoot: AISB_ROOT,
      permissionsProfile: PERMISSIONS_PROFILE,
    });

    await expect(gateway.startThread()).rejects.toMatchObject({
      reason: "not_applied",
      observedProfile: ":workspace",
    });
    expect(gateway.isInstructionVerified("thread-1")).toBe(false);
  });

  it("rejects an empty profile instead of falling back to sandbox defaults", () => {
    const client = new FakeGatewayClient();

    expect(
      () =>
        new TutorGateway(client, {
          aisbRoot: AISB_ROOT,
          permissionsProfile: "  ",
        }),
    ).toThrow(/permissionsProfile/);
  });
});

describe("TutorGateway persisted-turn recovery", () => {
  it("finds an idempotent turn on a later turn page", async () => {
    const client = new FakeGatewayClient();
    client.threadTurnPages = [
      {
        data: [
          makeTurnWithItems("turn-newer", "completed", [
            makeUserMessage("user-newer", "another-client-id"),
            makeAgentMessage("agent-newer", "A newer answer"),
          ]),
        ],
        nextCursor: "older-turns",
        backwardsCursor: null,
      },
      {
        data: [
          makeTurnWithItems("turn-target", "completed", [
            makeUserMessage("user-target", "client-message-target"),
            makeAgentMessage("agent-target", "Recovered answer"),
          ]),
        ],
        nextCursor: null,
        backwardsCursor: "newer-turns",
      },
    ];
    const gateway = new TutorGateway(client, {
      aisbRoot: AISB_ROOT,
      permissionsProfile: PERMISSIONS_PROFILE,
    });

    await expect(
      gateway.recoverTurnByClientMessageId("thread-1", "client-message-target"),
    ).resolves.toMatchObject({
      turn: { id: "turn-target", itemsView: "full" },
      text: "Recovered answer",
    });
    expect(client.listThreadTurnsCalls).toEqual([
      {
        threadId: "thread-1",
        limit: 100,
        sortDirection: "desc",
        itemsView: "full",
      },
      {
        threadId: "thread-1",
        cursor: "older-turns",
        limit: 100,
        sortDirection: "desc",
        itemsView: "full",
      },
    ]);
    expect(client.listThreadItemsCalls).toHaveLength(0);
  });

  it("hydrates a partial turn across every item page before matching it", async () => {
    const client = new FakeGatewayClient();
    client.threadTurnPages = [
      {
        data: [makeTurnWithItems("turn-target", "completed", [], "summary")],
        nextCursor: null,
        backwardsCursor: null,
      },
    ];
    client.threadItemPages = [
      {
        data: [
          {
            turnId: "turn-target",
            item: makeUserMessage("user-target", "client-message-target"),
          },
        ],
        nextCursor: "remaining-items",
        backwardsCursor: null,
      },
      {
        data: [
          {
            turnId: "turn-target",
            item: makeAgentMessage("agent-target", "Answer from hydrated items"),
          },
        ],
        nextCursor: null,
        backwardsCursor: "earlier-items",
      },
    ];
    const gateway = new TutorGateway(client, {
      aisbRoot: AISB_ROOT,
      permissionsProfile: PERMISSIONS_PROFILE,
    });

    const recovered = await gateway.recoverTurnByClientMessageId(
      "thread-1",
      "client-message-target",
    );

    expect(recovered).toMatchObject({
      turn: {
        id: "turn-target",
        itemsView: "full",
        items: [
          { type: "userMessage", clientId: "client-message-target" },
          { type: "agentMessage", text: "Answer from hydrated items" },
        ],
      },
      text: "Answer from hydrated items",
    });
    expect(client.listThreadItemsCalls).toEqual([
      {
        threadId: "thread-1",
        turnId: "turn-target",
        limit: 100,
        sortDirection: "asc",
      },
      {
        threadId: "thread-1",
        turnId: "turn-target",
        cursor: "remaining-items",
        limit: 100,
        sortDirection: "asc",
      },
    ]);
  });

  it("rejects a repeated turn cursor instead of looping", async () => {
    const client = new FakeGatewayClient();
    client.threadTurnPages = [
      { data: [], nextCursor: "cycle", backwardsCursor: null },
      { data: [], nextCursor: "cycle", backwardsCursor: null },
    ];
    const gateway = new TutorGateway(client, {
      aisbRoot: AISB_ROOT,
      permissionsProfile: PERMISSIONS_PROFILE,
    });

    await expect(
      gateway.recoverTurnByClientMessageId("thread-1", "client-message-target"),
    ).rejects.toThrow("Codex repeated a tutor-turn recovery cursor");
    expect(client.listThreadTurnsCalls).toHaveLength(2);
  });

  it("rejects a repeated item cursor instead of looping while hydrating", async () => {
    const client = new FakeGatewayClient();
    client.threadTurnPages = [
      {
        data: [makeTurnWithItems("turn-partial", "completed", [], "notLoaded")],
        nextCursor: null,
        backwardsCursor: null,
      },
    ];
    client.threadItemPages = [
      { data: [], nextCursor: "cycle", backwardsCursor: null },
      { data: [], nextCursor: "cycle", backwardsCursor: null },
    ];
    const gateway = new TutorGateway(client, {
      aisbRoot: AISB_ROOT,
      permissionsProfile: PERMISSIONS_PROFILE,
    });

    await expect(
      gateway.recoverTurnByClientMessageId("thread-1", "client-message-target"),
    ).rejects.toThrow("Codex repeated a tutor-item recovery cursor");
    expect(client.listThreadItemsCalls).toHaveLength(2);
  });

  it("returns null after exhausting all turn pages without a matching client id", async () => {
    const client = new FakeGatewayClient();
    client.threadTurnPages = [
      {
        data: [
          makeTurnWithItems("turn-other", "completed", [
            makeUserMessage("user-other", "another-client-id"),
            makeAgentMessage("agent-other", "Another answer"),
          ]),
        ],
        nextCursor: null,
        backwardsCursor: null,
      },
    ];
    const gateway = new TutorGateway(client, {
      aisbRoot: AISB_ROOT,
      permissionsProfile: PERMISSIONS_PROFILE,
    });

    await expect(
      gateway.recoverTurnByClientMessageId("thread-1", "client-message-target"),
    ).resolves.toBeNull();
    expect(client.listThreadItemsCalls).toHaveLength(0);
  });

  it("projects only final assistant text, never the frozen user envelope or commentary", async () => {
    const frozenEnvelope = "SECRET_FROZEN_ENVELOPE_WITH_PRIVATE_NOTES";
    const client = new FakeGatewayClient();
    client.threadTurnPages = [
      {
        data: [
          makeTurnWithItems("turn-target", "completed", [
            makeUserMessage("user-target", "client-message-target", frozenEnvelope),
            makeAgentMessage("commentary", "Interim reasoning for the learner", "commentary"),
            makeAgentMessage("final", "Safe final tutor reply", "final_answer"),
          ]),
        ],
        nextCursor: null,
        backwardsCursor: null,
      },
    ];
    const gateway = new TutorGateway(client, {
      aisbRoot: AISB_ROOT,
      permissionsProfile: PERMISSIONS_PROFILE,
    });

    const recovered = await gateway.recoverTurnByClientMessageId(
      "thread-1",
      "client-message-target",
    );

    expect(recovered?.text).toBe("Safe final tutor reply");
    expect(recovered?.text).not.toContain(frozenEnvelope);
    expect(recovered?.text).not.toContain("Interim reasoning");
  });
});

describe("TutorGateway turns", () => {
  it("streams early text deltas but returns only the completed turn's final text", async () => {
    const client = new FakeGatewayClient();
    const gateway = new TutorGateway(client, {
      aisbRoot: AISB_ROOT,
      permissionsProfile: PERMISSIONS_PROFILE,
    });
    await gateway.startThread();
    client.startTurnImpl = async () => {
      client.notify("turn/started", {
        threadId: "thread-1",
        turn: makeTurn("turn-1", "inProgress"),
      });
      client.notify("item/agentMessage/delta", {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "message-1",
        delta: "Try tracing ",
      });
      client.notify("item/agentMessage/delta", {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "message-1",
        delta: "one token first.",
      });
      client.notify("turn/completed", {
        threadId: "thread-1",
        turn: makeTurnWithItems("turn-1", "completed", [
          makeAgentMessage("commentary", "Try tracing one token first.", "commentary"),
          makeAgentMessage("final", "Fallback final text", "final_answer"),
        ]),
      });
      return { turn: makeTurn("turn-1", "inProgress") };
    };
    const events: TutorTurnEvent[] = [];

    const result = await gateway.runTurn({
      threadId: "thread-1",
      text: "Frozen page context plus user question",
      outputSchema: {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
        additionalProperties: false,
      },
      onEvent: (event) => events.push(event),
    });

    expect(result).toMatchObject({
      threadId: "thread-1",
      turnId: "turn-1",
      status: "completed",
      text: "Fallback final text",
    });
    expect(events.map((event) => event.type)).toEqual([
      "turn-started",
      "text-delta",
      "text-delta",
      "turn-completed",
    ]);
    expect(client.startTurnCalls[0]).toMatchObject({
      threadId: "thread-1",
      cwd: AISB_ROOT,
      runtimeWorkspaceRoots: [AISB_ROOT],
      approvalPolicy: "never",
      permissions: PERMISSIONS_PROFILE,
      outputSchema: {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
        additionalProperties: false,
      },
      input: [{ type: "text", text: "Frozen page context plus user question" }],
    });
    expect(client.startTurnCalls[0]).not.toHaveProperty("sandboxPolicy");
  });

  it("blocks turns for threads whose instruction sources were never verified", async () => {
    const client = new FakeGatewayClient();
    const gateway = new TutorGateway(client, {
      aisbRoot: AISB_ROOT,
      permissionsProfile: PERMISSIONS_PROFILE,
    });

    await expect(
      gateway.runTurn({ threadId: "unknown-thread", text: "hello" }),
    ).rejects.toBeInstanceOf(TutorGatewayError);
    expect(client.startTurnCalls).toHaveLength(0);
  });

  it("rejects the turn when the protocol edge reports a policy fault", async () => {
    const client = new FakeGatewayClient();
    const gateway = new TutorGateway(client, {
      aisbRoot: AISB_ROOT,
      permissionsProfile: PERMISSIONS_PROFILE,
    });
    await gateway.startThread();
    client.startTurnImpl = async () => {
      queueMicrotask(() => client.policyFault("item/commandExecution/requestApproval"));
      return { turn: makeTurn("turn-1", "inProgress") };
    };

    await expect(
      gateway.runTurn({ threadId: "thread-1", text: "do not mutate files" }),
    ).rejects.toBeInstanceOf(TutorPolicyFaultError);
  });

  it("rejects a failed terminal turn without emitting an empty completion", async () => {
    const client = new FakeGatewayClient();
    const gateway = new TutorGateway(client, {
      aisbRoot: AISB_ROOT,
      permissionsProfile: PERMISSIONS_PROFILE,
    });
    await gateway.startThread();
    const failedTurn: Turn = {
      ...makeTurn("turn-1", "failed"),
      error: {
        message: "model execution failed",
        codexErrorInfo: null,
        additionalDetails: null,
        misalignment: null,
      },
    };
    client.startTurnImpl = async () => {
      queueMicrotask(() => {
        client.notify("turn/completed", {
          threadId: "thread-1",
          turn: failedTurn,
        });
      });
      return { turn: makeTurn("turn-1", "inProgress") };
    };
    const events: TutorTurnEvent[] = [];

    await expect(
      gateway.runTurn({
        threadId: "thread-1",
        text: "question",
        onEvent: (event) => events.push(event),
      }),
    ).rejects.toMatchObject({
      name: TutorTurnFailedError.name,
      threadId: "thread-1",
      turnId: "turn-1",
      message: expect.stringContaining("model execution failed"),
    });
    expect(events).toContainEqual({
      type: "turn-error",
      threadId: "thread-1",
      turnId: "turn-1",
      message: "model execution failed",
      willRetry: false,
    });
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: "turn-completed" }),
    );
  });

  it("interrupts and rejects a turn that exceeds its completion deadline", async () => {
    vi.useFakeTimers();
    try {
      const client = new FakeGatewayClient();
      const gateway = new TutorGateway(client, {
        aisbRoot: AISB_ROOT,
        permissionsProfile: PERMISSIONS_PROFILE,
        turnTimeoutMs: 25,
      });
      await gateway.startThread();

      const pending = gateway.runTurn({ threadId: "thread-1", text: "question" });
      const rejection = expect(pending).rejects.toBeInstanceOf(TutorTurnTimeoutError);
      await vi.advanceTimersByTimeAsync(25);

      await rejection;
      expect(client.interruptTurnCalls).toEqual([
        { threadId: "thread-1", turnId: "turn-1" },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for authoritative interrupted completion after a caller stop", async () => {
    const client = new FakeGatewayClient();
    const gateway = new TutorGateway(client, {
      aisbRoot: AISB_ROOT,
      permissionsProfile: PERMISSIONS_PROFILE,
      interruptCompletionTimeoutMs: 1_000,
    });
    await gateway.startThread();
    const controller = new AbortController();

    const pending = gateway.runTurn({
      threadId: "thread-1",
      text: "question",
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(client.startTurnCalls).toHaveLength(1));
    controller.abort();
    await vi.waitFor(() => expect(client.interruptTurnCalls).toEqual([
      { threadId: "thread-1", turnId: "turn-1" },
    ]));

    let settled = false;
    void pending.finally(() => { settled = true; }).catch(() => undefined);
    await Promise.resolve();
    expect(settled).toBe(false);

    client.notify("turn/completed", {
      threadId: "thread-1",
      turn: makeTurn("turn-1", "interrupted"),
    });
    await expect(pending).rejects.toMatchObject({
      name: TutorTurnInterruptedError.name,
      threadId: "thread-1",
      turnId: "turn-1",
    });
  });

  it("keeps an authoritative completion when Stop loses the terminal race", async () => {
    const client = new FakeGatewayClient();
    const gateway = new TutorGateway(client, {
      aisbRoot: AISB_ROOT,
      permissionsProfile: PERMISSIONS_PROFILE,
    });
    await gateway.startThread();
    const controller = new AbortController();

    const pending = gateway.runTurn({
      threadId: "thread-1",
      text: "question",
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(client.startTurnCalls).toHaveLength(1));
    controller.abort();
    await vi.waitFor(() => expect(client.interruptTurnCalls).toHaveLength(1));
    client.notify("turn/completed", {
      threadId: "thread-1",
      turn: makeTurn("turn-1", "completed", "The completed answer"),
    });

    await expect(pending).resolves.toMatchObject({
      status: "completed",
      text: "The completed answer",
    });
  });
});
