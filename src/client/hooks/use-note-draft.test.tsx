// @vitest-environment jsdom

import "fake-indexeddb/auto";

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  claimDraftWriterEpoch,
  readDraft,
  resetDraftDatabaseForTests,
  writeDraft,
  type BrowserNoteDraft,
} from "../storage/drafts.js";
import type {
  NoteEditCoordinator,
  StartNoteEditCoordinationOptions,
} from "../notes/note-edit-coordinator.js";
import { initialNoteContent, useNoteDraft } from "./use-note-draft.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const NOW = () => new Date("2026-08-29T12:00:00.000Z");

const immediateCoordinator: NoteEditCoordinator = {
  startNoteEditCoordination(options: StartNoteEditCoordinationOptions) {
    let closed = false;
    queueMicrotask(() => {
      if (!closed) options.onAcquired();
    });
    return {
      announceDraftChanged: () => !closed,
      close: async () => {
        closed = true;
      },
    };
  },
};

function notePayload(
  noteId: string,
  content: string,
  revision: number,
  contentHash: string,
) {
  return {
    note_id: noteId,
    content,
    revision,
    content_hash: contentHash,
    updated_at: `2026-08-29T12:00:0${Math.min(revision, 9)}.000Z`,
    logical_path: `notes/ad-hoc/2026-08-29/20260829T120000000Z-${noteId}.md`,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function requestBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== "string") throw new Error("expected a JSON request body");
  return JSON.parse(init.body) as Record<string, unknown>;
}

beforeEach(async () => {
  await resetDraftDatabaseForTests();
  vi.restoreAllMocks();
});

describe("new note template", () => {
  it("starts with Raw Notes and keeps answers inline with Questions", () => {
    const content = initialNoteContent("Lesson 1.2");
    expect(content).toContain("# Lesson 1.2\n\n## Raw Notes\n\n\n## Key ideas");
    expect(content).toContain("## Questions\n\n\n## Reflection");
    expect(content).not.toContain("## Answers");
  });
});

describe("useNoteDraft opening mode", () => {
  it("GETs an existing query-selected note without using the create endpoint", async () => {
    const noteId = "lesson-1.1";
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse(notePayload(noteId, "Earlier topic notes", 4, HASH_D)),
    );

    const { result } = renderHook(() =>
      useNoteDraft(noteId, "Earlier topic", {
        fetch: fetchMock as typeof fetch,
        now: NOW,
        diskSaveDelayMs: 0,
        coordinator: immediateCoordinator,
        openExistingOnly: true,
      }),
    );

    await waitFor(() => expect(result.current.status).toBe("saved-disk"));
    expect(result.current.value).toBe("Earlier topic notes");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/notes/lesson-1.1",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("never POST-creates a missing existing-only note, including after Retry", async () => {
    const noteId = "day1_quicknote_stale";
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ error: "Note not found", code: "note_not_found" }, 404),
    );

    const { result } = renderHook(() =>
      useNoteDraft(noteId, "Stale quick note", {
        fetch: fetchMock as typeof fetch,
        now: NOW,
        diskSaveDelayMs: 0,
        coordinator: immediateCoordinator,
        openExistingOnly: true,
      }),
    );

    await waitFor(() => expect(result.current.status).toBe("offline"));
    act(() => result.current.retryDiskSave());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.status).toBe("offline"));

    expect(fetchMock.mock.calls).toEqual([
      [
        "/api/notes/day1_quicknote_stale",
        expect.objectContaining({ method: "GET" }),
      ],
      [
        "/api/notes/day1_quicknote_stale",
        expect.objectContaining({ method: "GET" }),
      ],
    ]);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
  });

  it("does not identify a newly selected note as loaded until that exact reconciliation finishes", async () => {
    const nextNote = deferred<Response>();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body ? requestBody(init) : {};
      return body.note_id === "note-next"
        ? nextNote.promise
        : jsonResponse(notePayload("note-current", "Current note", 1, HASH_A));
    });
    const { result, rerender } = renderHook(
      ({ noteId }) => useNoteDraft(noteId, "Route note", {
        fetch: fetchMock as typeof fetch,
        now: NOW,
        coordinator: immediateCoordinator,
      }),
      { initialProps: { noteId: "note-current" } },
    );

    await waitFor(() => expect(result.current.loadedNoteId).toBe("note-current"));
    rerender({ noteId: "note-next" });
    expect(result.current.loadedNoteId).not.toBe("note-next");

    await act(async () => {
      nextNote.resolve(jsonResponse(notePayload("note-next", "Next note", 2, HASH_B)));
      await nextNote.promise;
    });
    await waitFor(() => expect(result.current.loadedNoteId).toBe("note-next"));
    expect(result.current.value).toBe("Next note");
  });
});

describe("useNoteDraft recovery lineage", () => {
  it("does not pair a stale local revision with the hash of a manual disk edit", async () => {
    await writeDraft({
      noteId: "note-lineage",
      content: "local unsaved text",
      baseRevision: 3,
      baseContentHash: HASH_A,
      updatedAt: "2026-08-29T12:00:00.000Z",
    });
    const fetchMock = vi.fn(async () =>
      jsonResponse(notePayload("note-lineage", "manual Markdown edit", 3, HASH_B)),
    );

    const { result } = renderHook(() =>
      useNoteDraft("note-lineage", "Lineage", {
        fetch: fetchMock as typeof fetch,
        now: NOW,
        diskSaveDelayMs: 0,
        coordinator: immediateCoordinator,
      }),
    );

    await waitFor(() => expect(result.current.status).toBe("conflict"));
    expect(result.current.value).toBe("local unsaved text");
    expect(result.current.baseRevision).toBe(3);
    expect(result.current.baseContentHash).toBe(HASH_A);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(readDraft("note-lineage")).resolves.toMatchObject({
      content: "local unsaved text",
      baseContentHash: HASH_A,
    });

    act(() => result.current.updateValue("local unsaved text with another thought"));
    expect(result.current.status).toBe("conflict");
    await waitFor(() => expect(result.current.status).toBe("conflict"));
    await expect(readDraft("note-lineage")).resolves.toMatchObject({
      content: "local unsaved text with another thought",
      baseContentHash: HASH_A,
    });
  });

  it("explicitly rebases a preserved browser draft before saving it over a conflict", async () => {
    const noteId = "note-keep-browser";
    await writeDraft({
      noteId,
      content: "browser answer",
      baseRevision: 3,
      baseContentHash: HASH_A,
      updatedAt: "2026-08-29T12:00:00.000Z",
    });
    const disk = notePayload(noteId, "manual Markdown edit", 3, HASH_B);
    const putBodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST" || init?.method === undefined) return jsonResponse(disk);
      putBodies.push(requestBody(init));
      return jsonResponse(notePayload(noteId, "browser answer", 4, HASH_C));
    });
    const { result } = renderHook(() => useNoteDraft(noteId, "Conflict", {
      fetch: fetchMock as typeof fetch,
      now: NOW,
      diskSaveDelayMs: 0,
      coordinator: immediateCoordinator,
    }));

    await waitFor(() => expect(result.current.status).toBe("conflict"));
    act(() => result.current.resolveConflict("keep-local"));

    await waitFor(() => expect(result.current.status).toBe("saved-disk"));
    expect(result.current.value).toBe("browser answer");
    expect(putBodies).toEqual([{
      content: "browser answer",
      base_revision: 3,
      base_content_hash: HASH_B,
    }]);
    await expect(readDraft(noteId)).resolves.toMatchObject({
      content: "browser answer",
      baseRevision: 4,
      baseContentHash: HASH_C,
    });
  });

  it("preserves a conflicting browser draft before explicitly adopting disk", async () => {
    const noteId = "note-use-disk";
    await writeDraft({
      noteId,
      content: "browser answer",
      baseRevision: 3,
      baseContentHash: HASH_A,
      updatedAt: "2026-08-29T12:00:00.000Z",
    });
    const disk = notePayload(noteId, "manual Markdown edit", 3, HASH_B);
    const putBodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") return jsonResponse(disk);
      putBodies.push(requestBody(init));
      return jsonResponse({
        status: "conflict",
        current: disk,
        conflict_path: `notes/conflicts/${noteId}-browser.md`,
      }, 409);
    });
    const { result } = renderHook(() => useNoteDraft(noteId, "Conflict", {
      fetch: fetchMock as typeof fetch,
      now: NOW,
      diskSaveDelayMs: 0,
      coordinator: immediateCoordinator,
    }));

    await waitFor(() => expect(result.current.status).toBe("conflict"));
    act(() => result.current.resolveConflict("use-disk"));

    await waitFor(() => expect(result.current.status).toBe("saved-disk"));
    expect(putBodies).toEqual([{
      content: "browser answer",
      base_revision: 3,
      base_content_hash: HASH_A,
    }]);
    expect(result.current.value).toBe("manual Markdown edit");
    await expect(readDraft(noteId)).resolves.toMatchObject({
      content: "manual Markdown edit",
      baseRevision: 3,
      baseContentHash: HASH_B,
      editSequence: 1,
    });
  });

  it("restores an unreadable Markdown note from its recovery snapshot without losing the local fallback", async () => {
    const noteId = "day-day2";
    const title = "Day 2";
    const recovered = notePayload(noteId, "# Recovered notes\n\nValuable text.\n", 4, HASH_D);
    let openCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/recover")) return jsonResponse(recovered);
      if (init?.method === "POST") {
        openCount += 1;
        if (openCount === 1) {
          return jsonResponse({
            error: "The Markdown note is unreadable.",
            code: "invalid_note",
          }, 409);
        }
        return jsonResponse(recovered);
      }
      throw new Error("unexpected note request");
    });
    const { result } = renderHook(() => useNoteDraft(noteId, title, {
      fetch: fetchMock as typeof fetch,
      now: NOW,
      diskSaveDelayMs: 0,
      coordinator: immediateCoordinator,
    }));

    await waitFor(() => expect(result.current.status).toBe("offline"));
    expect(result.current.diskRecoveryAvailable).toBe(true);
    expect(result.current.value).toBe(initialNoteContent(title));

    act(() => result.current.recoverDiskFile());

    await waitFor(() => expect(result.current.status).toBe("saved-disk"));
    expect(result.current.diskRecoveryAvailable).toBe(false);
    expect(result.current.value).toBe(recovered.content);
    await expect(readDraft(noteId)).resolves.toMatchObject({
      content: recovered.content,
      baseRevision: 4,
      baseContentHash: HASH_D,
    });
  });

  it("safely attaches a never-persisted offline draft to an untouched blank note", async () => {
    await writeDraft({
      noteId: "offline-capture",
      content: "captured without the server",
      baseRevision: 0,
      baseContentHash: "",
      updatedAt: "2026-08-29T11:59:00.000Z",
    });
    const putBodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        return jsonResponse(notePayload("offline-capture", "", 1, HASH_A), 201);
      }
      putBodies.push(requestBody(init));
      return jsonResponse(notePayload("offline-capture", "captured without the server", 2, HASH_B));
    });

    const { result } = renderHook(() =>
      useNoteDraft("offline-capture", "Quick note", {
        fetch: fetchMock as typeof fetch,
        now: NOW,
        diskSaveDelayMs: 0,
        coordinator: immediateCoordinator,
      }),
    );

    await waitFor(() => expect(result.current.status).toBe("saved-disk"));
    expect(putBodies).toEqual([
      {
        content: "captured without the server",
        base_revision: 1,
        base_content_hash: HASH_A,
      },
    ]);
    await expect(readDraft("offline-capture")).resolves.toMatchObject({
      content: "captured without the server",
      baseRevision: 2,
      baseContentHash: HASH_B,
    });
  });

  it("safely attaches a never-persisted offline draft to an untouched note template", async () => {
    await writeDraft({
      noteId: "offline-template-capture",
      content: "captured before the server became available",
      baseRevision: 0,
      baseContentHash: "",
      updatedAt: "2026-08-29T11:59:00.000Z",
    });
    const putBodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        return jsonResponse(notePayload(
          "offline-template-capture",
          initialNoteContent("Template capture"),
          1,
          HASH_A,
        ));
      }
      if (init?.method === "PUT") {
        putBodies.push(requestBody(init));
        return jsonResponse(notePayload(
          "offline-template-capture",
          "captured before the server became available",
          2,
          HASH_B,
        ));
      }
      throw new Error("unexpected request");
    });

    const { result } = renderHook(() =>
      useNoteDraft("offline-template-capture", "Template capture", {
        fetch: fetchMock as typeof fetch,
        now: NOW,
        diskSaveDelayMs: 0,
        coordinator: immediateCoordinator,
      }),
    );

    await waitFor(() => expect(result.current.status).toBe("saved-disk"));
    expect(result.current.value).toBe("captured before the server became available");
    expect(putBodies).toEqual([
      {
        content: "captured before the server became available",
        base_revision: 1,
        base_content_hash: HASH_A,
      },
    ]);
  });

  it.each([
    {
      name: "immediately preceding template",
      legacy: "# Template upgrade\n\n## Raw Notes\n\n\n## Key ideas\n\n\n## Questions\n\n\n## Answers\n\n\n## Reflection\n\n",
    },
    {
      name: "pre-Raw-Notes template with Answers",
      legacy: "# Template upgrade\n\n## Key ideas\n\n\n## Questions\n\n\n## Answers\n\n\n## Reflection\n\n",
    },
    {
      name: "oldest template without Answers",
      legacy: "# Template upgrade\n\n## Key ideas\n\n\n## Questions\n\n\n## Reflection\n\n",
    },
  ])("adopts the server upgrade for an exact untouched $name recovery draft", async ({ legacy }) => {
    await writeDraft({
      noteId: "template-upgrade",
      content: legacy,
      baseRevision: 1,
      baseContentHash: HASH_A,
      updatedAt: "2026-08-29T11:59:00.000Z",
    });
    const upgraded = initialNoteContent("Template upgrade");
    const fetchMock = vi.fn(async () =>
      jsonResponse(notePayload("template-upgrade", upgraded, 2, HASH_B)),
    );

    const { result } = renderHook(() =>
      useNoteDraft("template-upgrade", "Template upgrade", {
        fetch: fetchMock as typeof fetch,
        now: NOW,
        diskSaveDelayMs: 0,
        coordinator: immediateCoordinator,
      }),
    );

    await waitFor(() => expect(result.current.status).toBe("saved-disk"));
    expect(result.current.value).toBe(upgraded);
    expect(result.current.error).toBeNull();
    await expect(readDraft("template-upgrade")).resolves.toMatchObject({
      content: upgraded,
      baseRevision: 2,
      baseContentHash: HASH_B,
    });
  });
});

describe("useNoteDraft save sequencing", () => {
  it("coalesces rapid edits into one three-second trailing Markdown save", async () => {
    const noteId = "debounced-markdown-save";
    const putBodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        return jsonResponse(notePayload(noteId, "Disk", 1, HASH_A));
      }
      putBodies.push(requestBody(init));
      return jsonResponse(notePayload(noteId, "Third edit", 2, HASH_B));
    });
    const timeoutSpy = vi.spyOn(window, "setTimeout");
    const { result, unmount } = renderHook(() => useNoteDraft(noteId, "Debounced save", {
      fetch: fetchMock as typeof fetch,
      now: NOW,
      coordinator: immediateCoordinator,
    }));
    await waitFor(() => expect(result.current.status).toBe("saved-disk"));

    act(() => {
      result.current.updateValue("First edit");
      result.current.updateValue("Second edit");
      result.current.updateValue("Third edit");
    });

    await waitFor(() => expect(result.current.status).toBe("saved-locally"));
    await expect(readDraft(noteId)).resolves.toMatchObject({ content: "Third edit" });
    expect(putBodies).toEqual([]);
    expect(timeoutSpy.mock.calls.filter(([, delay]) => delay === 3_000)).toHaveLength(1);

    unmount();
  });

  it("warns on unload only until accepted text reaches browser recovery storage", async () => {
    const noteId = "unload-fence-note";
    const localWriteGate = deferred<void>();
    let localWriteStarted = false;
    const draftStorage = {
      claimWriterEpoch: claimDraftWriterEpoch,
      read: readDraft,
      write: async (draft: BrowserNoteDraft) => {
        if (draft.content === "Exact accepted text") {
          localWriteStarted = true;
          await localWriteGate.promise;
        }
        await writeDraft(draft);
      },
    };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        return jsonResponse(notePayload(noteId, "Disk", 1, HASH_A));
      }
      throw new Error("Disk autosave should remain delayed in this test");
    });
    const { result } = renderHook(() => useNoteDraft(noteId, "Unload fence", {
      fetch: fetchMock as typeof fetch,
      now: NOW,
      diskSaveDelayMs: 60_000,
      coordinator: immediateCoordinator,
      draftStorage,
    }));
    await waitFor(() => expect(result.current.status).toBe("saved-disk"));

    act(() => result.current.updateValue("Exact accepted text"));
    await waitFor(() => expect(localWriteStarted).toBe(true));

    const unsafeUnload = new Event("beforeunload", { cancelable: true });
    expect(window.dispatchEvent(unsafeUnload)).toBe(false);
    expect(unsafeUnload.defaultPrevented).toBe(true);

    await act(async () => {
      localWriteGate.resolve(undefined);
      await localWriteGate.promise;
    });
    await waitFor(async () => {
      expect(await readDraft(noteId)).toMatchObject({ content: "Exact accepted text" });
    });
    await waitFor(() => expect(result.current.status).toBe("saved-locally"));

    const safeUnload = new Event("beforeunload", { cancelable: true });
    expect(window.dispatchEvent(safeUnload)).toBe(true);
    expect(safeUnload.defaultPrevented).toBe(false);
  });

  it("keeps a newly detected disk conflict visible while a later local write settles", async () => {
    const noteId = "conflict-during-local-write";
    const firstSave = deferred<Response>();
    const secondLocalWrite = deferred<void>();
    let secondLocalWriteStarted = false;
    const draftStorage = {
      claimWriterEpoch: claimDraftWriterEpoch,
      read: readDraft,
      write: async (draft: BrowserNoteDraft) => {
        if (draft.content === "Edit B") {
          secondLocalWriteStarted = true;
          await secondLocalWrite.promise;
        }
        await writeDraft(draft);
      },
    };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        return jsonResponse(notePayload(noteId, "Disk", 1, HASH_A));
      }
      return firstSave.promise;
    });
    const { result } = renderHook(() => useNoteDraft(noteId, "Conflict race", {
      fetch: fetchMock as typeof fetch,
      now: NOW,
      diskSaveDelayMs: 0,
      coordinator: immediateCoordinator,
      draftStorage,
    }));
    await waitFor(() => expect(result.current.status).toBe("saved-disk"));

    act(() => result.current.updateValue("Edit A"));
    await waitFor(() => {
      expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);
    });
    act(() => result.current.updateValue("Edit B"));
    await waitFor(() => expect(secondLocalWriteStarted).toBe(true));

    act(() => firstSave.resolve(jsonResponse({
      status: "conflict",
      current: notePayload(noteId, "Other writer", 2, HASH_B),
      conflict_path: `notes/conflicts/${noteId}-browser.md`,
    }, 409)));
    await waitFor(() => expect(result.current.status).toBe("conflict"));

    await act(async () => {
      secondLocalWrite.resolve(undefined);
      await secondLocalWrite.promise;
    });
    await waitFor(async () => {
      expect(await readDraft(noteId)).toMatchObject({ content: "Edit B" });
    });
    expect(result.current.status).toBe("conflict");
  });

  it("rebases and queues an edit made while the prior disk save is in flight", async () => {
    const firstSave = deferred<Response>();
    const putBodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        return jsonResponse(notePayload("race-note", "Disk", 1, HASH_A));
      }
      putBodies.push(requestBody(init));
      if (putBodies.length === 1) return firstSave.promise;
      return jsonResponse(notePayload("race-note", "Edit B", 3, HASH_C));
    });
    const { result } = renderHook(() =>
      useNoteDraft("race-note", "Race", {
        fetch: fetchMock as typeof fetch,
        now: NOW,
        diskSaveDelayMs: 0,
        coordinator: immediateCoordinator,
      }),
    );
    await waitFor(() => expect(result.current.status).toBe("saved-disk"));

    act(() => result.current.updateValue("Edit A"));
    await waitFor(() => expect(putBodies).toHaveLength(1));
    act(() => result.current.updateValue("Edit B"));
    await waitFor(async () =>
      expect(await readDraft("race-note")).toMatchObject({ content: "Edit B" }),
    );

    act(() => firstSave.resolve(jsonResponse(notePayload("race-note", "Edit A", 2, HASH_B))));
    await waitFor(() => expect(putBodies).toHaveLength(2));
    await waitFor(() => expect(result.current.status).toBe("saved-disk"));

    expect(putBodies).toEqual([
      { content: "Edit A", base_revision: 1, base_content_hash: HASH_A },
      { content: "Edit B", base_revision: 2, base_content_hash: HASH_B },
    ]);
    expect(result.current.value).toBe("Edit B");
    expect(result.current.baseRevision).toBe(3);
    await expect(readDraft("race-note")).resolves.toMatchObject({
      content: "Edit B",
      baseRevision: 3,
      baseContentHash: HASH_C,
    });
  });

  it("ignores a save acknowledgement from the note shown before route navigation", async () => {
    const oldSave = deferred<Response>();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = requestBody(init);
      if (init?.method === "POST") {
        const id = body.note_id as string;
        return id === "note-old"
          ? jsonResponse(notePayload(id, "Old disk", 1, HASH_A))
          : jsonResponse(notePayload(id, "New disk", 5, HASH_D));
      }
      return oldSave.promise;
    });
    const { result, rerender } = renderHook(
      ({ noteId }) =>
        useNoteDraft(noteId, "Route note", {
          fetch: fetchMock as typeof fetch,
          now: NOW,
          diskSaveDelayMs: 0,
          coordinator: immediateCoordinator,
        }),
      { initialProps: { noteId: "note-old" } },
    );
    await waitFor(() => expect(result.current.value).toBe("Old disk"));
    act(() => result.current.updateValue("Old edited"));
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1),
    );

    rerender({ noteId: "note-new" });
    await waitFor(() => expect(result.current.value).toBe("New disk"));
    await waitFor(() => expect(result.current.baseRevision).toBe(5));
    act(() => oldSave.resolve(jsonResponse(notePayload("note-old", "Old edited", 2, HASH_B))));
    await act(async () => Promise.resolve());

    expect(result.current.value).toBe("New disk");
    expect(result.current.baseRevision).toBe(5);
    expect(result.current.baseContentHash).toBe(HASH_D);
    expect(result.current.logicalPath).toContain("note-new");
  });

  it("retries a failed disk save and checkpoints the acknowledgement", async () => {
    let putCount = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        return jsonResponse(notePayload("retry-note", "Disk", 1, HASH_A));
      }
      putCount += 1;
      if (putCount === 1) throw new Error("temporary disk outage");
      return jsonResponse(notePayload("retry-note", "Retry me", 2, HASH_B));
    });
    const { result } = renderHook(() =>
      useNoteDraft("retry-note", "Retry", {
        fetch: fetchMock as typeof fetch,
        now: NOW,
        diskSaveDelayMs: 0,
        coordinator: immediateCoordinator,
      }),
    );
    await waitFor(() => expect(result.current.status).toBe("saved-disk"));
    act(() => result.current.updateValue("Retry me"));
    await waitFor(() => expect(result.current.status).toBe("error"));

    act(() => result.current.retryDiskSave());
    await waitFor(() => expect(result.current.status).toBe("saved-disk"));
    expect(putCount).toBe(2);
    await expect(readDraft("retry-note")).resolves.toMatchObject({
      content: "Retry me",
      baseRevision: 2,
      baseContentHash: HASH_B,
    });
  });

  it("automatically replays one exact save after a transient browser fetch failure", async () => {
    const putBodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        return jsonResponse(notePayload("transport-retry-note", "Disk", 1, HASH_A));
      }
      putBodies.push(requestBody(init));
      if (putBodies.length === 1) throw new TypeError("Failed to fetch");
      return jsonResponse(notePayload("transport-retry-note", "Keep this exact text", 2, HASH_B));
    });
    const { result } = renderHook(() =>
      useNoteDraft("transport-retry-note", "Transport retry", {
        fetch: fetchMock as typeof fetch,
        now: NOW,
        diskSaveDelayMs: 0,
        coordinator: immediateCoordinator,
      }),
    );
    await waitFor(() => expect(result.current.status).toBe("saved-disk"));

    act(() => result.current.updateValue("Keep this exact text"));
    await waitFor(() => expect(result.current.status).toBe("saved-disk"));

    expect(putBodies).toEqual([
      { content: "Keep this exact text", base_revision: 1, base_content_hash: HASH_A },
      { content: "Keep this exact text", base_revision: 1, base_content_hash: HASH_A },
    ]);
    expect(result.current.error).toBeNull();
    await expect(readDraft("transport-retry-note")).resolves.toMatchObject({
      content: "Keep this exact text",
      baseRevision: 2,
      baseContentHash: HASH_B,
    });
  });

  it("also replays when the response body is interrupted after the save request", async () => {
    const putBodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        return jsonResponse(notePayload("body-retry-note", "Disk", 1, HASH_A));
      }
      putBodies.push(requestBody(init));
      if (putBodies.length === 1) {
        const interruptedResponse = jsonResponse(null);
        interruptedResponse.json = async () => {
          throw new TypeError("Failed to fetch");
        };
        return interruptedResponse;
      }
      return jsonResponse(notePayload("body-retry-note", "Committed once", 2, HASH_B));
    });
    const { result } = renderHook(() =>
      useNoteDraft("body-retry-note", "Body retry", {
        fetch: fetchMock as typeof fetch,
        now: NOW,
        diskSaveDelayMs: 0,
        coordinator: immediateCoordinator,
      }),
    );
    await waitFor(() => expect(result.current.status).toBe("saved-disk"));

    act(() => result.current.updateValue("Committed once"));
    await waitFor(() => expect(result.current.status).toBe("saved-disk"));

    expect(putBodies).toHaveLength(2);
    expect(putBodies[1]).toEqual(putBodies[0]);
    expect(result.current.baseRevision).toBe(2);
  });

  it("stops after one automatic transport replay and leaves manual Retry available", async () => {
    let putCount = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        return jsonResponse(notePayload("bounded-retry-note", "Disk", 1, HASH_A));
      }
      putCount += 1;
      if (putCount <= 2) throw new TypeError("Failed to fetch");
      return jsonResponse(notePayload("bounded-retry-note", "Retry after outage", 2, HASH_B));
    });
    const { result } = renderHook(() =>
      useNoteDraft("bounded-retry-note", "Bounded retry", {
        fetch: fetchMock as typeof fetch,
        now: NOW,
        diskSaveDelayMs: 0,
        coordinator: immediateCoordinator,
      }),
    );
    await waitFor(() => expect(result.current.status).toBe("saved-disk"));

    act(() => result.current.updateValue("Retry after outage"));
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error).toBe("Failed to fetch");
    expect(putCount).toBe(2);

    act(() => result.current.retryDiskSave());
    await waitFor(() => expect(result.current.status).toBe("saved-disk"));
    expect(putCount).toBe(3);
  });

  it("persists a volatile offline edit before retry reconciliation can replace it", async () => {
    const noteId = "volatile-offline-retry";
    const initialContent = initialNoteContent("Volatile offline retry");
    const exactText = "# Volatile answer\n\n## Answers\n\nFirst line with  two spaces.  \nSecond line.\n";
    const retryWriteGate = deferred<void>();
    let failedFirstEditWrite = false;
    let retryWriteStarted = false;
    let postCount = 0;
    let draftSeenByReconnect: BrowserNoteDraft | null = null;
    const putBodies: Record<string, unknown>[] = [];
    const observedValues: string[] = [];

    const draftStorage = {
      claimWriterEpoch: claimDraftWriterEpoch,
      read: readDraft,
      write: async (draft: BrowserNoteDraft) => {
        if (draft.noteId === noteId && draft.editSequence === 1) {
          if (!failedFirstEditWrite) {
            failedFirstEditWrite = true;
            throw new Error("temporary IndexedDB write failure");
          }
          if (!retryWriteStarted) {
            retryWriteStarted = true;
            await retryWriteGate.promise;
          }
        }
        await writeDraft(draft);
      },
    };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        postCount += 1;
        if (postCount === 1) throw new Error("disk service is offline");
        draftSeenByReconnect = await readDraft(noteId);
        return jsonResponse(notePayload(noteId, "", 1, HASH_A), 201);
      }
      if (init?.method === "PUT") {
        putBodies.push(requestBody(init));
        return jsonResponse(notePayload(noteId, exactText, 2, HASH_B));
      }
      throw new Error("unexpected request");
    });

    const { result } = renderHook(() => {
      const draft = useNoteDraft(noteId, "Volatile offline retry", {
        fetch: fetchMock as typeof fetch,
        now: NOW,
        diskSaveDelayMs: 0,
        coordinator: immediateCoordinator,
        draftStorage,
      });
      observedValues.push(draft.value);
      return draft;
    });

    await waitFor(() => expect(result.current.status).toBe("offline"));
    expect(result.current.canEdit).toBe(true);
    await expect(readDraft(noteId)).resolves.toMatchObject({
      content: initialContent,
      baseRevision: 0,
      editSequence: 0,
      writerEpoch: 1,
    });

    act(() => result.current.updateValue(exactText));
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.value).toBe(exactText);
    expect(result.current.canEdit).toBe(true);
    await expect(readDraft(noteId)).resolves.toMatchObject({
      content: initialContent,
      editSequence: 0,
    });

    act(() => result.current.retryDiskSave());
    await waitFor(() => expect(retryWriteStarted).toBe(true));
    expect(postCount).toBe(1);
    expect(result.current.value).toBe(exactText);
    expect(result.current.canEdit).toBe(true);
    await expect(readDraft(noteId)).resolves.toMatchObject({
      content: initialContent,
      editSequence: 0,
    });

    await act(async () => {
      retryWriteGate.resolve(undefined);
      await retryWriteGate.promise;
    });

    await waitFor(() => expect(result.current.status).toBe("saved-disk"));
    expect(postCount).toBe(2);
    expect(draftSeenByReconnect).toMatchObject({
      content: exactText,
      baseRevision: 0,
      editSequence: 1,
      writerEpoch: 1,
    });
    expect(putBodies).toEqual([
      { content: exactText, base_revision: 1, base_content_hash: HASH_A },
    ]);
    expect(result.current.value).toBe(exactText);
    expect(result.current.canEdit).toBe(true);
    expect(result.current.coordinationStatus).toBe("editing");
    expect(result.current.coordinationError).toBeNull();
    await expect(readDraft(noteId)).resolves.toMatchObject({
      content: exactText,
      baseRevision: 2,
      baseContentHash: HASH_B,
      editSequence: 1,
      writerEpoch: 1,
    });
    const safeUnload = new Event("beforeunload", { cancelable: true });
    expect(window.dispatchEvent(safeUnload)).toBe(true);
    expect(safeUnload.defaultPrevented).toBe(false);

    const firstExactRender = observedValues.indexOf(exactText);
    expect(firstExactRender).toBeGreaterThanOrEqual(0);
    expect(observedValues.slice(firstExactRender)).toEqual(
      observedValues.slice(firstExactRender).map(() => exactText),
    );
  });
});
