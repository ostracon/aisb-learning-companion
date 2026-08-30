import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AppServerClient } from "../../src/server/codex/app-server-client.js";
import {
  ensureTutorCodexHome,
  TUTOR_PERMISSION_PROFILE,
} from "../../src/server/codex/runtime-profile.js";
import { TutorGateway } from "../../src/server/codex/tutor-gateway.js";
import {
  resolveRuntimeConfig,
  sanitizedChildEnvironment,
} from "../../src/server/config.js";

const liveDescribe = process.env.AISB_CODEX_LIVE === "1" ? describe : describe.skip;
const LIVE_MODEL = "gpt-5.6-sol";

liveDescribe("live Codex App Server (opt-in)", () => {
  it(
    "initializes the pinned package-local server and reads the model catalog",
    async () => {
      const config = resolveRuntimeConfig(process.env);
      const [codexHome, developerInstructions] = await Promise.all([
        ensureTutorCodexHome({
          companionRoot: config.companionRoot,
          aisbRoot: config.aisbRoot,
          stateRoot: config.stateRoot,
        }),
        readFile(join(config.companionRoot, "config", "developer-prompt.md"), "utf8"),
      ]);
      if (!codexHome.authCacheAvailable) {
        throw new Error(
          "The live Codex test requires an existing ~/.codex/auth.json cache to copy into the isolated tutor home",
        );
      }
      const client = await AppServerClient.connect({
        executable: config.codexExecutable,
        cwd: config.aisbRoot,
        env: sanitizedChildEnvironment(process.env, { CODEX_HOME: codexHome.path }),
        requestTimeoutMs: 30_000,
      });
      try {
        const gateway = new TutorGateway(client, {
          aisbRoot: config.aisbRoot,
          developerInstructions,
          permissionsProfile: TUTOR_PERMISSION_PROFILE,
          defaultModel: LIVE_MODEL,
          defaultEffort: "medium",
        });
        const models = await gateway.listModels();
        expect(models).toContainEqual(
          expect.objectContaining({ model: LIVE_MODEL, displayName: expect.any(String) }),
        );
        const thread = await gateway.startThread({ ephemeral: true });
        expect(thread).toMatchObject({
          model: LIVE_MODEL,
          activePermissionProfile: { id: TUTOR_PERMISSION_PROFILE },
        });

        const readable = await client.execCommand({
          command: ["/usr/bin/wc", "-c", join(config.aisbRoot, "1.1-llm-internals", "requirements.txt")],
          cwd: config.aisbRoot,
          permissionProfile: TUTOR_PERMISSION_PROFILE,
          timeoutMs: 5_000,
          outputBytesCap: 1_024,
        });
        expect(readable.exitCode).toBe(0);
        expect(readable.stdout).toMatch(/^\s*\d+/u);

        for (const deniedPath of [
          join(config.aisbRoot, "1.1-llm-internals", "section1_solution.py"),
          join(config.aisbRoot, "1.1-llm-internals", "README.md"),
          join(config.aisbRoot, "1.0-readings", "llm-training-guide.md"),
          join(config.companionRoot, "README.md"),
          join(config.stateRoot, "codex", "tutor-home", "auth.json"),
        ]) {
          // Prove a failure is the permission boundary, not a missing fixture.
          await expect(access(deniedPath)).resolves.toBeUndefined();
          const denied = await client.execCommand({
            command: ["/usr/bin/wc", "-c", deniedPath],
            cwd: config.aisbRoot,
            permissionProfile: TUTOR_PERMISSION_PROFILE,
            timeoutMs: 5_000,
            outputBytesCap: 1_024,
          });
          expect(denied.exitCode, deniedPath).not.toBe(0);
          expect(denied.stdout).toBe("");
        }
      } finally {
        client.close();
      }
    },
    60_000,
  );
});
