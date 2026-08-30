/**
 * Shared schedule domain types and the strict parser for the committed schedule
 * seed. This module deliberately has no filesystem, network, clock, or storage
 * dependencies so the client and server can use the same trusted projection.
 */

export const PROGRAMME_DAY_IDS = [
  "day1",
  "day2",
  "day3",
  "day4",
  "day5",
  "day6",
  "day7",
] as const;

export type ProgrammeDayId = (typeof PROGRAMME_DAY_IDS)[number];
export type CurriculumKind = "content" | "break";
export type NonProgrammeKind = "departure";
export type ScheduleEventStatus = "scheduled" | "cancelled";
export type ScheduleMealKind = "breakfast" | "lunch" | "dinner";

/**
 * Classify calendar rows that exist primarily to mark a meal. Keep this
 * deliberately narrower than a word search: a teaching session such as
 * "Lunch and learn" must continue to participate in learning navigation.
 */
export function classifyScheduleMealTitle(title: string): ScheduleMealKind | null {
  const normalized = title.normalize("NFKC").trim().replace(/\s+/g, " ");
  const exact = /^(breakfast|lunch|dinner)$/i.exec(normalized);
  if (exact !== null) return exact[1]!.toLowerCase() as ScheduleMealKind;

  const variant = /^(breakfast|lunch|dinner)\s*(?:\+|&|\/|\||:|[-\u2013\u2014])\s*(.+)$/i.exec(
    normalized,
  );
  if (variant === null) return null;

  // These suffixes describe a social or catering variant, rather than a lesson.
  if (!/^(?:networking|social|reception|buffet|meal|break)(?:\b.*)?$/i.test(variant[2]!)) {
    return null;
  }
  return variant[1]!.toLowerCase() as ScheduleMealKind;
}

/** True when a schedule row is a meal rather than a learning destination. */
export function isMealScheduleEvent(event: { readonly title: string }): boolean {
  return classifyScheduleMealTitle(event.title) !== null;
}

export interface ScheduleSeedProgrammeWindow {
  readonly start: string;
  readonly end: string;
  readonly timezone: string;
}

export interface ScheduleSeedProgrammeDay {
  readonly day_id: ProgrammeDayId;
  readonly date: string;
  readonly curriculum_kind: CurriculumKind;
}

export interface ScheduleSeedNonProgrammeDate {
  readonly date: string;
  readonly kind: NonProgrammeKind;
  readonly programme_day_id: null;
}

export interface ScheduleSeedEvent {
  readonly event_binding_id: string;
  readonly programme_day_id: ProgrammeDayId | null;
  readonly title: string;
  readonly start: string;
  readonly end: string;
  readonly all_day: boolean;
  readonly status: ScheduleEventStatus;
  readonly location?: string;
}

export interface ScheduleSeedPrivacyManifest {
  readonly included_fields: readonly string[];
  readonly public_release_sanitization: readonly string[];
  readonly excluded_fields: readonly string[];
}

export interface ScheduleSeed {
  readonly schema_version: 1;
  readonly seed_id: string;
  readonly source_label: string;
  readonly captured_at: string;
  readonly programme_window: ScheduleSeedProgrammeWindow;
  readonly programme_days: readonly ScheduleSeedProgrammeDay[];
  readonly non_programme_dates: readonly ScheduleSeedNonProgrammeDate[];
  readonly expected_event_count: number;
  readonly events_hash_algorithm: "sha256-rfc8785-events-array";
  readonly events_sha256: string;
  readonly privacy: ScheduleSeedPrivacyManifest;
  readonly events: readonly ScheduleSeedEvent[];
}

export interface RuntimeProgrammeWindow {
  readonly start: string;
  readonly end: string;
  readonly timeZone: string;
}

export interface RuntimeProgrammeDay {
  readonly dayId: ProgrammeDayId;
  readonly date: string;
  readonly curriculumKind: CurriculumKind;
}

export interface RuntimeNonProgrammeDate {
  readonly date: string;
  readonly kind: NonProgrammeKind;
}

export interface RuntimeScheduleEvent {
  readonly eventBindingId: string;
  readonly programmeDayId: ProgrammeDayId | null;
  readonly title: string;
  readonly start: string;
  readonly end: string;
  readonly allDay: boolean;
  readonly status: ScheduleEventStatus;
  readonly location?: string;
}

/** The local editable schedule projection consumed by navigation. */
export interface RuntimeSchedule {
  readonly schemaVersion: 1;
  readonly scheduleId: string;
  readonly scheduleRevision: string;
  readonly seedId: string;
  readonly sourceLabel: string;
  readonly programmeWindow: RuntimeProgrammeWindow;
  readonly programmeDays: readonly RuntimeProgrammeDay[];
  readonly nonProgrammeDates: readonly RuntimeNonProgrammeDate[];
  readonly events: readonly RuntimeScheduleEvent[];
}

export interface ParseScheduleSeedOptions {
  /**
   * The server-side seed service can supply the independently computed RFC 8785
   * hash here. The shared/browser parser never pretends to recompute it.
   */
  readonly computedEventsSha256?: string;
}

export class ScheduleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleValidationError";
  }
}

type UnknownRecord = Record<string, unknown>;

const RFC3339_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const EVENT_ID_PATTERN = /^aisb-2026-[0-9]{3}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const URL_PATTERN = /(?:https?:\/\/|www\.)/i;
const EMAIL_PATTERN = /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/;

function fail(path: string, message: string): never {
  throw new ScheduleValidationError(`${path}: ${message}`);
}

function expectRecord(value: unknown, path: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "expected an object");
  }
  return value as UnknownRecord;
}

function assertExactKeys(
  value: UnknownRecord,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(path, `unknown key ${JSON.stringify(key)}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(path, `missing key ${JSON.stringify(key)}`);
  }
}

function expectString(
  value: unknown,
  path: string,
  { min = 1, max = 500 }: { readonly min?: number; readonly max?: number } = {},
): string {
  if (typeof value !== "string") fail(path, "expected a string");
  if (value.length < min || value.length > max) {
    fail(path, `expected between ${min} and ${max} characters`);
  }
  return value;
}

function expectDisplayString(value: unknown, path: string, max: number): string {
  const result = expectString(value, path, { max });
  if (CONTROL_CHARACTER_PATTERN.test(result)) fail(path, "contains a control character");
  if (URL_PATTERN.test(result)) fail(path, "contains a URL");
  if (EMAIL_PATTERN.test(result)) fail(path, "contains an email address");
  return result;
}

function expectStringArray(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value)) fail(path, "expected an array");
  return Object.freeze(
    value.map((item, index) => expectDisplayString(item, `${path}[${index}]`, 300)),
  );
}

function expectBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "expected a boolean");
  return value;
}

function expectInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    fail(path, "expected a safe integer");
  }
  return value;
}

function expectDate(value: unknown, path: string): string {
  const result = expectString(value, path, { max: 10 });
  if (!DATE_PATTERN.test(result)) fail(path, "expected YYYY-MM-DD");
  const parsed = new Date(`${result}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== result) {
    fail(path, "invalid calendar date");
  }
  return result;
}

function expectInstant(value: unknown, path: string): string {
  const result = expectString(value, path, { max: 40 });
  if (!RFC3339_PATTERN.test(result) || !Number.isFinite(Date.parse(result))) {
    fail(path, "expected a valid RFC3339 timestamp with an explicit offset");
  }
  return result;
}

function assertTimeZone(value: string, path: string): void {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format(0);
  } catch {
    fail(path, "expected a valid IANA time zone");
  }
}

function expectProgrammeDayId(value: unknown, path: string): ProgrammeDayId {
  if (typeof value !== "string" || !(PROGRAMME_DAY_IDS as readonly string[]).includes(value)) {
    fail(path, `expected one of ${PROGRAMME_DAY_IDS.join(", ")}`);
  }
  return value as ProgrammeDayId;
}

/** Format an absolute instant as its calendar date in a named programme zone. */
export function dateInTimeZone(instant: Date, timeZone: string): string {
  if (!Number.isFinite(instant.getTime())) {
    throw new ScheduleValidationError("instant: expected a valid Date");
  }
  assertTimeZone(timeZone, "timeZone");
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes): string => {
    const result = parts.find((candidate) => candidate.type === type)?.value;
    if (result === undefined) throw new ScheduleValidationError(`missing ${type} date part`);
    return result;
  };
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function parseProgrammeWindow(value: unknown): ScheduleSeedProgrammeWindow {
  const record = expectRecord(value, "programme_window");
  assertExactKeys(record, ["start", "end", "timezone"], [], "programme_window");
  const result = Object.freeze({
    start: expectInstant(record.start, "programme_window.start"),
    end: expectInstant(record.end, "programme_window.end"),
    timezone: expectString(record.timezone, "programme_window.timezone", { max: 100 }),
  });
  assertTimeZone(result.timezone, "programme_window.timezone");
  if (Date.parse(result.end) <= Date.parse(result.start)) {
    fail("programme_window", "end must be after start");
  }
  return result;
}

function parseProgrammeDay(value: unknown, index: number): ScheduleSeedProgrammeDay {
  const path = `programme_days[${index}]`;
  const record = expectRecord(value, path);
  assertExactKeys(record, ["day_id", "date", "curriculum_kind"], [], path);
  const curriculumKind = record.curriculum_kind;
  if (curriculumKind !== "content" && curriculumKind !== "break") {
    fail(`${path}.curriculum_kind`, "expected content or break");
  }
  return Object.freeze({
    day_id: expectProgrammeDayId(record.day_id, `${path}.day_id`),
    date: expectDate(record.date, `${path}.date`),
    curriculum_kind: curriculumKind,
  });
}

function parseNonProgrammeDate(value: unknown, index: number): ScheduleSeedNonProgrammeDate {
  const path = `non_programme_dates[${index}]`;
  const record = expectRecord(value, path);
  assertExactKeys(record, ["date", "kind", "programme_day_id"], [], path);
  if (record.kind !== "departure") fail(`${path}.kind`, "expected departure");
  if (record.programme_day_id !== null) fail(`${path}.programme_day_id`, "expected null");
  return Object.freeze({
    date: expectDate(record.date, `${path}.date`),
    kind: "departure" as const,
    programme_day_id: null,
  });
}

function parsePrivacy(value: unknown): ScheduleSeedPrivacyManifest {
  const record = expectRecord(value, "privacy");
  assertExactKeys(
    record,
    [
      "included_fields",
      "public_release_sanitization",
      "excluded_fields",
    ],
    [],
    "privacy",
  );
  return Object.freeze({
    included_fields: expectStringArray(record.included_fields, "privacy.included_fields"),
    public_release_sanitization: expectStringArray(
      record.public_release_sanitization,
      "privacy.public_release_sanitization",
    ),
    excluded_fields: expectStringArray(record.excluded_fields, "privacy.excluded_fields"),
  });
}

function parseEvent(value: unknown, index: number): ScheduleSeedEvent {
  const path = `events[${index}]`;
  const record = expectRecord(value, path);
  assertExactKeys(
    record,
    ["event_binding_id", "programme_day_id", "title", "start", "end", "all_day", "status"],
    ["location"],
    path,
  );
  const eventBindingId = expectString(record.event_binding_id, `${path}.event_binding_id`, {
    max: 30,
  });
  if (!EVENT_ID_PATTERN.test(eventBindingId)) {
    fail(`${path}.event_binding_id`, "expected a companion AISB 2026 event ID");
  }
  const status = record.status;
  if (status !== "scheduled" && status !== "cancelled") {
    fail(`${path}.status`, "expected scheduled or cancelled");
  }
  const start = expectInstant(record.start, `${path}.start`);
  const end = expectInstant(record.end, `${path}.end`);
  if (Date.parse(end) <= Date.parse(start)) fail(path, "end must be after start");
  const allDay = expectBoolean(record.all_day, `${path}.all_day`);
  if (allDay && (!start.includes("T00:00:00") || !end.includes("T00:00:00"))) {
    fail(path, "all-day events must use local-midnight bounds");
  }
  const location =
    record.location === undefined
      ? undefined
      : expectDisplayString(record.location, `${path}.location`, 500);
  const base: Omit<ScheduleSeedEvent, "location"> = {
    event_binding_id: eventBindingId,
    programme_day_id:
      record.programme_day_id === null
        ? null
        : expectProgrammeDayId(record.programme_day_id, `${path}.programme_day_id`),
    title: expectDisplayString(record.title, `${path}.title`, 200),
    start,
    end,
    all_day: allDay,
    status: status as ScheduleEventStatus,
  };
  return Object.freeze(location === undefined ? base : { ...base, location });
}

/**
 * Strictly parse the immutable tracked seed. Unknown fields fail closed. Hash
 * computation belongs to the server seed service; when supplied, its result is
 * checked here alongside all structural and relational invariants.
 */
export function parseScheduleSeed(
  input: unknown,
  options: ParseScheduleSeedOptions = {},
): ScheduleSeed {
  const record = expectRecord(input, "schedule seed");
  assertExactKeys(
    record,
    [
      "schema_version",
      "seed_id",
      "source_label",
      "captured_at",
      "programme_window",
      "programme_days",
      "non_programme_dates",
      "expected_event_count",
      "events_hash_algorithm",
      "events_sha256",
      "privacy",
      "events",
    ],
    [],
    "schedule seed",
  );
  if (record.schema_version !== 1) fail("schema_version", "expected 1");
  if (record.events_hash_algorithm !== "sha256-rfc8785-events-array") {
    fail("events_hash_algorithm", "unsupported hash algorithm");
  }
  const programmeWindow = parseProgrammeWindow(record.programme_window);
  if (!Array.isArray(record.programme_days)) fail("programme_days", "expected an array");
  if (!Array.isArray(record.non_programme_dates)) {
    fail("non_programme_dates", "expected an array");
  }
  if (!Array.isArray(record.events)) fail("events", "expected an array");

  const programmeDays = Object.freeze(record.programme_days.map(parseProgrammeDay));
  const nonProgrammeDates = Object.freeze(
    record.non_programme_dates.map(parseNonProgrammeDate),
  );
  const events = Object.freeze(record.events.map(parseEvent));
  const expectedEventCount = expectInteger(record.expected_event_count, "expected_event_count");
  if (expectedEventCount !== events.length) {
    fail("events", `expected ${expectedEventCount} events, received ${events.length}`);
  }
  if (programmeDays.length !== PROGRAMME_DAY_IDS.length) {
    fail("programme_days", `expected exactly ${PROGRAMME_DAY_IDS.length} entries`);
  }

  const dayById = new Map<ProgrammeDayId, ScheduleSeedProgrammeDay>();
  const dayByDate = new Map<string, ScheduleSeedProgrammeDay>();
  for (const day of programmeDays) {
    if (dayById.has(day.day_id)) fail("programme_days", `duplicate day ID ${day.day_id}`);
    if (dayByDate.has(day.date)) fail("programme_days", `duplicate date ${day.date}`);
    dayById.set(day.day_id, day);
    dayByDate.set(day.date, day);
  }
  for (const dayId of PROGRAMME_DAY_IDS) {
    if (!dayById.has(dayId)) fail("programme_days", `missing explicit mapping for ${dayId}`);
  }
  const nonProgrammeByDate = new Map<string, ScheduleSeedNonProgrammeDate>();
  for (const date of nonProgrammeDates) {
    if (dayByDate.has(date.date) || nonProgrammeByDate.has(date.date)) {
      fail("non_programme_dates", `duplicate or conflicting date ${date.date}`);
    }
    nonProgrammeByDate.set(date.date, date);
  }

  const windowStart = Date.parse(programmeWindow.start);
  const windowEnd = Date.parse(programmeWindow.end);
  const eventIds = new Set<string>();
  let previous: ScheduleSeedEvent | undefined;
  for (const event of events) {
    if (eventIds.has(event.event_binding_id)) {
      fail("events", `duplicate event ID ${event.event_binding_id}`);
    }
    eventIds.add(event.event_binding_id);
    const start = Date.parse(event.start);
    const end = Date.parse(event.end);
    if (!(start < windowEnd && end > windowStart)) {
      fail(`events.${event.event_binding_id}`, "does not overlap the programme window");
    }
    if (
      previous !== undefined &&
      (start < Date.parse(previous.start) ||
        (start === Date.parse(previous.start) &&
          event.event_binding_id.localeCompare(previous.event_binding_id) < 0))
    ) {
      fail("events", "must be ordered by start time and then event ID");
    }
    previous = event;
    const localStartDate = dateInTimeZone(new Date(start), programmeWindow.timezone);
    if (event.programme_day_id === null) {
      if (!nonProgrammeByDate.has(localStartDate)) {
        fail(
          `events.${event.event_binding_id}.programme_day_id`,
          "may be null only on a declared non-programme date",
        );
      }
    } else if (dayById.get(event.programme_day_id)?.date !== localStartDate) {
      fail(
        `events.${event.event_binding_id}.programme_day_id`,
        "does not match the explicit programme date mapping",
      );
    }
  }

  const eventsSha256 = expectString(record.events_sha256, "events_sha256", { max: 64 });
  if (!SHA256_PATTERN.test(eventsSha256)) fail("events_sha256", "expected lowercase SHA-256");
  if (
    options.computedEventsSha256 !== undefined &&
    options.computedEventsSha256 !== eventsSha256
  ) {
    fail("events_sha256", "does not match the independently computed events hash");
  }

  return Object.freeze({
    schema_version: 1 as const,
    seed_id: expectString(record.seed_id, "seed_id", { max: 150 }),
    source_label: expectDisplayString(record.source_label, "source_label", 150),
    captured_at: expectInstant(record.captured_at, "captured_at"),
    programme_window: programmeWindow,
    programme_days: programmeDays,
    non_programme_dates: nonProgrammeDates,
    expected_event_count: expectedEventCount,
    events_hash_algorithm: "sha256-rfc8785-events-array" as const,
    events_sha256: eventsSha256,
    privacy: parsePrivacy(record.privacy),
    events,
  });
}

/** Create the immutable base runtime projection without retaining seed objects. */
export function runtimeScheduleFromSeed(
  seed: ScheduleSeed,
  scheduleRevision = `seed:${seed.events_sha256}`,
): RuntimeSchedule {
  if (scheduleRevision.trim().length === 0) {
    throw new ScheduleValidationError("scheduleRevision: expected a non-empty string");
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    scheduleId: seed.seed_id,
    scheduleRevision,
    seedId: seed.seed_id,
    sourceLabel: seed.source_label,
    programmeWindow: Object.freeze({
      start: seed.programme_window.start,
      end: seed.programme_window.end,
      timeZone: seed.programme_window.timezone,
    }),
    programmeDays: Object.freeze(
      seed.programme_days.map((day) =>
        Object.freeze({
          dayId: day.day_id,
          date: day.date,
          curriculumKind: day.curriculum_kind,
        }),
      ),
    ),
    nonProgrammeDates: Object.freeze(
      seed.non_programme_dates.map((date) =>
        Object.freeze({ date: date.date, kind: date.kind }),
      ),
    ),
    events: Object.freeze(
      seed.events.map((event) => {
        const base = {
          eventBindingId: event.event_binding_id,
          programmeDayId: event.programme_day_id,
          title: event.title,
          start: event.start,
          end: event.end,
          allDay: event.all_day,
          status: event.status,
        };
        return Object.freeze(
          event.location === undefined ? base : { ...base, location: event.location },
        );
      }),
    ),
  });
}
