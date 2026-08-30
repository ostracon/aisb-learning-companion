import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";

import { sanitizedChildEnvironment } from "../config.js";
import type { RouteRepositoryAdapter } from "./runtime-resolvers.js";

const execFileAsync = promisify(execFile);

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function gitValue(aisbRoot: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], {
    cwd: aisbRoot,
    env: sanitizedChildEnvironment(),
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 32_768,
  });
  const value = stdout.trim();
  if (!value) throw new Error(`Git returned no value for ${args.join(" ")}`);
  return value;
}

export function createVerifiedRepositoryAdapter(aisbRoot: string): RouteRepositoryAdapter {
  return {
    async read() {
      const [canonicalRoot, topLevel, commonGitDirectory, headCommit, instructionPath] =
        await Promise.all([
          realpath(aisbRoot),
          gitValue(aisbRoot, ["rev-parse", "--show-toplevel"]),
          gitValue(aisbRoot, ["rev-parse", "--git-common-dir"]),
          gitValue(aisbRoot, ["rev-parse", "HEAD"]),
          realpath(join(aisbRoot, "AGENTS.md")),
        ]);
      const canonicalTopLevel = await realpath(topLevel);
      if (canonicalTopLevel !== canonicalRoot) {
        throw new Error("AISB repository identity changed while assembling tutor context");
      }
      const relativeInstructionPath = relative(canonicalRoot, instructionPath);
      if (relativeInstructionPath.startsWith("..")) {
        throw new Error("AISB instruction source resolves outside the repository");
      }
      if (!/^[a-f0-9]{40,64}$/u.test(headCommit)) {
        throw new Error("AISB HEAD is not a full commit identifier");
      }
      const instructionContent = await readFile(instructionPath, "utf8");
      return Object.freeze({
        repositoryIdentity: `sha256:${digest(`${canonicalRoot}\0${commonGitDirectory}`)}`,
        headCommit,
        instructionSourceHash: `sha256:${digest(instructionContent)}`,
      });
    },
  };
}
