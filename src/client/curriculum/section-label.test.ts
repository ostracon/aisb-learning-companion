import { describe, expect, it } from "vitest";

import { sectionTitleWithoutRepeatedId } from "./section-label.js";

describe("sectionTitleWithoutRepeatedId", () => {
  it.each([
    ["4.1", "4.1 — Model editing", "Model editing"],
    ["1.2", "1.2 - Log probabilities", "Log probabilities"],
    ["2.3", "2.3: Prompt injection", "Prompt injection"],
  ])("removes a rendered section ID prefix from %s", (sectionId, title, expected) => {
    expect(sectionTitleWithoutRepeatedId(sectionId, title)).toBe(expected);
  });

  it("leaves a title without the exact section prefix alone", () => {
    expect(sectionTitleWithoutRepeatedId("1.2", "Section 1.2 concepts")).toBe("Section 1.2 concepts");
  });
});
