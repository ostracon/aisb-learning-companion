import { describe, expect, it, vi } from "vitest";

import type { Model } from "../codex/generated/v2/Model.js";
import type { RuntimeConfig } from "../config.js";
import {
  CodexSelfTestService,
  type CodexSelfTestRuntime,
} from "./codex-self-test.js";

const config: RuntimeConfig = {
  companionRoot: "/companion",
  aisbRoot: "/aisb",
  stateRoot: "/state",
  host: "127.0.0.1",
  port: 7_575,
  mode: "test",
  imageGenerationAvailable: false,
  codexExecutable: "/companion/node_modules/.bin/codex",
};

function requiredModel(overrides: Partial<Model> = {}): Model {
  return {
    id: "gpt-5.6-sol",
    model: "gpt-5.6-sol",
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: "GPT-5.6 Sol",
    description: "",
    modelSpecialty: null,
    hidden: false,
    supportedReasoningEfforts: [
      { reasoningEffort: "medium", description: "Balanced" },
    ],
    defaultReasoningEffort: "medium",
    inputModalities: ["text"],
    supportsPersonality: false,
    multiAgentVersion: null,
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault: true,
    ...overrides,
  };
}

function readyRuntime(overrides: Partial<CodexSelfTestRuntime> = {}): CodexSelfTestRuntime {
  return {
    identity: () => ({
      userAgent: "Codex Desktop/0.151.0 (Mac OS 26.6.2; arm64) dumb (aisb-learning-companion; 0.1.0)",
      platformFamily: "unix",
      platformOs: "macos",
    }),
    readAccount: async () => ({
      account: {
        type: "chatgpt",
        email: "private@example.invalid",
        planType: "plus",
      },
      requiresOpenaiAuth: false,
    }),
    listModels: async () => [requiredModel()],
    verifyProfile: async () => undefined,
    close: vi.fn(),
    ...overrides,
  };
}

describe("CodexSelfTestService", () => {
  it("verifies account, model, and both restricted profiles without exposing identity data", async () => {
    const verifyProfile = vi.fn<CodexSelfTestRuntime["verifyProfile"]>(
      async (_profileId) => undefined,
    );
    const close = vi.fn();
    const runtime = readyRuntime({ verifyProfile, close });
    const service = new CodexSelfTestService(config, {
      connect: async () => runtime,
      now: () => new Date("2026-08-30T08:00:00.000Z"),
    });

    const result = await service.run();

    expect(result.status).toBe("ready");
    expect(result.tested_at).toBe("2026-08-30T08:00:00.000Z");
    expect(result.version).toEqual({
      expected: "0.151.0",
      reported: "0.151.0",
      matches: true,
    });
    expect(result.account).toEqual({
      status: "authenticated",
      kind: "chatgpt",
      plan: "plus",
    });
    expect(result.model).toEqual({
      model: "gpt-5.6-sol",
      available: true,
      medium_effort_available: true,
    });
    expect(verifyProfile.mock.calls.map(([profile]) => profile)).toEqual([
      "aisb-tutor",
      "aisb-review",
    ]);
    expect(JSON.stringify(result)).not.toContain("private@example.invalid");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("reads the server version from a client-prefixed App Server identity", async () => {
    const runtime = readyRuntime({
      identity: () => ({
        userAgent: "aisb-learning-companion/0.151.0 (Mac OS 26.6.2; arm64) dumb (aisb-learning-companion; 0.1.0)",
        platformFamily: "unix",
        platformOs: "macos",
      }),
    });
    const service = new CodexSelfTestService(config, { connect: async () => runtime });

    const result = await service.run();

    expect(result.version).toEqual({
      expected: "0.151.0",
      reported: "0.151.0",
      matches: true,
    });
    expect(result.status).toBe("ready");
  });

  it("returns a stable redacted degraded result when App Server cannot start", async () => {
    const service = new CodexSelfTestService(config, {
      connect: async () => {
        throw new Error("secret token and private path");
      },
      now: () => new Date("2026-08-30T08:00:00.000Z"),
    });

    const result = await service.run();

    expect(result.status).toBe("degraded");
    expect(result.issues.map(({ code }) => code)).toEqual(["codex_process_unavailable"]);
    expect(JSON.stringify(result)).not.toMatch(/secret token|private path/u);
  });

  it("reports missing capability checks independently and still closes the process", async () => {
    const close = vi.fn();
    const runtime = readyRuntime({
      identity: () => ({
        userAgent: "codex-cli/0.150.0",
        platformFamily: "unix",
        platformOs: "macos",
      }),
      readAccount: async () => ({ account: null, requiresOpenaiAuth: true }),
      listModels: async () => [],
      verifyProfile: async (profileId) => {
        if (profileId === "aisb-review") throw new Error("raw private diagnostic");
      },
      close,
    });
    const service = new CodexSelfTestService(config, { connect: async () => runtime });

    const result = await service.run();

    expect(result.status).toBe("degraded");
    expect(result.issues.map(({ code }) => code)).toEqual([
      "codex_version_mismatch",
      "account_authentication_required",
      "required_model_unavailable",
      "review_profile_unavailable",
    ]);
    expect(result.profiles).toEqual([
      {
        profile_id: "aisb-tutor",
        applied: true,
        instruction_source_verified: true,
      },
      {
        profile_id: "aisb-review",
        applied: false,
        instruction_source_verified: false,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("raw private diagnostic");
    expect(close).toHaveBeenCalledTimes(1);
  });
});
