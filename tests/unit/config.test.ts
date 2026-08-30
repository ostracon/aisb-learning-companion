import { describe, expect, it } from "vitest";
import { sanitizedChildEnvironment } from "../../src/server/config.js";

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
