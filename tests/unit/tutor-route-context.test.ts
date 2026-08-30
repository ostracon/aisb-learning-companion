import { describe, expect, it } from "vitest";

import {
  createRoutePageContextRuntime,
  liveDraftFromClient,
} from "../../src/server/context/runtime-resolvers.js";

function section(sectionId: string) {
  const slug = sectionId.replace(".", "-");
  return {
    sectionId,
    title: `Section ${sectionId}`,
    sourcePath: `${sectionId}-section-${slug}/README.md`,
    sourceHash: `source-${slug}`,
    outcomes: [
      {
        outcomeId: `${sectionId}:engineering:1`,
        versionId: `version-${slug}`,
        category: "engineering" as const,
        text: `Outcome ${sectionId}`,
        sourcePath: `${sectionId}-section-${slug}/README.md`,
      },
    ],
  };
}

function runtimeFixture() {
  let linkedSectionIds: readonly string[] = [];
  let bindingRevision = "event-curriculum-bindings:r1:0000000000000000";
  let nonce = 0;
  const sections = [section("2.1"), section("2.2"), section("2.3")];
  const runtime = createRoutePageContextRuntime(
    {
      schedule: {
        async read() {
          return {
            scheduleRevision: "schedule:r1",
            eventCurriculumBindingRevision: bindingRevision,
            programmeTimeZone: "Europe/London",
            events: [
              {
                eventBindingId: "aisb-2026-016",
                programmeDayId: "day2" as const,
                title: "Session",
                start: "2026-09-01T09:00:00+01:00",
                end: "2026-09-01T10:00:00+01:00",
                allDay: false,
                status: "scheduled" as const,
                linkedSectionIds,
              },
            ],
          };
        },
      },
      curriculum: {
        async readDay() { return sections; },
        async readRepositoryDay() { return sections; },
      },
      materials: {
        async readForModelContext() {
          throw new Error("Study materials are not used in this test");
        },
      },
      notes: {
        async readById(noteId) {
          return { noteId, kind: "event" as const, persistedRevision: "1" };
        },
      },
      repository: {
        async read() {
          return {
            repositoryIdentity: "aisb-repository",
            headCommit: "abc123",
            instructionSourceHash: "instructions-abc123",
          };
        },
      },
      now: () => new Date("2026-09-01T09:15:00.000Z"),
    },
    { createBindingNonce: () => `nonce-${++nonce}` },
  );

  return {
    runtime,
    setBinding(nextRevision: string, nextSectionIds: readonly string[]) {
      bindingRevision = nextRevision;
      linkedSectionIds = nextSectionIds;
    },
  };
}

async function resolveEventContext(fixture: ReturnType<typeof runtimeFixture>) {
  const binding = await fixture.runtime.bindTutorRoute({
    contextMode: "today",
    dayId: "day2",
    eventBindingId: "aisb-2026-016",
    historyEntryId: "history-1",
    chatId: "chat-1",
    threadId: "thread-1",
  });
  const snapshot = await fixture.runtime.contextService.resolvePageContext(
    binding.requestIds,
    liveDraftFromClient({
      noteId: binding.expectedCurrentNoteId,
      content: "# Session notes\n",
      baseRevision: 1,
      saveStatus: "saved",
    }),
    [],
  );
  fixture.runtime.revokeRouteBinding(binding.scopeBindingId);
  return { binding, snapshot };
}

describe("Today tutor route curriculum scope", () => {
  it("gives an unmapped selected event no day-wide outcomes or files", async () => {
    const fixture = runtimeFixture();
    const { binding, snapshot } = await resolveEventContext(fixture);

    expect(binding.requestIds.sectionId).toBeUndefined();
    expect(snapshot.schedule?.event?.linkedSectionIds).toEqual([]);
    expect(snapshot.canonicalOutcomes).toEqual([]);
    expect(snapshot.relevantFiles).toEqual([]);
    expect(snapshot.lesson).toBeNull();
  });

  it("keeps a mapped ordered subset and changes context revision when relinked", async () => {
    const fixture = runtimeFixture();
    fixture.setBinding("event-curriculum-bindings:r2:1111111111111111", ["2.2", "2.1"]);
    const first = await resolveEventContext(fixture);

    expect(first.snapshot.schedule?.event?.linkedSectionIds).toEqual(["2.2", "2.1"]);
    expect(first.snapshot.canonicalOutcomes.map((outcome) => outcome.sectionId)).toEqual([
      "2.2",
      "2.1",
    ]);
    expect(first.snapshot.relevantFiles.map((file) => file.linkedSectionId)).toEqual([
      "2.2",
      "2.1",
    ]);

    fixture.setBinding("event-curriculum-bindings:r3:2222222222222222", ["2.3"]);
    const second = await resolveEventContext(fixture);
    expect(second.binding.contextRevision).not.toBe(first.binding.contextRevision);
    expect(second.binding.requestIds.sectionId).toBe("2.3");
    expect(second.snapshot.canonicalOutcomes.map((outcome) => outcome.sectionId)).toEqual([
      "2.3",
    ]);
    expect(second.snapshot.relevantFiles.map((file) => file.linkedSectionId)).toEqual([
      "2.3",
    ]);
  });
});
