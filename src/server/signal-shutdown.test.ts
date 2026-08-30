import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  installSignalShutdown,
  type ShutdownSignal,
  type SignalShutdownHost,
} from "./signal-shutdown.js";

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

class FakeSignalHost extends EventEmitter implements SignalShutdownHost {
  readonly exitCodes: number[] = [];
  readonly errors: unknown[] = [];

  public addListener(signal: ShutdownSignal, listener: () => void): this {
    return super.addListener(signal, listener);
  }

  public removeListener(signal: ShutdownSignal, listener: () => void): this {
    return super.removeListener(signal, listener);
  }

  public setExitCode(exitCode: number): void {
    this.exitCodes.push(exitCode);
  }

  public reportError(error: unknown): void {
    this.errors.push(error);
  }
}

describe("installSignalShutdown", () => {
  it("awaits one close across repeated signals and preserves the first signal exit code", async () => {
    const host = new FakeSignalHost();
    const closing = deferred();
    const close = vi.fn(() => closing.promise);
    const installed = installSignalShutdown(close, host);

    host.emit("SIGINT");
    host.emit("SIGTERM");
    await Promise.resolve();
    expect(close).toHaveBeenCalledTimes(1);
    expect(host.exitCodes).toEqual([130]);
    expect(host.listenerCount("SIGINT")).toBe(1);

    closing.resolve();
    await installed.request("SIGTERM");

    expect(host.listenerCount("SIGINT")).toBe(0);
    expect(host.listenerCount("SIGTERM")).toBe(0);
    expect(host.errors).toEqual([]);
  });

  it("reports close failures without leaving an unhandled rejection", async () => {
    const host = new FakeSignalHost();
    const failure = new Error("close failed");
    const installed = installSignalShutdown(() => Promise.reject(failure), host);

    await expect(installed.request("SIGTERM")).resolves.toBeUndefined();

    expect(host.exitCodes).toEqual([143]);
    expect(host.errors).toEqual([failure]);
    expect(host.listenerCount("SIGTERM")).toBe(0);
  });
});
