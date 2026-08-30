import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

import type { InitializeParams } from "./generated/InitializeParams.js";
import type { InitializeResponse } from "./generated/InitializeResponse.js";
import type { CommandExecParams } from "./generated/v2/CommandExecParams.js";
import type { CommandExecResponse } from "./generated/v2/CommandExecResponse.js";
import type { GetAccountParams } from "./generated/v2/GetAccountParams.js";
import type { GetAccountResponse } from "./generated/v2/GetAccountResponse.js";
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
import type { TurnInterruptParams } from "./generated/v2/TurnInterruptParams.js";
import type { TurnInterruptResponse } from "./generated/v2/TurnInterruptResponse.js";
import type { TurnStartParams } from "./generated/v2/TurnStartParams.js";
import type { TurnStartResponse } from "./generated/v2/TurnStartResponse.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_LINE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;
const DEFAULT_MAX_OUTBOUND_BYTES = 2 * 1024 * 1024;

type RequestId = string | number;

export interface AppServerReadable {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
}

export interface AppServerWritable {
  write(chunk: string): boolean;
  end?(): void;
  on(event: "error", listener: (error: Error) => void): unknown;
}

/** Minimal child-process surface, deliberately easy to replace with a fake. */
export interface AppServerProcess {
  readonly stdin: AppServerWritable;
  readonly stdout: AppServerReadable;
  readonly stderr: AppServerReadable;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface AppServerLaunch {
  readonly executable: string;
  readonly args: readonly ["app-server"];
  /** Must be the validated AISB root. */
  readonly cwd: string;
  /** Must already have been allowlisted/sanitized by the caller. */
  readonly env: NodeJS.ProcessEnv;
}

export type AppServerSpawner = (launch: Readonly<AppServerLaunch>) => AppServerProcess;

export interface AppServerClientOptions {
  readonly executable: string;
  readonly cwd: string;
  /** Required: the client intentionally never falls back to ambient process.env. */
  readonly env: NodeJS.ProcessEnv;
  readonly clientInfo?: Readonly<InitializeParams["clientInfo"]>;
  readonly requestTimeoutMs?: number;
  readonly maxLineBytes?: number;
  readonly maxStderrBytes?: number;
  readonly maxOutboundBytes?: number;
  readonly spawn?: AppServerSpawner;
  /**
   * Handles the one application-owned dynamic-tool request surface. Every
   * other server-initiated interaction continues to fail closed.
   */
  readonly dynamicToolHandler?: (params: unknown) => Promise<unknown>;
}

export interface AppServerNotification {
  readonly method: string;
  readonly params: unknown;
}

export interface AppServerFault {
  readonly kind: "protocol" | "policy" | "process";
  readonly message: string;
  readonly method?: string;
  readonly requestId?: RequestId;
  readonly cause?: unknown;
}

export interface AppServerPolicyFault extends AppServerFault {
  readonly kind: "policy";
  readonly method: string;
  readonly requestId: RequestId;
}

export interface StderrSnapshot {
  readonly text: string;
  readonly truncated: boolean;
}

export interface AppServerIdentity {
  readonly userAgent: string;
  readonly platformFamily: string;
  readonly platformOs: string;
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

interface JsonObject {
  readonly [key: string]: unknown;
}

export class AppServerError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class AppServerProtocolError extends AppServerError {}

export class AppServerRequestError extends AppServerError {
  public constructor(
    public readonly method: string,
    public readonly code: number,
    public readonly detail: string,
    public readonly data: unknown,
  ) {
    super(`Codex App Server ${method} failed (${code}): ${detail}`);
  }
}

export class AppServerRequestTimeoutError extends AppServerError {
  public constructor(
    public readonly method: string,
    public readonly timeoutMs: number,
  ) {
    super(`Codex App Server ${method} timed out after ${timeoutMs} ms`);
  }
}

export class AppServerClosedError extends AppServerError {}

/**
 * A version-pinned JSONL client for `codex app-server`.
 *
 * The caller owns path validation and environment sanitization. This class owns
 * only the stdio protocol and never exposes server-originated approval UI.
 */
export class AppServerClient {
  readonly #process: AppServerProcess;
  readonly #events = new EventEmitter();
  readonly #requestTimeoutMs: number;
  readonly #maxLineBytes: number;
  readonly #maxStderrBytes: number;
  readonly #maxOutboundBytes: number;
  readonly #dynamicToolHandler: AppServerClientOptions["dynamicToolHandler"];
  readonly #pending = new Map<string, PendingRequest>();
  #state: "initializing" | "ready" | "closed" = "initializing";
  #nextRequestId = 1;
  #stdoutBuffer = Buffer.alloc(0);
  #stderrBuffer = Buffer.alloc(0);
  #stderrTruncated = false;
  #identity: AppServerIdentity | null = null;

  private constructor(process: AppServerProcess, options: Readonly<AppServerClientOptions>) {
    this.#process = process;
    this.#requestTimeoutMs = positiveInteger(
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      "requestTimeoutMs",
    );
    this.#maxLineBytes = positiveInteger(
      options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES,
      "maxLineBytes",
    );
    this.#maxStderrBytes = positiveInteger(
      options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES,
      "maxStderrBytes",
    );
    this.#maxOutboundBytes = positiveInteger(
      options.maxOutboundBytes ?? DEFAULT_MAX_OUTBOUND_BYTES,
      "maxOutboundBytes",
    );
    this.#dynamicToolHandler = options.dynamicToolHandler;

    process.stdout.on("data", (chunk) => this.#receiveStdout(chunk));
    process.stderr.on("data", (chunk) => this.#receiveStderr(chunk));
    process.stdin.on("error", (error) => this.#handleProcessFailure(error));
    process.on("error", (error) => this.#handleProcessFailure(error));
    process.on("exit", (code, signal) => {
      const detail = signal === null ? `code ${String(code)}` : `signal ${signal}`;
      this.#handleProcessFailure(
        new AppServerClosedError(`Codex App Server exited with ${detail}`),
      );
    });
  }

  public static async connect(
    options: Readonly<AppServerClientOptions>,
  ): Promise<AppServerClient> {
    if (!options.executable || !options.cwd) {
      throw new AppServerError("Codex executable and AISB cwd are required");
    }
    if (options.env === process.env) {
      throw new AppServerError(
        "Pass a separately constructed, sanitized child environment; ambient process.env is forbidden",
      );
    }

    const launch: AppServerLaunch = {
      executable: options.executable,
      args: ["app-server"],
      cwd: options.cwd,
      env: options.env,
    };
    const child = (options.spawn ?? defaultSpawner)(launch);
    const client = new AppServerClient(child, options);
    try {
      await client.#initialize(options.clientInfo);
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }

  public get ready(): boolean {
    return this.#state === "ready";
  }

  public onNotification(listener: (notification: AppServerNotification) => void): () => void {
    this.#events.on("notification", listener);
    return () => this.#events.off("notification", listener);
  }

  public onFault(listener: (fault: AppServerFault) => void): () => void {
    this.#events.on("fault", listener);
    return () => this.#events.off("fault", listener);
  }

  public onPolicyFault(listener: (fault: AppServerPolicyFault) => void): () => void {
    this.#events.on("policy-fault", listener);
    return () => this.#events.off("policy-fault", listener);
  }

  public stderrSnapshot(): StderrSnapshot {
    return {
      text: this.#stderrBuffer.toString("utf8"),
      truncated: this.#stderrTruncated,
    };
  }

  public identity(): AppServerIdentity {
    if (this.#identity === null) {
      throw new AppServerClosedError("Codex App Server identity is unavailable");
    }
    return this.#identity;
  }

  public readAccount(params: Readonly<GetAccountParams> = {}): Promise<GetAccountResponse> {
    return this.#readyRequest("account/read", params);
  }

  public listModels(params: Readonly<ModelListParams> = {}): Promise<ModelListResponse> {
    return this.#readyRequest("model/list", params);
  }

  public permissionProfileList(
    params: Readonly<PermissionProfileListParams> = {},
  ): Promise<PermissionProfileListResponse> {
    return this.#readyRequest("permissionProfile/list", params);
  }

  /** Run a fixed argv vector under an explicitly selected App Server profile. */
  public execCommand(params: Readonly<CommandExecParams>): Promise<CommandExecResponse> {
    return this.#readyRequest("command/exec", params);
  }

  public startThread(params: Readonly<ThreadStartParams>): Promise<ThreadStartResponse> {
    return this.#readyRequest("thread/start", params);
  }

  public resumeThread(params: Readonly<ThreadResumeParams>): Promise<ThreadResumeResponse> {
    return this.#readyRequest("thread/resume", params);
  }

  public readThread(params: Readonly<ThreadReadParams>): Promise<ThreadReadResponse> {
    return this.#readyRequest("thread/read", params);
  }

  public listThreadTurns(
    params: Readonly<ThreadTurnsListParams>,
  ): Promise<ThreadTurnsListResponse> {
    return this.#readyRequest("thread/turns/list", params);
  }

  public listThreadItems(
    params: Readonly<ThreadItemsListParams>,
  ): Promise<ThreadItemsListResponse> {
    return this.#readyRequest("thread/items/list", params);
  }

  public startTurn(params: Readonly<TurnStartParams>): Promise<TurnStartResponse> {
    return this.#readyRequest("turn/start", params);
  }

  public interruptTurn(params: Readonly<TurnInterruptParams>): Promise<TurnInterruptResponse> {
    return this.#readyRequest("turn/interrupt", params);
  }

  public close(): void {
    if (this.#state === "closed") return;
    this.#state = "closed";
    this.#rejectPending(new AppServerClosedError("Codex App Server client closed"));
    try {
      this.#process.stdin.end?.();
    } finally {
      this.#process.kill("SIGTERM");
    }
  }

  async #initialize(
    clientInfo: Readonly<InitializeParams["clientInfo"]> | undefined,
  ): Promise<void> {
    const params: InitializeParams = {
      clientInfo: {
        name: clientInfo?.name ?? "aisb-learning-companion",
        title: clientInfo?.title ?? "AISB Learning Companion",
        version: clientInfo?.version ?? "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        mcpServerOpenaiFormElicitation: false,
      },
    };
    const response = await this.#request<InitializeResponse>("initialize", params, true);
    this.#identity = Object.freeze({
      userAgent: response.userAgent,
      platformFamily: response.platformFamily,
      platformOs: response.platformOs,
    });
    this.#write({ method: "initialized" });
    this.#state = "ready";
  }

  #readyRequest<Result>(method: string, params: unknown): Promise<Result> {
    if (this.#state !== "ready") {
      return Promise.reject(
        new AppServerClosedError(
          this.#state === "closed"
            ? "Codex App Server client is closed"
            : "Codex App Server initialization is incomplete",
        ),
      );
    }
    return this.#request<Result>(method, params, false);
  }

  #request<Result>(method: string, params: unknown, allowInitializing: boolean): Promise<Result> {
    if (this.#state === "closed" || (!allowInitializing && this.#state !== "ready")) {
      return Promise.reject(new AppServerClosedError("Codex App Server is unavailable"));
    }
    const id = `aisb-${this.#nextRequestId++}`;
    return new Promise<Result>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestKey(id));
        reject(new AppServerRequestTimeoutError(method, this.#requestTimeoutMs));
      }, this.#requestTimeoutMs);
      timer.unref?.();
      this.#pending.set(requestKey(id), {
        method,
        resolve: (result) => resolve(result as Result),
        reject,
        timer,
      });
      try {
        this.#write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(requestKey(id));
        reject(error instanceof Error ? error : new AppServerError(String(error)));
      }
    });
  }

  #write(message: Readonly<JsonObject>): void {
    if (this.#state === "closed") {
      throw new AppServerClosedError("Cannot write to a closed Codex App Server");
    }
    let encoded: string;
    try {
      encoded = `${JSON.stringify(message)}\n`;
    } catch (error) {
      throw new AppServerProtocolError("Could not encode Codex App Server request", {
        cause: error,
      });
    }
    if (Buffer.byteLength(encoded, "utf8") > this.#maxOutboundBytes) {
      throw new AppServerProtocolError(
        `Codex App Server request exceeds ${this.#maxOutboundBytes} bytes`,
      );
    }
    this.#process.stdin.write(encoded);
  }

  #receiveStdout(chunk: Buffer | string): void {
    if (this.#state === "closed") return;
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    this.#stdoutBuffer = Buffer.concat([this.#stdoutBuffer, incoming]);

    for (;;) {
      const newline = this.#stdoutBuffer.indexOf(0x0a);
      if (newline < 0) break;
      const rawLine = this.#stdoutBuffer.subarray(0, newline);
      this.#stdoutBuffer = this.#stdoutBuffer.subarray(newline + 1);
      if (rawLine.byteLength > this.#maxLineBytes) {
        this.#fatalProtocol(`Codex App Server line exceeds ${this.#maxLineBytes} bytes`);
        return;
      }
      const line = rawLine.at(-1) === 0x0d ? rawLine.subarray(0, -1) : rawLine;
      if (line.byteLength === 0) continue;
      this.#parseLine(line.toString("utf8"));
      if (this.#isClosed()) return;
    }

    if (this.#stdoutBuffer.byteLength > this.#maxLineBytes) {
      this.#fatalProtocol(`Codex App Server line exceeds ${this.#maxLineBytes} bytes`);
    }
  }

  #parseLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (error) {
      this.#fatalProtocol("Codex App Server emitted malformed JSON", error);
      return;
    }
    if (!isJsonObject(parsed)) {
      this.#fatalProtocol("Codex App Server emitted a non-object JSON message");
      return;
    }

    if (isRequestId(parsed.id) && typeof parsed.method === "string") {
      this.#handleServerRequest(parsed.id, parsed.method, parsed.params);
      return;
    }
    if (isRequestId(parsed.id) && ("result" in parsed || "error" in parsed)) {
      this.#handleResponse(parsed.id, parsed);
      return;
    }
    if (typeof parsed.method === "string" && !("id" in parsed)) {
      this.#events.emit("notification", {
        method: parsed.method,
        params: parsed.params,
      } satisfies AppServerNotification);
      return;
    }
    this.#fatalProtocol("Codex App Server emitted an unrecognized JSON message");
  }

  #handleResponse(id: RequestId, message: JsonObject): void {
    const key = requestKey(id);
    const pending = this.#pending.get(key);
    if (pending === undefined) {
      this.#emitFault({
        kind: "protocol",
        message: `Ignoring response for unknown request ${String(id)}`,
        requestId: id,
      });
      return;
    }
    this.#pending.delete(key);
    clearTimeout(pending.timer);

    if (isJsonObject(message.error)) {
      const code = typeof message.error.code === "number" ? message.error.code : -32_000;
      const detail =
        typeof message.error.message === "string"
          ? message.error.message
          : "Unknown JSON-RPC error";
      pending.reject(
        new AppServerRequestError(pending.method, code, detail, message.error.data),
      );
      return;
    }
    if (!("result" in message)) {
      pending.reject(new AppServerProtocolError(`Missing result for ${pending.method}`));
      return;
    }
    pending.resolve(message.result);
  }

  #handleServerRequest(id: RequestId, method: string, params: unknown): void {
    if (method === "item/tool/call" && this.#dynamicToolHandler !== undefined) {
      void this.#handleDynamicToolRequest(id, params);
      return;
    }
    const fault: AppServerPolicyFault = {
      kind: "policy",
      message: `Codex App Server requested disallowed client interaction: ${method}`,
      method,
      requestId: id,
    };

    const decline = automaticDeclineResult(method);
    if (decline === undefined) {
      this.#write({
        id,
        error: {
          code: -32_001,
          message: "Denied by AISB Learning Companion policy",
        },
      });
    } else {
      this.#write({ id, result: decline });
    }
    this.#events.emit("policy-fault", fault);
    this.#emitFault(fault);
  }

  async #handleDynamicToolRequest(id: RequestId, params: unknown): Promise<void> {
    try {
      const result = await this.#dynamicToolHandler?.(params);
      this.#write({ id, result });
    } catch {
      // A failed visual proposal is a normal tool failure. It must not tear
      // down an otherwise healthy tutor process or expose internal details.
      try {
        this.#write({
          id,
          result: {
            success: false,
            contentItems: [{
              type: "inputText",
              text: "The learning-visual brief could not be prepared. Continue with a prose explanation instead.",
            }],
          },
        });
      } catch {
        // Closing the process while a tool is finishing needs no second fault.
      }
    }
  }

  #receiveStderr(chunk: Buffer | string): void {
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    if (incoming.byteLength >= this.#maxStderrBytes) {
      this.#stderrBuffer = Buffer.from(
        incoming.subarray(incoming.byteLength - this.#maxStderrBytes),
      );
      this.#stderrTruncated = true;
      return;
    }
    const combined = Buffer.concat([this.#stderrBuffer, incoming]);
    if (combined.byteLength > this.#maxStderrBytes) {
      this.#stderrBuffer = combined.subarray(combined.byteLength - this.#maxStderrBytes);
      this.#stderrTruncated = true;
    } else {
      this.#stderrBuffer = combined;
    }
  }

  #fatalProtocol(message: string, cause?: unknown): void {
    const error = new AppServerProtocolError(message, { cause });
    this.#emitFault({ kind: "protocol", message, cause });
    this.#state = "closed";
    this.#rejectPending(error);
    this.#process.kill("SIGTERM");
  }

  #handleProcessFailure(error: Error): void {
    if (this.#state === "closed") return;
    this.#state = "closed";
    this.#emitFault({ kind: "process", message: error.message, cause: error });
    this.#rejectPending(error);
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #emitFault(fault: AppServerFault): void {
    this.#events.emit("fault", fault);
  }

  #isClosed(): boolean {
    return this.#state === "closed";
  }
}

function defaultSpawner(launch: Readonly<AppServerLaunch>): AppServerProcess {
  return spawn(launch.executable, [...launch.args], {
    cwd: launch.cwd,
    env: launch.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AppServerError(`${name} must be a positive safe integer`);
  }
  return value;
}

function requestKey(id: RequestId): string {
  return `${typeof id}:${String(id)}`;
}

function isRequestId(value: unknown): value is RequestId {
  return typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value));
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function automaticDeclineResult(method: string): JsonObject | undefined {
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { decision: "decline" };
    case "applyPatchApproval":
    case "execCommandApproval":
      return { decision: "denied" };
    case "mcpServer/elicitation/request":
      return { action: "decline", content: null, _meta: null };
    default:
      return undefined;
  }
}
