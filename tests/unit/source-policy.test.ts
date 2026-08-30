import { describe, expect, it } from "vitest";
import { classifyRelativeAisbPath } from "../../src/server/policy/source-policy.js";

describe("source policy", () => {
  it("allows only explicit visible curriculum and participant file classes", () => {
    expect(classifyRelativeAisbPath("1.1-llm-internals/README.md")).toMatchObject({ allowed: true });
    expect(classifyRelativeAisbPath("1.1-llm-internals/day1_answers.py")).toMatchObject({ allowed: true });
    expect(classifyRelativeAisbPath("1.1-llm-internals/section1_solution.py")).toMatchObject({ allowed: false });
    expect(classifyRelativeAisbPath("1.1-llm-internals/section1_instructions.md")).toMatchObject({ allowed: false });
    expect(classifyRelativeAisbPath(".git/config")).toMatchObject({ allowed: false });
  });

  it("rejects traversal and secret-looking files", () => {
    expect(classifyRelativeAisbPath("../aisb-learning-companion/package.json")).toMatchObject({ allowed: false });
    expect(classifyRelativeAisbPath("1.1-llm-internals/api_token.txt")).toMatchObject({ allowed: false });
  });
});
