import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  hashSeedEvents,
  ScheduleStore,
  ScheduleStoreError,
} from "../../src/server/schedule/store.js";
import { EventCurriculumBindingStore } from "../../src/server/curriculum/event-binding-store.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createStoreFixture(): Promise<{
  readonly stateRoot: string;
  readonly seedPath: string;
  readonly store: ScheduleStore;
}> {
  const stateRoot = await mkdtemp(join(tmpdir(), "aisb-schedule-store-"));
  temporaryRoots.push(stateRoot);
  const seedPath = join(process.cwd(), "config/schedule/aisb-example-week.snapshot.json");
  return { stateRoot, seedPath, store: new ScheduleStore(seedPath, stateRoot) };
}

async function createStore(): Promise<ScheduleStore> {
  return (await createStoreFixture()).store;
}

describe("tracked schedule seed", () => {
  it("matches the declared RFC 8785 events hash", async () => {
    const seed = JSON.parse(
      await readFile(join(process.cwd(), "config/schedule/aisb-example-week.snapshot.json"), "utf8"),
    ) as { events: unknown[]; events_sha256: string; expected_event_count: number };
    expect(seed.events).toHaveLength(seed.expected_event_count);
    expect(hashSeedEvents(seed.events)).toBe(seed.events_sha256);
  });

  it("contains only generalized public example events", async () => {
    const seed = JSON.parse(
      await readFile(join(process.cwd(), "config/schedule/aisb-example-week.snapshot.json"), "utf8"),
    ) as {
      privacy: { public_release_sanitization: string[] };
      events: Array<{ title: string; location?: string }>;
    };
    const allowedTitles = new Set([
      "Break",
      "Breakfast",
      "Debrief",
      "Departure",
      "Dinner",
      "Feedback",
      "Lightning Talks",
      "Lunch",
      "Lunch + Networking",
      "Office Hours",
      "Pair Programming",
      "Pair Programming (setup)",
      "Pitching",
      "Site visit",
      "Talk",
      "Talks",
      "Travel",
    ]);

    expect(seed.privacy.public_release_sanitization).toHaveLength(2);
    expect(seed.events.every((event) => event.location === undefined)).toBe(true);
    expect(seed.events.every((event) => allowedTitles.has(event.title))).toBe(true);
  });

  it("adds, moves, updates, and cancels events with immutable local IDs", async () => {
    const store = await createStore();
    const initial = await store.read();
    const added = await store.mutate(initial.scheduleRevision, {
      kind: "add",
      event: {
        programmeDayId: "day1",
        title: "Office hours",
        start: "2026-08-30T18:00:00+01:00",
        end: "2026-08-30T18:30:00+01:00",
        allDay: false,
        location: "Teaching room",
      },
    });

    expect(added.events).toHaveLength(initial.events.length + 1);
    const created = added.events.find((event) => event.title === "Office hours");
    expect(created?.eventBindingId).toMatch(/^aisb-2026-\d{3}$/);

    const moved = await store.mutate(added.scheduleRevision, {
      kind: "update",
      eventBindingId: created!.eventBindingId,
      changes: {
        programmeDayId: "day2",
        title: "Updated office hours",
        start: "2026-08-31T18:00:00+01:00",
        end: "2026-08-31T18:45:00+01:00",
        location: null,
      },
    });
    const updated = moved.events.find((event) => event.eventBindingId === created!.eventBindingId);
    expect(updated).toMatchObject({
      programmeDayId: "day2",
      title: "Updated office hours",
      status: "scheduled",
    });
    expect(updated).not.toHaveProperty("location");

    const cancelled = await store.mutate(moved.scheduleRevision, {
      kind: "cancel",
      eventBindingId: created!.eventBindingId,
    });
    expect(cancelled.events.find((event) => event.eventBindingId === created!.eventBindingId)?.status)
      .toBe("cancelled");
  });

  it("rejects stale writers while allowing exactly one concurrent mutation", async () => {
    const store = await createStore();
    const initial = await store.read();
    const mutation = (title: string) => store.mutate(initial.scheduleRevision, {
      kind: "add" as const,
      event: {
        programmeDayId: "day1" as const,
        title,
        start: "2026-08-30T18:00:00+01:00",
        end: "2026-08-30T18:30:00+01:00",
        allDay: false,
      },
    });

    const results = await Promise.allSettled([mutation("First"), mutation("Second")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ScheduleStoreError);
    expect((rejected.reason as ScheduleStoreError).code).toBe("conflict");
  });

  it("holds queued mutations behind an exact-revision cross-store callback", async () => {
    const store = await createStore();
    const initial = await store.read();
    let enterCallback!: () => void;
    const callbackEntered = new Promise<void>((resolve) => { enterCallback = resolve; });
    let releaseCallback!: () => void;
    const callbackGate = new Promise<void>((resolve) => { releaseCallback = resolve; });
    const held = store.withSnapshotAtRevision(
      initial.scheduleRevision,
      async (snapshot) => {
        expect(snapshot.scheduleRevision).toBe(initial.scheduleRevision);
        enterCallback();
        await callbackGate;
        return "committed-cross-store-operation";
      },
    );
    await callbackEntered;

    const queuedMutation = store.mutate(initial.scheduleRevision, {
      kind: "add",
      event: {
        programmeDayId: "day1",
        title: "Queued behind binding commit",
        start: "2026-08-30T18:00:00+01:00",
        end: "2026-08-30T18:30:00+01:00",
        allDay: false,
      },
    });
    let queuedSettled = false;
    void queuedMutation.then(
      () => { queuedSettled = true; },
      () => { queuedSettled = true; },
    );
    await Promise.resolve();

    expect(queuedSettled).toBe(false);
    expect((await store.read()).events.some(
      (event) => event.title === "Queued behind binding commit",
    )).toBe(false);

    releaseCallback();
    await expect(held).resolves.toBe("committed-cross-store-operation");
    const mutated = await queuedMutation;
    expect(mutated.events.some(
      (event) => event.title === "Queued behind binding commit",
    )).toBe(true);

    let staleCallbackRan = false;
    await expect(store.withSnapshotAtRevision(
      initial.scheduleRevision,
      async () => {
        staleCallbackRan = true;
      },
    )).rejects.toMatchObject({ code: "conflict" });
    expect(staleCallbackRan).toBe(false);
  });

  it("explicitly reimports the tracked seed without resetting revision history", async () => {
    const store = await createStore();
    const initial = await store.read();
    const edited = await store.mutate(initial.scheduleRevision, {
      kind: "cancel",
      eventBindingId: initial.events[0]!.eventBindingId,
    });
    expect(edited.events[0]!.status).toBe("cancelled");

    const reimported = await store.reimportFromSeed(edited.scheduleRevision);
    expect(reimported.events).toHaveLength(initial.events.length);
    expect(reimported.events[0]!.status).toBe(initial.events[0]!.status);
    expect(reimported.scheduleRevision).not.toBe(initial.scheduleRevision);
    expect(reimported.scheduleRevision).not.toBe(edited.scheduleRevision);
  });

  it("never reuses an orphaned local event ID after re-import and restart", async () => {
    const { stateRoot, seedPath, store } = await createStoreFixture();
    const initial = await store.read();
    const added = await store.mutate(initial.scheduleRevision, {
      kind: "add",
      event: {
        programmeDayId: "day1",
        title: "Locally added session",
        start: "2026-08-30T18:00:00+01:00",
        end: "2026-08-30T18:30:00+01:00",
        allDay: false,
      },
    });
    const localEvent = added.events.find((event) => event.title === "Locally added session")!;
    expect(localEvent.eventBindingId).toBe("aisb-2026-094");

    const bindingStore = new EventCurriculumBindingStore(stateRoot);
    const bindings = await bindingStore.read();
    await bindingStore.replace(
      bindings.revision,
      localEvent.eventBindingId,
      ["1.1"],
    );

    const reimported = await store.reimportFromSeed(added.scheduleRevision);
    expect(reimported.events.some(
      (event) => event.eventBindingId === localEvent.eventBindingId,
    )).toBe(false);
    expect(await bindingStore.resolve(localEvent.eventBindingId)).toMatchObject({
      status: "mapped",
      sectionIds: ["1.1"],
    });

    const restarted = new ScheduleStore(seedPath, stateRoot);
    const afterRestart = await restarted.read();
    const next = await restarted.mutate(afterRestart.scheduleRevision, {
      kind: "add",
      event: {
        programmeDayId: "day1",
        title: "Later local session",
        start: "2026-08-30T19:00:00+01:00",
        end: "2026-08-30T19:30:00+01:00",
        allDay: false,
      },
    });
    const laterEvent = next.events.find((event) => event.title === "Later local session")!;
    expect(laterEvent.eventBindingId).toBe("aisb-2026-095");
    expect(laterEvent.eventBindingId).not.toBe(localEvent.eventBindingId);
  });

  it("rejects invalid event updates and preserves the prior revision", async () => {
    const store = await createStore();
    const initial = await store.read();
    await expect(store.mutate(initial.scheduleRevision, {
      kind: "update",
      eventBindingId: initial.events[0]!.eventBindingId,
      changes: { title: "   " },
    })).rejects.toMatchObject({ code: "invalid_event" });
    expect((await store.read()).scheduleRevision).toBe(initial.scheduleRevision);
  });

  it("rejects programme-day changes that contradict the London start date", async () => {
    const store = await createStore();
    const initial = await store.read();
    const dayOneEvent = initial.events.find((event) => event.programmeDayId === "day1")!;

    await expect(store.mutate(initial.scheduleRevision, {
      kind: "update",
      eventBindingId: dayOneEvent.eventBindingId,
      changes: { programmeDayId: "day2" },
    })).rejects.toMatchObject({
      code: "invalid_event",
      message: "The schedule event must start on 2026-08-31 in Europe/London",
    });

    await expect(store.mutate(initial.scheduleRevision, {
      kind: "add",
      event: {
        programmeDayId: "day1",
        title: "Offset-date mismatch",
        start: "2026-08-30T23:30:00-05:00",
        end: "2026-08-31T00:00:00-05:00",
        allDay: false,
      },
    })).rejects.toMatchObject({ code: "invalid_event" });
    expect((await store.read()).scheduleRevision).toBe(initial.scheduleRevision);
  });

  it("rejects local events that do not overlap the programme window", async () => {
    const store = await createStore();
    const initial = await store.read();

    await expect(store.mutate(initial.scheduleRevision, {
      kind: "add",
      event: {
        programmeDayId: "day1",
        title: "Outside the programme",
        start: "2026-08-29T10:00:00+01:00",
        end: "2026-08-29T11:00:00+01:00",
        allDay: false,
      },
    })).rejects.toMatchObject({
      code: "invalid_event",
      message: "The schedule event must overlap the programme window",
    });
    expect((await store.read()).scheduleRevision).toBe(initial.scheduleRevision);
  });
});
