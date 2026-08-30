import {
  dateInTimeZone,
  isMealScheduleEvent,
  type CurriculumKind,
  type NonProgrammeKind,
  type ProgrammeDayId,
  type RuntimeSchedule,
  type RuntimeScheduleEvent,
} from "../../shared/schedule";

export const CLOCK_SAMPLE_SCHEMA_VERSION = 1 as const;
export const NOW_ANCHOR_SCHEMA_VERSION = 1 as const;

export type ClockCaptureSource = "load" | "button";

/** Navigation-only clock. Ordinary save/chat timestamps use another boundary. */
export interface Clock {
  now(): Date;
}

export interface ClockSample {
  readonly schemaVersion: typeof CLOCK_SAMPLE_SCHEMA_VERSION;
  readonly capturedAt: string;
  readonly captureSource: ClockCaptureSource;
  readonly historyEntryId: string;
  readonly bootstrapId: string;
}

export interface RouterAnchorIdentity {
  readonly historyEntryId: string;
  readonly bootstrapId: string;
}

export type ProgrammeDateState =
  | Readonly<{
      kind: "programme-day";
      date: string;
      programmeDayId: ProgrammeDayId;
      curriculumKind: CurriculumKind;
    }>
  | Readonly<{
      kind: "non-programme-date";
      date: string;
      programmeDayId: null;
      nonProgrammeKind: NonProgrammeKind;
    }>
  | Readonly<{
      kind: "before-programme";
      date: string;
      programmeDayId: ProgrammeDayId | null;
    }>
  | Readonly<{
      kind: "programme-complete";
      date: string;
      programmeDayId: null;
    }>
  | Readonly<{
      kind: "unmapped-programme-date";
      date: string;
      programmeDayId: null;
    }>;

export type NowAnchorFallbackReason =
  | "active-timed-event"
  | "active-all-day-event"
  | "before-first-event"
  | "between-events"
  | "after-last-event"
  | "before-programme"
  | "programme-complete"
  | "no-events-on-date"
  | "no-scheduled-events";

export interface NowAnchor {
  readonly schemaVersion: typeof NOW_ANCHOR_SCHEMA_VERSION;
  readonly capturedAt: string;
  readonly captureSource: ClockCaptureSource;
  readonly historyEntryId: string;
  readonly bootstrapId: string;
  readonly programmeTimeZone: string;
  readonly scheduleRevision: string;
  /** Calendar date of the sampled absolute instant in the programme zone. */
  readonly capturedProgrammeDate: string;
  /** Date the overview should display; before/after states clamp to the programme. */
  readonly resolvedDate: string;
  readonly programmeDayId: ProgrammeDayId | null;
  readonly dateState: ProgrammeDateState;
  readonly activeEventBindingIds: readonly string[];
  readonly primaryEventBindingId: string | null;
  readonly fallbackReason: NowAnchorFallbackReason;
}

export type NowAnchorScheduleState =
  | Readonly<{ kind: "current" }>
  | Readonly<{
      kind: "schedule-changed";
      capturedRevision: string;
      currentRevision: string;
    }>
  | Readonly<{
      kind: "target-unavailable";
      capturedRevision: string;
      currentRevision: string;
      missingEventBindingId: string;
    }>;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const FALLBACK_REASONS = new Set<NowAnchorFallbackReason>([
  "active-timed-event",
  "active-all-day-event",
  "before-first-event",
  "between-events",
  "after-last-event",
  "before-programme",
  "programme-complete",
  "no-events-on-date",
  "no-scheduled-events",
]);

function assertIdentifier(value: string, label: string): void {
  if (value.trim().length === 0 || value.length > 200) {
    throw new TypeError(`${label} must be a non-empty identifier`);
  }
}

function instantMilliseconds(value: string, label: string): number {
  const result = Date.parse(value);
  if (!Number.isFinite(result)) throw new TypeError(`${label} must be a valid timestamp`);
  return result;
}

function freezeStringArray(values: readonly string[]): readonly string[] {
  return Object.freeze([...values]);
}

function compareEvents(left: RuntimeScheduleEvent, right: RuntimeScheduleEvent): number {
  return (
    instantMilliseconds(left.start, "event start") -
      instantMilliseconds(right.start, "event start") ||
    left.eventBindingId.localeCompare(right.eventBindingId)
  );
}

function selectLastEvent(events: readonly RuntimeScheduleEvent[]): RuntimeScheduleEvent | undefined {
  return events.length === 0 ? undefined : events[events.length - 1];
}

/** Prefer learning rows, but retain meals as a fallback for meal-only days. */
function navigationEvents(
  events: readonly RuntimeScheduleEvent[],
): readonly RuntimeScheduleEvent[] {
  const nonMealEvents = events.filter((event) => !isMealScheduleEvent(event));
  return nonMealEvents.length > 0 ? nonMealEvents : events;
}

function eventsForResolvedDate(
  schedule: RuntimeSchedule,
  dateState: ProgrammeDateState,
): readonly RuntimeScheduleEvent[] {
  const scheduled = schedule.events.filter((event) => event.status !== "cancelled");
  if (dateState.kind === "programme-day") {
    return scheduled.filter((event) => event.programmeDayId === dateState.programmeDayId);
  }
  if (dateState.kind === "non-programme-date") {
    return scheduled.filter(
      (event) =>
        event.programmeDayId === null &&
        dateInTimeZone(new Date(event.start), schedule.programmeWindow.timeZone) === dateState.date,
    );
  }
  return [];
}

function resolveDateState(
  capturedAtMs: number,
  capturedDate: string,
  schedule: RuntimeSchedule,
): { readonly resolvedDate: string; readonly dateState: ProgrammeDateState } {
  const windowStart = instantMilliseconds(schedule.programmeWindow.start, "programme window start");
  const windowEnd = instantMilliseconds(schedule.programmeWindow.end, "programme window end");
  const firstDay = [...schedule.programmeDays].sort((a, b) => a.date.localeCompare(b.date))[0];
  const finalMappedDate = [
    ...schedule.programmeDays.map((day) => day.date),
    ...schedule.nonProgrammeDates.map((date) => date.date),
  ].sort().at(-1);

  if (capturedAtMs < windowStart) {
    const resolvedDate = firstDay?.date ?? capturedDate;
    return {
      resolvedDate,
      dateState: Object.freeze({
        kind: "before-programme" as const,
        date: resolvedDate,
        programmeDayId: firstDay?.dayId ?? null,
      }),
    };
  }
  if (capturedAtMs >= windowEnd) {
    const resolvedDate = finalMappedDate ?? capturedDate;
    return {
      resolvedDate,
      dateState: Object.freeze({
        kind: "programme-complete" as const,
        date: resolvedDate,
        programmeDayId: null,
      }),
    };
  }

  const programmeDay = schedule.programmeDays.find((day) => day.date === capturedDate);
  if (programmeDay !== undefined) {
    return {
      resolvedDate: capturedDate,
      dateState: Object.freeze({
        kind: "programme-day" as const,
        date: capturedDate,
        programmeDayId: programmeDay.dayId,
        curriculumKind: programmeDay.curriculumKind,
      }),
    };
  }
  const nonProgrammeDate = schedule.nonProgrammeDates.find((date) => date.date === capturedDate);
  if (nonProgrammeDate !== undefined) {
    return {
      resolvedDate: capturedDate,
      dateState: Object.freeze({
        kind: "non-programme-date" as const,
        date: capturedDate,
        programmeDayId: null,
        nonProgrammeKind: nonProgrammeDate.kind,
      }),
    };
  }
  return {
    resolvedDate: capturedDate,
    dateState: Object.freeze({
      kind: "unmapped-programme-date" as const,
      date: capturedDate,
      programmeDayId: null,
    }),
  };
}

/**
 * Take exactly one defensive copy of the navigation clock value. Resolution is
 * intentionally a separate operation so a deferred schedule load cannot read a
 * newer time.
 */
export function captureClockSample(
  clock: Clock,
  source: ClockCaptureSource,
  historyEntryId: string,
  bootstrapId: string,
): ClockSample {
  assertIdentifier(historyEntryId, "historyEntryId");
  assertIdentifier(bootstrapId, "bootstrapId");
  const sampledDate = clock.now();
  const sampledMilliseconds = sampledDate.getTime();
  if (!Number.isFinite(sampledMilliseconds)) throw new TypeError("clock returned an invalid Date");
  return Object.freeze({
    schemaVersion: CLOCK_SAMPLE_SCHEMA_VERSION,
    capturedAt: new Date(sampledMilliseconds).toISOString(),
    captureSource: source,
    historyEntryId,
    bootstrapId,
  });
}

/** True only while a deferred sample still belongs to the current entry/bootstrap. */
export function isSampleCurrent(
  sample: ClockSample,
  routerState: RouterAnchorIdentity | null | undefined,
): boolean {
  return (
    routerState !== null &&
    routerState !== undefined &&
    sample.historyEntryId === routerState.historyEntryId &&
    sample.bootstrapId === routerState.bootstrapId
  );
}

/**
 * Resolve one frozen sample against one immutable local schedule revision.
 * Bounds are half-open: start <= sample < end.
 */
export function resolveNowAnchor(
  sample: ClockSample,
  schedule: RuntimeSchedule,
  programmeTimeZone: string,
): NowAnchor {
  if (programmeTimeZone !== schedule.programmeWindow.timeZone) {
    throw new TypeError("programmeTimeZone must match the schedule programme time zone");
  }
  const capturedAtMs = instantMilliseconds(sample.capturedAt, "sample capturedAt");
  const capturedProgrammeDate = dateInTimeZone(new Date(capturedAtMs), programmeTimeZone);
  const { resolvedDate, dateState } = resolveDateState(
    capturedAtMs,
    capturedProgrammeDate,
    schedule,
  );
  const scheduledEvents = schedule.events
    .filter((event) => event.status !== "cancelled")
    .slice()
    .sort(compareEvents);

  let activeEventBindingIds: readonly string[] = Object.freeze([]);
  let primaryEventBindingId: string | null = null;
  let fallbackReason: NowAnchorFallbackReason;

  if (dateState.kind === "before-programme") {
    const navigable = navigationEvents(scheduledEvents);
    const firstTimed = navigable.find((event) => !event.allDay);
    const first = firstTimed ?? navigable[0];
    primaryEventBindingId = first?.eventBindingId ?? null;
    fallbackReason = first === undefined ? "no-scheduled-events" : "before-programme";
  } else if (dateState.kind === "programme-complete") {
    const navigable = navigationEvents(scheduledEvents);
    const timed = navigable.filter((event) => !event.allDay);
    const last = selectLastEvent(timed.length > 0 ? timed : navigable);
    primaryEventBindingId = last?.eventBindingId ?? null;
    fallbackReason = last === undefined ? "no-scheduled-events" : "programme-complete";
  } else {
    const active = scheduledEvents.filter(
      (event) =>
        instantMilliseconds(event.start, "event start") <= capturedAtMs &&
        capturedAtMs < instantMilliseconds(event.end, "event end"),
    );
    const activeTimed = active.filter((event) => !event.allDay).sort(compareEvents);
    const activeAllDay = active.filter((event) => event.allDay).sort(compareEvents);
    activeEventBindingIds = freezeStringArray(
      [...activeTimed, ...activeAllDay].map((event) => event.eventBindingId),
    );

    const dateEvents = [...eventsForResolvedDate(schedule, dateState)].sort(compareEvents);
    const navigableDateEvents = navigationEvents(dateEvents);
    const mealsAreFallbackOnly = navigableDateEvents !== dateEvents;
    const activeNavigableTimed = activeTimed.filter(
      (event) => !mealsAreFallbackOnly || !isMealScheduleEvent(event),
    );
    const activeNavigableAllDay = activeAllDay.filter(
      (event) => !mealsAreFallbackOnly || !isMealScheduleEvent(event),
    );

    if (activeNavigableTimed.length > 0) {
      primaryEventBindingId = activeNavigableTimed[0]!.eventBindingId;
      fallbackReason = "active-timed-event";
    } else if (activeNavigableAllDay.length > 0) {
      primaryEventBindingId = activeNavigableAllDay[0]!.eventBindingId;
      fallbackReason = "active-all-day-event";
    } else {
      // Timed rows carry navigation when any exist; all-day is the fallback-only surface.
      const timedDateEvents = navigableDateEvents.filter((event) => !event.allDay);
      const selectable =
        timedDateEvents.length > 0 ? timedDateEvents : navigableDateEvents;
      if (selectable.length === 0) {
        fallbackReason = "no-events-on-date";
      } else {
        const nextIndex = selectable.findIndex(
          (event) => instantMilliseconds(event.start, "event start") > capturedAtMs,
        );
        if (nextIndex === 0) {
          primaryEventBindingId = selectable[0]!.eventBindingId;
          fallbackReason = "before-first-event";
        } else if (nextIndex > 0) {
          primaryEventBindingId = selectable[nextIndex]!.eventBindingId;
          fallbackReason = "between-events";
        } else {
          primaryEventBindingId = selectable[selectable.length - 1]!.eventBindingId;
          fallbackReason = "after-last-event";
        }
      }
    }
  }

  return Object.freeze({
    schemaVersion: NOW_ANCHOR_SCHEMA_VERSION,
    capturedAt: sample.capturedAt,
    captureSource: sample.captureSource,
    historyEntryId: sample.historyEntryId,
    bootstrapId: sample.bootstrapId,
    programmeTimeZone,
    scheduleRevision: schedule.scheduleRevision,
    capturedProgrammeDate,
    resolvedDate,
    programmeDayId:
      dateState.kind === "programme-day" || dateState.kind === "before-programme"
        ? dateState.programmeDayId
        : null,
    dateState,
    activeEventBindingIds,
    primaryEventBindingId,
    fallbackReason,
  });
}

/** Keep the frozen selection and report whether its old target still exists. */
export function assessNowAnchorScheduleState(
  anchor: NowAnchor,
  schedule: RuntimeSchedule,
): NowAnchorScheduleState {
  const targetExists =
    anchor.primaryEventBindingId === null ||
    schedule.events.some((event) => event.eventBindingId === anchor.primaryEventBindingId);
  if (!targetExists) {
    return Object.freeze({
      kind: "target-unavailable" as const,
      capturedRevision: anchor.scheduleRevision,
      currentRevision: schedule.scheduleRevision,
      missingEventBindingId: anchor.primaryEventBindingId as string,
    });
  }
  if (anchor.scheduleRevision !== schedule.scheduleRevision) {
    return Object.freeze({
      kind: "schedule-changed" as const,
      capturedRevision: anchor.scheduleRevision,
      currentRevision: schedule.scheduleRevision,
    });
  }
  return Object.freeze({ kind: "current" as const });
}

type UnknownRecord = Record<string, unknown>;

function recordOrNull(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function hasExactKeys(
  record: UnknownRecord,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(record, key)) &&
    Object.keys(record).every((key) => allowed.has(key))
  );
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 200;
}

function isIsoInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function parseClockSampleRecord(value: unknown): ClockSample | null {
  const record = recordOrNull(value);
  if (
    record === null ||
    !hasExactKeys(record, [
      "schemaVersion",
      "capturedAt",
      "captureSource",
      "historyEntryId",
      "bootstrapId",
    ]) ||
    record.schemaVersion !== CLOCK_SAMPLE_SCHEMA_VERSION ||
    !isIsoInstant(record.capturedAt) ||
    (record.captureSource !== "load" && record.captureSource !== "button") ||
    !isIdentifier(record.historyEntryId) ||
    !isIdentifier(record.bootstrapId)
  ) {
    return null;
  }
  return Object.freeze({
    schemaVersion: CLOCK_SAMPLE_SCHEMA_VERSION,
    capturedAt: record.capturedAt,
    captureSource: record.captureSource,
    historyEntryId: record.historyEntryId,
    bootstrapId: record.bootstrapId,
  });
}

function parseDateState(value: unknown): ProgrammeDateState | null {
  const record = recordOrNull(value);
  if (record === null || typeof record.kind !== "string" || !isDate(record.date)) return null;
  if (record.kind === "programme-day") {
    if (
      !hasExactKeys(record, ["kind", "date", "programmeDayId", "curriculumKind"]) ||
      !/^day[1-7]$/.test(String(record.programmeDayId)) ||
      (record.curriculumKind !== "content" && record.curriculumKind !== "break")
    ) {
      return null;
    }
    return Object.freeze({
      kind: "programme-day",
      date: record.date,
      programmeDayId: record.programmeDayId as ProgrammeDayId,
      curriculumKind: record.curriculumKind,
    });
  }
  if (record.kind === "non-programme-date") {
    if (
      !hasExactKeys(record, ["kind", "date", "programmeDayId", "nonProgrammeKind"]) ||
      record.programmeDayId !== null ||
      record.nonProgrammeKind !== "departure"
    ) {
      return null;
    }
    return Object.freeze({
      kind: "non-programme-date",
      date: record.date,
      programmeDayId: null,
      nonProgrammeKind: "departure",
    });
  }
  if (record.kind === "before-programme") {
    if (
      !hasExactKeys(record, ["kind", "date", "programmeDayId"]) ||
      (record.programmeDayId !== null && !/^day[1-7]$/.test(String(record.programmeDayId)))
    ) {
      return null;
    }
    return Object.freeze({
      kind: "before-programme",
      date: record.date,
      programmeDayId: record.programmeDayId as ProgrammeDayId | null,
    });
  }
  if (record.kind === "programme-complete" || record.kind === "unmapped-programme-date") {
    if (
      !hasExactKeys(record, ["kind", "date", "programmeDayId"]) ||
      record.programmeDayId !== null
    ) {
      return null;
    }
    return Object.freeze({ kind: record.kind, date: record.date, programmeDayId: null });
  }
  return null;
}

/** Return a history/structured-clone-safe defensive copy of a clock sample. */
export function serializeClockSample(sample: ClockSample): ClockSample {
  return Object.freeze({ ...sample });
}

/** Validate untrusted browser-history data; malformed state is ignored. */
export function deserializeClockSample(value: unknown): ClockSample | null {
  return parseClockSampleRecord(value);
}

/** Return a history/structured-clone-safe defensive copy of an anchor. */
export function serializeNowAnchor(anchor: NowAnchor): NowAnchor {
  return Object.freeze({
    ...anchor,
    dateState: Object.freeze({ ...anchor.dateState }) as ProgrammeDateState,
    activeEventBindingIds: freezeStringArray(anchor.activeEventBindingIds),
  });
}

/** Validate untrusted browser-history data; malformed or inconsistent state is ignored. */
export function deserializeNowAnchor(value: unknown): NowAnchor | null {
  const record = recordOrNull(value);
  if (
    record === null ||
    !hasExactKeys(record, [
      "schemaVersion",
      "capturedAt",
      "captureSource",
      "historyEntryId",
      "bootstrapId",
      "programmeTimeZone",
      "scheduleRevision",
      "capturedProgrammeDate",
      "resolvedDate",
      "programmeDayId",
      "dateState",
      "activeEventBindingIds",
      "primaryEventBindingId",
      "fallbackReason",
    ]) ||
    record.schemaVersion !== NOW_ANCHOR_SCHEMA_VERSION ||
    !isIsoInstant(record.capturedAt) ||
    (record.captureSource !== "load" && record.captureSource !== "button") ||
    !isIdentifier(record.historyEntryId) ||
    !isIdentifier(record.bootstrapId) ||
    !isIdentifier(record.programmeTimeZone) ||
    !isIdentifier(record.scheduleRevision) ||
    !isDate(record.capturedProgrammeDate) ||
    !isDate(record.resolvedDate) ||
    (record.programmeDayId !== null && !/^day[1-7]$/.test(String(record.programmeDayId))) ||
    !Array.isArray(record.activeEventBindingIds) ||
    !record.activeEventBindingIds.every(isIdentifier) ||
    new Set(record.activeEventBindingIds).size !== record.activeEventBindingIds.length ||
    (record.primaryEventBindingId !== null && !isIdentifier(record.primaryEventBindingId)) ||
    typeof record.fallbackReason !== "string" ||
    !FALLBACK_REASONS.has(record.fallbackReason as NowAnchorFallbackReason)
  ) {
    return null;
  }
  const dateState = parseDateState(record.dateState);
  if (
    dateState === null ||
    dateState.date !== record.resolvedDate ||
    (dateState.kind === "programme-day" || dateState.kind === "before-programme"
      ? dateState.programmeDayId !== record.programmeDayId
      : record.programmeDayId !== null)
  ) {
    return null;
  }
  const activeIds = record.activeEventBindingIds as string[];
  if (
    (record.fallbackReason === "active-timed-event" ||
      record.fallbackReason === "active-all-day-event") &&
    (record.primaryEventBindingId === null || !activeIds.includes(record.primaryEventBindingId))
  ) {
    return null;
  }
  return Object.freeze({
    schemaVersion: NOW_ANCHOR_SCHEMA_VERSION,
    capturedAt: record.capturedAt,
    captureSource: record.captureSource,
    historyEntryId: record.historyEntryId,
    bootstrapId: record.bootstrapId,
    programmeTimeZone: record.programmeTimeZone,
    scheduleRevision: record.scheduleRevision,
    capturedProgrammeDate: record.capturedProgrammeDate,
    resolvedDate: record.resolvedDate,
    programmeDayId: record.programmeDayId as ProgrammeDayId | null,
    dateState,
    activeEventBindingIds: freezeStringArray(activeIds),
    primaryEventBindingId: record.primaryEventBindingId,
    fallbackReason: record.fallbackReason as NowAnchorFallbackReason,
  });
}
