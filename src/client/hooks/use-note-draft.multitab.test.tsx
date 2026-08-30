// @vitest-environment jsdom

import "fake-indexeddb/auto";

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  NoteEditCoordinationHandle,
  NoteEditCoordinator,
  StartNoteEditCoordinationOptions,
} from "../notes/note-edit-coordinator.js";
import {
  claimDraftWriterEpoch,
  readDraft,
  resetDraftDatabaseForTests,
  StaleDraftWriterError,
  writeDraft,
  type BrowserNoteDraft,
} from "../storage/drafts.js";
import { useNoteDraft } from "./use-note-draft.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const NOW = () => new Date("2026-08-29T12:00:00.000Z");
const LONG_DISK_DELAY_MS = 60_000;

interface FakeCoordinationSession {
  readonly options: StartNoteEditCoordinationOptions;
  owner: boolean;
  closed: boolean;
}

/**
 * One deterministic, shared ownership authority for several hook instances.
 * It models the observable Web Lock and BroadcastChannel contract without
 * depending on jsdom scheduling or browser globals.
 */
class SharedFakeCoordinator implements NoteEditCoordinator {
  readonly #sessions = new Set<FakeCoordinationSession>();
  startCount = 0;
  acquisitionCount = 0;
  closeCount = 0;

  startNoteEditCoordination(
    options: StartNoteEditCoordinationOptions,
  ): NoteEditCoordinationHandle {
    this.startCount += 1;
    const session: FakeCoordinationSession = {
      options,
      owner: false,
      closed: false,
    };
    this.#sessions.add(session);
    this.#schedulePump(options.noteId);

    return {
      announceDraftChanged: () => {
        if (session.closed || !session.owner) return false;
        for (const peer of this.#sessions) {
          if (
            peer !== session &&
            !peer.closed &&
            peer.options.noteId === session.options.noteId
          ) {
            queueMicrotask(() => {
              if (!peer.closed) peer.options.onDraftChanged?.();
            });
          }
        }
        return true;
      },
      close: async () => {
        this.closeCount += 1;
        if (session.closed) return;
        const releasedOwnership = session.owner;
        session.closed = true;
        session.owner = false;
        this.#sessions.delete(session);

        if (releasedOwnership) {
          for (const peer of this.#sessions) {
            if (!peer.closed && peer.options.noteId === session.options.noteId) {
              queueMicrotask(() => {
                if (!peer.closed) peer.options.onReleased?.();
              });
            }
          }
        }
        this.#schedulePump(session.options.noteId);
      },
    };
  }

  /** Models the browser releasing a Web Lock when its owning document dies. */
  simulateDocumentLoss(noteId: string): void {
    const session = [...this.#sessions].find(
      (candidate) =>
        !candidate.closed && candidate.owner && candidate.options.noteId === noteId,
    );
    if (!session) throw new Error(`no active owner for ${noteId}`);
    session.closed = true;
    session.owner = false;
    this.#sessions.delete(session);
    for (const peer of this.#sessions) {
      if (!peer.closed && peer.options.noteId === noteId) {
        queueMicrotask(() => {
          if (!peer.closed) peer.options.onReleased?.();
        });
      }
    }
    this.#schedulePump(noteId);
  }

  activeOwnerCount(noteId: string): number {
    return [...this.#sessions].filter(
      (session) => !session.closed && session.owner && session.options.noteId === noteId,
    ).length;
  }

  get openSessionCount(): number {
    return this.#sessions.size;
  }

  #schedulePump(noteId: string): void {
    queueMicrotask(() => this.#pump(noteId));
  }

  #pump(noteId: string): void {
    const sessions = [...this.#sessions].filter(
      (session) => !session.closed && session.options.noteId === noteId,
    );
    if (sessions.some((session) => session.owner)) return;
    const next = sessions[0];
    if (!next) return;
    next.owner = true;
    this.acquisitionCount += 1;
    next.options.onAcquired();
  }
}

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
    updated_at: `2026-08-29T12:00:0${revision}.000Z`,
    logical_path: `notes/ad-hoc/2026-08-29/${noteId}.md`,
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

function noteServer(noteId: string, diskContent = "Disk copy") {
  const putBodies: Record<string, unknown>[] = [];
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      return jsonResponse(notePayload(noteId, diskContent, 1, HASH_A));
    }
    if (init?.method === "PUT") {
      const body = requestBody(init);
      putBodies.push(body);
      return jsonResponse(notePayload(noteId, String(body.content), 2, HASH_B));
    }
    throw new Error(`unexpected note request method ${String(init?.method)}`);
  });
  return { fetchMock, putBodies };
}

beforeEach(async () => {
  await resetDraftDatabaseForTests();
  vi.restoreAllMocks();
});

afterEach(() => cleanup());

describe("useNoteDraft multi-tab ownership", () => {
  it("fails closed instead of crashing when coordination startup throws", async () => {
    const coordinator: NoteEditCoordinator = {
      startNoteEditCoordination() {
        throw new TypeError("invalid note identity");
      },
    };
    const fetchMock = vi.fn();
    const { result, unmount } = renderHook(() => useNoteDraft("invalid note id", "Invalid", {
      coordinator,
      fetch: fetchMock as typeof fetch,
      now: NOW,
    }));

    await waitFor(() =>
      expect(result.current.coordinationStatus).toBe("coordination-error"),
    );
    await waitFor(() => expect(result.current.value).toContain("# Invalid"));
    expect(result.current.coordinationError).toContain("invalid note identity");
    expect(result.current.canEdit).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    unmount();
  });

  it("gives exactly one hook edit ownership and makes a follower update a no-op", async () => {
    const noteId = "shared-owner";
    const coordinator = new SharedFakeCoordinator();
    const server = noteServer(noteId);
    const options = {
      coordinator,
      fetch: server.fetchMock as typeof fetch,
      now: NOW,
      diskSaveDelayMs: 0,
    };
    const owner = renderHook(() => useNoteDraft(noteId, "Shared note", options));
    const follower = renderHook(() => useNoteDraft(noteId, "Shared note", options));

    await waitFor(() => expect(owner.result.current.canEdit).toBe(true));
    await waitFor(() =>
      expect(follower.result.current.coordinationStatus).toBe("viewing-other-tab"),
    );
    expect(coordinator.activeOwnerCount(noteId)).toBe(1);
    expect(follower.result.current.canEdit).toBe(false);

    act(() => follower.result.current.updateValue("Follower must not write"));
    await act(async () => Promise.resolve());

    expect(follower.result.current.value).toBe("Disk copy");
    expect(server.putBodies).toEqual([]);
    await expect(readDraft(noteId)).resolves.toMatchObject({ content: "Disk copy" });

    follower.unmount();
    owner.unmount();
    await waitFor(() => expect(coordinator.openSessionCount).toBe(0));
  });

  it("mirrors an owner's committed IndexedDB draft into the view-only follower", async () => {
    const noteId = "shared-mirror";
    const coordinator = new SharedFakeCoordinator();
    const server = noteServer(noteId);
    const options = {
      coordinator,
      fetch: server.fetchMock as typeof fetch,
      now: NOW,
      diskSaveDelayMs: LONG_DISK_DELAY_MS,
    };
    const owner = renderHook(() => useNoteDraft(noteId, "Shared note", options));
    const follower = renderHook(() => useNoteDraft(noteId, "Shared note", options));
    await waitFor(() => expect(owner.result.current.canEdit).toBe(true));
    await waitFor(() => expect(follower.result.current.status).toBe("view-only"));

    act(() => owner.result.current.updateValue("Locally committed owner draft"));

    await waitFor(async () =>
      expect(await readDraft(noteId)).toMatchObject({
        content: "Locally committed owner draft",
        baseRevision: 1,
        baseContentHash: HASH_A,
      }),
    );
    await waitFor(() =>
      expect(follower.result.current.value).toBe("Locally committed owner draft"),
    );
    expect(follower.result.current.status).toBe("view-only");
    expect(follower.result.current.canEdit).toBe(false);
    expect(server.putBodies).toEqual([]);

    follower.unmount();
    owner.unmount();
    await waitFor(() => expect(coordinator.openSessionCount).toBe(0));
  });

  it("hands off after owner unmount and reconciles the exact local draft before editing", async () => {
    const noteId = "shared-handoff";
    const coordinator = new SharedFakeCoordinator();
    const server = noteServer(noteId);
    const options = {
      coordinator,
      fetch: server.fetchMock as typeof fetch,
      now: NOW,
      diskSaveDelayMs: LONG_DISK_DELAY_MS,
    };
    const owner = renderHook(() => useNoteDraft(noteId, "Shared note", options));
    const successor = renderHook(() => useNoteDraft(noteId, "Shared note", options));
    await waitFor(() => expect(owner.result.current.canEdit).toBe(true));
    await waitFor(() => expect(successor.result.current.canEdit).toBe(false));

    act(() => owner.result.current.updateValue("Draft accepted before owner close"));
    await waitFor(() => expect(owner.result.current.status).toBe("saved-locally"));
    await waitFor(() =>
      expect(successor.result.current.value).toBe("Draft accepted before owner close"),
    );

    owner.unmount();

    await waitFor(() => expect(successor.result.current.canEdit).toBe(true));
    expect(successor.result.current.coordinationStatus).toBe("editing");
    expect(successor.result.current.value).toBe("Draft accepted before owner close");
    expect(successor.result.current.baseRevision).toBe(1);
    expect(successor.result.current.baseContentHash).toBe(HASH_A);
    expect(coordinator.activeOwnerCount(noteId)).toBe(1);

    act(() => successor.result.current.updateValue("Successor's first edit"));
    await waitFor(async () =>
      expect(await readDraft(noteId)).toMatchObject({
        content: "Successor's first edit",
        baseRevision: 1,
        baseContentHash: HASH_A,
      }),
    );
    expect(server.putBodies).toEqual([]);

    successor.unmount();
    await waitFor(() => expect(coordinator.openSessionCount).toBe(0));
  });

  it("bounds handoff when an abort-insensitive disk request never settles", async () => {
    const noteId = "shared-wedged-put";
    const coordinator = new SharedFakeCoordinator();
    const neverSettlingPut = deferred<Response>();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        return jsonResponse(notePayload(noteId, "Disk copy", 1, HASH_A));
      }
      if (init?.method === "PUT") return neverSettlingPut.promise;
      throw new Error(`unexpected note request method ${String(init?.method)}`);
    });
    const owner = renderHook(() => useNoteDraft(noteId, "Shared note", {
      coordinator,
      fetch: fetchMock as typeof fetch,
      now: NOW,
      diskSaveDelayMs: 0,
      handoffDrainTimeoutMs: 5,
    }));
    const successor = renderHook(() => useNoteDraft(noteId, "Shared note", {
      coordinator,
      fetch: fetchMock as typeof fetch,
      now: NOW,
      diskSaveDelayMs: LONG_DISK_DELAY_MS,
      handoffDrainTimeoutMs: 5,
    }));
    await waitFor(() => expect(owner.result.current.canEdit).toBe(true));
    await waitFor(() => expect(successor.result.current.canEdit).toBe(false));

    act(() => owner.result.current.updateValue("Recoverable while disk is wedged"));
    await waitFor(() => expect(owner.result.current.status).toBe("saving-disk"));
    owner.unmount();

    await waitFor(() => expect(successor.result.current.canEdit).toBe(true));
    expect(successor.result.current.value).toBe("Recoverable while disk is wedged");
    expect(successor.result.current.baseRevision).toBe(1);
    expect(coordinator.activeOwnerCount(noteId)).toBe(1);

    successor.unmount();
    await waitFor(() => expect(coordinator.openSessionCount).toBe(0));
  });

  it("fences an old owner's local write delayed beyond the handoff deadline", async () => {
    const noteId = "shared-delayed-local-write";
    const coordinator = new SharedFakeCoordinator();
    const server = noteServer(noteId);
    const delayedWriteStarted = deferred<BrowserNoteDraft>();
    const releaseDelayedWrite = deferred<void>();
    const delayedWriteRejected = deferred<unknown>();
    let delayedOwnerEdit = false;
    const ownerStorage = {
      claimWriterEpoch: claimDraftWriterEpoch,
      read: readDraft,
      write: async (draft: BrowserNoteDraft) => {
        if (
          !delayedOwnerEdit &&
          draft.content === "Owner A accepted but delayed"
        ) {
          delayedOwnerEdit = true;
          delayedWriteStarted.resolve(draft);
          await releaseDelayedWrite.promise;
          try {
            await writeDraft(draft);
          } catch (reason) {
            delayedWriteRejected.resolve(reason);
            throw reason;
          }
          return;
        }
        await writeDraft(draft);
      },
    };
    const successorStorage = {
      claimWriterEpoch: claimDraftWriterEpoch,
      read: readDraft,
      write: writeDraft,
    };
    const owner = renderHook(() => useNoteDraft(noteId, "Shared note", {
      coordinator,
      draftStorage: ownerStorage,
      fetch: server.fetchMock as typeof fetch,
      now: NOW,
      diskSaveDelayMs: LONG_DISK_DELAY_MS,
      handoffDrainTimeoutMs: 5,
    }));
    const successor = renderHook(() => useNoteDraft(noteId, "Shared note", {
      coordinator,
      draftStorage: successorStorage,
      fetch: server.fetchMock as typeof fetch,
      now: NOW,
      diskSaveDelayMs: LONG_DISK_DELAY_MS,
      handoffDrainTimeoutMs: 5,
    }));
    await waitFor(() => expect(owner.result.current.canEdit).toBe(true));
    await waitFor(() => expect(successor.result.current.canEdit).toBe(false));

    act(() => owner.result.current.updateValue("Owner A accepted but delayed"));
    const staleDraft = await delayedWriteStarted.promise;
    expect(staleDraft).toMatchObject({
      content: "Owner A accepted but delayed",
      writerEpoch: 1,
      editSequence: 1,
    });
    expect(owner.result.current.status).toBe("saving-local");

    owner.unmount();

    // Acquiring before the delayed write is released proves the 5 ms drain
    // deadline elapsed and successor B claimed the next persistent epoch.
    await waitFor(() => expect(successor.result.current.canEdit).toBe(true));
    expect(successor.result.current.value).toBe("Disk copy");
    act(() => successor.result.current.updateValue("Successor B committed"));
    await waitFor(async () =>
      expect(await readDraft(noteId)).toMatchObject({
        content: "Successor B committed",
        baseRevision: 1,
        baseContentHash: HASH_A,
        writerEpoch: 2,
        editSequence: 1,
      }),
    );
    const successorCheckpoint = {
      revision: successor.result.current.baseRevision,
      contentHash: successor.result.current.baseContentHash,
    };

    act(() => releaseDelayedWrite.resolve());
    await expect(delayedWriteRejected.promise).resolves.toBeInstanceOf(
      StaleDraftWriterError,
    );

    expect(successor.result.current.canEdit).toBe(true);
    expect(successor.result.current.value).toBe("Successor B committed");
    expect({
      revision: successor.result.current.baseRevision,
      contentHash: successor.result.current.baseContentHash,
    }).toEqual(successorCheckpoint);
    await expect(readDraft(noteId)).resolves.toMatchObject({
      content: "Successor B committed",
      baseRevision: 1,
      baseContentHash: HASH_A,
      writerEpoch: 2,
      editSequence: 1,
    });
    expect(server.putBodies).toEqual([]);

    successor.unmount();
    await waitFor(() => expect(coordinator.openSessionCount).toBe(0));
  });

  it("aborts a delayed pre-transaction claim before a successor epoch is established", async () => {
    const noteId = "shared-delayed-claim";
    const coordinator = new SharedFakeCoordinator();
    const server = noteServer(noteId);
    const delayedClaimStarted = deferred<AbortSignal | undefined>();
    const releaseDelayedClaim = deferred<void>();
    const delayedClaimSettled = deferred<{
      readonly kind: "aborted" | "claimed";
      readonly signal: AbortSignal | undefined;
      readonly epoch?: number;
    }>();
    const ownerStorage = {
      claimWriterEpoch: async (
        requestedNoteId: string,
        signal?: AbortSignal,
      ): Promise<number> => {
        delayedClaimStarted.resolve(signal);
        await releaseDelayedClaim.promise;
        if (signal?.aborted) {
          delayedClaimSettled.resolve({ kind: "aborted", signal });
          throw new DOMException("The writer claim was aborted", "AbortError");
        }
        const epoch = await claimDraftWriterEpoch(requestedNoteId);
        delayedClaimSettled.resolve({ kind: "claimed", signal, epoch });
        return epoch;
      },
      read: readDraft,
      write: writeDraft,
    };
    const successorStorage = {
      claimWriterEpoch: claimDraftWriterEpoch,
      read: readDraft,
      write: writeDraft,
    };
    const owner = renderHook(() => useNoteDraft(noteId, "Shared note", {
      coordinator,
      draftStorage: ownerStorage,
      fetch: server.fetchMock as typeof fetch,
      now: NOW,
      diskSaveDelayMs: LONG_DISK_DELAY_MS,
      handoffDrainTimeoutMs: 5,
    }));
    const successor = renderHook(() => useNoteDraft(noteId, "Shared note", {
      coordinator,
      draftStorage: successorStorage,
      fetch: server.fetchMock as typeof fetch,
      now: NOW,
      diskSaveDelayMs: LONG_DISK_DELAY_MS,
      handoffDrainTimeoutMs: 5,
    }));

    await delayedClaimStarted.promise;
    expect(owner.result.current.canEdit).toBe(false);
    owner.unmount();

    // B can claim and commit while A's wrapper is still paused before opening
    // the real IndexedDB claim transaction.
    await waitFor(() => expect(successor.result.current.canEdit).toBe(true));
    act(() => successor.result.current.updateValue("Successor before old claim release"));
    await waitFor(async () =>
      expect(await readDraft(noteId)).toMatchObject({
        content: "Successor before old claim release",
        writerEpoch: 1,
        editSequence: 1,
      }),
    );

    act(() => releaseDelayedClaim.resolve());
    const claimOutcome = await delayedClaimSettled.promise;
    expect(claimOutcome.kind).toBe("aborted");
    expect(claimOutcome.signal).toBeInstanceOf(AbortSignal);
    expect(claimOutcome.signal?.aborted).toBe(true);

    act(() => successor.result.current.updateValue("Successor after old claim release"));
    await waitFor(async () =>
      expect(await readDraft(noteId)).toMatchObject({
        content: "Successor after old claim release",
        writerEpoch: 1,
        editSequence: 2,
      }),
    );
    expect(successor.result.current.coordinationStatus).toBe("editing");
    expect(successor.result.current.coordinationError).toBeNull();

    successor.unmount();
    await waitFor(() => expect(coordinator.openSessionCount).toBe(0));
  });

  it("preserves the edit sequence when an offline first open reconciles on retry", async () => {
    const noteId = "shared-offline-reconcile";
    const coordinator = new SharedFakeCoordinator();
    let diskAvailable = false;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== "POST") {
        throw new Error(`unexpected note request method ${String(init?.method)}`);
      }
      if (!diskAvailable) throw new Error("disk service offline");
      return jsonResponse(notePayload(noteId, "", 1, HASH_A));
    });
    const storage = {
      claimWriterEpoch: claimDraftWriterEpoch,
      read: readDraft,
      write: writeDraft,
    };
    const { result, unmount } = renderHook(() => useNoteDraft(noteId, "Offline note", {
      coordinator,
      draftStorage: storage,
      fetch: fetchMock as typeof fetch,
      now: NOW,
      diskSaveDelayMs: LONG_DISK_DELAY_MS,
    }));
    await waitFor(() => expect(result.current.canEdit).toBe(true));
    expect(result.current.status).toBe("offline");

    act(() => result.current.updateValue("Persisted offline edit"));
    await waitFor(async () =>
      expect(await readDraft(noteId)).toMatchObject({
        content: "Persisted offline edit",
        baseRevision: 0,
        baseContentHash: "",
        writerEpoch: 1,
        editSequence: 1,
      }),
    );

    diskAvailable = true;
    act(() => result.current.retryDiskSave());
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2),
    );
    await waitFor(() => expect(result.current.coordinationStatus).toBe("editing"));

    expect(result.current.canEdit).toBe(true);
    expect(result.current.status).toBe("saved-locally");
    expect(result.current.coordinationError).toBeNull();
    await expect(readDraft(noteId)).resolves.toMatchObject({
      content: "Persisted offline edit",
      baseRevision: 1,
      baseContentHash: HASH_A,
      writerEpoch: 1,
      editSequence: 1,
    });

    act(() => result.current.updateValue("Second edit after reconciliation"));
    await waitFor(async () =>
      expect(await readDraft(noteId)).toMatchObject({
        content: "Second edit after reconciliation",
        writerEpoch: 1,
        editSequence: 2,
      }),
    );
    expect(result.current.coordinationStatus).toBe("editing");
    expect(result.current.coordinationError).toBeNull();

    unmount();
    await waitFor(() => expect(coordinator.openSessionCount).toBe(0));
  });

  it("releases the lock after an initial fenced checkpoint write fails", async () => {
    const noteId = "shared-initial-write-failure";
    const coordinator = new SharedFakeCoordinator();
    const server = noteServer(noteId);
    let rejectInitialWrite = true;
    const failingOwnerStorage = {
      claimWriterEpoch: claimDraftWriterEpoch,
      read: readDraft,
      write: async (draft: BrowserNoteDraft) => {
        if (rejectInitialWrite) {
          rejectInitialWrite = false;
          throw new Error("simulated initial fenced checkpoint failure");
        }
        await writeDraft(draft);
      },
    };
    const successorStorage = {
      claimWriterEpoch: claimDraftWriterEpoch,
      read: readDraft,
      write: writeDraft,
    };
    const owner = renderHook(() => useNoteDraft(noteId, "Shared note", {
      coordinator,
      draftStorage: failingOwnerStorage,
      fetch: server.fetchMock as typeof fetch,
      now: NOW,
      diskSaveDelayMs: LONG_DISK_DELAY_MS,
    }));
    const successor = renderHook(() => useNoteDraft(noteId, "Shared note", {
      coordinator,
      draftStorage: successorStorage,
      fetch: server.fetchMock as typeof fetch,
      now: NOW,
      diskSaveDelayMs: LONG_DISK_DELAY_MS,
    }));

    await waitFor(() =>
      expect(owner.result.current.coordinationStatus).toBe("coordination-error"),
    );
    expect(owner.result.current.canEdit).toBe(false);
    expect(owner.result.current.coordinationError).toContain(
      "browser recovery draft could not be secured",
    );

    // The failed owner remains mounted. B must receive the lock without an
    // explicit retry, unmount, or direct coordinator close from the test.
    await waitFor(() => expect(successor.result.current.canEdit).toBe(true));
    expect(successor.result.current.coordinationStatus).toBe("editing");
    expect(coordinator.activeOwnerCount(noteId)).toBe(1);
    await expect(readDraft(noteId)).resolves.toMatchObject({
      content: "Disk copy",
      writerEpoch: 2,
      editSequence: 0,
    });

    owner.unmount();
    successor.unmount();
    await waitFor(() => expect(coordinator.openSessionCount).toBe(0));
  });

  it("ignores a late failed follower read after that tab acquires ownership", async () => {
    const noteId = "shared-late-viewer-read";
    const coordinator = new SharedFakeCoordinator();
    const server = noteServer(noteId);
    const lateViewerRead = deferred<BrowserNoteDraft | null>();
    let followerReadCount = 0;
    const followerStorage = {
      claimWriterEpoch: claimDraftWriterEpoch,
      read: (requestedNoteId: string) => {
        followerReadCount += 1;
        return followerReadCount === 1
          ? lateViewerRead.promise
          : readDraft(requestedNoteId);
      },
      write: writeDraft,
    };
    const owner = renderHook(() => useNoteDraft(noteId, "Shared note", {
      coordinator,
      fetch: server.fetchMock as typeof fetch,
      now: NOW,
      diskSaveDelayMs: LONG_DISK_DELAY_MS,
    }));
    const successor = renderHook(() => useNoteDraft(noteId, "Shared note", {
      coordinator,
      draftStorage: followerStorage,
      fetch: server.fetchMock as typeof fetch,
      now: NOW,
      diskSaveDelayMs: LONG_DISK_DELAY_MS,
    }));
    await waitFor(() => expect(owner.result.current.canEdit).toBe(true));
    await waitFor(() =>
      expect(successor.result.current.coordinationStatus).toBe("viewing-other-tab"),
    );

    owner.unmount();
    await waitFor(() => expect(successor.result.current.canEdit).toBe(true));
    const statusAfterAcquisition = successor.result.current.status;

    act(() => lateViewerRead.reject(new Error("late follower read failed")));
    await act(async () => Promise.resolve());

    expect(successor.result.current.coordinationStatus).toBe("editing");
    expect(successor.result.current.canEdit).toBe(true);
    expect(successor.result.current.status).toBe(statusAfterAcquisition);
    expect(successor.result.current.status).not.toBe("view-only");
    expect(successor.result.current.error).toBeNull();

    successor.unmount();
    await waitFor(() => expect(coordinator.openSessionCount).toBe(0));
  });

  it("fences a delayed old-owner acknowledgement after document-loss handoff", async () => {
    const noteId = "shared-delayed-ack";
    const coordinator = new SharedFakeCoordinator();
    const oldOwnerAcknowledgement = deferred<Response>();
    const putBodies: Record<string, unknown>[] = [];
    let disk = notePayload(noteId, "Disk copy", 1, HASH_A);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") return jsonResponse(disk);
      if (init?.method !== "PUT") {
        throw new Error(`unexpected note request method ${String(init?.method)}`);
      }

      const body = requestBody(init);
      putBodies.push(body);
      if (
        body.base_revision !== disk.revision ||
        body.base_content_hash !== disk.content_hash
      ) {
        return jsonResponse({
          status: "conflict",
          current: disk,
          conflict_path: `notes/conflicts/${noteId}-stale.md`,
        }, 409);
      }

      // The backend CAS has committed owner A's bytes and revision. Only its
      // HTTP response is delayed, so successor B must reconcile from revision 2.
      disk = notePayload(noteId, String(body.content), 2, HASH_B);
      return oldOwnerAcknowledgement.promise;
    });
    const owner = renderHook(() => useNoteDraft(noteId, "Shared note", {
      coordinator,
      fetch: fetchMock as typeof fetch,
      now: NOW,
      diskSaveDelayMs: 0,
    }));
    const successor = renderHook(() => useNoteDraft(noteId, "Shared note", {
      coordinator,
      fetch: fetchMock as typeof fetch,
      now: NOW,
      diskSaveDelayMs: LONG_DISK_DELAY_MS,
    }));
    await waitFor(() => expect(owner.result.current.canEdit).toBe(true));
    await waitFor(() => expect(successor.result.current.canEdit).toBe(false));

    act(() => owner.result.current.updateValue("Owner A committed on disk"));
    await waitFor(() => expect(putBodies).toEqual([{
      content: "Owner A committed on disk",
      base_revision: 1,
      base_content_hash: HASH_A,
    }]));
    await waitFor(() => expect(owner.result.current.status).toBe("saving-disk"));

    owner.unmount();
    // A real tab/document loss releases its Web Lock independently of React's
    // pending fetch continuation. The fake models that host-level handoff.
    coordinator.simulateDocumentLoss(noteId);
    await waitFor(() => expect(successor.result.current.canEdit).toBe(true));
    expect(successor.result.current.value).toBe("Owner A committed on disk");
    expect(successor.result.current.baseRevision).toBe(2);
    expect(successor.result.current.baseContentHash).toBe(HASH_B);

    act(() => successor.result.current.updateValue("Successor B newer local draft"));
    await waitFor(async () =>
      expect(await readDraft(noteId)).toMatchObject({
        content: "Successor B newer local draft",
        baseRevision: 2,
        baseContentHash: HASH_B,
      }),
    );

    act(() => oldOwnerAcknowledgement.resolve(jsonResponse(disk)));
    // The first close call occurs only after owner A's delayed save continuation
    // has fully settled, making the assertions below sensitive to late writes.
    await waitFor(() => expect(coordinator.closeCount).toBe(1));

    expect(successor.result.current.value).toBe("Successor B newer local draft");
    expect(successor.result.current.baseRevision).toBe(2);
    expect(successor.result.current.baseContentHash).toBe(HASH_B);
    await expect(readDraft(noteId)).resolves.toMatchObject({
      content: "Successor B newer local draft",
      baseRevision: 2,
      baseContentHash: HASH_B,
    });
    expect(putBodies).toHaveLength(1);

    successor.unmount();
    await waitFor(() => expect(coordinator.openSessionCount).toBe(0));
  });

  it("does not reacquire or reload when only the same note's title changes", async () => {
    const noteId = "same-note-title";
    const coordinator = new SharedFakeCoordinator();
    const server = noteServer(noteId);
    const { result, rerender, unmount } = renderHook(
      ({ title }) => useNoteDraft(noteId, title, {
        coordinator,
        fetch: server.fetchMock as typeof fetch,
        now: NOW,
        diskSaveDelayMs: LONG_DISK_DELAY_MS,
      }),
      { initialProps: { title: "Original title" } },
    );
    await waitFor(() => expect(result.current.canEdit).toBe(true));

    act(() => result.current.updateValue("Keep this in-progress draft"));
    await waitFor(() => expect(result.current.status).toBe("saved-locally"));
    rerender({ title: "Renamed title" });
    await act(async () => Promise.resolve());

    expect(result.current.canEdit).toBe(true);
    expect(result.current.value).toBe("Keep this in-progress draft");
    expect(coordinator.startCount).toBe(1);
    expect(coordinator.acquisitionCount).toBe(1);
    expect(server.fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(server.putBodies).toEqual([]);

    unmount();
    await waitFor(() => expect(coordinator.openSessionCount).toBe(0));
  });
});
