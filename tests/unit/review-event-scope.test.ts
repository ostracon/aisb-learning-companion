import { describe, expect, it } from "vitest";

import {
  scopeStudyReviewSections,
  scopeTodayReviewSections,
} from "../../src/server/review/context-scope.js";
import { ReviewCoachServiceError } from "../../src/server/review/service.js";
import type { CurriculumSectionView } from "../../src/shared/api.js";

const sections: CurriculumSectionView[] = [
  {
    sectionId: "1.1",
    title: "One",
    sourcePath: "1.1-one/README.md",
    outcomes: [],
  },
  {
    sectionId: "1.2",
    title: "Two",
    sourcePath: "1.2-two/README.md",
    outcomes: [],
  },
  {
    sectionId: "1.3",
    title: "Three",
    sourcePath: "1.3-three/README.md",
    outcomes: [],
  },
];

const events = [
  {
    eventBindingId: "aisb-2026-016",
    programmeDayId: "day1" as const,
    title: "Session",
    start: "2026-08-31T09:00:00+01:00",
    end: "2026-08-31T10:00:00+01:00",
    allDay: false,
    status: "scheduled" as const,
  },
];

function bindingSnapshot(sectionIds: readonly string[]) {
  return {
    schemaVersion: 1 as const,
    revision: "event-curriculum-bindings:r2:1111111111111111",
    bindings: sectionIds.length === 0
      ? []
      : [
          {
            eventBindingId: "aisb-2026-016",
            sectionIds,
            source: "explicit" as const,
          },
        ],
  };
}

describe("scopeTodayReviewSections", () => {
  it("keeps day-level Review broad but scopes an event in explicit link order", () => {
    expect(scopeTodayReviewSections({
      dayId: "day1",
      eventBindingId: null,
      sections,
      events,
      eventCurriculumBindings: bindingSnapshot(["1.2", "1.1"]),
    })).toEqual(sections);

    expect(scopeTodayReviewSections({
      dayId: "day1",
      eventBindingId: "aisb-2026-016",
      sections,
      events,
      eventCurriculumBindings: bindingSnapshot(["1.2", "1.1"]),
    }).map((section) => section.sectionId)).toEqual(["1.2", "1.1"]);
  });

  it("rejects unlinked events rather than falling back to all day outcomes", () => {
    expect(() => scopeTodayReviewSections({
      dayId: "day1",
      eventBindingId: "aisb-2026-016",
      sections,
      events,
      eventCurriculumBindings: bindingSnapshot([]),
    })).toThrowError(ReviewCoachServiceError);
  });

  it("uses the current relinked subset rather than an earlier event scope", () => {
    const before = scopeTodayReviewSections({
      dayId: "day1",
      eventBindingId: "aisb-2026-016",
      sections,
      events,
      eventCurriculumBindings: bindingSnapshot(["1.1"]),
    });
    const after = scopeTodayReviewSections({
      dayId: "day1",
      eventBindingId: "aisb-2026-016",
      sections,
      events,
      eventCurriculumBindings: bindingSnapshot(["1.2"]),
    });

    expect(before.map((section) => section.sectionId)).toEqual(["1.1"]);
    expect(after.map((section) => section.sectionId)).toEqual(["1.2"]);
  });

  it("rejects a stale section link and a schedule event that left the route day", () => {
    expect(() => scopeTodayReviewSections({
      dayId: "day1",
      eventBindingId: "aisb-2026-016",
      sections,
      events,
      eventCurriculumBindings: bindingSnapshot(["1.9"]),
    })).toThrow(/link is stale/i);

    expect(() => scopeTodayReviewSections({
      dayId: "day2",
      eventBindingId: "aisb-2026-016",
      sections,
      events,
      eventCurriculumBindings: bindingSnapshot(["1.1"]),
    })).toThrow(/event changed/i);
  });
});

describe("scopeStudyReviewSections", () => {
  it("keeps a repository-day review broad but narrows a selected section", () => {
    expect(scopeStudyReviewSections({
      dayId: "day1",
      sectionId: null,
      sections,
    })).toEqual(sections);

    expect(scopeStudyReviewSections({
      dayId: "day1",
      sectionId: "1.2",
      sections,
    }).map((section) => section.sectionId)).toEqual(["1.2"]);
  });

  it("rejects a missing or out-of-day selected Study section", () => {
    expect(() => scopeStudyReviewSections({
      dayId: "day1",
      sectionId: "1.9",
      sections,
    })).toThrow(/no longer belongs to this repository day/i);

    expect(() => scopeStudyReviewSections({
      dayId: "day2",
      sectionId: "2.1",
      sections,
    })).toThrowError(ReviewCoachServiceError);
  });
});
