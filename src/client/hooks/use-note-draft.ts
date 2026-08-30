import { useCallback, useEffect, useRef, useState } from "react";

import {
  claimDraftWriterEpoch,
  readDraft,
  writeDraft,
  type BrowserNoteDraft,
} from "../storage/drafts.js";
import {
  createNoteEditCoordinator,
  type NoteEditCoordinationHandle,
  type NoteEditCoordinator,
} from "../notes/note-edit-coordinator.js";
import {
  createNoteTemplate,
  upgradeUntouchedNoteTemplate,
} from "../../shared/notes.js";

export type NoteSaveStatus =
  | "loading"
  | "saving-local"
  | "saved-locally"
  | "saving-disk"
  | "saved-disk"
  | "conflict"
  | "offline"
  | "error"
  | "view-only";

export type NoteCoordinationStatus =
  | "acquiring"
  | "viewing-other-tab"
  | "reconciling"
  | "editing"
  | "coordination-error";

interface NoteResponse {
  readonly note_id: string;
  readonly content: string;
  readonly revision: number;
  readonly content_hash: string;
  readonly updated_at: string;
  readonly logical_path: string;
}

interface ConflictResponse {
  readonly status: "conflict";
  readonly current: NoteResponse;
  readonly conflict_path: string;
}

class RecoverableDiskNoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecoverableDiskNoteError";
  }
}

interface DiskCheckpoint {
  readonly revision: number;
  readonly contentHash: string;
}

interface ActiveDiskSave {
  readonly generation: number;
  readonly noteId: string;
  readonly editSequence: number;
  readonly controller: AbortController;
}

export interface UseNoteDraftOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
  readonly diskSaveDelayMs?: number;
  readonly handoffDrainTimeoutMs?: number;
  readonly coordinator?: NoteEditCoordinator;
  readonly draftStorage?: {
    readonly claimWriterEpoch: typeof claimDraftWriterEpoch;
    readonly read: typeof readDraft;
    readonly write: typeof writeDraft;
  };
}

const sha256Pattern = /^[a-f0-9]{64}$/;
const defaultFetch: typeof globalThis.fetch = (input, init) => globalThis.fetch(input, init);
const defaultNow = () => new Date();
const defaultDraftStorage = Object.freeze({
  claimWriterEpoch: claimDraftWriterEpoch,
  read: readDraft,
  write: writeDraft,
});
const defaultDiskSaveDelayMs = 3_000;
const defaultHandoffDrainTimeoutMs = 2_500;

interface PendingBrowserDraftCheckpoint {
  acceptedSequence: number;
  persistedSequence: number;
}

// Keep the unload fence outside any one hook lifetime. A route change may
// unmount an editor while its last IndexedDB transaction is still settling;
// the browser must continue warning until those accepted bytes are durable.
const pendingBrowserDraftCheckpoints = new Map<symbol, PendingBrowserDraftCheckpoint>();
let browserDraftUnloadFenceInstalled = false;

function fenceUnsafeUnload(event: BeforeUnloadEvent): void {
  if (pendingBrowserDraftCheckpoints.size === 0) return;
  event.preventDefault();
  event.returnValue = "";
}

function syncBrowserDraftUnloadFence(): void {
  if (typeof window === "undefined") return;
  const required = pendingBrowserDraftCheckpoints.size > 0;
  if (required === browserDraftUnloadFenceInstalled) return;
  browserDraftUnloadFenceInstalled = required;
  if (required) {
    window.addEventListener("beforeunload", fenceUnsafeUnload);
  } else {
    window.removeEventListener("beforeunload", fenceUnsafeUnload);
  }
}

function markBrowserDraftAccepted(batch: symbol, sequence: number): void {
  const current = pendingBrowserDraftCheckpoints.get(batch) ?? {
    acceptedSequence: 0,
    persistedSequence: 0,
  };
  pendingBrowserDraftCheckpoints.set(batch, {
    ...current,
    acceptedSequence: Math.max(current.acceptedSequence, sequence),
  });
  syncBrowserDraftUnloadFence();
}

function markBrowserDraftPersisted(batch: symbol, sequence: number): void {
  const current = pendingBrowserDraftCheckpoints.get(batch);
  if (current === undefined) return;
  const persistedSequence = Math.max(current.persistedSequence, sequence);
  if (persistedSequence >= current.acceptedSequence) {
    pendingBrowserDraftCheckpoints.delete(batch);
  } else {
    pendingBrowserDraftCheckpoints.set(batch, { ...current, persistedSequence });
  }
  syncBrowserDraftUnloadFence();
}

export function initialNoteContent(title: string): string {
  return createNoteTemplate(title);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseNoteResponse(value: unknown, expectedNoteId: string): NoteResponse {
  if (!isRecord(value)) throw new Error("The note service returned a malformed response");
  if (value.note_id !== expectedNoteId) {
    throw new Error("The note service responded for a different note");
  }
  if (typeof value.content !== "string") {
    throw new Error("The note service returned malformed content");
  }
  if (typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 1) {
    throw new Error("The note service returned a malformed revision");
  }
  if (typeof value.content_hash !== "string" || !sha256Pattern.test(value.content_hash)) {
    throw new Error("The note service returned a malformed content hash");
  }
  if (typeof value.updated_at !== "string" || !Number.isFinite(Date.parse(value.updated_at))) {
    throw new Error("The note service returned a malformed update time");
  }
  if (typeof value.logical_path !== "string" || !value.logical_path.startsWith("notes/")) {
    throw new Error("The note service returned a malformed logical path");
  }
  return {
    note_id: value.note_id,
    content: value.content,
    revision: value.revision,
    content_hash: value.content_hash,
    updated_at: value.updated_at,
    logical_path: value.logical_path,
  };
}

function parseConflictResponse(value: unknown, expectedNoteId: string): ConflictResponse {
  if (!isRecord(value) || value.status !== "conflict") {
    throw new Error("The note service returned a malformed conflict");
  }
  if (typeof value.conflict_path !== "string" || !value.conflict_path.startsWith("notes/")) {
    throw new Error("The note service returned a malformed conflict path");
  }
  return {
    status: "conflict",
    current: parseNoteResponse(value.current, expectedNoteId),
    conflict_path: value.conflict_path,
  };
}

function checkpointFromDisk(note: NoteResponse): DiskCheckpoint {
  return { revision: note.revision, contentHash: note.content_hash };
}

function checkpointFromDraft(draft: BrowserNoteDraft): DiskCheckpoint {
  return { revision: draft.baseRevision, contentHash: draft.baseContentHash };
}

function isPersistedCheckpoint(checkpoint: DiskCheckpoint): boolean {
  return checkpoint.revision > 0 && sha256Pattern.test(checkpoint.contentHash);
}

function errorMessage(reason: unknown, fallback: string): string {
  return reason instanceof Error ? reason.message : fallback;
}

function browserIsOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine;
}

function settleWithDeadline(
  pending: readonly Promise<unknown>[],
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve();
    };
    const timer = window.setTimeout(finish, timeoutMs);
    void Promise.allSettled(pending).then(finish);
  });
}

/**
 * Owns note editing across three durability boundaries: one authoritative
 * same-origin tab, an IndexedDB recovery draft, and a conditional Markdown
 * save. A tab cannot accept input until it owns the per-note Web Lock and has
 * reconciled both persisted copies.
 */
export function useNoteDraft(
  noteId: string,
  title: string,
  options: UseNoteDraftOptions = {},
) {
  const fetchImpl = options.fetch ?? defaultFetch;
  const now = options.now ?? defaultNow;
  const diskSaveDelayMs = options.diskSaveDelayMs ?? defaultDiskSaveDelayMs;
  const handoffDrainTimeoutMs = Math.max(
    0,
    options.handoffDrainTimeoutMs ?? defaultHandoffDrainTimeoutMs,
  );
  const draftStorage = options.draftStorage ?? defaultDraftStorage;
  const [coordinator] = useState(
    () => options.coordinator ?? createNoteEditCoordinator(),
  );

  const [value, setValue] = useState("");
  const [baseRevision, setBaseRevision] = useState(0);
  const [baseContentHash, setBaseContentHash] = useState("");
  const [logicalPath, setLogicalPath] = useState("");
  const [diskRecoveryAvailable, setDiskRecoveryAvailable] = useState(false);
  const [status, setStatus] = useState<NoteSaveStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [coordinationStatus, setCoordinationStatus] =
    useState<NoteCoordinationStatus>("acquiring");
  const [coordinationError, setCoordinationError] = useState<string | null>(null);
  const [ownerToken, setOwnerToken] = useState(0);
  const [reloadSequence, setReloadSequence] = useState(0);
  const [coordinationRetrySequence, setCoordinationRetrySequence] = useState(0);

  const titleRef = useRef(title);
  titleRef.current = title;
  const loadedRef = useRef(false);
  const canEditRef = useRef(false);
  const generationRef = useRef(0);
  const loadGenerationRef = useRef(0);
  const ownerCounterRef = useRef(0);
  const activeOwnerTokenRef = useRef<number | null>(null);
  const writerEpochRef = useRef(0);
  const editSequenceRef = useRef(0);
  const valueRef = useRef("");
  const checkpointRef = useRef<DiskCheckpoint>({ revision: 0, contentHash: "" });
  const blockedByConflictRef = useRef(false);
  const inFlightSaveRef = useRef<ActiveDiskSave | null>(null);
  const inFlightCompletionRef = useRef<Promise<void> | null>(null);
  const localWriteTailRef = useRef<Promise<void>>(Promise.resolve());
  const coordinationHandleRef = useRef<NoteEditCoordinationHandle | null>(null);
  const retireCoordinationRef = useRef<(() => void) | null>(null);
  const unloadBatchRef = useRef(Symbol("note-draft-generation"));

  const enqueueLocalWrite = useCallback((draft: BrowserNoteDraft): Promise<void> => {
    const announcingHandle = coordinationHandleRef.current;
    const unloadBatch = unloadBatchRef.current;
    const fencedDraft: BrowserNoteDraft = {
      ...draft,
      writerEpoch: writerEpochRef.current,
      editSequence: draft.editSequence ?? editSequenceRef.current,
    };
    const write = localWriteTailRef.current.then(async () => {
      await draftStorage.write(fencedDraft);
      markBrowserDraftPersisted(unloadBatch, fencedDraft.editSequence ?? 0);
      announcingHandle?.announceDraftChanged();
    });
    localWriteTailRef.current = write.catch(() => undefined);
    return write;
  }, [draftStorage]);

  useEffect(() => {
    const generation = ++generationRef.current;
    const titleAtStart = titleRef.current;
    loadedRef.current = false;
    canEditRef.current = false;
    activeOwnerTokenRef.current = null;
    writerEpochRef.current = 0;
    editSequenceRef.current = 0;
    unloadBatchRef.current = Symbol("note-draft-generation");
    valueRef.current = "";
    checkpointRef.current = { revision: 0, contentHash: "" };
    blockedByConflictRef.current = false;
    // The prior route's cleanup retained its own completion snapshot. These
    // live refs now belong exclusively to the new note generation.
    inFlightSaveRef.current = null;
    inFlightCompletionRef.current = null;
    setValue("");
    setBaseRevision(0);
    setBaseContentHash("");
    setLogicalPath("");
    setDiskRecoveryAvailable(false);
    setStatus("loading");
    setError(null);
    setCoordinationStatus("acquiring");
    setCoordinationError(null);
    setOwnerToken(0);
    const ownershipClaimController = new AbortController();

    const loadViewerDraft = async (): Promise<void> => {
      try {
        const draft = await draftStorage.read(noteId);
        if (
          generation !== generationRef.current ||
          activeOwnerTokenRef.current !== null
        ) {
          return;
        }
        const viewerContent = draft?.content ?? initialNoteContent(titleAtStart);
        const viewerCheckpoint = draft === null
          ? { revision: 0, contentHash: "" }
          : checkpointFromDraft(draft);
        valueRef.current = viewerContent;
        checkpointRef.current = viewerCheckpoint;
        setValue(viewerContent);
        setBaseRevision(viewerCheckpoint.revision);
        setBaseContentHash(viewerCheckpoint.contentHash);
        setLogicalPath(draft === null ? "Waiting for the editing tab" : "Browser recovery draft");
        setError(null);
        setStatus("view-only");
      } catch (reason) {
        if (
          generation !== generationRef.current ||
          activeOwnerTokenRef.current !== null
        ) {
          return;
        }
        setStatus("view-only");
        setError(errorMessage(reason, "The shared recovery draft could not be read"));
      }
    };

    let startupFailed = false;
    let handle: NoteEditCoordinationHandle;
    try {
      handle = coordinator.startNoteEditCoordination({
        noteId,
        onAcquired: () => {
          if (generation !== generationRef.current) return;
          const token = ++ownerCounterRef.current;
          activeOwnerTokenRef.current = token;
          loadedRef.current = false;
          canEditRef.current = false;
          setCoordinationStatus("reconciling");
          setCoordinationError(null);
          setStatus("loading");
          void draftStorage.claimWriterEpoch(noteId, ownershipClaimController.signal)
            .then((writerEpoch) => {
              if (
                generation !== generationRef.current ||
                token !== activeOwnerTokenRef.current
              ) {
                return;
              }
              writerEpochRef.current = writerEpoch;
              setOwnerToken(token);
            })
            .catch((reason: unknown) => {
              if (
                generation !== generationRef.current ||
                token !== activeOwnerTokenRef.current
              ) {
                return;
              }
              activeOwnerTokenRef.current = null;
              loadedRef.current = false;
              canEditRef.current = false;
              setCoordinationStatus("coordination-error");
              setCoordinationError(
                errorMessage(reason, "Local note ownership could not be secured"),
              );
              void loadViewerDraft();
              // The browser lock is already ours, but editing cannot become
              // safe without a persistent epoch. Release it so another tab is
              // not stranded behind this failed owner.
              queueMicrotask(() => void handle.close());
            });
        },
        onDraftChanged: () => {
          if (
            generation === generationRef.current &&
            activeOwnerTokenRef.current === null
          ) {
            void loadViewerDraft();
          }
        },
        onReleased: () => {
          if (
            generation === generationRef.current &&
            activeOwnerTokenRef.current === null
          ) {
            setCoordinationStatus("acquiring");
          }
        },
        onError: (reason) => {
          if (generation !== generationRef.current) return;
          activeOwnerTokenRef.current = null;
          loadedRef.current = false;
          canEditRef.current = false;
          setCoordinationStatus("coordination-error");
          setCoordinationError(reason.message);
          void loadViewerDraft();
          queueMicrotask(() => void handle.close());
        },
      });
    } catch (reason) {
      startupFailed = true;
      activeOwnerTokenRef.current = null;
      loadedRef.current = false;
      canEditRef.current = false;
      setCoordinationStatus("coordination-error");
      setCoordinationError(
        errorMessage(reason, "Safe multi-tab note coordination could not start"),
      );
      void loadViewerDraft();
      handle = Object.freeze({
        announceDraftChanged: () => false,
        close: async () => undefined,
      });
    }
    coordinationHandleRef.current = handle;

    let retired = false;
    const retire = () => {
      if (retired) return;
      retired = true;
      ownershipClaimController.abort();
      if (generation === generationRef.current) ++generationRef.current;
      ++loadGenerationRef.current;
      loadedRef.current = false;
      canEditRef.current = false;
      activeOwnerTokenRef.current = null;
      const activeSave = inFlightSaveRef.current;
      activeSave?.controller.abort();
      const localTail = localWriteTailRef.current;
      const diskTail = inFlightCompletionRef.current;
      if (coordinationHandleRef.current === handle) {
        coordinationHandleRef.current = null;
      }
      // Give accepted keystrokes and the active PUT a bounded chance to drain
      // before handoff. The deadline prevents one wedged browser primitive
      // from locking every other tab forever; persistent local writer epochs,
      // generation fences, and disk CAS remain the backstops for work that
      // settles after release.
      void settleWithDeadline(
        [localTail, diskTail ?? Promise.resolve()],
        handoffDrainTimeoutMs,
      ).then(() => handle.close());
    };
    retireCoordinationRef.current = retire;

    // The lock callback is asynchronous. If it has not run by the next
    // microtask, another tab owns or is ahead in the lock queue, so expose the
    // current recovery draft as a selectable read-only view while waiting.
    queueMicrotask(() => {
      if (
        !startupFailed &&
        generation === generationRef.current &&
        activeOwnerTokenRef.current === null
      ) {
        setCoordinationStatus((current) =>
          current === "coordination-error" ? current : "viewing-other-tab",
        );
        void loadViewerDraft();
      }
    });

    return () => {
      if (retireCoordinationRef.current === retire) {
        retireCoordinationRef.current = null;
      }
      retire();
    };
  }, [
    coordinator,
    coordinationRetrySequence,
    draftStorage,
    handoffDrainTimeoutMs,
    noteId,
  ]);

  useEffect(() => {
    const releaseForPageCache = () => {
      retireCoordinationRef.current?.();
    };
    const reconcileAfterPageCache = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      setCoordinationStatus("acquiring");
      setCoordinationRetrySequence((current) => current + 1);
    };
    window.addEventListener("pagehide", releaseForPageCache);
    window.addEventListener("pageshow", reconcileAfterPageCache);
    return () => {
      window.removeEventListener("pagehide", releaseForPageCache);
      window.removeEventListener("pageshow", reconcileAfterPageCache);
    };
  }, []);

  useEffect(() => {
    if (ownerToken === 0 || ownerToken !== activeOwnerTokenRef.current) return;
    const generation = generationRef.current;
    const loadGeneration = ++loadGenerationRef.current;
    const controller = new AbortController();
    const titleAtLoad = titleRef.current;
    loadedRef.current = false;
    canEditRef.current = false;
    blockedByConflictRef.current = false;
    setCoordinationStatus("reconciling");
    setStatus("loading");
    setError(null);

    const diskRequest = fetchImpl("/api/notes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note_id: noteId, title: titleAtLoad }),
      signal: controller.signal,
    }).then(async (response) => {
      const payload = (await response.json()) as unknown;
      if (!response.ok) {
        const detail = isRecord(payload) && typeof payload.error === "string"
          ? payload.error
          : "Could not open the Markdown note";
        if (isRecord(payload) && payload.code === "invalid_note") {
          throw new RecoverableDiskNoteError(detail);
        }
        throw new Error(detail);
      }
      return parseNoteResponse(payload, noteId);
    });

    void Promise.allSettled([draftStorage.read(noteId), diskRequest]).then(
      async ([draftResult, diskResult]) => {
        if (
          generation !== generationRef.current ||
          loadGeneration !== loadGenerationRef.current ||
          ownerToken !== activeOwnerTokenRef.current
        ) {
          return;
        }
        const draft = draftResult.status === "fulfilled" ? draftResult.value : null;
        const disk = diskResult.status === "fulfilled" ? diskResult.value : null;
        if (draft?.writerEpoch === writerEpochRef.current) {
          editSequenceRef.current = Math.max(
            editSequenceRef.current,
            draft.editSequence ?? 0,
          );
        }
        const diskFailure = diskResult.status === "rejected"
          ? errorMessage(diskResult.reason, "Markdown disk service unavailable")
          : null;
        setDiskRecoveryAvailable(
          diskResult.status === "rejected" && diskResult.reason instanceof RecoverableDiskNoteError,
        );
        const draftFailure = draftResult.status === "rejected"
          ? errorMessage(draftResult.reason, "Local recovery draft unavailable")
          : null;

        let selectedContent: string;
        let selectedCheckpoint: DiskCheckpoint;
        let finalStatus: NoteSaveStatus;
        let nextError: string | null = draftFailure;
        let shouldCheckpointLocally = true;
        let selectedLogicalPath: string;

        if (draft !== null && disk !== null) {
          if (
            draft.content === disk.content ||
            upgradeUntouchedNoteTemplate(draft.content, titleAtLoad) === disk.content
          ) {
            selectedContent = disk.content;
            selectedCheckpoint = checkpointFromDisk(disk);
            finalStatus = "saved-disk";
          } else if (
            draft.baseRevision === disk.revision &&
            draft.baseContentHash === disk.content_hash
          ) {
            selectedContent = draft.content;
            selectedCheckpoint = checkpointFromDraft(draft);
            finalStatus = "saved-locally";
          } else if (
            draft.baseRevision === 0 &&
            draft.baseContentHash === "" &&
            draft.content === initialNoteContent(titleAtLoad)
          ) {
            // The server was unavailable or its file was unreadable when this
            // untouched fallback was created. A recovered real Markdown note
            // is authoritative; there are no learner-authored bytes to merge.
            selectedContent = disk.content || initialNoteContent(titleAtLoad);
            selectedCheckpoint = checkpointFromDisk(disk);
            finalStatus = "saved-disk";
          } else if (
            draft.baseRevision === 0 &&
            draft.baseContentHash === "" &&
            disk.revision === 1 &&
            (disk.content === "" || disk.content === initialNoteContent(titleAtLoad))
          ) {
            selectedContent = draft.content;
            selectedCheckpoint = checkpointFromDisk(disk);
            finalStatus = "saved-locally";
          } else {
            selectedContent = draft.content;
            selectedCheckpoint = checkpointFromDraft(draft);
            finalStatus = "conflict";
            shouldCheckpointLocally = false;
            blockedByConflictRef.current = true;
            nextError =
              "The local recovery draft and Markdown file have diverged. Both are preserved; resolve the conflict before disk autosave.";
          }
          selectedLogicalPath = disk.logical_path;
        } else if (draft !== null) {
          selectedContent = draft.content;
          selectedCheckpoint = checkpointFromDraft(draft);
          finalStatus = "offline";
          shouldCheckpointLocally = false;
          nextError = `${diskFailure ?? "Markdown disk service unavailable"}; the local recovery draft is intact.`;
          selectedLogicalPath = "Local recovery draft";
        } else if (disk !== null) {
          selectedContent = disk.content || initialNoteContent(titleAtLoad);
          selectedCheckpoint = checkpointFromDisk(disk);
          finalStatus = disk.content === "" ? "saved-locally" : "saved-disk";
          selectedLogicalPath = disk.logical_path;
        } else {
          selectedContent = initialNoteContent(titleAtLoad);
          selectedCheckpoint = { revision: 0, contentHash: "" };
          finalStatus = "offline";
          nextError = `${diskFailure ?? "Markdown disk service unavailable"}; a new local recovery draft has been created.`;
          selectedLogicalPath = "Local recovery draft";
        }

        valueRef.current = selectedContent;
        checkpointRef.current = selectedCheckpoint;
        if (shouldCheckpointLocally && draft !== null && draft.content !== selectedContent) {
          editSequenceRef.current += 1;
        }
        setValue(selectedContent);
        setBaseRevision(selectedCheckpoint.revision);
        setBaseContentHash(selectedCheckpoint.contentHash);
        setLogicalPath(selectedLogicalPath);
        setError(nextError);

        const enableEditing = () => {
          if (
            generation !== generationRef.current ||
            loadGeneration !== loadGenerationRef.current ||
            ownerToken !== activeOwnerTokenRef.current
          ) {
            return;
          }
          loadedRef.current = true;
          canEditRef.current = true;
          setCoordinationStatus("editing");
          setStatus(finalStatus);
        };

        if (!shouldCheckpointLocally) {
          enableEditing();
          return;
        }

        setStatus("saving-local");
        try {
          await enqueueLocalWrite({
            noteId,
            content: selectedContent,
            baseRevision: selectedCheckpoint.revision,
            baseContentHash: selectedCheckpoint.contentHash,
            updatedAt: now().toISOString(),
          });
          enableEditing();
        } catch (reason) {
          if (
            generation !== generationRef.current ||
            loadGeneration !== loadGenerationRef.current ||
            ownerToken !== activeOwnerTokenRef.current
          ) {
            return;
          }
          activeOwnerTokenRef.current = null;
          loadedRef.current = false;
          canEditRef.current = false;
          setStatus("error");
          setError(errorMessage(reason, "Local recovery save failed"));
          setCoordinationStatus("coordination-error");
          setCoordinationError(
            "Editing is read-only because the browser recovery draft could not be secured. Retry after checking local storage availability.",
          );
          const failedHandle = coordinationHandleRef.current;
          queueMicrotask(() => void failedHandle?.close());
        }
      },
    );

    return () => {
      controller.abort();
      if (loadGeneration === loadGenerationRef.current) {
        ++loadGenerationRef.current;
      }
    };
  }, [
    draftStorage,
    enqueueLocalWrite,
    fetchImpl,
    noteId,
    now,
    ownerToken,
    reloadSequence,
  ]);

  const updateValue = useCallback(
    (nextValue: string) => {
      if (!canEditRef.current || activeOwnerTokenRef.current === null) return;
      const generation = generationRef.current;
      const owner = activeOwnerTokenRef.current;
      const editSequence = ++editSequenceRef.current;
      const unloadBatch = unloadBatchRef.current;
      const checkpoint = checkpointRef.current;
      valueRef.current = nextValue;
      setValue(nextValue);
      // A conflict is a stable, learner-actionable state. Keep its recovery
      // controls mounted while every accepted edit is secured in browser
      // storage; briefly replacing the conflict with "saving" made the whole
      // notes header disappear and reappear on each keystroke.
      if (!blockedByConflictRef.current) {
        setStatus("saving-local");
        setError(null);
      }
      markBrowserDraftAccepted(unloadBatch, editSequence);

      void enqueueLocalWrite({
        noteId,
        content: nextValue,
        baseRevision: checkpoint.revision,
        baseContentHash: checkpoint.contentHash,
        updatedAt: now().toISOString(),
      })
        .then(() => {
          if (
            generation !== generationRef.current ||
            owner !== activeOwnerTokenRef.current ||
            editSequence !== editSequenceRef.current ||
            valueRef.current !== nextValue
          ) {
            return;
          }
          if (blockedByConflictRef.current) {
            setStatus("conflict");
          } else if (isPersistedCheckpoint(checkpointRef.current)) {
            setStatus("saved-locally");
          } else {
            setStatus("offline");
            setError("Saved locally. Reconnect or retry to attach this draft to its Markdown file.");
          }
        })
        .catch((reason: unknown) => {
          if (
            generation !== generationRef.current ||
            owner !== activeOwnerTokenRef.current ||
            editSequence !== editSequenceRef.current
          ) {
            return;
          }
          setStatus("error");
          setError(errorMessage(reason, "Local recovery save failed"));
        });
    },
    [enqueueLocalWrite, noteId, now],
  );

  useEffect(() => {
    if (
      coordinationStatus !== "editing" ||
      !canEditRef.current ||
      !loadedRef.current ||
      status !== "saved-locally" ||
      blockedByConflictRef.current ||
      inFlightSaveRef.current !== null
    ) {
      return;
    }
    const checkpoint = checkpointRef.current;
    if (!isPersistedCheckpoint(checkpoint)) {
      setStatus("offline");
      setError("Saved locally. Reconnect or retry to attach this draft to its Markdown file.");
      return;
    }

    const generation = generationRef.current;
    const owner = activeOwnerTokenRef.current;
    const valueAtSchedule = valueRef.current;
    const editSequenceAtSchedule = editSequenceRef.current;
    const timer = window.setTimeout(() => {
      if (
        generation !== generationRef.current ||
        owner === null ||
        owner !== activeOwnerTokenRef.current ||
        !canEditRef.current ||
        inFlightSaveRef.current !== null ||
        blockedByConflictRef.current
      ) {
        return;
      }
      const controller = new AbortController();
      const active: ActiveDiskSave = {
        generation,
        noteId,
        editSequence: editSequenceAtSchedule,
        controller,
      };
      inFlightSaveRef.current = active;
      setStatus("saving-disk");

      const saveWork = (async () => {
        try {
          const requestBody = JSON.stringify({
            content: valueAtSchedule,
            base_revision: checkpoint.revision,
            base_content_hash: checkpoint.contentHash,
          });
          const attemptSave = async () => {
            const response = await fetchImpl(`/api/notes/${encodeURIComponent(noteId)}`, {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: requestBody,
              signal: controller.signal,
            });
            const payload = (await response.json()) as unknown;
            return { response, payload } as const;
          };
          let attemptResult: Awaited<ReturnType<typeof attemptSave>>;
          try {
            attemptResult = await attemptSave();
          } catch (reason) {
            if (!(reason instanceof TypeError) || controller.signal.aborted) throw reason;
            // Browsers can reject the first request after a suspended or stale
            // local connection with `TypeError: Failed to fetch`. Replay the
            // exact captured CAS request once after a short bounded pause. The
            // note store treats an already-committed identical body as
            // unchanged before checking the stale revision, so a lost response
            // remains idempotent; a genuinely divergent writer still conflicts.
            await new Promise<void>((resolve) => {
              window.setTimeout(resolve, Math.min(250, Math.max(0, diskSaveDelayMs)));
            });
            if (controller.signal.aborted) throw reason;
            attemptResult = await attemptSave();
          }
          const { response, payload } = attemptResult;
          if (response.status === 409) {
            const conflict = parseConflictResponse(payload, noteId);
            if (generation !== generationRef.current || owner !== activeOwnerTokenRef.current) return;
            blockedByConflictRef.current = true;
            if (inFlightSaveRef.current === active) inFlightSaveRef.current = null;
            setStatus("conflict");
            setError(
              `Another writer saved first. The submitted version is preserved at ${conflict.conflict_path}; your latest local draft also remains in browser recovery storage.`,
            );
            return;
          }
          if (!response.ok) {
            const detail = isRecord(payload) && typeof payload.error === "string" ? payload.error : null;
            throw new Error(detail ?? "Disk autosave failed");
          }
          const savedNote = parseNoteResponse(payload, noteId);
          if (savedNote.content !== valueAtSchedule) {
            throw new Error("The note service acknowledged different content");
          }
          if (generation !== generationRef.current || owner !== activeOwnerTokenRef.current) return;

          const acknowledged = checkpointFromDisk(savedNote);
          checkpointRef.current = acknowledged;
          blockedByConflictRef.current = false;
          setBaseRevision(acknowledged.revision);
          setBaseContentHash(acknowledged.contentHash);
          setLogicalPath(savedNote.logical_path);

          const latestContent = valueRef.current;
          const latestEditSequence = editSequenceRef.current;
          const hasNewerEdit =
            latestEditSequence !== editSequenceAtSchedule || latestContent !== valueAtSchedule;
          setStatus("saving-local");
          await enqueueLocalWrite({
            noteId,
            content: latestContent,
            baseRevision: acknowledged.revision,
            baseContentHash: acknowledged.contentHash,
            updatedAt: now().toISOString(),
          });
          if (
            generation !== generationRef.current ||
            owner !== activeOwnerTokenRef.current ||
            latestEditSequence !== editSequenceRef.current ||
            latestContent !== valueRef.current
          ) {
            return;
          }
          if (inFlightSaveRef.current === active) inFlightSaveRef.current = null;
          setStatus(hasNewerEdit ? "saved-locally" : "saved-disk");
        } catch (reason) {
          if (
            generation !== generationRef.current ||
            owner !== activeOwnerTokenRef.current
          ) {
            return;
          }
          if (inFlightSaveRef.current === active) inFlightSaveRef.current = null;
          setStatus(browserIsOnline() ? "error" : "offline");
          setError(errorMessage(reason, "Disk autosave failed"));
        } finally {
          if (inFlightSaveRef.current === active) inFlightSaveRef.current = null;
        }
      })();
      inFlightCompletionRef.current = saveWork;
      void saveWork.finally(() => {
        if (inFlightCompletionRef.current === saveWork) {
          inFlightCompletionRef.current = null;
        }
      });
    }, diskSaveDelayMs);
    return () => window.clearTimeout(timer);
  }, [
    coordinationStatus,
    diskSaveDelayMs,
    enqueueLocalWrite,
    fetchImpl,
    noteId,
    now,
    status,
    value,
  ]);

  const retryDiskSave = useCallback(() => {
    if (!loadedRef.current || !canEditRef.current) return;
    const generation = generationRef.current;
    const owner = activeOwnerTokenRef.current;
    if (owner === null) return;
    const editSequence = editSequenceRef.current;
    const currentValue = valueRef.current;
    const checkpoint = checkpointRef.current;
    const needsReconciliation =
      blockedByConflictRef.current || !isPersistedCheckpoint(checkpoint);
    setError(null);
    setStatus("saving-local");
    // A failed browser-storage write can leave the newest accepted keystrokes
    // only in memory. Always checkpoint that exact visible value before a
    // conflict/offline reconciliation is allowed to replace editor state.
    void enqueueLocalWrite({
      noteId,
      content: currentValue,
      baseRevision: checkpoint.revision,
      baseContentHash: checkpoint.contentHash,
      updatedAt: now().toISOString(),
    })
      .then(() => {
        if (
          generation === generationRef.current &&
          owner !== null &&
          owner === activeOwnerTokenRef.current &&
          editSequence === editSequenceRef.current &&
          currentValue === valueRef.current
        ) {
          if (needsReconciliation) {
            loadedRef.current = false;
            canEditRef.current = false;
            setCoordinationStatus("reconciling");
            setReloadSequence((current) => current + 1);
          } else {
            setStatus("saved-locally");
          }
        }
      })
      .catch((reason: unknown) => {
        if (generation !== generationRef.current || owner !== activeOwnerTokenRef.current) return;
        setStatus("error");
        setError(errorMessage(reason, "Local recovery save failed"));
      });
  }, [enqueueLocalWrite, noteId, now]);

  const resolveConflict = useCallback((choice: "keep-local" | "use-disk") => {
    if (
      !blockedByConflictRef.current ||
      !loadedRef.current ||
      !canEditRef.current
    ) {
      return;
    }
    const generation = generationRef.current;
    const owner = activeOwnerTokenRef.current;
    if (owner === null) return;
    const localContent = valueRef.current;
    const localEditSequence = editSequenceRef.current;
    const staleCheckpoint = checkpointRef.current;

    setStatus("saving-local");
    setError(null);
    void (async () => {
      try {
        // Preserve the exact visible bytes before any network reconciliation.
        await enqueueLocalWrite({
          noteId,
          content: localContent,
          baseRevision: staleCheckpoint.revision,
          baseContentHash: staleCheckpoint.contentHash,
          updatedAt: now().toISOString(),
        });
        if (
          generation !== generationRef.current ||
          owner !== activeOwnerTokenRef.current ||
          localEditSequence !== editSequenceRef.current ||
          localContent !== valueRef.current
        ) {
          return;
        }

        let currentDisk: NoteResponse;
        if (choice === "keep-local") {
          const response = await fetchImpl(`/api/notes/${encodeURIComponent(noteId)}`);
          if (!response.ok) throw new Error("Could not read the current Markdown version");
          currentDisk = parseNoteResponse(await response.json(), noteId);
        } else {
          // Deliberately submit with the stale checkpoint. A divergent server
          // writes a durable conflict copy of the browser draft before the UI
          // switches to its current Markdown version.
          const response = await fetchImpl(`/api/notes/${encodeURIComponent(noteId)}`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              content: localContent,
              base_revision: staleCheckpoint.revision,
              base_content_hash: staleCheckpoint.contentHash,
            }),
          });
          const payload = (await response.json()) as unknown;
          if (response.status === 409) {
            currentDisk = parseConflictResponse(payload, noteId).current;
          } else {
            if (!response.ok) throw new Error("Could not preserve the browser draft");
            currentDisk = parseNoteResponse(payload, noteId);
          }
        }

        if (
          generation !== generationRef.current ||
          owner !== activeOwnerTokenRef.current ||
          localEditSequence !== editSequenceRef.current ||
          localContent !== valueRef.current
        ) {
          return;
        }

        const adoptedContent = choice === "keep-local" ? localContent : currentDisk.content;
        const adoptedCheckpoint = checkpointFromDisk(currentDisk);
        const adoptedEditSequence = choice === "use-disk"
          ? localEditSequence + 1
          : localEditSequence;
        checkpointRef.current = adoptedCheckpoint;
        blockedByConflictRef.current = false;
        if (choice === "use-disk") {
          editSequenceRef.current = adoptedEditSequence;
          valueRef.current = adoptedContent;
          setValue(adoptedContent);
        }
        setBaseRevision(adoptedCheckpoint.revision);
        setBaseContentHash(adoptedCheckpoint.contentHash);
        setLogicalPath(currentDisk.logical_path);
        await enqueueLocalWrite({
          noteId,
          content: adoptedContent,
          baseRevision: adoptedCheckpoint.revision,
          baseContentHash: adoptedCheckpoint.contentHash,
          updatedAt: now().toISOString(),
          editSequence: adoptedEditSequence,
        });
        if (
          generation !== generationRef.current ||
          owner !== activeOwnerTokenRef.current ||
          (choice === "keep-local" &&
            (localEditSequence !== editSequenceRef.current || localContent !== valueRef.current))
        ) {
          return;
        }
        setStatus(
          choice === "use-disk" || adoptedContent === currentDisk.content
            ? "saved-disk"
            : "saved-locally",
        );
      } catch (reason) {
        if (generation !== generationRef.current || owner !== activeOwnerTokenRef.current) return;
        blockedByConflictRef.current = true;
        setStatus("conflict");
        setError(errorMessage(reason, "The note conflict could not be resolved"));
      }
    })();
  }, [enqueueLocalWrite, fetchImpl, noteId, now]);

  const recoverDiskFile = useCallback(() => {
    if (!diskRecoveryAvailable || activeOwnerTokenRef.current === null) return;
    const generation = generationRef.current;
    const owner = activeOwnerTokenRef.current;
    setStatus("loading");
    setError(null);
    void fetchImpl(`/api/notes/${encodeURIComponent(noteId)}/recover`, {
      method: "POST",
    })
      .then(async (response) => {
        const payload = (await response.json()) as unknown;
        if (!response.ok) {
          const detail = isRecord(payload) && typeof payload.error === "string"
            ? payload.error
            : "The Markdown recovery snapshot could not be restored";
          throw new Error(detail);
        }
        parseNoteResponse(payload, noteId);
      })
      .then(() => {
        if (generation !== generationRef.current || owner !== activeOwnerTokenRef.current) return;
        setDiskRecoveryAvailable(false);
        loadedRef.current = false;
        canEditRef.current = false;
        setCoordinationStatus("reconciling");
        setReloadSequence((current) => current + 1);
      })
      .catch((reason: unknown) => {
        if (generation !== generationRef.current || owner !== activeOwnerTokenRef.current) return;
        setStatus("error");
        setError(errorMessage(reason, "The Markdown recovery snapshot could not be restored"));
      });
  }, [diskRecoveryAvailable, fetchImpl, noteId]);

  const retryCoordination = useCallback(() => {
    setCoordinationRetrySequence((current) => current + 1);
  }, []);

  useEffect(() => {
    const retryWhenOnline = () => {
      if (
        canEditRef.current &&
        (status === "offline" || status === "error")
      ) {
        retryDiskSave();
      }
    };
    window.addEventListener("online", retryWhenOnline);
    return () => window.removeEventListener("online", retryWhenOnline);
  }, [retryDiskSave, status]);

  return {
    value,
    updateValue,
    status,
    error,
    baseRevision,
    baseContentHash,
    logicalPath,
    diskRecoveryAvailable,
    canEdit: coordinationStatus === "editing" && loadedRef.current,
    coordinationStatus,
    coordinationError,
    retryDiskSave,
    resolveConflict,
    recoverDiskFile,
    retryCoordination,
  };
}
