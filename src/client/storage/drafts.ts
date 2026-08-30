export interface BrowserNoteDraft {
  noteId: string;
  content: string;
  baseRevision: number;
  /** Hash of the exact disk revision from which content was edited. */
  baseContentHash: string;
  updatedAt: string;
  /** Persistent per-note writer generation. Legacy records normalize to 0. */
  writerEpoch?: number;
  /** Monotonic accepted-edit sequence within one writer epoch. */
  editSequence?: number;
}

const databaseName = "aisb-learning-companion";
const storeName = "note-drafts";
const writerStoreName = "note-writer-state";
let databasePromise: Promise<IDBDatabase> | null = null;
const sha256Pattern = /^[a-f0-9]{64}$/;

export interface BrowserNoteWriterState {
  readonly noteId: string;
  readonly writerEpoch: number;
}

export interface BrowserDraftRecoverySnapshot {
  readonly noteDrafts: readonly Required<BrowserNoteDraft>[];
  readonly noteWriterStates: readonly BrowserNoteWriterState[];
}

export class StaleDraftWriterError extends Error {
  constructor(message = "A newer tab owns this note's recovery draft") {
    super(message);
    this.name = "StaleDraftWriterError";
  }
}

function nonNegativeSafeInteger(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("The local note draft writer fence is malformed");
  }
  return value;
}

function normalizeDraft(value: unknown): BrowserNoteDraft {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("The local note draft is malformed");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.noteId !== "string" || record.noteId.length === 0) {
    throw new Error("The local note draft has no note identity");
  }
  if (typeof record.content !== "string") {
    throw new Error("The local note draft content is malformed");
  }
  if (
    typeof record.baseRevision !== "number" ||
    !Number.isSafeInteger(record.baseRevision) ||
    record.baseRevision < 0
  ) {
    throw new Error("The local note draft revision is malformed");
  }
  const baseContentHash =
    typeof record.baseContentHash === "string" ? record.baseContentHash : "";
  if (baseContentHash !== "" && !sha256Pattern.test(baseContentHash)) {
    throw new Error("The local note draft base hash is malformed");
  }
  if (typeof record.updatedAt !== "string" || !Number.isFinite(Date.parse(record.updatedAt))) {
    throw new Error("The local note draft timestamp is malformed");
  }
  const writerEpoch = nonNegativeSafeInteger(record.writerEpoch, 0);
  const editSequence = nonNegativeSafeInteger(record.editSequence, 0);
  return {
    noteId: record.noteId,
    content: record.content,
    baseRevision: record.baseRevision,
    baseContentHash,
    updatedAt: record.updatedAt,
    writerEpoch,
    editSequence,
  };
}

function normalizeWriterState(value: unknown, noteId: string): BrowserNoteWriterState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("The local note writer state is malformed");
  }
  const record = value as Record<string, unknown>;
  if (record.noteId !== noteId) {
    throw new Error("The local note writer state has the wrong note identity");
  }
  return {
    noteId,
    writerEpoch: nonNegativeSafeInteger(record.writerEpoch, 0),
  };
}

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, 2);
    let settled = false;
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(storeName)) {
        database.createObjectStore(storeName, { keyPath: "noteId" });
      }
      if (!database.objectStoreNames.contains(writerStoreName)) {
        database.createObjectStore(writerStoreName, { keyPath: "noteId" });
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
        // A delete/upgrade from another tab invalidates this connection. Clear
        // the cached promise as well so the next operation opens a fresh one
        // instead of trying to transact on a closed IDBDatabase.
        if (databasePromise === opening) databasePromise = null;
      };
      if (settled) {
        database.close();
        return;
      }
      settled = true;
      resolve(database);
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      reject(request.error ?? new Error("Could not open local draft storage"));
    };
    request.onblocked = () => {
      if (settled) return;
      settled = true;
      reject(new Error(
        "Local draft storage is awaiting another tab; close older companion tabs and retry",
      ));
    };
  });
  databasePromise = opening;
  void opening.catch(() => {
    if (databasePromise === opening) databasePromise = null;
  });
  return opening;
}

export async function readDraft(noteId: string): Promise<BrowserNoteDraft | null> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, "readonly");
    const request = transaction.objectStore(storeName).get(noteId);
    request.onsuccess = () => {
      try {
        const result = request.result as unknown;
        resolve(result === undefined ? null : normalizeDraft(result));
      } catch (reason) {
        reject(reason);
      }
    };
    request.onerror = () => reject(request.error ?? new Error("Could not read the local draft"));
  });
}

export async function writeDraft(draft: BrowserNoteDraft): Promise<void> {
  const validated = normalizeDraft(draft);
  if (validated.baseRevision === 0 && validated.baseContentHash !== "") {
    throw new Error("A never-persisted draft cannot have a disk content hash");
  }
  // Legacy records may have a positive revision but no hash. Keep them locally
  // so no text is lost, but the hook will refuse disk autosave until it can
  // establish exact lineage from the server.
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(
      [storeName, writerStoreName],
      "readwrite",
    );
    const draftStore = transaction.objectStore(storeName);
    const writerStore = transaction.objectStore(writerStoreName);
    const currentDraftRequest = draftStore.get(validated.noteId);
    const writerStateRequest = writerStore.get(validated.noteId);
    let currentDraftReady = false;
    let writerStateReady = false;
    let currentDraft: BrowserNoteDraft | null = null;
    let activeWriterEpoch = 0;
    let abortReason: Error | null = null;

    const abortWith = (reason: unknown, fallback: string) => {
      abortReason = reason instanceof Error ? reason : new Error(fallback);
      try {
        transaction.abort();
      } catch {
        // The transaction may already be aborting because the request failed.
      }
    };

    const publishIfReady = () => {
      if (!currentDraftReady || !writerStateReady) return;
      const incomingEpoch = validated.writerEpoch ?? 0;
      const incomingSequence = validated.editSequence ?? 0;
      const currentEpoch = currentDraft?.writerEpoch ?? 0;
      const currentSequence = currentDraft?.editSequence ?? 0;
      if (
        incomingEpoch !== activeWriterEpoch ||
        incomingEpoch < currentEpoch ||
        (incomingEpoch === currentEpoch && incomingSequence < currentSequence) ||
        (currentDraft !== null &&
          incomingEpoch === currentEpoch &&
          incomingSequence === currentSequence &&
          validated.content !== currentDraft.content)
      ) {
        abortWith(new StaleDraftWriterError(), "The local draft writer is stale");
        return;
      }
      try {
        draftStore.put(validated);
      } catch (reason) {
        abortWith(reason, "Could not stage the local draft");
      }
    };

    currentDraftRequest.onsuccess = () => {
      try {
        const result = currentDraftRequest.result as unknown;
        currentDraft = result === undefined ? null : normalizeDraft(result);
        currentDraftReady = true;
        publishIfReady();
      } catch (reason) {
        abortWith(reason, "The existing local draft is malformed");
      }
    };
    writerStateRequest.onsuccess = () => {
      try {
        const result = writerStateRequest.result as unknown;
        activeWriterEpoch = result === undefined
          ? 0
          : normalizeWriterState(result, validated.noteId).writerEpoch;
        writerStateReady = true;
        publishIfReady();
      } catch (reason) {
        abortWith(reason, "The local note writer state is malformed");
      }
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Could not save the local draft"));
    transaction.onabort = () => reject(
      abortReason ?? transaction.error ?? new Error("Local draft save was aborted"),
    );
  });
}

/**
 * Claims the next persistent writer generation after the caller has acquired
 * the per-note Web Lock. Every later write must carry this exact epoch.
 */
export async function claimDraftWriterEpoch(
  noteId: string,
  signal?: AbortSignal,
): Promise<number> {
  if (!/^[A-Za-z0-9._-]{1,180}$/.test(noteId)) {
    throw new Error("The note identity is not safe for local writer state");
  }
  const abortedError = () => {
    const error = new Error("Local note ownership was released before it could be claimed");
    error.name = "AbortError";
    return error;
  };
  if (signal?.aborted) throw abortedError();
  const database = await openDatabase();
  // Opening or upgrading IndexedDB can wait behind another document. Never
  // begin a claim transaction after the Web Lock lifetime has ended.
  if (signal?.aborted) throw abortedError();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(writerStoreName, "readwrite");
    const store = transaction.objectStore(writerStoreName);
    let claimedEpoch = 0;
    let abortReason: Error | null = null;
    const removeAbortListener = () => signal?.removeEventListener("abort", abortFromSignal);
    const abortWith = (reason: unknown, fallback: string) => {
      abortReason = reason instanceof Error ? reason : new Error(fallback);
      try {
        transaction.abort();
      } catch {
        // The transaction may already be aborting because the request failed.
      }
    };
    const abortFromSignal = () => abortWith(
      abortedError(),
      "Local note ownership was released before it could be claimed",
    );
    signal?.addEventListener("abort", abortFromSignal, { once: true });
    if (signal?.aborted) {
      abortFromSignal();
      return;
    }

    const request = store.get(noteId);
    request.onsuccess = () => {
      try {
        if (signal?.aborted) {
          abortFromSignal();
          return;
        }
        const result = request.result as unknown;
        const priorEpoch = result === undefined
          ? 0
          : normalizeWriterState(result, noteId).writerEpoch;
        if (priorEpoch >= Number.MAX_SAFE_INTEGER) {
          abortWith(
            new Error("The local note ownership counter is exhausted"),
            "Local note ownership could not advance",
          );
          return;
        }
        claimedEpoch = priorEpoch + 1;
        store.put({ noteId, writerEpoch: claimedEpoch } satisfies BrowserNoteWriterState);
      } catch (reason) {
        abortWith(reason, "Local note ownership could not advance");
      }
    };
    transaction.oncomplete = () => {
      removeAbortListener();
      resolve(claimedEpoch);
    };
    transaction.onerror = () => {
      removeAbortListener();
      reject(transaction.error ?? new Error("Could not claim local note ownership"));
    };
    transaction.onabort = () => {
      removeAbortListener();
      reject(abortReason ?? transaction.error ?? new Error("Local note ownership could not advance"));
    };
  });
}

export async function deleteDraft(noteId: string): Promise<void> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).delete(noteId);
    // Keep the writer epoch high-water mark. Reusing an epoch after clearing a
    // draft would let a delayed write from the prior owner pass the fence.
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Could not clear the local draft"));
  });
}

/**
 * Reads every browser-only note recovery record for an explicit backup. The
 * transaction is read-only and all values pass through the same normalizers as
 * ordinary draft recovery before they leave IndexedDB.
 */
export async function readDraftRecoverySnapshotForBackup(): Promise<BrowserDraftRecoverySnapshot> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction([storeName, writerStoreName], "readonly");
    const draftsRequest = transaction.objectStore(storeName).getAll();
    const writersRequest = transaction.objectStore(writerStoreName).getAll();
    let result: BrowserDraftRecoverySnapshot | null = null;
    let abortReason: Error | null = null;

    transaction.oncomplete = () => {
      if (result === null) {
        reject(new Error("Local draft backup completed without a verified snapshot"));
        return;
      }
      resolve(result);
    };
    transaction.onerror = () => reject(
      transaction.error ?? new Error("Could not read local drafts for backup"),
    );
    transaction.onabort = () => reject(
      abortReason ?? transaction.error ?? new Error("Reading local drafts for backup was aborted"),
    );

    const prepare = () => {
      if (draftsRequest.readyState !== "done" || writersRequest.readyState !== "done") return;
      try {
        const noteDrafts = (draftsRequest.result as readonly unknown[])
          .map((value) => {
            const draft = normalizeDraft(value);
            return {
              ...draft,
              writerEpoch: draft.writerEpoch ?? 0,
              editSequence: draft.editSequence ?? 0,
            };
          })
          .sort((left, right) => left.noteId.localeCompare(right.noteId));
        const noteWriterStates = (writersRequest.result as readonly unknown[])
          .map((value) => {
            if (typeof value !== "object" || value === null || Array.isArray(value)) {
              throw new Error("The local note writer state is malformed");
            }
            const noteId = (value as Record<string, unknown>).noteId;
            if (typeof noteId !== "string" || noteId.length === 0) {
              throw new Error("The local note writer state has no note identity");
            }
            return normalizeWriterState(value, noteId);
          })
          .sort((left, right) => left.noteId.localeCompare(right.noteId));
        result = { noteDrafts, noteWriterStates };
      } catch (reason) {
        abortReason = reason instanceof Error
          ? reason
          : new Error("The local draft backup state is malformed");
        try {
          transaction.abort();
        } catch {
          reject(abortReason);
        }
      }
    };

    draftsRequest.onsuccess = prepare;
    writersRequest.onsuccess = prepare;
    draftsRequest.onerror = () => reject(
      draftsRequest.error ?? new Error("Could not read local note drafts for backup"),
    );
    writersRequest.onerror = () => reject(
      writersRequest.error ?? new Error("Could not read local note writer state for backup"),
    );
  });
}

export async function resetDraftDatabaseForTests(): Promise<void> {
  const previous = databasePromise;
  databasePromise = null;
  if (previous) {
    try {
      (await previous).close();
    } catch {
      // A failed open has no connection to close.
    }
  }
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(databaseName);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("Could not reset draft storage"));
    request.onblocked = () => reject(new Error("Draft storage reset was blocked by an open tab"));
  });
}
