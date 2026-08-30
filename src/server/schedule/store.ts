import { createHash, randomUUID } from "node:crypto";
import { open, readFile, rename, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type {
  ProgrammeDayId,
  ProgrammeDaySummary,
  ScheduleEventView,
} from "../../shared/api.js";
import { dateInTimeZone, type RuntimeSchedule } from "../../shared/schedule.js";

const programmeDayIdSchema = z.enum(["day1", "day2", "day3", "day4", "day5", "day6", "day7"]);
const eventSchema = z
  .object({
    event_binding_id: z.string().regex(/^aisb-\d{4}-\d{3}$/),
    programme_day_id: programmeDayIdSchema.nullable(),
    title: z.string().trim().min(1).max(240),
    start: z.iso.datetime({ offset: true }),
    end: z.iso.datetime({ offset: true }),
    all_day: z.boolean(),
    status: z.enum(["scheduled", "cancelled"]),
    location: z.string().trim().min(1).max(500).optional(),
  })
  .strict()
  .refine((event) => Date.parse(event.end) > Date.parse(event.start), "Event end must follow start");

const programmeDaySchema = z
  .object({
    day_id: programmeDayIdSchema,
    date: z.iso.date(),
    curriculum_kind: z.enum(["content", "break"]),
  })
  .strict();

const seedSchema = z
  .object({
    schema_version: z.literal(1),
    seed_id: z.string().min(1),
    source_label: z.string().min(1),
    captured_at: z.iso.datetime({ offset: true }),
    events_hash_algorithm: z.literal("sha256-rfc8785-events-array"),
    events_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    expected_event_count: z.number().int().positive(),
    programme_window: z
      .object({
        start: z.iso.datetime({ offset: true }),
        end: z.iso.datetime({ offset: true }),
        timezone: z.literal("Europe/London"),
      })
      .strict(),
    programme_days: z.array(programmeDaySchema).length(7),
    non_programme_dates: z.array(
      z
        .object({
          date: z.iso.date(),
          kind: z.literal("departure"),
          programme_day_id: z.null(),
        })
        .strict(),
    ),
    privacy: z.record(z.string(), z.unknown()),
    events: z.array(eventSchema),
  })
  .strict();

const runtimeSchema = z
  .object({
    schema_version: z.literal(1),
    seed_id: z.string(),
    seed_events_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    schedule_revision: z.number().int().positive(),
    source_label: z.string().min(1),
    programme_time_zone: z.literal("Europe/London"),
    programme_window: z
      .object({
        start: z.iso.datetime({ offset: true }),
        end: z.iso.datetime({ offset: true }),
      })
      .strict(),
    programme_days: z.array(programmeDaySchema).length(7),
    non_programme_dates: z.array(
      z
        .object({
          date: z.iso.date(),
          kind: z.literal("departure"),
        })
        .strict(),
    ),
    /**
     * Durable allocation ledger. Events may be removed by an explicit seed
     * re-import, but an application-owned binding ID must never be reused.
     */
    event_id_high_water_marks: z
      .record(z.string().regex(/^\d{4}$/), z.number().int().min(0).max(999))
      .default({}),
    events: z.array(eventSchema),
  })
  .strict();

type SeedSchedule = z.infer<typeof seedSchema>;
type RuntimeScheduleFile = z.infer<typeof runtimeSchema>;

export interface NewScheduleEvent {
  programmeDayId: ProgrammeDayId | null;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  status?: "scheduled" | "cancelled";
  location?: string;
}

export interface ScheduleEventChanges {
  programmeDayId?: ProgrammeDayId | null;
  title?: string;
  start?: string;
  end?: string;
  allDay?: boolean;
  status?: "scheduled" | "cancelled";
  /** `null` removes the saved location. */
  location?: string | null;
}

export type ScheduleMutation =
  | { kind: "add"; event: NewScheduleEvent }
  | { kind: "update"; eventBindingId: string; changes: ScheduleEventChanges }
  | { kind: "cancel"; eventBindingId: string };

export class ScheduleStoreError extends Error {
  constructor(
    readonly code: "conflict" | "not_found" | "invalid_event" | "event_id_exhausted",
    message: string,
    readonly currentRevision?: string,
  ) {
    super(message);
    this.name = "ScheduleStoreError";
  }
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("Unsupported value in canonical JSON");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`)
      .join(",")}}`;
  }
  throw new Error("Unsupported value in canonical JSON");
}

export function hashSeedEvents(events: readonly unknown[]): string {
  return createHash("sha256").update(canonicalize(events)).digest("hex");
}

function validateSeed(input: unknown): SeedSchedule {
  const seed = seedSchema.parse(input);
  if (seed.events.length !== seed.expected_event_count) {
    throw new Error(`Expected ${seed.expected_event_count} schedule events, found ${seed.events.length}`);
  }
  const eventIds = new Set(seed.events.map((event) => event.event_binding_id));
  if (eventIds.size !== seed.events.length) throw new Error("Schedule event_binding_id values must be unique");
  const hash = hashSeedEvents(seed.events);
  if (hash !== seed.events_sha256) throw new Error("Schedule seed events hash does not match its manifest");
  for (let index = 1; index < seed.events.length; index += 1) {
    if (Date.parse(seed.events[index]!.start) < Date.parse(seed.events[index - 1]!.start)) {
      throw new Error("Schedule seed events must be chronologically ordered");
    }
  }
  return seed;
}

async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const temporary = join(dirname(target), `.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, target);
  const directoryHandle = await open(dirname(target), "r");
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

function toRuntime(seed: SeedSchedule): RuntimeScheduleFile {
  return {
    schema_version: 1,
    seed_id: seed.seed_id,
    seed_events_sha256: seed.events_sha256,
    schedule_revision: 1,
    source_label: seed.source_label,
    programme_time_zone: "Europe/London",
    programme_window: {
      start: seed.programme_window.start,
      end: seed.programme_window.end,
    },
    programme_days: seed.programme_days,
    non_programme_dates: seed.non_programme_dates.map(({ date, kind }) => ({ date, kind })),
    event_id_high_water_marks: highWaterMarksFromEvents(seed.events),
    events: seed.events,
  };
}

function highWaterMarksFromEvents(
  events: readonly { readonly event_binding_id: string }[],
): Record<string, number> {
  const marks: Record<string, number> = {};
  for (const event of events) {
    const match = event.event_binding_id.match(/^aisb-(\d{4})-(\d{3})$/);
    if (!match) continue;
    const year = match[1]!;
    const sequence = Number.parseInt(match[2]!, 10);
    marks[year] = Math.max(marks[year] ?? 0, sequence);
  }
  return marks;
}

function mergedHighWaterMarks(
  ...sources: readonly Readonly<Record<string, number>>[]
): Record<string, number> {
  const merged: Record<string, number> = {};
  for (const source of sources) {
    for (const [year, sequence] of Object.entries(source)) {
      merged[year] = Math.max(merged[year] ?? 0, sequence);
    }
  }
  return merged;
}

/**
 * Read legacy runtime files without an allocation ledger, deriving a safe
 * starting point from every ID that is still present. The next successful
 * mutation persists the ledger in the current schema.
 */
function parseRuntime(input: unknown): RuntimeScheduleFile {
  const parsed = runtimeSchema.parse(input);
  return runtimeSchema.parse({
    ...parsed,
    event_id_high_water_marks: mergedHighWaterMarks(
      parsed.event_id_high_water_marks,
      highWaterMarksFromEvents(parsed.events),
    ),
  });
}

function scheduleRevisionFor(runtime: RuntimeScheduleFile): string {
  return `${runtime.seed_id}:r${runtime.schedule_revision}:${hashSeedEvents(runtime.events).slice(0, 12)}`;
}

function sortEvents(events: RuntimeScheduleFile["events"]): RuntimeScheduleFile["events"] {
  return [...events].sort((left, right) => {
    const byStart = Date.parse(left.start) - Date.parse(right.start);
    return byStart || left.event_binding_id.localeCompare(right.event_binding_id);
  });
}

function nextEventBindingId(runtime: RuntimeScheduleFile): string {
  const year = runtime.programme_days[0]?.date.slice(0, 4);
  if (!year || !/^\d{4}$/.test(year)) {
    throw new ScheduleStoreError("invalid_event", "The programme year is unavailable");
  }
  const prefix = `aisb-${year}-`;
  const lastSequence = Math.max(
    runtime.event_id_high_water_marks[year] ?? 0,
    highWaterMarksFromEvents(runtime.events)[year] ?? 0,
  );
  if (lastSequence >= 999) {
    throw new ScheduleStoreError("event_id_exhausted", `No local event IDs remain for ${year}`);
  }
  return `${prefix}${String(lastSequence + 1).padStart(3, "0")}`;
}

function parseEventForMutation(
  input: unknown,
  runtime: RuntimeScheduleFile,
): RuntimeScheduleFile["events"][number] {
  let event: RuntimeScheduleFile["events"][number];
  try {
    event = eventSchema.parse(input);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ScheduleStoreError("invalid_event", "The schedule event did not match the local contract");
    }
    throw error;
  }

  const start = Date.parse(event.start);
  const end = Date.parse(event.end);
  const windowStart = Date.parse(runtime.programme_window.start);
  const windowEnd = Date.parse(runtime.programme_window.end);
  if (!(start < windowEnd && end > windowStart)) {
    throw new ScheduleStoreError(
      "invalid_event",
      "The schedule event must overlap the programme window",
    );
  }

  const localStartDate = dateInTimeZone(new Date(start), runtime.programme_time_zone);
  if (event.programme_day_id === null) {
    if (!runtime.non_programme_dates.some((date) => date.date === localStartDate)) {
      throw new ScheduleStoreError(
        "invalid_event",
        "An event without a programme day must start on a declared non-programme date",
      );
    }
  } else {
    const programmeDate = runtime.programme_days.find(
      (day) => day.day_id === event.programme_day_id,
    )?.date;
    if (programmeDate !== localStartDate) {
      throw new ScheduleStoreError(
        "invalid_event",
        `The schedule event must start on ${programmeDate ?? "its programme date"} in Europe/London`,
      );
    }
  }

  return event;
}

export interface ScheduleSnapshot {
  runtimeSchedule: RuntimeSchedule;
  scheduleRevision: string;
  programmeTimeZone: "Europe/London";
  programmeDays: ProgrammeDaySummary[];
  events: ScheduleEventView[];
}

export class ScheduleStore {
  private readonly runtimePath: string;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly seedPath: string,
    stateRoot: string,
  ) {
    this.runtimePath = join(stateRoot, "schedule", "schedule.json");
  }

  async seedIfAbsent(): Promise<RuntimeScheduleFile> {
    try {
      return parseRuntime(JSON.parse(await readFile(this.runtimePath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const seed = validateSeed(JSON.parse(await readFile(this.seedPath, "utf8")));
    const runtime = toRuntime(seed);
    try {
      await writeJsonAtomic(this.runtimePath, runtime);
      return runtime;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return parseRuntime(JSON.parse(await readFile(this.runtimePath, "utf8")));
    }
  }

  async read(): Promise<ScheduleSnapshot> {
    const runtime = await this.seedIfAbsent();
    return this.toSnapshot(runtime);
  }

  /**
   * Hold the schedule mutation queue while a cross-store operation validates
   * and commits against one exact schedule revision. The callback must not
   * call another mutating ScheduleStore method.
   */
  async withSnapshotAtRevision<T>(
    expectedRevision: string,
    operation: (snapshot: ScheduleSnapshot) => Promise<T>,
  ): Promise<T> {
    return this.serializeMutation(async () => {
      const current = await this.seedIfAbsent();
      this.assertRevision(current, expectedRevision);
      return operation(this.toSnapshot(current));
    });
  }

  async mutate(expectedRevision: string, mutation: ScheduleMutation): Promise<ScheduleSnapshot> {
    return this.serializeMutation(async () => {
      const current = await this.seedIfAbsent();
      this.assertRevision(current, expectedRevision);
      const events = [...current.events];
      let highWaterMarks = { ...current.event_id_high_water_marks };

      if (mutation.kind === "add") {
        const eventBindingId = nextEventBindingId(current);
        const idMatch = eventBindingId.match(/^aisb-(\d{4})-(\d{3})$/)!;
        highWaterMarks = {
          ...highWaterMarks,
          [idMatch[1]!]: Number.parseInt(idMatch[2]!, 10),
        };
        events.push(
          parseEventForMutation({
            event_binding_id: eventBindingId,
            programme_day_id: mutation.event.programmeDayId,
            title: mutation.event.title,
            start: mutation.event.start,
            end: mutation.event.end,
            all_day: mutation.event.allDay,
            status: mutation.event.status ?? "scheduled",
            ...(mutation.event.location ? { location: mutation.event.location } : {}),
          }, current),
        );
      } else {
        const index = events.findIndex((event) => event.event_binding_id === mutation.eventBindingId);
        if (index === -1) {
          throw new ScheduleStoreError(
            "not_found",
            `Schedule event ${mutation.eventBindingId} does not exist`,
            scheduleRevisionFor(current),
          );
        }
        const existing = events[index]!;
        if (mutation.kind === "cancel") {
          events[index] = { ...existing, status: "cancelled" };
        } else {
          const changes = mutation.changes;
          const updated: Record<string, unknown> = {
            ...existing,
            ...(changes.programmeDayId !== undefined
              ? { programme_day_id: changes.programmeDayId }
              : {}),
            ...(changes.title !== undefined ? { title: changes.title } : {}),
            ...(changes.start !== undefined ? { start: changes.start } : {}),
            ...(changes.end !== undefined ? { end: changes.end } : {}),
            ...(changes.allDay !== undefined ? { all_day: changes.allDay } : {}),
            ...(changes.status !== undefined ? { status: changes.status } : {}),
          };
          if (Object.hasOwn(changes, "location")) {
            if (changes.location === null) delete updated.location;
            else updated.location = changes.location;
          }
          events[index] = parseEventForMutation(updated, current);
        }
      }

      const next = parseRuntime({
        ...current,
        schedule_revision: current.schedule_revision + 1,
        event_id_high_water_marks: highWaterMarks,
        events: sortEvents(events),
      });
      await writeJsonAtomic(this.runtimePath, next);
      return this.toSnapshot(next);
    });
  }

  /** Explicitly replace all local events with the current tracked seed. */
  async reimportFromSeed(expectedRevision: string): Promise<ScheduleSnapshot> {
    return this.serializeMutation(async () => {
      const current = await this.seedIfAbsent();
      this.assertRevision(current, expectedRevision);
      const seed = validateSeed(JSON.parse(await readFile(this.seedPath, "utf8")));
      const imported = toRuntime(seed);
      const next = parseRuntime({
        ...imported,
        schedule_revision: current.schedule_revision + 1,
        event_id_high_water_marks: mergedHighWaterMarks(
          current.event_id_high_water_marks,
          imported.event_id_high_water_marks,
        ),
      });
      await writeJsonAtomic(this.runtimePath, next);
      return this.toSnapshot(next);
    });
  }

  private assertRevision(runtime: RuntimeScheduleFile, expectedRevision: string): void {
    const currentRevision = scheduleRevisionFor(runtime);
    if (currentRevision !== expectedRevision) {
      throw new ScheduleStoreError(
        "conflict",
        "The schedule changed after this page loaded; refresh it before applying this edit",
        currentRevision,
      );
    }
  }

  private serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private toSnapshot(runtime: RuntimeScheduleFile): ScheduleSnapshot {
    const scheduleRevision = scheduleRevisionFor(runtime);
    const runtimeSchedule: RuntimeSchedule = {
      schemaVersion: 1,
      scheduleId: runtime.seed_id,
      scheduleRevision,
      seedId: runtime.seed_id,
      sourceLabel: runtime.source_label,
      programmeWindow: {
        start: runtime.programme_window.start,
        end: runtime.programme_window.end,
        timeZone: runtime.programme_time_zone,
      },
      programmeDays: runtime.programme_days.map((day) => ({
        dayId: day.day_id,
        date: day.date,
        curriculumKind: day.curriculum_kind,
      })),
      nonProgrammeDates: runtime.non_programme_dates,
      events: runtime.events.map((event) => ({
        eventBindingId: event.event_binding_id,
        programmeDayId: event.programme_day_id,
        title: event.title,
        start: event.start,
        end: event.end,
        allDay: event.all_day,
        status: event.status,
        ...(event.location ? { location: event.location } : {}),
      })),
    };
    return {
      runtimeSchedule,
      scheduleRevision,
      programmeTimeZone: runtime.programme_time_zone,
      programmeDays: runtime.programme_days.map((day, index) => ({
        dayId: day.day_id as ProgrammeDayId,
        date: day.date,
        curriculumKind: day.curriculum_kind,
        title: day.curriculum_kind === "break" ? `Day ${index + 1} · Schedule only` : `Day ${index + 1}`,
      })),
      events: runtime.events.map((event) => ({
        eventBindingId: event.event_binding_id,
        programmeDayId: event.programme_day_id as ProgrammeDayId | null,
        title: event.title,
        start: event.start,
        end: event.end,
        allDay: event.all_day,
        status: event.status,
        ...(event.location ? { location: event.location } : {}),
      })),
    };
  }
}
