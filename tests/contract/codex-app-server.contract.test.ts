import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const companionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const codexRoot = resolve(companionRoot, "src/server/codex");

describe("pinned Codex App Server contract", () => {
  it("pins the executable package and generated protocol to 0.151.0", async () => {
    const version = JSON.parse(
      await readFile(resolve(codexRoot, "codex-version.json"), "utf8"),
    ) as Record<string, unknown>;

    expect(version).toEqual({
      package: "@openai/codex",
      version: "0.151.0",
      protocol: "app-server",
      experimental_bindings: true,
    });
  });

  it("retains every method used by the stdio adapter", async () => {
    const schema = await readFile(
      resolve(codexRoot, "generated/schema/codex_app_server_protocol.schemas.json"),
      "utf8",
    );
    const methods = [
      "initialize",
      "account/read",
      "model/list",
      "permissionProfile/list",
      "thread/start",
      "thread/resume",
      "thread/read",
      "turn/start",
      "turn/interrupt",
      "turn/started",
      "item/agentMessage/delta",
      "turn/completed",
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "item/permissions/requestApproval",
    ];

    for (const method of methods) expect(schema).toContain(`"${method}"`);
  });

  it("keeps instructionSources in both start and resume responses", async () => {
    const [start, resume] = await Promise.all([
      readFile(
        resolve(codexRoot, "generated/schema/v2/ThreadStartResponse.json"),
        "utf8",
      ),
      readFile(
        resolve(codexRoot, "generated/schema/v2/ThreadResumeResponse.json"),
        "utf8",
      ),
    ]);

    for (const responseSchema of [start, resume]) {
      expect(responseSchema).toContain('"instructionSources"');
      expect(responseSchema).toMatch(/"required"\s*:\s*\[[\s\S]*"instructionSources"/);
    }
  });
});
