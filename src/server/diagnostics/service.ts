import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DiagnosticsView } from "../../shared/api.js";
import { sanitizedChildEnvironment, type RuntimeConfig } from "../config.js";

const execFileAsync = promisify(execFile);

async function runVersion(executable: string, args: string[], cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(executable, args, {
      cwd,
      env: sanitizedChildEnvironment(),
      timeout: 5_000,
      maxBuffer: 32_768,
      encoding: "utf8",
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export class DiagnosticsService {
  constructor(private readonly config: RuntimeConfig) {}

  async read(): Promise<DiagnosticsView> {
    const [codexVersion, aisbHead] = await Promise.all([
      runVersion(this.config.codexExecutable, ["--version"], this.config.companionRoot),
      runVersion("git", ["rev-parse", "HEAD"], this.config.aisbRoot),
    ]);
    const codexAvailable = codexVersion?.startsWith("codex-cli ") ?? false;
    const repositoriesSeparated = this.config.aisbRoot !== this.config.companionRoot;

    return {
      status: codexAvailable && repositoriesSeparated ? "ready" : "degraded",
      nodeVersion: process.version,
      companionRoot: this.config.companionRoot,
      aisbRoot: this.config.aisbRoot,
      stateRoot: this.config.stateRoot,
      repositoriesSeparated,
      aisbHead,
      codex: {
        available: codexAvailable,
        version: codexVersion,
        detail: codexAvailable
          ? "The package-local Codex executable is available. Run the on-demand self-test to check account, model, and restricted profiles."
          : "The package-local Codex executable is unavailable.",
      },
      imageGeneration: {
        available: this.config.imageGenerationAvailable,
        detail: this.config.imageGenerationAvailable
          ? "Available for a separately confirmed visual-aid request."
          : "Unavailable: restart the backend from the environment that provides the application image key.",
      },
    };
  }
}
