import { describe, expect, it, vi } from "vitest";

import seedJson from "../../config/schedule/aisb-example-week.snapshot.json";
import {
  classifyScheduleMealTitle,
  isMealScheduleEvent,
  parseScheduleSeed,
  runtimeScheduleFromSeed,
  ScheduleValidationError,
  type ProgrammeDayId,
  type RuntimeSchedule,
  type RuntimeScheduleEvent,
} from "../../src/shared/schedule";
import {
  assessNowAnchorScheduleState,
  captureClockSample,
  deserializeClockSample,
  deserializeNowAnchor,
  isSampleCurrent,
  resolveNowAnchor,
  serializeClockSample,
  serializeNowAnchor,
  type Clock,
} from "../../src/client/time/now-anchor";

const LONDON = "Europe/London";

function scheduleEvent(
  eventBindingId: string,
  programmeDayId: ProgrammeDayId | null,
  start: string,
  end: string,
  options: {
    readonly allDay?: boolean;
    readonly status?: "scheduled" | "cancelled";
    readonly title?: string;
  } = {},
): RuntimeScheduleEvent {
  return Object.freeze({
    eventBindingId,
    programmeDayId,
    title: options.title ?? eventBindingId,
    start,
    end,
    allDay: options.allDay ?? false,
    status: options.status ?? "scheduled",
  });
}

function makeSchedule(events: readonly RuntimeScheduleEvent[], revision = "revision-1"): RuntimeSchedule {
  return Object.freeze({
    schemaVersion: 1,
    scheduleId: "test-schedule",
    scheduleRevision: revision,
    seedId: "test-seed",
    sourceLabel: "Test schedule",
    programmeWindow: Object.freeze({
      start: "2026-08-30T00:00:00+01:00",
      end: "2026-09-07T00:00:00+01:00",
      timeZone: LONDON,
    }),
    programmeDays: Object.freeze([
      Object.freeze({ dayId: "day1", date: "2026-08-30", curriculumKind: "content" }),
      Object.freeze({ dayId: "day2", date: "2026-08-31", curriculumKind: "content" }),
      Object.freeze({ dayId: "day3", date: "2026-09-01", curriculumKind: "content" }),
      Object.freeze({ dayId: "day4", date: "2026-09-02", curriculumKind: "break" }),
      Object.freeze({ dayId: "day5", date: "2026-09-03", curriculumKind: "content" }),
      Object.freeze({ dayId: "day6", date: "2026-09-04", curriculumKind: "content" }),
      Object.freeze({ dayId: "day7", date: "2026-09-05", curriculumKind: "content" }),
    ]),
    nonProgrammeDates: Object.freeze([
      Object.freeze({ date: "2026-09-06", kind: "departure" }),
    ]),
    events: Object.freeze([...events]),
  });
}

function sampleAt(instant: string, source: "load" | "button" = "load") {
  let calls = 0;
  const clock: Clock = {
    now() {
      calls += 1;
      return new Date(instant);
    },
  };
  return {
    sample: captureClockSample(clock, source, "entry-1", "bootstrap-1"),
    calls: () => calls,
  };
}

const dayOneEvents = Object.freeze([
  scheduleEvent(
    "event-a",
    "day1",
    "2026-08-30T09:00:00+01:00",
    "2026-08-30T10:00:00+01:00",
  ),
  scheduleEvent(
    "event-b",
    "day1",
    "2026-08-30T11:00:00+01:00",
    "2026-08-30T12:00:00+01:00",
  ),
]);

describe("schedule seed", () => {
  it("strictly parses the tracked 93-event seed into an immutable runtime projection", () => {
    const seed = parseScheduleSeed(seedJson, {
      computedEventsSha256: seedJson.events_sha256,
    });
    const schedule = runtimeScheduleFromSeed(seed);

    expect(seed.events).toHaveLength(93);
    expect(schedule.events).toHaveLength(93);
    expect(schedule.programmeWindow.timeZone).toBe(LONDON);
    expect(schedule.programmeDays.find((day) => day.dayId === "day4")).toMatchObject({
      date: "2026-09-02",
      curriculumKind: "break",
    });
    expect(schedule.programmeDays.find((day) => day.dayId === "day5")).toMatchObject({
      date: "2026-09-03",
      curriculumKind: "content",
    });
    expect(schedule.nonProgrammeDates).toEqual([
      { date: "2026-09-06", kind: "departure" },
    ]);
    expect(Object.isFrozen(seed.events)).toBe(true);
    expect(Object.isFrozen(schedule.events)).toBe(true);
  });

  it("rejects unknown fields, count drift, hash drift, and broken day relationships", () => {
    const unknownField = structuredClone(seedJson) as Record<string, unknown>;
    unknownField.google_calendar_id = "must-not-be-accepted";
    expect(() => parseScheduleSeed(unknownField)).toThrow(ScheduleValidationError);

    const badCount = structuredClone(seedJson);
    badCount.expected_event_count = 92;
    expect(() => parseScheduleSeed(badCount)).toThrow(/expected 92 events/);

    expect(() =>
      parseScheduleSeed(seedJson, { computedEventsSha256: "0".repeat(64) }),
    ).toThrow(/independently computed events hash/);

    const wrongDay = structuredClone(seedJson);
    wrongDay.events[0]!.programme_day_id = "day2";
    expect(() => parseScheduleSeed(wrongDay)).toThrow(/explicit programme date mapping/);
  });
});

describe("meal event titles", () => {
  it.each([
    ["Breakfast", "breakfast"],
    ["  lunch  ", "lunch"],
    ["DINNER", "dinner"],
    ["Lunch + Networking", "lunch"],
    ["Lunch   +   Networking reception", "lunch"],
    ["Dinner — Social", "dinner"],
  ] as const)("classifies %j as %s", (title, expected) => {
    expect(classifyScheduleMealTitle(title)).toBe(expected);
    expect(isMealScheduleEvent({ title })).toBe(true);
  });

  it.each([
    "Lunch and learn",
    "Lunch and Learn: Model Security",
    "Breakfast briefing",
    "Dinner keynote",
    "Post-lunch lab",
    "Networking",
    "Lunch — Transformers workshop",
  ])("does not classify learning-shaped title %j as a meal", (title) => {
    expect(classifyScheduleMealTitle(title)).toBeNull();
    expect(isMealScheduleEvent({ title })).toBe(false);
  });
});

describe("clock capture", () => {
  it("reads the injected clock exactly once and copies the sampled instant", () => {
    const mutableDate = new Date("2026-08-30T09:00:00.000Z");
    const now = vi.fn(() => mutableDate);
    const sample = captureClockSample({ now }, "load", "entry", "bootstrap");
    mutableDate.setUTCFullYear(2035);

    expect(now).toHaveBeenCalledTimes(1);
    expect(sample.capturedAt).toBe("2026-08-30T09:00:00.000Z");
    expect(Object.isFrozen(sample)).toBe(true);
  });

  it("matches both stable IDs before accepting deferred resolution", () => {
    const { sample } = sampleAt("2026-08-30T09:00:00.000Z");
    expect(
      isSampleCurrent(sample, { historyEntryId: "entry-1", bootstrapId: "bootstrap-1" }),
    ).toBe(true);
    expect(
      isSampleCurrent(sample, { historyEntryId: "entry-2", bootstrapId: "bootstrap-1" }),
    ).toBe(false);
    expect(
      isSampleCurrent(sample, { historyEntryId: "entry-1", bootstrapId: "bootstrap-2" }),
    ).toBe(false);
  });
});

describe("NowAnchor resolution", () => {
  it("anchors breakfast load to the first learning session while preserving active meal context", () => {
    const schedule = makeSchedule([
      scheduleEvent(
        "breakfast",
        "day1",
        "2026-08-30T07:00:00+01:00",
        "2026-08-30T09:00:00+01:00",
        { title: "Breakfast" },
      ),
      scheduleEvent(
        "welcome",
        "day1",
        "2026-08-30T10:00:00+01:00",
        "2026-08-30T10:30:00+01:00",
        { title: "Welcome to AISB" },
      ),
    ]);

    const anchor = resolveNowAnchor(
      sampleAt("2026-08-30T06:30:00.000Z").sample,
      schedule,
      LONDON,
    );

    expect(anchor.activeEventBindingIds).toEqual(["breakfast"]);
    expect(anchor.primaryEventBindingId).toBe("welcome");
    expect(anchor.fallbackReason).toBe("before-first-event");
  });

  it("skips active lunch and dinner when choosing between or after learning sessions", () => {
    const schedule = makeSchedule([
      scheduleEvent(
        "morning-lab",
        "day1",
        "2026-08-30T10:00:00+01:00",
        "2026-08-30T12:00:00+01:00",
      ),
      scheduleEvent(
        "lunch",
        "day1",
        "2026-08-30T12:00:00+01:00",
        "2026-08-30T13:00:00+01:00",
        { title: "Lunch + Networking" },
      ),
      scheduleEvent(
        "afternoon-lab",
        "day1",
        "2026-08-30T13:00:00+01:00",
        "2026-08-30T17:00:00+01:00",
      ),
      scheduleEvent(
        "dinner",
        "day1",
        "2026-08-30T18:00:00+01:00",
        "2026-08-30T20:00:00+01:00",
        { title: "Dinner" },
      ),
    ]);

    const atLunch = resolveNowAnchor(
      sampleAt("2026-08-30T11:30:00.000Z").sample,
      schedule,
      LONDON,
    );
    const atDinner = resolveNowAnchor(
      sampleAt("2026-08-30T18:00:00.000Z").sample,
      schedule,
      LONDON,
    );

    expect(atLunch.activeEventBindingIds).toEqual(["lunch"]);
    expect(atLunch.primaryEventBindingId).toBe("afternoon-lab");
    expect(atLunch.fallbackReason).toBe("between-events");
    expect(atDinner.activeEventBindingIds).toEqual(["dinner"]);
    expect(atDinner.primaryEventBindingId).toBe("afternoon-lab");
    expect(atDinner.fallbackReason).toBe("after-last-event");
  });

  it("still selects meals on a day with no learning events", () => {
    const schedule = makeSchedule([
      scheduleEvent(
        "breakfast",
        "day1",
        "2026-08-30T07:00:00+01:00",
        "2026-08-30T09:00:00+01:00",
        { title: "Breakfast" },
      ),
      scheduleEvent(
        "lunch",
        "day1",
        "2026-08-30T12:00:00+01:00",
        "2026-08-30T13:00:00+01:00",
        { title: "Lunch" },
      ),
    ]);

    const activeMeal = resolveNowAnchor(
      sampleAt("2026-08-30T06:30:00.000Z").sample,
      schedule,
      LONDON,
    );
    const betweenMeals = resolveNowAnchor(
      sampleAt("2026-08-30T09:30:00.000Z").sample,
      schedule,
      LONDON,
    );

    expect(activeMeal.primaryEventBindingId).toBe("breakfast");
    expect(activeMeal.fallbackReason).toBe("active-timed-event");
    expect(betweenMeals.primaryEventBindingId).toBe("lunch");
    expect(betweenMeals.fallbackReason).toBe("between-events");
  });

  it("chooses an overlapping learning session over an active meal regardless of start order", () => {
    const schedule = makeSchedule([
      scheduleEvent(
        "breakfast",
        "day1",
        "2026-08-30T07:00:00+01:00",
        "2026-08-30T10:30:00+01:00",
        { title: "Breakfast" },
      ),
      scheduleEvent(
        "orientation",
        "day1",
        "2026-08-30T10:00:00+01:00",
        "2026-08-30T11:00:00+01:00",
        { title: "Orientation" },
      ),
    ]);

    const anchor = resolveNowAnchor(
      sampleAt("2026-08-30T09:15:00.000Z").sample,
      schedule,
      LONDON,
    );

    expect(anchor.activeEventBindingIds).toEqual(["breakfast", "orientation"]);
    expect(anchor.primaryEventBindingId).toBe("orientation");
    expect(anchor.fallbackReason).toBe("active-timed-event");
  });

  it("uses half-open event bounds at exact start and exact end", () => {
    const adjacent = makeSchedule([
      scheduleEvent(
        "first",
        "day1",
        "2026-08-30T09:00:00+01:00",
        "2026-08-30T10:00:00+01:00",
      ),
      scheduleEvent(
        "second",
        "day1",
        "2026-08-30T10:00:00+01:00",
        "2026-08-30T11:00:00+01:00",
      ),
    ]);
    const atStart = resolveNowAnchor(
      sampleAt("2026-08-30T08:00:00.000Z").sample,
      adjacent,
      LONDON,
    );
    const atHandoff = resolveNowAnchor(
      sampleAt("2026-08-30T09:00:00.000Z").sample,
      adjacent,
      LONDON,
    );

    expect(atStart.primaryEventBindingId).toBe("first");
    expect(atStart.activeEventBindingIds).toEqual(["first"]);
    expect(atHandoff.primaryEventBindingId).toBe("second");
    expect(atHandoff.activeEventBindingIds).toEqual(["second"]);
  });

  it("chooses deterministic overlapping timed events and never lets all-day mask them", () => {
    const schedule = makeSchedule([
      scheduleEvent(
        "all-day",
        "day1",
        "2026-08-30T00:00:00+01:00",
        "2026-08-31T00:00:00+01:00",
        { allDay: true },
      ),
      scheduleEvent(
        "timed-first",
        "day1",
        "2026-08-30T09:00:00+01:00",
        "2026-08-30T11:00:00+01:00",
      ),
      scheduleEvent(
        "timed-second",
        "day1",
        "2026-08-30T09:15:00+01:00",
        "2026-08-30T10:00:00+01:00",
      ),
      scheduleEvent(
        "cancelled",
        "day1",
        "2026-08-30T08:00:00+01:00",
        "2026-08-30T12:00:00+01:00",
        { status: "cancelled" },
      ),
    ]);
    const anchor = resolveNowAnchor(
      sampleAt("2026-08-30T08:30:00.000Z").sample,
      schedule,
      LONDON,
    );

    expect(anchor.primaryEventBindingId).toBe("timed-first");
    expect(anchor.activeEventBindingIds).toEqual(["timed-first", "timed-second", "all-day"]);
    expect(anchor.fallbackReason).toBe("active-timed-event");
  });

  it("uses an active all-day row only when no timed session is active", () => {
    const schedule = makeSchedule([
      scheduleEvent(
        "all-day",
        "day1",
        "2026-08-30T00:00:00+01:00",
        "2026-08-31T00:00:00+01:00",
        { allDay: true },
      ),
      ...dayOneEvents,
    ]);
    const anchor = resolveNowAnchor(
      sampleAt("2026-08-30T06:00:00.000Z").sample,
      schedule,
      LONDON,
    );

    expect(anchor.primaryEventBindingId).toBe("all-day");
    expect(anchor.fallbackReason).toBe("active-all-day-event");
  });

  it.each([
    ["2026-08-30T07:00:00.000Z", "event-a", "before-first-event"],
    ["2026-08-30T09:30:00.000Z", "event-b", "between-events"],
    ["2026-08-30T12:30:00.000Z", "event-b", "after-last-event"],
  ] as const)("selects the documented daily fallback at %s", (instant, eventId, reason) => {
    const anchor = resolveNowAnchor(sampleAt(instant).sample, makeSchedule(dayOneEvents), LONDON);
    expect(anchor.primaryEventBindingId).toBe(eventId);
    expect(anchor.fallbackReason).toBe(reason);
  });

  it("uses explicit programme mappings for the break day and departure non-day", () => {
    const departure = scheduleEvent(
      "departure",
      null,
      "2026-09-06T10:00:00+01:00",
      "2026-09-06T11:00:00+01:00",
    );
    const schedule = makeSchedule([...dayOneEvents, departure]);
    const breakDay = resolveNowAnchor(
      sampleAt("2026-09-02T11:00:00.000Z").sample,
      schedule,
      LONDON,
    );
    const departureDay = resolveNowAnchor(
      sampleAt("2026-09-06T09:30:00.000Z").sample,
      schedule,
      LONDON,
    );

    expect(breakDay.dateState).toEqual({
      kind: "programme-day",
      date: "2026-09-02",
      programmeDayId: "day4",
      curriculumKind: "break",
    });
    expect(breakDay.fallbackReason).toBe("no-events-on-date");
    expect(departureDay.dateState).toEqual({
      kind: "non-programme-date",
      date: "2026-09-06",
      programmeDayId: null,
      nonProgrammeKind: "departure",
    });
    expect(departureDay.primaryEventBindingId).toBe("departure");
  });

  it("clamps outside programme dates without inventing another programme day", () => {
    const schedule = makeSchedule(dayOneEvents);
    const before = resolveNowAnchor(
      sampleAt("2026-08-29T12:00:00.000Z").sample,
      schedule,
      LONDON,
    );
    const after = resolveNowAnchor(
      sampleAt("2026-09-07T00:00:00.000Z").sample,
      schedule,
      LONDON,
    );

    expect(before.dateState.kind).toBe("before-programme");
    expect(before.programmeDayId).toBe("day1");
    expect(before.primaryEventBindingId).toBe("event-a");
    expect(after.dateState.kind).toBe("programme-complete");
    expect(after.programmeDayId).toBeNull();
    expect(after.fallbackReason).toBe("programme-complete");
  });

  it("resolves absolute instants in Europe/London independent of device-zone labels", () => {
    const londonMorning = makeSchedule([
      scheduleEvent(
        "london-session",
        "day1",
        "2026-08-30T10:00:00+01:00",
        "2026-08-30T10:30:00+01:00",
      ),
    ]);
    const anchor = resolveNowAnchor(
      sampleAt("2026-08-30T09:15:00.000Z").sample,
      londonMorning,
      LONDON,
    );

    expect(anchor.capturedProgrammeDate).toBe("2026-08-30");
    expect(anchor.primaryEventBindingId).toBe("london-session");
  });

  it("does not mutate schedule input or resample while resolving", () => {
    const { sample, calls } = sampleAt("2026-08-30T08:30:00.000Z");
    const originalEvents = [dayOneEvents[1]!, dayOneEvents[0]!];
    const schedule = makeSchedule(originalEvents);
    const before = schedule.events.map((event) => event.eventBindingId);
    const anchor = resolveNowAnchor(sample, schedule, LONDON);

    expect(calls()).toBe(1);
    expect(schedule.events.map((event) => event.eventBindingId)).toEqual(before);
    expect(Object.isFrozen(anchor)).toBe(true);
    expect(Object.isFrozen(anchor.activeEventBindingIds)).toBe(true);
  });
});

describe("async schedule and history safety", () => {
  it("discards a stale sample when navigation changes before a deferred schedule arrives", async () => {
    const { sample, calls } = sampleAt("2026-08-30T08:30:00.000Z");
    let currentRouter = { historyEntryId: "entry-1", bootstrapId: "bootstrap-1" };
    let publishSchedule!: (schedule: RuntimeSchedule) => void;
    const deferredSchedule = new Promise<RuntimeSchedule>((resolve) => {
      publishSchedule = resolve;
    });
    let resolvedAnchor: ReturnType<typeof resolveNowAnchor> | undefined;
    const completion = deferredSchedule.then((schedule) => {
      if (isSampleCurrent(sample, currentRouter)) {
        resolvedAnchor = resolveNowAnchor(sample, schedule, LONDON);
      }
    });

    currentRouter = { historyEntryId: "entry-2", bootstrapId: "bootstrap-1" };
    publishSchedule(makeSchedule(dayOneEvents));
    await completion;

    expect(calls()).toBe(1);
    expect(resolvedAnchor).toBeUndefined();
  });

  it("round-trips valid history state and rejects malformed or inconsistent state", () => {
    const { sample } = sampleAt("2026-08-30T08:30:00.000Z", "button");
    const anchor = resolveNowAnchor(sample, makeSchedule(dayOneEvents), LONDON);

    expect(deserializeClockSample(structuredClone(serializeClockSample(sample)))).toEqual(sample);
    expect(deserializeNowAnchor(structuredClone(serializeNowAnchor(anchor)))).toEqual(anchor);
    expect(deserializeClockSample({ ...sample, extra: true })).toBeNull();
    expect(
      deserializeNowAnchor({
        ...anchor,
        activeEventBindingIds: [],
        fallbackReason: "active-timed-event",
      }),
    ).toBeNull();
  });

  it("reports changed and unavailable schedule revisions without re-resolving", () => {
    const anchor = resolveNowAnchor(
      sampleAt("2026-08-30T08:30:00.000Z").sample,
      makeSchedule(dayOneEvents, "revision-1"),
      LONDON,
    );
    expect(assessNowAnchorScheduleState(anchor, makeSchedule(dayOneEvents, "revision-1"))).toEqual({
      kind: "current",
    });
    expect(assessNowAnchorScheduleState(anchor, makeSchedule(dayOneEvents, "revision-2"))).toEqual({
      kind: "schedule-changed",
      capturedRevision: "revision-1",
      currentRevision: "revision-2",
    });
    expect(assessNowAnchorScheduleState(anchor, makeSchedule([], "revision-3"))).toEqual({
      kind: "target-unavailable",
      capturedRevision: "revision-1",
      currentRevision: "revision-3",
      missingEventBindingId: "event-a",
    });
  });
});
