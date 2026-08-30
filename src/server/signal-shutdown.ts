export type ShutdownSignal = "SIGINT" | "SIGTERM";

export interface SignalShutdownHost {
  readonly addListener: (signal: ShutdownSignal, listener: () => void) => void;
  readonly removeListener: (signal: ShutdownSignal, listener: () => void) => void;
  readonly setExitCode: (exitCode: number) => void;
  readonly reportError: (error: unknown) => void;
}

export interface InstalledSignalShutdown {
  /** Idempotent seam used by both signal handlers and focused tests. */
  readonly request: (signal: ShutdownSignal) => Promise<void>;
  readonly dispose: () => void;
}

const nodeProcessHost: SignalShutdownHost = {
  addListener(signal, listener) {
    process.on(signal, listener);
  },
  removeListener(signal, listener) {
    process.off(signal, listener);
  },
  setExitCode(exitCode) {
    process.exitCode = exitCode;
  },
  reportError(error) {
    process.stderr.write(
      `AISB Companion shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  },
};

const exitCodeForSignal: Readonly<Record<ShutdownSignal, number>> = Object.freeze({
  SIGINT: 130,
  SIGTERM: 143,
});

/**
 * Close the HTTP server exactly once before allowing Node to leave naturally.
 * Setting the conventional signal exit code preserves shell/service semantics
 * while Fastify's onClose hooks finish shutting down its Codex children.
 */
export function installSignalShutdown(
  close: () => void | Promise<void>,
  host: SignalShutdownHost = nodeProcessHost,
): InstalledSignalShutdown {
  let shutdown: Promise<void> | null = null;
  let disposed = false;

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    host.removeListener("SIGINT", onSigint);
    host.removeListener("SIGTERM", onSigterm);
  };

  const request = (signal: ShutdownSignal): Promise<void> => {
    if (shutdown !== null) return shutdown;
    host.setExitCode(exitCodeForSignal[signal]);
    shutdown = Promise.resolve()
      .then(close)
      .catch((error: unknown) => {
        host.reportError(error);
      })
      .finally(dispose);
    return shutdown;
  };

  const onSigint = () => {
    void request("SIGINT");
  };
  const onSigterm = () => {
    void request("SIGTERM");
  };

  host.addListener("SIGINT", onSigint);
  host.addListener("SIGTERM", onSigterm);
  return Object.freeze({ request, dispose });
}
