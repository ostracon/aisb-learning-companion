import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const envSchema = z.object({
  AISB_REPO_PATH: z.string().trim().min(1).optional(),
  AISB_COMPANION_STATE_PATH: z.string().trim().min(1).optional(),
  AISB_COMPANION_ALLOW_TEMPORARY_STATE: z.enum(["true", "false"]).default("false"),
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

/**
 * Resolve symlinks in the longest existing prefix while preserving any
 * not-yet-created suffix. State directories do not have to exist at startup,
 * but their existing parents still define where the data will really live.
 */
function canonicalizePathForSafety(candidate: string): string {
  const absolute = resolve(candidate);
  let existingPrefix = absolute;

  while (!existsSync(existingPrefix)) {
    const parent = dirname(existingPrefix);
    if (parent === existingPrefix) break;
    existingPrefix = parent;
  }

  const canonicalPrefix = realpathSync(existingPrefix);
  return resolve(canonicalPrefix, relative(existingPrefix, absolute));
}

function isWithin(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function platformTemporaryRoots(): readonly string[] {
  if (process.platform === "win32") return [];

  const candidates = [tmpdir(), "/tmp", "/private/tmp", "/var/tmp"];
  if (process.platform === "darwin") {
    candidates.push("/var/folders", "/private/var/folders");
  }
  return candidates;
}

/** Returns the canonical temporary root containing a state path, if any. */
export function temporaryStateRoot(
  candidate: string,
  roots: readonly string[] = platformTemporaryRoots(),
): string | null {
  const canonicalCandidate = canonicalizePathForSafety(candidate);
  const canonicalRoots = new Set(roots.map(canonicalizePathForSafety));
  for (const root of canonicalRoots) {
    if (isWithin(canonicalCandidate, root)) return root;
  }
  return null;
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
  const stateRoot = resolve(stateCandidate);

  if (
    parsed.NODE_ENV === "production" &&
    parsed.AISB_COMPANION_ALLOW_TEMPORARY_STATE !== "true"
  ) {
    const temporaryRoot = temporaryStateRoot(stateRoot);
    if (temporaryRoot !== null) {
      throw new Error(
        `Refusing to use temporary learner state in production: ${stateRoot} resolves under ${temporaryRoot}. ` +
          "Choose a durable AISB_COMPANION_STATE_PATH (or unset it to use the default). " +
          "For an intentionally disposable test only, set AISB_COMPANION_ALLOW_TEMPORARY_STATE=true.",
      );
    }
  }

  return {
    companionRoot,
    aisbRoot,
    stateRoot,
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
