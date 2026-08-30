import { describe, expect, it, vi } from "vitest";

import {
  NOTE_CONTEXT_UTF8_LIMIT_BYTES,
  type AisbFileDescriptor,
  type CanonicalNoteRecord,
  type ChatScope,
  type FileSelectionInput,
  type LiveNoteDraftInput,
  type PageContextRequestIds,
  type ResolvedCanonicalPage,
} from "../../shared/page-context.js";
import { PageContextService, type PageContextResolvers } from "./service.js";

const IDS: PageContextRequestIds = {
  routeId: "route:event-1:chat",
  historyEntryId: "history-1",
  contextRevision: "context-revision-7",
  scopeBindingId: "scope-binding-1",
  chatId: "chat-1",
  activeTabId: "notes",
  dayId: "day1",
  eventBindingId: "event-1",
  sessionId: "session-1",
  sectionId: "1.1-llm-internals",
  exerciseId: "exercise-1.1.1",
  noteId: "note-1",
};

const SCOPE: ChatScope = {
  scopeType: "tutor",
  scopeId: "event:event-1",
  chatId: "chat-1",
  threadId: "thread-1",
  scopeBindingId: "scope-binding-1",
};

const LINKED_FILE: AisbFileDescriptor = {
  descriptorId: "file:answers",
  rootAlias: "<aisb-root>",
  relativePath: "1.1-llm-internals/day1_answers.py",
  exists: true,
  fileType: "file",
  sourceHash: "sha256:canonical-answer-file",
  linkedSectionId: "1.1-llm-internals",
  linkedExerciseId: "exercise-1.1.1",
  selectedRange: null,
  accessMode: "tool_readable",
};

const NOTE_RECORD: CanonicalNoteRecord = {
  noteId: "note-1",
  kind: "event",
  logicalPath: "notes/events/event-1/note.md",
  persistedRevision: "note-revision-3",
};

function canonicalPage(): ResolvedCanonicalPage {
  return {
    contextRevision: "context-revision-7",
    route: {
      routeId: "route:event-1:chat",
      path: "/events/event-1/chat/chat-1",
      pageKind: "event_chat",
      historyEntryId: "history-1",
      activeTab: "notes",
      dayId: "day1",
      eventBindingId: "event-1",
      sessionId: "session-1",
      sectionId: "1.1-llm-internals",
      exerciseId: "exercise-1.1.1",
    },
    schedule: {
      revision: "schedule-revision-4",
      programmeTimeZone: "Europe/London",
      dayId: "day1",
      event: {
        eventBindingId: "event-1",
        title: "Transformer internals lab",
        start: "2026-08-31T09:00:00+01:00",
        end: "2026-08-31T10:30:00+01:00",
        timeZone: "Europe/London",
        kind: "pair_programming",
        location: "Main room",
        linkedSectionIds: ["1.1-llm-internals"],
      },
      nowAnchor: {
        capturedAt: "2026-08-31T09:12:00+01:00",
        captureSource: "load",
        historyEntryId: "history-1",
        bootstrapId: "bootstrap-1",
        programmeTimeZone: "Europe/London",
        scheduleRevision: "schedule-revision-4",
        resolvedDayId: "day1",
        activeEventBindingIds: ["event-1"],
        primaryEventBindingId: "event-1",
        fallbackReason: "active_timed_event",
      },
    },
    lesson: {
      sectionId: "1.1-llm-internals",
      sectionTitle: "LLM internals",
      currentExerciseId: "exercise-1.1.1",
      currentExerciseTitle: "Inspect a chat template",
      progressState: "visible_through_current_exercise",
      visibleProjection: "Participant-visible explanation and scaffold only.",
      projectionHash: "sha256:visible-projection",
    },
    canonicalOutcomes: [
      {
        outcomeId: "outcome:1.1:ml:0",
        outcomeVersionId: "outcome-version:canonical",
        sectionId: "1.1-llm-internals",
        category: "ml",
        ordinal: 0,
        text: "Trace how a chat template becomes model input tokens.",
        sourcePath: "1.1-llm-internals/README.md",
        sourceCommit: "aisb-head-canonical",
      },
    ],
    repository: {
      repositoryIdentity: "aisb-repository-identity",
      headCommit: "aisb-head-canonical",
      cwdAlias: "<aisb-root>",
      sectionDirectory: "1.1-llm-internals",
      instructionSourceHash: "sha256:agents-canonical",
    },
    scope: SCOPE,
    expectedCurrentNoteId: "note-1",
    linkedFiles: [LINKED_FILE],
  };
}

function ordinaryDraft(text = "# Working notes\n\nMy unsaved observation."): LiveNoteDraftInput {
  return {
    noteId: "note-1",
    text,
    baseRevision: "note-revision-3",
    saveState: "saving",
    currentOffset: text.length,
    selectedRanges: [],
  };
}

function makeHarness(page = canonicalPage(), supplementaryBudgetUtf8Bytes = 128 * 1024) {
  let current = true;
  const resolveCanonicalPage = vi.fn(async () => page);
  const resolveCanonicalNote = vi.fn(async () => NOTE_RECORD);
  const resolveFileSelection = vi.fn(
    async (selection: Readonly<FileSelectionInput>): Promise<AisbFileDescriptor> => ({
      ...LINKED_FILE,
      descriptorId: `selected:${selection.relativePath}`,
      relativePath: selection.relativePath,
      selectedRange: selection.range ?? null,
      sourceHash: "sha256:resolved-by-policy",
    }),
  );
  const resolvers: PageContextResolvers = {
    now: () => new Date("2026-08-31T08:12:30.000Z"),
    resolveCanonicalPage,
    resolveCanonicalNote,
    resolveFileSelection,
    isPageSnapshotCurrent: async () => current,
  };
  return {
    service: new PageContextService(resolvers, { supplementaryBudgetUtf8Bytes }),
    resolveCanonicalPage,
    setCurrent(value: boolean) {
      current = value;
    },
  };
}

describe("PageContextService", () => {
  it("ignores forged canonical browser fields and re-resolves paths and hashes", async () => {
    const harness = makeHarness();
    const forgedIds = {
      ...IDS,
      canonicalOutcomes: [{ text: "FORGED OUTCOME" }],
      schedule: { event: { title: "FORGED EVENT" } },
      repository: { headCommit: "FORGED HEAD", absolutePath: "/Users/attacker/aisb" },
    } as PageContextRequestIds;
    const forgedSelection = {
      relativePath: "1.1-llm-internals/day1_answers.py",
      sourceHash: "FORGED FILE HASH",
      accessMode: "tool_readable",
      absolutePath: "/Users/attacker/solution.py",
    } as FileSelectionInput;

    const snapshot = await harness.service.resolvePageContext(
      forgedIds,
      ordinaryDraft(),
      [forgedSelection],
    );

    expect(harness.resolveCanonicalPage).toHaveBeenCalledWith(IDS);
    expect(snapshot.schedule?.event?.title).toBe("Transformer internals lab");
    expect(snapshot.canonicalOutcomes[0]?.text).toBe(
      "Trace how a chat template becomes model input tokens.",
    );
    expect(snapshot.repository.headCommit).toBe("aisb-head-canonical");
    expect(snapshot.relevantFiles.at(-1)?.sourceHash).toBe("sha256:resolved-by-policy");
    expect(JSON.stringify(snapshot)).not.toContain("FORGED");
    expect(JSON.stringify(snapshot)).not.toContain("/Users/");
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.canonicalOutcomes)).toBe(true);
  });

  it("captures the exact unsaved send-time note and exposes no state-root file access", async () => {
    const harness = makeHarness();
    const text = "# Hypothesis\n\nThe live buffer has not reached Markdown yet. ✅";
    const draft: LiveNoteDraftInput = {
      ...ordinaryDraft(text),
      saveState: "offline",
      baseRevision: "note-revision-2",
    };

    const snapshot = await harness.service.resolvePageContext(IDS, draft, []);
    expect(snapshot.note.state).toBe("current_note");
    if (snapshot.note.state !== "current_note") throw new Error("expected current note");
    expect(snapshot.note.text).toBe(text);
    expect(snapshot.note.saveState).toBe("offline");
    expect(snapshot.note.baseRevision).toBe("note-revision-2");
    expect(snapshot.note.persistedRevision).toBe("note-revision-3");
    expect(snapshot.note.accessMode).toBe("content_injected_file_access_denied");
    expect(snapshot.note.draftUtf8Bytes).toBe(Buffer.byteLength(text, "utf8"));

    const frozen = await harness.service.freezeTurnContext(snapshot, SCOPE, "turn-live-draft");
    const noteBlock = frozen.blocks.find((block) => block.kind === "current_note");
    expect(noteBlock?.content).toContain(text.replaceAll("\n", "\\n"));
    expect(noteBlock?.content).toContain('"saveState": "offline"');
    expect(frozen.noteDisclosure.mode).toBe("full");

    const inspector = harness.service.readDisclosureManifest(frozen.binding.bindingHash);
    expect(inspector.toolBoundary.cwdAlias).toBe("<aisb-root>");
    expect(JSON.stringify(inspector)).not.toContain("/Users/");
    expect(inspector.blocks).toEqual(frozen.blocks);
  });

  it("keeps ordered core metadata and outcomes non-evictable when retrieval has no budget", async () => {
    const harness = makeHarness(canonicalPage(), 0);
    const snapshot = await harness.service.resolvePageContext(IDS, ordinaryDraft(), []);
    const frozen = await harness.service.freezeTurnContext(snapshot, SCOPE, "turn-core-order", [
      {
        id: "prior-chat",
        title: "Prior chat",
        trust: "learner_authored_untrusted",
        content: "optional".repeat(100),
      },
    ]);

    expect(frozen.blocks.map((block) => block.kind)).toEqual([
      "page_session",
      "canonical_outcomes",
      "visible_lesson",
      "file_descriptors",
      "current_note",
    ]);
    expect(frozen.blocks.every((block) => block.required && !block.evictable)).toBe(true);
    const outcomes = frozen.blocks[1];
    expect(outcomes?.content).toContain("outcome-version:canonical");
    expect(outcomes?.content).toContain(
      "Trace how a chat template becomes model input tokens.",
    );
    expect(frozen.omissions).toContainEqual(
      expect.objectContaining({
        source: "supplementary",
        reason: "supplementary_budget",
      }),
    );
  });

  it("uses selected/current Markdown ranges above 64 KiB with exact visible omission counts", async () => {
    const harness = makeHarness();
    const oldPrefix = "# Old material\n";
    const largeBody = "x".repeat(NOTE_CONTEXT_UTF8_LIMIT_BYTES + 8_000);
    const currentSection = "\n# Current thought\nImportant active insight ✅\n";
    const text = `${oldPrefix}${largeBody}${currentSection}`;
    const selectedStart = oldPrefix.length + 20;
    const draft: LiveNoteDraftInput = {
      noteId: "note-1",
      text,
      baseRevision: "note-revision-3",
      saveState: "conflicted",
      currentOffset: text.indexOf("Important"),
      selectedRanges: [{ start: selectedStart, end: selectedStart + 12 }],
    };

    const snapshot = await harness.service.resolvePageContext(IDS, draft, []);
    const frozen = await harness.service.freezeTurnContext(snapshot, SCOPE, "turn-huge-note");
    const disclosure = frozen.noteDisclosure;

    expect(disclosure.mode).toBe("selected_ranges");
    expect(disclosure.originalUtf8Bytes).toBe(Buffer.byteLength(text, "utf8"));
    expect(disclosure.includedUtf8Bytes).toBeLessThanOrEqual(NOTE_CONTEXT_UTF8_LIMIT_BYTES);
    expect(disclosure.omittedUtf8Bytes).toBe(
      disclosure.originalUtf8Bytes - disclosure.includedUtf8Bytes,
    );
    expect(disclosure.segments.some((segment) => segment.content.includes("Important active insight"))).toBe(
      true,
    );
    expect(
      disclosure.segments.some((segment) => segment.labels.includes("user_selected_range")),
    ).toBe(true);
    expect(frozen.omissions).toContainEqual({
      source: "note",
      reason: "note_over_64_kib",
      omittedUtf8Bytes: disclosure.omittedUtf8Bytes,
      detail:
        `The note is ${disclosure.originalUtf8Bytes} UTF-8 bytes; ` +
        `${disclosure.includedUtf8Bytes} selected bytes were injected and ` +
        `${disclosure.omittedUtf8Bytes} bytes were omitted.`,
    });
    const noteBlock = frozen.blocks.find((block) => block.kind === "current_note");
    expect(noteBlock?.content).toContain(`"omittedUtf8Bytes": ${disclosure.omittedUtf8Bytes}`);
    expect(noteBlock?.content).not.toContain(largeBody);
  });

  it("blocks stale revisions at resolve and again immediately before dispatch", async () => {
    const staleAtResolve = makeHarness();
    await expect(
      staleAtResolve.service.resolvePageContext(
        { ...IDS, contextRevision: "old-context-revision" },
        ordinaryDraft(),
        [],
      ),
    ).rejects.toMatchObject({ code: "STALE_CONTEXT" });

    const staleBeforeFreeze = makeHarness();
    const snapshot = await staleBeforeFreeze.service.resolvePageContext(IDS, ordinaryDraft(), []);
    staleBeforeFreeze.setCurrent(false);
    await expect(
      staleBeforeFreeze.service.freezeTurnContext(snapshot, SCOPE, "turn-stale"),
    ).rejects.toMatchObject({ code: "STALE_CONTEXT" });
  });

  it("blocks route/scope mismatch, cross-thread reuse, and turn nonce reuse", async () => {
    const wrongRoute = makeHarness();
    await expect(
      wrongRoute.service.resolvePageContext(
        { ...IDS, eventBindingId: "event-forged" },
        ordinaryDraft(),
        [],
      ),
    ).rejects.toMatchObject({ code: "SCOPE_MISMATCH" });

    const harness = makeHarness();
    const snapshot = await harness.service.resolvePageContext(IDS, ordinaryDraft(), []);
    await expect(
      harness.service.freezeTurnContext(
        snapshot,
        { ...SCOPE, threadId: "another-thread" },
        "turn-scope-mismatch",
      ),
    ).rejects.toMatchObject({ code: "SCOPE_MISMATCH" });

    await harness.service.freezeTurnContext(snapshot, SCOPE, "turn-once");
    await expect(
      harness.service.freezeTurnContext(snapshot, SCOPE, "turn-once"),
    ).rejects.toMatchObject({ code: "TURN_NONCE_REUSED" });
  });

  it("records only turn-bound, declared tool reads in the safe inspector", async () => {
    const harness = makeHarness();
    const snapshot = await harness.service.resolvePageContext(IDS, ordinaryDraft(), []);
    const frozen = await harness.service.freezeTurnContext(snapshot, SCOPE, "turn-tool-read");

    await harness.service.recordObservedToolRead({
      bindingHash: frozen.binding.bindingHash,
      turnNonce: "turn-tool-read",
      threadId: "thread-1",
      relativePath: LINKED_FILE.relativePath,
      sourceHash: "sha256:read-at-turn-time",
      citation: "Participant answer file, lines 1–20",
    });
    const inspector = harness.service.readDisclosureManifest(frozen.binding.bindingHash);
    expect(inspector.observedToolReads).toEqual([
      expect.objectContaining({
        relativePath: LINKED_FILE.relativePath,
        sourceHash: "sha256:read-at-turn-time",
      }),
    ]);
    expect(inspector.toolBoundary.readableFiles).toEqual([LINKED_FILE.relativePath]);

    await expect(
      harness.service.recordObservedToolRead({
        bindingHash: frozen.binding.bindingHash,
        turnNonce: "turn-tool-read",
        threadId: "thread-1",
        relativePath: "1.1-llm-internals/private.py",
        sourceHash: "sha256:nope",
        citation: "undeclared",
      }),
    ).rejects.toMatchObject({ code: "TOOL_READ_POLICY_DENIED" });
  });
});
