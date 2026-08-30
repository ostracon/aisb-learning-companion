import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const envSchema = z.object({
  AISB_REPO_PATH: z.string().trim().min(1).optional(),
  AISB_COMPANION_STATE_PATH: z.string().trim().min(1).optional(),
  PORT: z.coerce.number().int().min(1).max(65_535).default(7_575),
  HOST: z.literal("127.0.0.1").default("127.0.0.1"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export interface RuntimeConfig {
  companionRoot: string;
  aisbRoot: string;
  stateRoot: string;
  host: "127.0.0.1";
  port: number;
  mode: "development" | "test" | "production";
  imageGenerationAvailable: boolean;
  codexExecutable: string;
}

function isCompanionRoot(candidate: string): boolean {
  const packagePath = join(candidate, "package.json");
  if (!existsSync(packagePath)) return false;
  try {
    const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as { name?: string };
    return parsed.name === "aisb-learning-companion";
  } catch {
    return false;
  }
}

export function findCompanionRoot(start = dirname(fileURLToPath(import.meta.url))): string {
  let candidate = resolve(start);
  for (;;) {
    if (isCompanionRoot(candidate)) return realpathSync(candidate);
    const parent = dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  throw new Error(`Could not locate the companion repository above ${start}`);
}

function resolveFromRoot(value: string, root: string): string {
  return realpathSync(isAbsolute(value) ? value : resolve(root, value));
}

export function validateAisbRoot(candidate: string, companionRoot: string): string {
  const resolved = realpathSync(candidate);
  if (resolved === companionRoot) {
    throw new Error("AISB and companion repositories must be separate roots");
  }
  if (!existsSync(join(resolved, ".git")) || !existsSync(join(resolved, "build-instructions.sh"))) {
    throw new Error(`AISB_REPO_PATH does not identify an AISB checkout: ${resolved}`);
  }
  return resolved;
}

export function resolveRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env,
  start?: string,
): RuntimeConfig {
  const parsed = envSchema.parse(environment);
  const companionRoot = findCompanionRoot(start);
  const aisbCandidate = resolveFromRoot(parsed.AISB_REPO_PATH ?? "../aisb", companionRoot);
  const aisbRoot = validateAisbRoot(aisbCandidate, companionRoot);
  const stateCandidate = parsed.AISB_COMPANION_STATE_PATH
    ? isAbsolute(parsed.AISB_COMPANION_STATE_PATH)
      ? parsed.AISB_COMPANION_STATE_PATH
      : resolve(companionRoot, parsed.AISB_COMPANION_STATE_PATH)
    : join(homedir(), "Library", "Application Support", "AISB Learning Companion");

  return {
    companionRoot,
    aisbRoot,
    stateRoot: resolve(stateCandidate),
    host: parsed.HOST,
    port: parsed.PORT,
    mode: parsed.NODE_ENV,
    imageGenerationAvailable: Boolean(environment.CODEX_OPENAI_API_KEY?.trim()),
    codexExecutable: join(companionRoot, "node_modules", ".bin", "codex"),
  };
}

const inheritedChildKeys = [
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PATH",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TERM",
  "COLORTERM",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
] as const;

export function sanitizedChildEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  additions: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of inheritedChildKeys) {
    const value = environment[key];
    if (value) result[key] = value;
  }
  for (const [key, value] of Object.entries(additions)) result[key] = value;
  return result;
}
