import { describe, expect, it } from "vitest";

import type {
  FileSelectionInput,
  LiveNoteDraftInput,
  PageContextRequestIds,
} from "../../shared/page-context.js";
import {
  createRoutePageContextRuntime,
  liveDraftFromClient,
  mapClientSaveState,
  type RoutePageContextAdapters,
} from "./runtime-resolvers.js";
import { CurriculumMaterialError } from "../materials/service.js";

function fixture() {
  const state = {
    scheduleRevision: "schedule:r1",
    eventTitle: "Canonical transformer lab",
    outcomeText: "Trace how a chat template becomes model input tokens.",
    headCommit: "aisb-head-1",
    sectionSourcePath: "1.1-llm-internals/README.md",
    materialManifestRevision: `sha256:${"a".repeat(64)}`,
    materialDocumentId: `doc_${"b".repeat(64)}`,
    materialContentHash: `sha256:${"c".repeat(64)}`,
    materialProjection: "# Participant task\n\nVisible, answer-free instructions.",
    protectedRawMaterial: "REFERENCE ANSWER: import the forbidden _solution.py file",
  };
  const sectionsForDay = (dayId: string) => {
    if (dayId === "day1") return [
      {
        sectionId: "1.1",
        title: "LLM internals",
        sourcePath: state.sectionSourcePath,
        sourceHash: "readme-hash-1",
        outcomes: [
          {
            outcomeId: "outcome:1.1:ml",
            versionId: "outcome-version-1",
            category: "ml" as const,
            text: state.outcomeText,
            // Deliberately inconsistent: section README remains canonical provenance.
            sourcePath: "FORGED/outcome_solution.py",
          },
        ],
      },
    ];
    if (dayId === "day4") return [
      {
        sectionId: "4.1",
        title: "Model editing",
        sourcePath: "4.1-model-editing/README.md",
        sourceHash: "readme-hash-4-1",
        outcomes: [
          {
            outcomeId: "outcome:4.1:security",
            versionId: "outcome-version-4-1",
            category: "security" as const,
            text: "Evaluate a model-editing intervention without reading the reference solution.",
            sourcePath: "4.1-model-editing/README.md",
          },
        ],
      },
      {
        sectionId: "4.2",
        title: "Representations",
        sourcePath: "4.2-representations/README.md",
        sourceHash: "readme-hash-4-2",
        outcomes: [
          {
            outcomeId: "outcome:4.2:ml",
            versionId: "outcome-version-4-2",
            category: "ml" as const,
            text: "Inspect a representation.",
            sourcePath: "4.2-representations/README.md",
          },
        ],
      },
    ];
    return [];
  };
  const adapters: RoutePageContextAdapters = {
    now: () => new Date("2026-08-31T08:45:00.000Z"),
    schedule: {
      async read() {
        return {
          scheduleRevision: state.scheduleRevision,
          programmeTimeZone: "Europe/London",
          events: [
            {
              eventBindingId: "event-1",
              programmeDayId: "day1",
              title: state.eventTitle,
              start: "2026-08-31T09:00:00+01:00",
              end: "2026-08-31T10:30:00+01:00",
              allDay: false,
              status: "scheduled",
              location: "Main room",
              kind: "pair_programming",
              linkedSectionIds: ["1.1"],
            },
            {
              eventBindingId: "event-day2",
              programmeDayId: "day2",
              title: "Another day",
              start: "2026-09-01T09:00:00+01:00",
              end: "2026-09-01T10:00:00+01:00",
              allDay: false,
              status: "scheduled",
            },
          ],
        };
      },
    },
    curriculum: {
      async readDay(dayId) {
        return sectionsForDay(dayId);
      },
      async readRepositoryDay(dayId) {
        return sectionsForDay(dayId);
      },
    },
    materials: {
      async readForModelContext(input) {
        if (input.expectedManifestRevision !== state.materialManifestRevision) {
          throw new CurriculumMaterialError(
            "stale_manifest",
            409,
            "The material manifest changed",
            state.materialManifestRevision,
          );
        }
        if (input.documentId !== state.materialDocumentId) {
          throw new CurriculumMaterialError(
            "document_not_found",
            404,
            "The selected document is not in the manifest",
          );
        }
        return {
          audience: "model_context" as const,
          sectionId: input.sectionId,
          manifestRevision: state.materialManifestRevision,
          document: {
            documentId: state.materialDocumentId,
            title: "Participant task",
            filename: "day1_instructions.md",
            kind: "participant_instructions",
            accessClassification: "human_reader_only",
            contentHash: state.materialContentHash,
            byteLength: state.materialProjection.length,
            links: [],
            linksTruncated: false,
          },
          modelSafeMarkdown: state.materialProjection,
          modelProjection: "spoiler_stripped_instructions" as const,
          omittedProtectedBlocks: 2,
          // An adapter may retain internal raw data for its own bookkeeping;
          // the context runtime must copy only the explicit safe projection.
          rawMarkdown: state.protectedRawMaterial,
        };
      },
    },
    notes: {
      async readById(noteId) {
        if (noteId === "event-event-1") {
          return {
            noteId,
            kind: "event",
            persistedRevision: "4",
            locator: { kind: "event", event_binding_id: "event-1" },
            logicalPath: "notes/events/event-1/notes.md",
          };
        }
        if (noteId === "day-day1") {
          return {
            noteId,
            kind: "day",
            persistedRevision: "2",
            locator: { kind: "day", programme_day_id: "day1" },
            logicalPath: "notes/days/day1/overview.md",
          };
        }
        if (noteId === "lesson-1.1") {
          return {
            noteId,
            kind: "lesson",
            persistedRevision: "7",
            locator: { kind: "lesson", section_id: "1.1" },
            logicalPath: "notes/lessons/1.1/notes.md",
          };
        }
        if (noteId === "lesson-4.1") {
          return {
            noteId,
            kind: "lesson",
            persistedRevision: "8",
            locator: { kind: "lesson", section_id: "4.1" },
            logicalPath: "notes/lessons/4.1/notes.md",
          };
        }
        if (noteId === "lesson-4.2") {
          return {
            noteId,
            kind: "lesson",
            persistedRevision: "9",
            locator: { kind: "lesson", section_id: "4.2" },
            logicalPath: "notes/lessons/4.2/notes.md",
          };
        }
        if (noteId === "day4_quicknote_attention") {
          return {
            noteId,
            kind: "ad_hoc",
            persistedRevision: "3",
            locator: {
              kind: "ad_hoc",
              creation_date: "2026-09-03",
              note_id: noteId,
            },
            logicalPath: `notes/ad-hoc/2026-09-03/${noteId}.md`,
          };
        }
        if (noteId === "day3_quicknote_other_day") {
          return {
            noteId,
            kind: "ad_hoc",
            persistedRevision: "1",
            locator: {
              kind: "ad_hoc",
              creation_date: "2026-09-02",
              note_id: noteId,
            },
            logicalPath: `notes/ad-hoc/2026-09-02/${noteId}.md`,
          };
        }
        if (noteId === "day4_quicknote_") {
          return {
            noteId,
            kind: "ad_hoc",
            persistedRevision: "1",
            locator: {
              kind: "ad_hoc",
              creation_date: "2026-09-03",
              note_id: noteId,
            },
            logicalPath: `notes/ad-hoc/2026-09-03/${noteId}.md`,
          };
        }
        return null;
      },
    },
    repository: {
      async read() {
        return {
          repositoryIdentity: "aisb-repository-identity",
          headCommit: state.headCommit,
          instructionSourceHash: "agents-hash-1",
        };
      },
    },
  };
  let nonce = 0;
  const runtime = createRoutePageContextRuntime(adapters, {
    createBindingNonce: () => `nonce-${++nonce}`,
  });
  return { state, adapters, runtime };
}

function eventDraft(): LiveNoteDraftInput {
  return liveDraftFromClient({
    noteId: "event-event-1",
    content: "# Live notes\n\nAn unsaved observation.",
    baseRevision: 4,
    saveStatus: "saved-locally",
  });
}

function studyDraft(noteId = "lesson-4.1"): LiveNoteDraftInput {
  return liveDraftFromClient({
    noteId,
    content: "# Model editing\n\nMy current reasoning, saved or unsaved.",
    baseRevision: 8,
    saveStatus: "saving-disk",
  });
}

describe("route page-context runtime", () => {
  it("binds canonical day/event routes and derives all domain records server-side", async () => {
    const { runtime } = fixture();
    const binding = await runtime.bindTutorRoute({
      contextMode: "today",
      dayId: "day1",
      eventBindingId: "event-1",
      historyEntryId: "history-1",
      chatId: "chat-1",
      threadId: "thread-1",
    });

    expect(binding.routePath).toBe("/day/day1/event/event-1");
    expect(binding.contextRevision).toMatch(/^context:[a-f0-9]{40}$/);
    expect(binding.scopeBindingId).toMatch(/^scope:[a-f0-9]{32}$/);
    expect(binding.expectedCurrentNoteId).toBe("event-event-1");
    expect(binding.requestIds).toMatchObject({
      dayId: "day1",
      eventBindingId: "event-1",
      sessionId: "event-1",
      sectionId: "1.1",
      noteId: "event-event-1",
      contextRevision: binding.contextRevision,
      scopeBindingId: binding.scopeBindingId,
    });

    const snapshot = await runtime.contextService.resolvePageContext(
      binding.requestIds,
      eventDraft(),
      [{ relativePath: "1.1-llm-internals/README.md" }],
    );
    expect(snapshot.route).toMatchObject({
      path: "/day/day1/event/event-1",
      pageKind: "event_chat",
      dayId: "day1",
      eventBindingId: "event-1",
      sectionId: "1.1",
    });
    expect(snapshot.schedule?.event).toMatchObject({
      title: "Canonical transformer lab",
      kind: "pair_programming",
      linkedSectionIds: ["1.1"],
    });
    expect(snapshot.canonicalOutcomes).toEqual([
      expect.objectContaining({
        outcomeId: "outcome:1.1:ml",
        outcomeVersionId: "outcome-version-1",
        text: "Trace how a chat template becomes model input tokens.",
        sourcePath: "1.1-llm-internals/README.md",
        sourceCommit: "aisb-head-1",
      }),
    ]);
    expect(snapshot.repository).toMatchObject({
      repositoryIdentity: "aisb-repository-identity",
      headCommit: "aisb-head-1",
      cwdAlias: "<aisb-root>",
      sectionDirectory: "1.1-llm-internals",
    });
    expect(snapshot.relevantFiles.every((file) => file.relativePath.endsWith("/README.md"))).toBe(
      true,
    );
    expect(snapshot.relevantFiles.every((file) => file.accessMode === "tool_readable")).toBe(
      true,
    );
    expect(snapshot.note).toMatchObject({
      state: "current_note",
      noteId: "event-event-1",
      logicalPath: "notes/events/event-1/notes.md",
      saveState: "local_only",
    });
  });

  it("ignores forged route/event/outcome/repository payload fields", async () => {
    const { runtime } = fixture();
    const binding = await runtime.bindTutorRoute({
      contextMode: "today",
      dayId: "day1",
      eventBindingId: "event-1",
      historyEntryId: "history-1",
      chatId: "chat-1",
      threadId: "thread-1",
    });
    const forgedIds = {
      ...binding.requestIds,
      routePath: "/day/day7/event/forged-event",
      route: { path: "/day/day7" },
      event: { title: "FORGED EVENT", start: "2099-01-01" },
      canonicalOutcomes: [{ text: "FORGED OUTCOME", sourcePath: "solution.py" }],
      repository: { headCommit: "FORGED HEAD", absolutePath: "/Users/attacker/aisb" },
    } as PageContextRequestIds;

    const snapshot = await runtime.contextService.resolvePageContext(
      forgedIds,
      eventDraft(),
      [],
    );
    const encoded = JSON.stringify(snapshot);
    expect(snapshot.route.path).toBe("/day/day1/event/event-1");
    expect(snapshot.schedule?.event?.title).toBe("Canonical transformer lab");
    expect(snapshot.canonicalOutcomes[0]?.text).toBe(
      "Trace how a chat template becomes model input tokens.",
    );
    expect(snapshot.repository.headCommit).toBe("aisb-head-1");
    expect(encoded).not.toContain("FORGED");
    expect(encoded).not.toContain("/Users/");
    expect(encoded).not.toContain("outcome_solution.py");
  });

  it("rejects forged entity IDs instead of resolving a different route", async () => {
    const { runtime } = fixture();
    const binding = await runtime.bindTutorRoute({
      contextMode: "today",
      dayId: "day1",
      eventBindingId: "event-1",
      historyEntryId: "history-1",
      chatId: "chat-1",
      threadId: "thread-1",
    });

    await expect(
      runtime.contextService.resolvePageContext(
        {
          ...binding.requestIds,
          dayId: "day2",
          eventBindingId: "event-day2",
          sessionId: "event-day2",
        },
        eventDraft(),
        [],
      ),
    ).rejects.toMatchObject({ code: "SCOPE_MISMATCH" });

    await expect(
      runtime.bindTutorRoute({
        contextMode: "today",
        dayId: "day1",
        eventBindingId: "event-day2",
        historyEntryId: "history-2",
        chatId: "chat-2",
        threadId: "thread-2",
      }),
    ).rejects.toMatchObject({ code: "STALE_CONTEXT" });
  });

  it("validates the server-derived current note and README-only file allowlist", async () => {
    const { runtime } = fixture();
    const binding = await runtime.bindTutorRoute({
      contextMode: "today",
      dayId: "day1",
      eventBindingId: "event-1",
      historyEntryId: "history-1",
      chatId: "chat-1",
      threadId: "thread-1",
    });

    await expect(
      runtime.contextService.resolvePageContext(
        binding.requestIds,
        { ...eventDraft(), noteId: "day-day1" },
        [],
      ),
    ).rejects.toMatchObject({ code: "NOTE_SCOPE_MISMATCH" });

    const unsafeSelection: FileSelectionInput = {
      relativePath: "1.1-llm-internals/day1_answers.py",
    };
    await expect(
      runtime.contextService.resolvePageContext(binding.requestIds, eventDraft(), [unsafeSelection]),
    ).rejects.toMatchObject({ code: "FILE_POLICY_DENIED" });
  });

  it("marks an issued binding stale when schedule/curriculum/repository inputs change", async () => {
    const { runtime, state } = fixture();
    const binding = await runtime.bindTutorRoute({
      contextMode: "today",
      dayId: "day1",
      eventBindingId: "event-1",
      historyEntryId: "history-1",
      chatId: "chat-1",
      threadId: "thread-1",
    });
    state.scheduleRevision = "schedule:r2";
    state.outcomeText = "A revised canonical outcome.";
    state.headCommit = "aisb-head-2";

    await expect(
      runtime.contextService.resolvePageContext(binding.requestIds, eventDraft(), []),
    ).rejects.toMatchObject({ code: "STALE_CONTEXT" });
  });

  it("binds repository Day 4 Study material to one section, one lesson note, and one safe projection", async () => {
    const { runtime, state } = fixture();
    const binding = await runtime.bindTutorRoute({
      contextMode: "study",
      dayId: "day4",
      sectionId: "4.1",
      documentId: state.materialDocumentId,
      materialManifestRevision: state.materialManifestRevision,
      noteId: "lesson-4.1",
      historyEntryId: "history-study-4-1",
      chatId: "chat-study-4-1",
      threadId: "thread-study-4-1",
    });

    expect(binding.routePath).toBe(
      `/study/day4/section/4.1/document/${state.materialDocumentId}`,
    );
    expect(binding.expectedCurrentNoteId).toBe("lesson-4.1");
    expect(binding.requestIds).toMatchObject({
      dayId: "day4",
      sectionId: "4.1",
      noteId: "lesson-4.1",
    });
    expect(binding.requestIds).not.toHaveProperty("eventBindingId");

    const snapshot = await runtime.contextService.resolvePageContext(
      binding.requestIds,
      studyDraft(),
      [],
    );
    expect(snapshot.route).toMatchObject({
      pageKind: "repository",
      dayId: "day4",
      sectionId: "4.1",
      eventBindingId: null,
    });
    expect(snapshot.schedule).toBeNull();
    expect(snapshot.scope.scopeId).toBe("study:section:4.1");
    expect(snapshot.canonicalOutcomes).toEqual([
      expect.objectContaining({
        outcomeId: "outcome:4.1:security",
        sectionId: "4.1",
      }),
    ]);
    expect(snapshot.canonicalOutcomes).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ sectionId: "4.2" })]),
    );
    expect(snapshot.note).toMatchObject({
      state: "current_note",
      noteId: "lesson-4.1",
      kind: "lesson",
      logicalPath: "notes/lessons/4.1/notes.md",
      saveState: "saving",
    });
    expect(snapshot.lesson?.visibleProjection).toContain(state.materialProjection);
    expect(snapshot.lesson?.visibleProjection).toContain(state.materialDocumentId);
    expect(snapshot.lesson?.visibleProjection).toContain(state.materialContentHash);
    const encoded = JSON.stringify(snapshot);
    expect(encoded).not.toContain("day1_instructions.md");
    expect(encoded).not.toContain("_solution.py");
    expect(encoded).not.toContain(state.protectedRawMaterial);
    const frozen = await runtime.contextService.freezeTurnContext(
      snapshot,
      snapshot.scope,
      "turn-study-4-1",
    );
    const modelEnvelope = JSON.stringify(frozen.blocks);
    const lessonBlock = frozen.blocks.find((block) => block.kind === "visible_lesson");
    const lessonEnvelope = JSON.parse(lessonBlock?.content ?? "null") as {
      lesson?: { visibleProjection?: string };
    } | null;
    expect(lessonEnvelope?.lesson?.visibleProjection).toContain(state.materialProjection);
    expect(modelEnvelope).not.toContain("day1_instructions.md");
    expect(modelEnvelope).not.toContain(state.protectedRawMaterial);
    expect(snapshot.relevantFiles).toEqual([
      expect.objectContaining({
        relativePath: "4.1-model-editing/README.md",
        accessMode: "tool_readable",
      }),
    ]);
  });

  it("keeps visible Study material fixed while binding another lesson note from the same day", async () => {
    const { runtime, state } = fixture();
    const binding = await runtime.bindTutorRoute({
      contextMode: "study",
      dayId: "day4",
      sectionId: "4.1",
      documentId: state.materialDocumentId,
      materialManifestRevision: state.materialManifestRevision,
      noteId: "lesson-4.2",
      historyEntryId: "history-study-reference-lesson",
      chatId: "chat-study-reference-lesson",
      threadId: "thread-study-reference-lesson",
    });

    expect(binding.routePath).toBe(
      `/study/day4/section/4.1/document/${state.materialDocumentId}`,
    );
    expect(binding.expectedCurrentNoteId).toBe("lesson-4.2");
    expect(binding.requestIds).toMatchObject({
      dayId: "day4",
      sectionId: "4.1",
      noteId: "lesson-4.2",
    });

    const snapshot = await runtime.contextService.resolvePageContext(
      binding.requestIds,
      studyDraft("lesson-4.2"),
      [],
    );
    expect(snapshot.route).toMatchObject({
      path: `/study/day4/section/4.1/document/${state.materialDocumentId}`,
      sectionId: "4.1",
    });
    expect(snapshot.lesson?.sectionId).toBe("4.1");
    expect(snapshot.canonicalOutcomes.map((outcome) => outcome.sectionId)).toEqual(["4.1"]);
    expect(snapshot.note).toMatchObject({
      state: "current_note",
      noteId: "lesson-4.2",
      kind: "lesson",
      logicalPath: "notes/lessons/4.2/notes.md",
      persistedRevision: "9",
    });
  });

  it("binds a same-day quick note without changing the visible Study section", async () => {
    const { runtime, state } = fixture();
    const binding = await runtime.bindTutorRoute({
      contextMode: "study",
      dayId: "day4",
      sectionId: "4.1",
      documentId: state.materialDocumentId,
      materialManifestRevision: state.materialManifestRevision,
      noteId: "day4_quicknote_attention",
      historyEntryId: "history-study-reference-quick",
      chatId: "chat-study-reference-quick",
      threadId: "thread-study-reference-quick",
    });

    const snapshot = await runtime.contextService.resolvePageContext(
      binding.requestIds,
      studyDraft("day4_quicknote_attention"),
      [],
    );
    expect(snapshot.route.sectionId).toBe("4.1");
    expect(snapshot.lesson?.sectionId).toBe("4.1");
    expect(snapshot.note).toMatchObject({
      state: "current_note",
      noteId: "day4_quicknote_attention",
      kind: "ad_hoc",
      logicalPath: "notes/ad-hoc/2026-09-03/day4_quicknote_attention.md",
      persistedRevision: "3",
    });
  });

  it.each([
    ["unknown note", "missing-study-note"],
    ["a lesson from another repository day", "lesson-1.1"],
    ["a quick note bearing another day prefix", "day3_quicknote_other_day"],
    ["an event note", "event-event-1"],
    ["a day note", "day-day1"],
    ["a malformed quick-note identifier", "day4_quicknote_"],
  ])("rejects %s from a Day 4 Study binding", async (_label, noteId) => {
    const { runtime, state } = fixture();
    await expect(
      runtime.bindTutorRoute({
        contextMode: "study",
        dayId: "day4",
        sectionId: "4.1",
        documentId: state.materialDocumentId,
        materialManifestRevision: state.materialManifestRevision,
        noteId,
        historyEntryId: `history-reject-${noteId}`,
        chatId: `chat-reject-${noteId}`,
        threadId: `thread-reject-${noteId}`,
      }),
    ).rejects.toMatchObject({ code: "NOTE_SCOPE_MISMATCH" });
  });

  it("retains strict draft-to-bound-note matching for alternate Study notes", async () => {
    const { runtime, state } = fixture();
    const binding = await runtime.bindTutorRoute({
      contextMode: "study",
      dayId: "day4",
      sectionId: "4.1",
      documentId: state.materialDocumentId,
      materialManifestRevision: state.materialManifestRevision,
      noteId: "lesson-4.2",
      historyEntryId: "history-study-note-mismatch",
      chatId: "chat-study-note-mismatch",
      threadId: "thread-study-note-mismatch",
    });

    await expect(
      runtime.contextService.resolvePageContext(binding.requestIds, studyDraft("lesson-4.1"), []),
    ).rejects.toMatchObject({ code: "NOTE_SCOPE_MISMATCH" });
  });

  it("rejects stale or mismatched Study material identifiers before a page binding is issued", async () => {
    const { runtime, state } = fixture();
    await expect(
      runtime.bindTutorRoute({
        contextMode: "study",
        dayId: "day4",
        sectionId: "4.1",
        documentId: state.materialDocumentId,
        materialManifestRevision: `sha256:${"d".repeat(64)}`,
        noteId: "lesson-4.1",
        historyEntryId: "history-stale",
        chatId: "chat-stale",
        threadId: "thread-stale",
      }),
    ).rejects.toMatchObject({ code: "stale_manifest", statusCode: 409 });

    await expect(
      runtime.bindTutorRoute({
        contextMode: "study",
        dayId: "day4",
        sectionId: "4.1",
        documentId: `doc_${"e".repeat(64)}`,
        materialManifestRevision: state.materialManifestRevision,
        noteId: "lesson-4.1",
        historyEntryId: "history-wrong-document",
        chatId: "chat-wrong-document",
        threadId: "thread-wrong-document",
      }),
    ).rejects.toMatchObject({ code: "document_not_found", statusCode: 404 });
  });

  it("makes the selected Study material identity and content hash part of staleness", async () => {
    const { runtime, state } = fixture();
    const binding = await runtime.bindTutorRoute({
      contextMode: "study",
      dayId: "day4",
      sectionId: "4.1",
      documentId: state.materialDocumentId,
      materialManifestRevision: state.materialManifestRevision,
      noteId: "lesson-4.1",
      historyEntryId: "history-material-hash",
      chatId: "chat-material-hash",
      threadId: "thread-material-hash",
    });
    state.materialContentHash = `sha256:${"f".repeat(64)}`;

    await expect(
      runtime.contextService.resolvePageContext(binding.requestIds, studyDraft(), []),
    ).rejects.toMatchObject({ code: "STALE_CONTEXT" });
  });

  it("fails route binding closed when curriculum descriptors are not safe READMEs", async () => {
    const { runtime, state } = fixture();
    state.sectionSourcePath = "1.1-llm-internals/day1_instructions.md";
    await expect(
      runtime.bindTutorRoute({
        contextMode: "today",
        dayId: "day1",
        eventBindingId: null,
        historyEntryId: "history-1",
        chatId: "chat-1",
        threadId: "thread-1",
      }),
    ).rejects.toMatchObject({ code: "FILE_POLICY_DENIED" });
  });
});

describe("client note-state mapping", () => {
  it.each([
    ["loading", "local_only"],
    ["saving-local", "saving"],
    ["saved-locally", "local_only"],
    ["saving-disk", "saving"],
    ["saved-disk", "saved"],
    ["conflict", "conflicted"],
    ["offline", "offline"],
    ["error", "error"],
  ] as const)("maps %s to %s", (input, expected) => {
    expect(mapClientSaveState(input)).toBe(expected);
  });

  it("rejects unknown save states", () => {
    expect(() => mapClientSaveState("synced-maybe")).toThrowError(
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });
});
