import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  EventCurriculumBindingService,
  EventCurriculumBindingServiceError,
} from "../../src/server/curriculum/event-binding-service.js";
import { EventCurriculumBindingStore } from "../../src/server/curriculum/event-binding-store.js";
import type { ProgrammeDayId } from "../../src/shared/api.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function temporaryStateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "aisb-event-binding-service-"));
  temporaryRoots.push(root);
  return root;
}

function fixtures(input: {
  readonly eventId?: string;
  readonly dayId?: ProgrammeDayId | null;
  readonly status?: "scheduled" | "cancelled";
  readonly sectionIds?: readonly string[];
}) {
  const eventId = input.eventId ?? "aisb-2026-016";
  const storePromise = temporaryStateRoot().then((root) => new EventCurriculumBindingStore(root));
  const schedule = {
    async withSnapshotAtRevision<T>(
      expectedRevision: string,
      operation: (snapshot: {
        readonly scheduleRevision: string;
        readonly events: readonly {
          readonly eventBindingId: string;
          readonly programmeDayId: ProgrammeDayId | null;
          readonly status: "scheduled" | "cancelled";
        }[];
      }) => Promise<T>,
    ) {
      expect(expectedRevision).toBe("schedule:r1");
      return operation({
        scheduleRevision: "schedule:r1",
        events: [
          {
            eventBindingId: eventId,
            programmeDayId: input.dayId === undefined ? "day2" as const : input.dayId,
            status: input.status ?? "scheduled" as const,
          },
        ],
      });
    },
  };
  const curriculum = {
    async readDay() {
      return (input.sectionIds ?? ["2.1", "2.2"]).map((sectionId) => ({ sectionId }));
    },
  };
  return { eventId, storePromise, schedule, curriculum };
}

describe("EventCurriculumBindingService", () => {
  it("persists an explicit ordered link only after validating current day material", async () => {
    const fixture = fixtures({});
    const store = await fixture.storePromise;
    const service = new EventCurriculumBindingService(
      store,
      fixture.schedule,
      fixture.curriculum,
    );
    const initial = await service.read();

    const saved = await service.replace({
      expectedRevision: initial.revision,
      expectedScheduleRevision: "schedule:r1",
      eventBindingId: fixture.eventId,
      sectionIds: ["2.2", "2.1"],
    });

    expect(saved).toEqual({
      schemaVersion: 1,
      revision: expect.stringMatching(/^event-curriculum-bindings:r2:/),
      bindings: [
        {
          eventBindingId: fixture.eventId,
          sectionIds: ["2.2", "2.1"],
          source: "explicit",
        },
      ],
    });
  });

  it("rejects a section from another day without changing the binding store", async () => {
    const fixture = fixtures({ sectionIds: ["2.1"] });
    const store = await fixture.storePromise;
    const service = new EventCurriculumBindingService(
      store,
      fixture.schedule,
      fixture.curriculum,
    );
    const initial = await service.read();

    await expect(
      service.replace({
        expectedRevision: initial.revision,
        expectedScheduleRevision: "schedule:r1",
        eventBindingId: fixture.eventId,
        sectionIds: ["1.1"],
      }),
    ).rejects.toMatchObject({
      code: "section_not_available",
      statusCode: 409,
    });
    expect(await service.read()).toEqual(initial);
  });

  it.each([
    {
      label: "missing",
      fixture: fixtures({ eventId: "aisb-2026-015" }),
      requestedId: "aisb-2026-016",
      code: "event_not_found",
      statusCode: 404,
    },
    {
      label: "cancelled",
      fixture: fixtures({ status: "cancelled" }),
      requestedId: "aisb-2026-016",
      code: "event_not_linkable",
      statusCode: 409,
    },
    {
      label: "not assigned to a day",
      fixture: fixtures({ dayId: null }),
      requestedId: "aisb-2026-016",
      code: "event_not_linkable",
      statusCode: 409,
    },
  ])("rejects a $label event", async ({ fixture, requestedId, code, statusCode }) => {
    const service = new EventCurriculumBindingService(
      await fixture.storePromise,
      fixture.schedule,
      fixture.curriculum,
    );
    const initial = await service.read();
    await expect(
      service.replace({
        expectedRevision: initial.revision,
        expectedScheduleRevision: "schedule:r1",
        eventBindingId: requestedId,
        sectionIds: ["2.1"],
      }),
    ).rejects.toMatchObject({ code, statusCode });
  });

  it("allows an explicit clear after the schedule target has become stale", async () => {
    let eventExists = true;
    const store = new EventCurriculumBindingStore(await temporaryStateRoot());
    const service = new EventCurriculumBindingService(
      store,
      {
        async withSnapshotAtRevision<T>(
          _expectedRevision: string,
          operation: (snapshot: {
            readonly scheduleRevision: string;
            readonly events: readonly {
              readonly eventBindingId: string;
              readonly programmeDayId: ProgrammeDayId | null;
              readonly status: "scheduled" | "cancelled";
            }[];
          }) => Promise<T>,
        ) {
          return operation({
            scheduleRevision: "schedule:r1",
            events: eventExists
              ? [
                  {
                    eventBindingId: "aisb-2026-016",
                    programmeDayId: "day2" as const,
                    status: "scheduled" as const,
                  },
                ]
              : [],
          });
        },
      },
      { async readDay() { return [{ sectionId: "2.1" }]; } },
    );
    const initial = await service.read();
    const linked = await service.replace({
      expectedRevision: initial.revision,
      expectedScheduleRevision: "schedule:r1",
      eventBindingId: "aisb-2026-016",
      sectionIds: ["2.1"],
    });
    eventExists = false;

    const cleared = await service.replace({
      expectedRevision: linked.revision,
      expectedScheduleRevision: "schedule:r1",
      eventBindingId: "aisb-2026-016",
      sectionIds: [],
    });
    expect(cleared.bindings).toEqual([]);
  });
});
