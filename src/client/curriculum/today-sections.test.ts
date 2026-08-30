import { describe, expect, it } from "vitest";

import { curriculumSectionsForTodaySelection } from "./today-sections.js";

describe("curriculumSectionsForTodaySelection", () => {
  const sections = [
    { sectionId: "1.1", title: "One", sourcePath: "1.1-one/README.md", outcomes: [] },
    { sectionId: "1.2", title: "Two", sourcePath: "1.2-two/README.md", outcomes: [] },
    { sectionId: "1.3", title: "Three", sourcePath: "1.3-three/README.md", outcomes: [] },
  ];
  const snapshot = {
    schemaVersion: 1 as const,
    revision: "event-curriculum-bindings:r2:bbbbbbbbbbbbbbbb",
    bindings: [{
      eventBindingId: "aisb-2026-016",
      sectionIds: ["1.3", "1.1", "1.9"],
      source: "explicit" as const,
    }],
  };

  it("keeps a bare schedule route and an unmapped event curriculum-empty", () => {
    expect(curriculumSectionsForTodaySelection(sections, null, snapshot)).toEqual([]);
    expect(curriculumSectionsForTodaySelection(sections, "aisb-2026-017", snapshot)).toEqual([]);
  });

  it("uses the explicit link order and leaves stale IDs out of active context", () => {
    expect(
      curriculumSectionsForTodaySelection(sections, "aisb-2026-016", snapshot)
        .map((section) => section.sectionId),
    ).toEqual(["1.3", "1.1"]);
  });
});
