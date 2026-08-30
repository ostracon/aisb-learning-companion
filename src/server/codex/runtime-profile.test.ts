import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  ensureTutorCodexHome,
  ensureReviewCodexWorkspace,
  REVIEW_PERMISSION_PROFILE,
  TUTOR_PERMISSION_PROFILE,
  tutorCodexConfig,
} from "./runtime-profile.js";

describe("isolated tutor Codex configuration", () => {
  it("persists tutor history while deterministically denying protected sources", () => {
    const config = tutorCodexConfig({
      companionRoot: "/code/companion",
      aisbRoot: "/code/aisb",
      stateRoot: "/state/companion",
    });

    expect(config).toContain(`default_permissions = "${TUTOR_PERMISSION_PROFILE}"`);
    expect(config).toContain('[history]\npersistence = "save-all"');
    expect(config).not.toContain('persistence = "none"');
    const tutorProfile = config.slice(
      config.indexOf(`[permissions.${TUTOR_PERMISSION_PROFILE}]`),
      config.indexOf(`[permissions.${REVIEW_PERMISSION_PROFILE}]`),
    );
    const reviewProfile = config.slice(
      config.indexOf(`[permissions.${REVIEW_PERMISSION_PROFILE}]`),
    );
    expect(tutorProfile).toContain('":minimal" = "read"');
    expect(tutorProfile).toContain('"." = "read"');
    expect(tutorProfile).not.toContain('"/code/aisb" = "deny"');
    expect(tutorProfile).toContain('"**/*_solution.py" = "deny"');
    expect(tutorProfile).toContain('"**/*_reference.py" = "deny"');
    expect(tutorProfile).toContain('"*/**/*.md" = "deny"');
    expect(tutorProfile).toContain('"**/*_test.py" = "deny"');
    expect(tutorProfile).toContain('"**/reference_solutions/**" = "deny"');
    expect(reviewProfile).toContain('":minimal" = "deny"');
    expect(reviewProfile.match(/^.* = "read"$/gmu)).toEqual(['"." = "read"']);
    expect(config).toContain('"**/*answer*.py" = "deny"');
    expect(config).toContain('"**/*answer*.md" = "deny"');
    expect(config).toContain('"**/*answer*.ipynb" = "deny"');
    expect(config).toContain('"/code/companion" = "deny"');
    expect(config).toContain('"/code/companion/**" = "deny"');
    expect(config).toContain('"/state/companion" = "deny"');
    expect(config).toContain('"/state/companion/**" = "deny"');
    expect(reviewProfile).toContain('"/code/aisb" = "deny"');
    expect(reviewProfile).toContain('"/code/aisb/**" = "deny"');
    expect(config).toContain("enabled = false");
    expect(config).not.toContain("sandbox_mode");
  });

  it("writes a stable private home without inheriting ambient configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "aisb-codex-home-"));
    const authSourcePath = join(root, "auth.json");
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(authSourcePath, '{"test":"credential-cache"}\n', { mode: 0o600 }),
    );
    const result = await ensureTutorCodexHome({
      companionRoot: join(root, "companion"),
      aisbRoot: join(root, "aisb"),
      stateRoot: join(root, "state"),
      authSourcePath,
    });
    const second = await ensureTutorCodexHome({
      companionRoot: join(root, "companion"),
      aisbRoot: join(root, "aisb"),
      stateRoot: join(root, "state"),
      authSourcePath,
    });

    expect(second.configHash).toBe(result.configHash);
    expect(result.authCacheAvailable).toBe(true);
    expect(await readFile(result.configPath, "utf8")).toContain(
      'web_search = "disabled"',
    );
  });

  it("builds a private review workspace containing only a verified AGENTS.md", async () => {
    const root = await mkdtemp(join(tmpdir(), "aisb-review-workspace-test-"));
    const aisbRoot = join(root, "aisb");
    const temporaryRoot = join(root, "private-temp");
    await mkdir(aisbRoot, { recursive: true });
    await mkdir(temporaryRoot, { recursive: true });
    await writeFile(join(aisbRoot, "AGENTS.md"), "# Learner contract\n", "utf8");

    const workspace = await ensureReviewCodexWorkspace({ aisbRoot, temporaryRoot });

    expect(await readFile(workspace.agentsPath, "utf8")).toBe("# Learner contract\n");
    expect(await readdir(workspace.path)).toEqual(["AGENTS.md"]);
    expect((await lstat(workspace.path)).mode & 0o777).toBe(0o700);
    expect((await lstat(workspace.agentsPath)).mode & 0o777).toBe(0o600);
  });

  it("accepts the repository's relative AGENTS.md symlink only when its target stays in AISB", async () => {
    const root = await mkdtemp(join(tmpdir(), "aisb-review-workspace-symlink-"));
    const aisbRoot = join(root, "aisb");
    const temporaryRoot = join(root, "private-temp");
    await mkdir(aisbRoot, { recursive: true });
    await mkdir(temporaryRoot, { recursive: true });
    await writeFile(join(aisbRoot, "CLAUDE.md"), "# Canonical learner contract\n", "utf8");
    await symlink("CLAUDE.md", join(aisbRoot, "AGENTS.md"));

    const workspace = await ensureReviewCodexWorkspace({ aisbRoot, temporaryRoot });

    expect(await readFile(workspace.agentsPath, "utf8")).toBe("# Canonical learner contract\n");
    expect((await lstat(workspace.agentsPath)).isSymbolicLink()).toBe(false);
    expect(await readdir(workspace.path)).toEqual(["AGENTS.md"]);
  });

  it("rejects an AGENTS.md symlink whose target escapes the AISB repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "aisb-review-workspace-escape-"));
    const aisbRoot = join(root, "aisb");
    const temporaryRoot = join(root, "private-temp");
    await mkdir(aisbRoot, { recursive: true });
    await mkdir(temporaryRoot, { recursive: true });
    await writeFile(join(root, "outside.md"), "# Outside contract\n", "utf8");
    await symlink("../outside.md", join(aisbRoot, "AGENTS.md"));

    await expect(ensureReviewCodexWorkspace({ aisbRoot, temporaryRoot }))
      .rejects.toThrow(/resolves outside the AISB repository/);
  });

  it("fails closed when an existing deterministic review workspace has any extra entry", async () => {
    const root = await mkdtemp(join(tmpdir(), "aisb-review-workspace-extra-"));
    const aisbRoot = join(root, "aisb");
    const temporaryRoot = join(root, "private-temp");
    await mkdir(aisbRoot, { recursive: true });
    await mkdir(temporaryRoot, { recursive: true });
    await writeFile(join(aisbRoot, "AGENTS.md"), "# Learner contract\n", "utf8");
    const workspace = await ensureReviewCodexWorkspace({ aisbRoot, temporaryRoot });
    await writeFile(join(workspace.path, "unexpected.txt"), "must fail closed\n", "utf8");

    await expect(ensureReviewCodexWorkspace({ aisbRoot, temporaryRoot }))
      .rejects.toThrow(/contains an unexpected entry/);
  });
});
