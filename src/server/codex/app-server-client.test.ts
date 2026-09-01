import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  AppServerClient,
  AppServerProtocolError,
  AppServerRequestTimeoutError,
  type AppServerLaunch,
  type AppServerPolicyFault,
  type AppServerProcess,
} from "./app-server-client.js";

type WireMessage = Record<string, unknown>;

class FakeAppServerProcess extends EventEmitter implements AppServerProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly messages: WireMessage[] = [];
  readonly stdin = Object.assign(new EventEmitter(), {
    write: (chunk: string): boolean => {
      this.#receive(chunk);
      return true;
    },
    end: (): void => undefined,
  });
  onMessage: ((message: WireMessage) => void) | undefined;
  launch: AppServerLaunch | undefined;
  killed = false;
  #input = "";

  public kill(): boolean {
    if (this.killed) return false;
    this.killed = true;
    this.emit("exit", null, "SIGTERM");
    return true;
  }

  public reply(message: WireMessage): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  public replyFragments(...fragments: string[]): void {
    for (const fragment of fragments) this.stdout.write(fragment);
  }

  #receive(chunk: string): void {
    this.#input += chunk;
    for (;;) {
      const newline = this.#input.indexOf("\n");
      if (newline < 0) return;
      const line = this.#input.slice(0, newline);
      this.#input = this.#input.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line) as WireMessage;
      this.messages.push(message);
      this.onMessage?.(message);
    }
  }
}

function connect(
  fake: FakeAppServerProcess,
  options: {
    requestTimeoutMs?: number;
    maxLineBytes?: number;
    maxStderrBytes?: number;
    dynamicToolHandler?: (params: unknown) => Promise<unknown>;
  } = {},
): Promise<AppServerClient> {
  const previous = fake.onMessage;
  fake.onMessage = (message) => {
    if (message.method === "initialize") {
      fake.reply({
        id: message.id,
        result: {
          userAgent: "codex-cli/0.151.0",
          codexHome: "/tmp/codex-home",
          platformFamily: "unix",
          platformOs: "macos",
        },
      });
    }
    previous?.(message);
  };
  return AppServerClient.connect({
    executable: "/companion/node_modules/.bin/codex",
    cwd: "/workspace/aisb",
    env: { PATH: "/bin", HOME: "/tmp/home" },
    spawn: (launch) => {
      fake.launch = launch as AppServerLaunch;
      return fake;
    },
    ...options,
  });
}

describe("AppServerClient", () => {
  it("launches the pinned app-server command and completes initialize before requests", async () => {
    const fake = new FakeAppServerProcess();
    fake.onMessage = (message) => {
      if (message.method === "model/list") {
        fake.reply({ id: message.id, result: { data: [], nextCursor: null } });
      }
    };

    const client = await connect(fake);
    expect(client.ready).toBe(true);
    expect(fake.launch).toEqual({
      executable: "/companion/node_modules/.bin/codex",
      args: ["app-server"],
      cwd: "/workspace/aisb",
      env: { PATH: "/bin", HOME: "/tmp/home" },
    });
    expect(fake.messages.slice(0, 2)).toMatchObject([
      {
        method: "initialize",
        params: {
          clientInfo: { name: "aisb-learning-companion", version: "0.1.0" },
          capabilities: { experimentalApi: true, requestAttestation: false },
        },
      },
      { method: "initialized" },
    ]);

    await expect(client.listModels()).resolves.toEqual({ data: [], nextCursor: null });
    client.close();
  });

  it("correlates concurrent responses even when the server replies out of order", async () => {
    const fake = new FakeAppServerProcess();
    const queued: WireMessage[] = [];
    fake.onMessage = (message) => {
      if (message.method !== "model/list") return;
      queued.push(message);
      if (queued.length === 2) {
        fake.reply({ id: queued[1]?.id, result: { data: [], nextCursor: "second" } });
        fake.reply({ id: queued[0]?.id, result: { data: [], nextCursor: "first" } });
      }
    };
    const client = await connect(fake);

    const first = client.listModels({ cursor: "one" });
    const second = client.listModels({ cursor: "two" });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { data: [], nextCursor: "first" },
      { data: [], nextCursor: "second" },
    ]);
    client.close();
  });

  it("lists named permission profiles through the pinned experimental method", async () => {
    const fake = new FakeAppServerProcess();
    fake.onMessage = (message) => {
      if (message.method === "permissionProfile/list") {
        fake.reply({
          id: message.id,
          result: {
            data: [{ id: "aisb-tutor", description: "AISB tutor", allowed: true }],
            nextCursor: null,
          },
        });
      }
    };
    const client = await connect(fake);

    await expect(
      client.permissionProfileList({ cwd: "/workspace/aisb", limit: 100 }),
    ).resolves.toEqual({
      data: [{ id: "aisb-tutor", description: "AISB tutor", allowed: true }],
      nextCursor: null,
    });
    expect(fake.messages.at(-1)).toMatchObject({
      method: "permissionProfile/list",
      params: { cwd: "/workspace/aisb", limit: 100 },
    });
    client.close();
  });

  it("exposes only the sanitized server identity and typed account state", async () => {
    const fake = new FakeAppServerProcess();
    fake.onMessage = (message) => {
      if (message.method === "account/read") {
        fake.reply({
          id: message.id,
          result: {
            account: { type: "chatgpt", email: "private@example.test", planType: "plus" },
            requiresOpenaiAuth: true,
          },
        });
      }
    };
    const client = await connect(fake);

    expect(client.identity()).toEqual({
      userAgent: "codex-cli/0.151.0",
      platformFamily: "unix",
      platformOs: "macos",
    });
    await expect(client.readAccount({ refreshToken: false })).resolves.toMatchObject({
      account: { type: "chatgpt", planType: "plus" },
      requiresOpenaiAuth: true,
    });
    expect(fake.messages.at(-1)).toMatchObject({
      method: "account/read",
      params: { refreshToken: false },
    });
    client.close();
  });

  it("runs standalone argv under an explicit permission profile", async () => {
    const fake = new FakeAppServerProcess();
    fake.onMessage = (message) => {
      if (message.method === "command/exec") {
        fake.reply({ id: message.id, result: { exitCode: 0, stdout: "42\n", stderr: "" } });
      }
    };
    const client = await connect(fake);

    await expect(
      client.execCommand({
        command: ["/usr/bin/wc", "-c", "/workspace/aisb/README.md"],
        cwd: "/workspace/aisb",
        permissionProfile: "aisb-tutor",
        timeoutMs: 5_000,
        outputBytesCap: 1_024,
      }),
    ).resolves.toEqual({ exitCode: 0, stdout: "42\n", stderr: "" });
    expect(fake.messages.at(-1)).toMatchObject({
      method: "command/exec",
      params: {
        command: ["/usr/bin/wc", "-c", "/workspace/aisb/README.md"],
        cwd: "/workspace/aisb",
        permissionProfile: "aisb-tutor",
      },
    });
    client.close();
  });

  it("times out unanswered requests without consuming a later correlation id", async () => {
    const fake = new FakeAppServerProcess();
    const client = await connect(fake, { requestTimeoutMs: 15 });

    await expect(client.listModels()).rejects.toBeInstanceOf(AppServerRequestTimeoutError);
    client.close();
  });

  it("turns an asynchronous stdin EPIPE into a handled client failure", async () => {
    const fake = new FakeAppServerProcess();
    const client = await connect(fake);
    const faults: string[] = [];
    client.onFault((fault) => faults.push(fault.message));

    const pending = client.listModels();
    const epPipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });

    expect(() => fake.stdin.emit("error", epPipe)).not.toThrow();
    await expect(pending).rejects.toBe(epPipe);
    expect(client.ready).toBe(false);
    expect(faults).toEqual(["write EPIPE"]);
  });

  it("parses fragmented JSONL notifications and keeps only bounded stderr tail bytes", async () => {
    const fake = new FakeAppServerProcess();
    const client = await connect(fake, { maxStderrBytes: 8 });
    const methods: string[] = [];
    client.onNotification((notification) => methods.push(notification.method));

    fake.replyFragments('{"method":"turn/', 'started","params":{"threadId":"t"}}\r', "\n");
    fake.stderr.write("0123456789abcdef");

    expect(methods).toEqual(["turn/started"]);
    expect(client.stderrSnapshot()).toEqual({ text: "89abcdef", truncated: true });
    client.close();
  });

  it.each([
    ["item/commandExecution/requestApproval", { decision: "decline" }],
    ["item/fileChange/requestApproval", { decision: "decline" }],
    ["applyPatchApproval", { decision: "denied" }],
  ])("automatically rejects %s and surfaces a policy fault", async (method, result) => {
    const fake = new FakeAppServerProcess();
    const client = await connect(fake);
    const faults: AppServerPolicyFault[] = [];
    client.onPolicyFault((fault) => faults.push(fault));

    fake.reply({ id: 77, method, params: { command: "unsafe" } });

    expect(fake.messages.at(-1)).toEqual({ id: 77, result });
    expect(faults).toEqual([
      expect.objectContaining({ kind: "policy", method, requestId: 77 }),
    ]);
    client.close();
  });

  it("errors permission escalation requests instead of fabricating a grant", async () => {
    const fake = new FakeAppServerProcess();
    const client = await connect(fake);

    fake.reply({ id: "permission-1", method: "item/permissions/requestApproval", params: {} });

    expect(fake.messages.at(-1)).toEqual({
      id: "permission-1",
      error: {
        code: -32_001,
        message: "Denied by AISB Learning Companion policy",
      },
    });
    client.close();
  });

  it("handles only the explicitly configured application dynamic-tool request", async () => {
    const fake = new FakeAppServerProcess();
    const seen: unknown[] = [];
    const client = await connect(fake, {
      dynamicToolHandler: async (params) => {
        seen.push(params);
        return {
          success: true,
          contentItems: [{ type: "inputText", text: "brief prepared" }],
        };
      },
    });
    const faults: AppServerPolicyFault[] = [];
    client.onPolicyFault((fault) => faults.push(fault));

    fake.reply({
      id: "tool-1",
      method: "item/tool/call",
      params: { threadId: "thread-1", tool: "prepare_learning_visual" },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(seen).toEqual([{ threadId: "thread-1", tool: "prepare_learning_visual" }]);
    expect(fake.messages.at(-1)).toEqual({
      id: "tool-1",
      result: {
        success: true,
        contentItems: [{ type: "inputText", text: "brief prepared" }],
      },
    });
    expect(faults).toEqual([]);
    client.close();
  });

  it("fails closed on malformed or oversized protocol lines", async () => {
    const malformed = new FakeAppServerProcess();
    malformed.onMessage = (message) => {
      if (message.method === "model/list") malformed.stdout.write("{not-json}\n");
    };
    const malformedClient = await connect(malformed);
    await expect(malformedClient.listModels()).rejects.toBeInstanceOf(AppServerProtocolError);
    expect(malformed.killed).toBe(true);

    const oversized = new FakeAppServerProcess();
    oversized.onMessage = (message) => {
      if (message.method === "model/list") oversized.stdout.write("x".repeat(257));
    };
    // The initialize response remains below the limit; the next unterminated line exceeds it.
    const oversizedClient = await connect(oversized, { maxLineBytes: 256 });
    await expect(oversizedClient.listModels()).rejects.toBeInstanceOf(AppServerProtocolError);
    expect(oversized.killed).toBe(true);
  });

  it("accepts a bounded resume-sized response beyond the legacy 2 MiB limit", async () => {
    const fake = new FakeAppServerProcess();
    const largeDisplayName = "x".repeat(3 * 1024 * 1024);
    fake.onMessage = (message) => {
      if (message.method === "model/list") {
        fake.reply({
          id: message.id,
          result: {
            data: [{ id: "large-history-probe", displayName: largeDisplayName }],
            nextCursor: null,
          },
        });
      }
    };

    const client = await connect(fake);
    await expect(client.listModels()).resolves.toMatchObject({
      data: [{ id: "large-history-probe" }],
    });
    expect(fake.killed).toBe(false);
    client.close();
  });
});
