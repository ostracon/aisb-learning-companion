import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

export const TUTOR_PERMISSION_PROFILE = "aisb-tutor";
export const REVIEW_PERMISSION_PROFILE = "aisb-review";

export interface TutorCodexHome {
  readonly path: string;
  readonly configPath: string;
  readonly configHash: string;
  readonly permissionProfile: typeof TUTOR_PERMISSION_PROFILE;
  readonly authCacheAvailable: boolean;
}

export interface ReviewCodexWorkspace {
  readonly path: string;
  readonly agentsPath: string;
  readonly sourceHash: string;
}

const MAX_REVIEW_AGENTS_BYTES = 512 * 1024;

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function tutorCodexConfig(input: {
  readonly companionRoot: string;
  readonly aisbRoot: string;
  readonly stateRoot: string;
}): string {
  const deniedWorkspaceGlobs = [
    "**/*_solution.py",
    "**/*_reference.py",
    // Markdown shown in Study is projected by the companion before it reaches
    // the tutor. Deny raw Markdown tool access so a model cannot bypass that
    // projection by reading an answer/hint fold directly from disk.
    // Require at least one repository directory component so Codex can still
    // load the root AGENTS.md/CLAUDE.md contract. All curriculum Markdown lives
    // below a section/day directory and is supplied through the safe projection.
    "*/**/*.md",
    "**/*_test.py",
    "**/reference_solutions/**",
    "**/.env",
    "**/.env.*",
    ".git/**",
  ];
  const deniedReviewAnswerGlobs = [
    "**/*answer*.py",
    "**/*answer*.md",
    "**/*answer*.ipynb",
  ];
  const lines = [
    `default_permissions = ${tomlString(TUTOR_PERMISSION_PROFILE)}`,
    'approval_policy = "never"',
    'approvals_reviewer = "user"',
    'web_search = "disabled"',
    "check_for_update_on_startup = false",
    "allow_login_shell = false",
    "",
    "[history]",
    'persistence = "save-all"',
    "",
    "[features]",
    "apps = false",
    "memories = false",
    "multi_agent = false",
    "remote_plugin = false",
    "network_proxy = false",
    "",
    `[permissions.${TUTOR_PERMISSION_PROFILE}]`,
    'description = "Read learner-visible AISB material while denying protected answer sources."',
    "",
    `[permissions.${TUTOR_PERMISSION_PROFILE}.filesystem]`,
    '":minimal" = "read"',
    "glob_scan_max_depth = 16",
    `${tomlString(input.companionRoot)} = "deny"`,
    `${tomlString(join(input.companionRoot, "**"))} = "deny"`,
    `${tomlString(input.stateRoot)} = "deny"`,
    `${tomlString(join(input.stateRoot, "**"))} = "deny"`,
    "",
    `[permissions.${TUTOR_PERMISSION_PROFILE}.filesystem.":workspace_roots"]`,
    '"." = "read"',
    ...deniedWorkspaceGlobs.map((pattern) => `${tomlString(pattern)} = "deny"`),
    "",
    `[permissions.${TUTOR_PERMISSION_PROFILE}.network]`,
    "enabled = false",
    "",
    `[permissions.${REVIEW_PERMISSION_PROFILE}]`,
    'description = "Use canonical outcome envelopes and disclosed recall responses without reading learner answer files or protected sources."',
    "",
    `[permissions.${REVIEW_PERMISSION_PROFILE}.filesystem]`,
    '":minimal" = "deny"',
    "glob_scan_max_depth = 16",
    `${tomlString(input.companionRoot)} = "deny"`,
    `${tomlString(join(input.companionRoot, "**"))} = "deny"`,
    `${tomlString(input.stateRoot)} = "deny"`,
    `${tomlString(join(input.stateRoot, "**"))} = "deny"`,
    `${tomlString(input.aisbRoot)} = "deny"`,
    `${tomlString(join(input.aisbRoot, "**"))} = "deny"`,
    "",
    `[permissions.${REVIEW_PERMISSION_PROFILE}.filesystem.":workspace_roots"]`,
    // Review and manager threads use a private, generated workspace containing
    // only a verified copy of the root AGENTS.md. Their runtime root is readable
    // so Codex can load that contract, while the real AISB root is denied above.
    '"." = "read"',
    ...deniedWorkspaceGlobs.map((pattern) => `${tomlString(pattern)} = "deny"`),
    ...deniedReviewAnswerGlobs.map((pattern) => `${tomlString(pattern)} = "deny"`),
    "",
    `[permissions.${REVIEW_PERMISSION_PROFILE}.network]`,
    "enabled = false",
    "",
  ];
  return `${lines.join("\n")}\n`;
}

async function writeAtomicPrivate(target: string, content: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(target), `.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, target);
  const directory = await open(dirname(target), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function copyPrivate(source: string, target: string): Promise<boolean> {
  try {
    const temporary = join(dirname(target), `.${randomUUID()}.auth.tmp`);
    await copyFile(source, temporary, constants.COPYFILE_EXCL);
    await chmod(temporary, 0o600);
    await rename(temporary, target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function ensureTutorCodexHome(input: {
  readonly companionRoot: string;
  readonly aisbRoot: string;
  readonly stateRoot: string;
  readonly authSourcePath?: string;
}): Promise<TutorCodexHome> {
  const homePath = join(input.stateRoot, "codex", "tutor-home");
  const configPath = join(homePath, "config.toml");
  const content = tutorCodexConfig(input);
  const configHash = `sha256:${createHash("sha256").update(content).digest("hex")}`;
  const authSourcePath = input.authSourcePath ?? join(homedir(), ".codex", "auth.json");
  const authPath = join(homePath, "auth.json");

  await mkdir(homePath, { recursive: true, mode: 0o700 });
  try {
    const metadata = await lstat(configPath);
    if (metadata.isSymbolicLink()) {
      throw new Error("Refusing to use a symbolic link as the isolated Codex config");
    }
    if ((await readFile(configPath, "utf8")) !== content) {
      await writeAtomicPrivate(configPath, content);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await writeAtomicPrivate(configPath, content);
  }
  const authCacheAvailable = await copyPrivate(authSourcePath, authPath);

  return Object.freeze({
    path: homePath,
    configPath,
    configHash,
    permissionProfile: TUTOR_PERMISSION_PROFILE,
    authCacheAvailable,
  });
}

export async function ensureReviewCodexWorkspace(input: {
  readonly aisbRoot: string;
  readonly temporaryRoot?: string;
}): Promise<ReviewCodexWorkspace> {
  const sourcePath = join(input.aisbRoot, "AGENTS.md");
  const [canonicalAisbRoot, canonicalSourcePath] = await Promise.all([
    realpath(input.aisbRoot),
    realpath(sourcePath),
  ]);
  const sourceRelativePath = relative(canonicalAisbRoot, canonicalSourcePath);
  if (
    sourceRelativePath === ".."
    || sourceRelativePath.startsWith(`..${sep}`)
    || isAbsolute(sourceRelativePath)
  ) {
    throw new Error("The AISB instruction source resolves outside the AISB repository");
  }
  const source = await open(
    canonicalSourcePath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  let content: string;
  try {
    const metadata = await source.stat();
    if (!metadata.isFile() || metadata.nlink !== 1) {
      throw new Error("The AISB instruction source must be a single regular file");
    }
    if (metadata.size > MAX_REVIEW_AGENTS_BYTES) {
      throw new Error("The AISB instruction source exceeds the review workspace bound");
    }
    content = await source.readFile("utf8");
  } finally {
    await source.close();
  }

  const sourceHash = `sha256:${createHash("sha256").update(content).digest("hex")}`;
  const workspaceId = createHash("sha256")
    .update(input.aisbRoot)
    .update("\0")
    .update(sourceHash)
    .digest("hex")
    .slice(0, 24);
  const workspacePath = join(
    input.temporaryRoot ?? tmpdir(),
    `aisb-companion-review-${workspaceId}`,
  );

  try {
    const metadata = await lstat(workspacePath);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("Refusing an unsafe review workspace path");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(workspacePath, { mode: 0o700 });
  }
  await chmod(workspacePath, 0o700);

  const entries = await readdir(workspacePath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name !== "AGENTS.md" || !entry.isFile()) {
      throw new Error("The private review workspace contains an unexpected entry");
    }
  }

  const agentsPath = join(workspacePath, "AGENTS.md");
  await writeAtomicPrivate(agentsPath, content);
  return Object.freeze({ path: workspacePath, agentsPath, sourceHash });
}
