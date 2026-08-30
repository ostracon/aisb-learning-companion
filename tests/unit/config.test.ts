import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveRuntimeConfig,
  sanitizedChildEnvironment,
  temporaryStateRoot,
} from "../../src/server/config.js";

const temporaryFixtures: string[] = [];

async function configFixture(): Promise<{ companionRoot: string; aisbRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), "aisb-config-"));
  temporaryFixtures.push(root);
  const companionRoot = join(root, "companion");
  const aisbRoot = join(root, "aisb");
  await mkdir(join(aisbRoot, ".git"), { recursive: true });
  await mkdir(companionRoot, { recursive: true });
  await writeFile(
    join(companionRoot, "package.json"),
    JSON.stringify({ name: "aisb-learning-companion" }),
  );
  await writeFile(join(aisbRoot, "build-instructions.sh"), "#!/bin/sh\n");
  return { companionRoot, aisbRoot };
}

afterEach(async () => {
  await Promise.all(
    temporaryFixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("child-process environment", () => {
  it("omits the image API key and unrelated ambient variables", () => {
    const sanitized = sanitizedChildEnvironment({
      PATH: "/bin",
      HOME: "/tmp/home",
      CODEX_OPENAI_API_KEY: "canary-secret",
      OPENAI_API_KEY: "another-canary",
      GIT_DIR: "/tmp/hostile",
    });
    expect(sanitized).toEqual({ PATH: "/bin", HOME: "/tmp/home" });
    expect(JSON.stringify(sanitized)).not.toContain("canary-secret");
  });
});

describe("production state-root safety", () => {
  it("rejects a production state root under the operating-system temporary directory", async () => {
    const fixture = await configFixture();
    const stateRoot = join(tmpdir(), "aisb-companion-learner-state");

    expect(() =>
      resolveRuntimeConfig(
        {
          AISB_REPO_PATH: fixture.aisbRoot,
          AISB_COMPANION_STATE_PATH: stateRoot,
          NODE_ENV: "production",
        },
        fixture.companionRoot,
      ),
    ).toThrow(/AISB_COMPANION_ALLOW_TEMPORARY_STATE=true/);
  });

  it("allows a durable production state root without an override", async () => {
    const fixture = await configFixture();
    const stateRoot = "/srv/aisb-companion-state-test";

    const config = resolveRuntimeConfig(
      {
        AISB_REPO_PATH: fixture.aisbRoot,
        AISB_COMPANION_STATE_PATH: stateRoot,
        NODE_ENV: "production",
      },
      fixture.companionRoot,
    );

    expect(config.stateRoot).toBe(stateRoot);
  });

  it("allows a temporary production state root only with the explicit disposable-test opt-in", async () => {
    const fixture = await configFixture();
    const stateRoot = join(tmpdir(), "aisb-companion-production-smoke");

    const config = resolveRuntimeConfig(
      {
        AISB_REPO_PATH: fixture.aisbRoot,
        AISB_COMPANION_STATE_PATH: stateRoot,
        AISB_COMPANION_ALLOW_TEMPORARY_STATE: "true",
        NODE_ENV: "production",
      },
      fixture.companionRoot,
    );

    expect(config.stateRoot).toBe(stateRoot);
  });

  it("does not apply the production guard to a development server", async () => {
    const fixture = await configFixture();
    const stateRoot = join(tmpdir(), "aisb-companion-development-state");

    const config = resolveRuntimeConfig(
      {
        AISB_REPO_PATH: fixture.aisbRoot,
        AISB_COMPANION_STATE_PATH: stateRoot,
        NODE_ENV: "development",
      },
      fixture.companionRoot,
    );

    expect(config.stateRoot).toBe(stateRoot);
  });

  it("resolves a symlinked parent before checking a not-yet-created state directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "aisb-config-alias-"));
    temporaryFixtures.push(root);
    const canonicalTemporaryRoot = join(root, "canonical-temporary-root");
    const alias = join(root, "state-alias");
    await mkdir(canonicalTemporaryRoot);
    await symlink(canonicalTemporaryRoot, alias);

    expect(
      temporaryStateRoot(join(alias, "nested", "state"), [canonicalTemporaryRoot]),
    ).toBe(await realpath(canonicalTemporaryRoot));
  });
});
