import { describe, expect, it, vi } from "vitest";

import type { ScheduleSnapshotResponse } from "../../shared/api.js";
import { DayReviewContextService } from "./context-service.js";

describe("DayReviewContextService", () => {
  it("builds a compact day map without embedding resource contents", async () => {
    const retrieval = {
      inventory: vi.fn(async () => ({
        resources: [{
          resourceId: `dayres_${"a".repeat(48)}`,
          kind: "prepared_reference" as const,
          title: "Prepared paper",
          citation: "Prepared paper · sha256:abc · 12 pages",
          summary: "Verified page-aware projection.",
        }],
        omissions: ["Protected solution material is excluded."],
      })),
    };
    const schedule = {
      read: vi.fn(async () => ({
        runtimeSchedule: {},
        scheduleRevision: "schedule-v2",
        programmeTimeZone: "Europe/London",
        programmeDays: [{ dayId: "day1", date: "2026-08-30", curriculumKind: "content", title: "Day 1" }],
        events: [{
          eventBindingId: "event-1",
          programmeDayId: "day1",
          title: "LLM internals",
          start: "2026-08-30T10:00:00+01:00",
          end: "2026-08-30T11:00:00+01:00",
          allDay: false,
          status: "scheduled",
        }],
      } as ScheduleSnapshotResponse)),
    };
    const curriculum = {
      readDay: vi.fn(async () => [{
        sectionId: "1.1",
        title: "Serialization",
        sourcePath: "1.1/README.md",
        outcomes: [{
          outcomeId: "1.1:security:1",
          versionId: "v1",
          category: "security" as const,
          text: "Explain the serialization boundary.",
          sourcePath: "1.1/README.md",
        }],
      }]),
    };
    const progress = {
      read: vi.fn(async () => ({
        version: "v1",
        completions: [{ outcomeId: "1.1:security:1", outcomeVersionId: "v1", completed: true }],
      })),
    };
    const service = new DayReviewContextService(
      "day1",
      schedule,
      curriculum,
      progress as never,
      retrieval as never,
      () => new Date("2026-08-30T20:00:00.000Z"),
    );

    const context = await service.build();
    expect(context.schedule.events).toEqual([expect.objectContaining({ title: "LLM internals" })]);
    expect(context.outcomes).toEqual([expect.objectContaining({ checked: true })]);
    expect(context.resourceCounts.prepared_reference).toBe(1);
    expect(context.omissions).toContain("Protected solution material is excluded.");
    expect(JSON.stringify(context)).not.toContain("Full paper text that must stay tool-only");
    expect(retrieval.inventory).toHaveBeenCalledWith("day1");
  });
});
