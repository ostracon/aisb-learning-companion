import { describe, expect, it } from "vitest";

import { createTutorScheduleAdapter } from "../../src/server/tutor/service.js";
import type { EventCurriculumBindingSnapshot } from "../../src/server/curriculum/event-binding-store.js";

describe("createTutorScheduleAdapter", () => {
  it("re-reads explicit links on every context resolution without title inference", async () => {
    let reads = 0;
    let snapshot: EventCurriculumBindingSnapshot = {
      schemaVersion: 1,
      revision: "event-curriculum-bindings:r1:0000000000000000",
      bindings: [
        {
          eventBindingId: "aisb-2026-016",
          sectionIds: ["2.1"],
          source: "explicit",
        },
      ],
    };
    const adapter = createTutorScheduleAdapter(
      {
        async read() {
          return {
            scheduleRevision: "schedule:r1",
            programmeTimeZone: "Europe/London",
            events: [
              {
                eventBindingId: "aisb-2026-016",
                programmeDayId: "day2" as const,
                title: "Different title",
                start: "2026-09-01T09:00:00+01:00",
                end: "2026-09-01T10:00:00+01:00",
                allDay: false,
                status: "scheduled" as const,
              },
              {
                eventBindingId: "aisb-2026-017",
                programmeDayId: "day2" as const,
                title: "2.2 — matching-looking title",
                start: "2026-09-01T10:00:00+01:00",
                end: "2026-09-01T11:00:00+01:00",
                allDay: false,
                status: "scheduled" as const,
              },
            ],
          };
        },
      },
      {
        async read() {
          reads += 1;
          return snapshot;
        },
      },
    );

    const first = await adapter.read();
    expect(first.events.map((event) => event.linkedSectionIds)).toEqual([["2.1"], []]);

    snapshot = {
      schemaVersion: 1,
      revision: "event-curriculum-bindings:r2:1111111111111111",
      bindings: [
        {
          eventBindingId: "aisb-2026-016",
          sectionIds: ["2.2", "2.1"],
          source: "explicit",
        },
      ],
    };
    const second = await adapter.read();

    expect(reads).toBe(2);
    expect(second.eventCurriculumBindingRevision).toBe(snapshot.revision);
    expect(second.events.map((event) => event.linkedSectionIds)).toEqual([
      ["2.2", "2.1"],
      [],
    ]);
  });
});
