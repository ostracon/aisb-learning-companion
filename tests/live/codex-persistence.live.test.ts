import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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

liveDescribe("live Codex App Server persistence (opt-in)", () => {
  it(
    "reads and resumes a completed non-ephemeral tutor thread after restart",
    async () => {
      const config = resolveRuntimeConfig(process.env);
      const isolatedStateRoot = await mkdtemp(join(tmpdir(), "aisb-codex-persistence-"));
      let firstClient: AppServerClient | undefined;
      let secondClient: AppServerClient | undefined;

      try {
        const [codexHome, developerInstructions] = await Promise.all([
          ensureTutorCodexHome({
            companionRoot: config.companionRoot,
            aisbRoot: config.aisbRoot,
            stateRoot: isolatedStateRoot,
          }),
          readFile(join(config.companionRoot, "config", "developer-prompt.md"), "utf8"),
        ]);
        if (!codexHome.authCacheAvailable) {
          throw new Error(
            "The live Codex test requires an existing ~/.codex/auth.json cache to copy into the isolated tutor home",
          );
        }

        const connect = () =>
          AppServerClient.connect({
            executable: config.codexExecutable,
            cwd: config.aisbRoot,
            env: sanitizedChildEnvironment(process.env, { CODEX_HOME: codexHome.path }),
            requestTimeoutMs: 30_000,
          });
        const gatewayFor = (client: AppServerClient) =>
          new TutorGateway(client, {
            aisbRoot: config.aisbRoot,
            developerInstructions,
            permissionsProfile: TUTOR_PERMISSION_PROFILE,
            defaultModel: LIVE_MODEL,
            defaultEffort: "medium",
            turnTimeoutMs: 120_000,
          });

        firstClient = await connect();
        const firstGateway = gatewayFor(firstClient);
        const started = await firstGateway.startThread({ ephemeral: false });
        expect(started.thread.ephemeral).toBe(false);

        const completed = await firstGateway.runTurn({
          threadId: started.thread.id,
          text: "Reply with exactly PERSISTENCE_OK. Do not use tools.",
        });
        expect(completed.status).toBe("completed");

        firstClient.close();
        firstClient = undefined;

        secondClient = await connect();
        const read = await secondClient.readThread({
          threadId: started.thread.id,
          includeTurns: true,
        });
        expect(read.thread).toMatchObject({
          id: started.thread.id,
          ephemeral: false,
        });
        expect(read.thread.turns.map((turn) => turn.id)).toContain(completed.turnId);

        const resumed = await gatewayFor(secondClient).resumeThread({
          threadId: started.thread.id,
        });
        expect(resumed.thread.id).toBe(started.thread.id);
        expect(resumed.thread.turns.map((turn) => turn.id)).toContain(completed.turnId);
      } finally {
        firstClient?.close();
        secondClient?.close();
        await rm(isolatedStateRoot, { force: true, recursive: true });
      }
    },
    180_000,
  );
});
