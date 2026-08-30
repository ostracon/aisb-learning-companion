import { describe, expect, it, vi } from "vitest";

import {
  createNoteEditCoordinator,
  type NoteEditBroadcastChannel,
  type NoteEditCoordinationError,
  type NoteEditLock,
  type NoteEditLockManager,
} from "./note-edit-coordinator.js";

interface PendingLockRequest {
  readonly signal: AbortSignal;
  readonly start: () => void;
  readonly abort: () => void;
}

class FakeLockManager implements NoteEditLockManager {
  readonly #active = new Set<string>();
  readonly #queues = new Map<string, PendingLockRequest[]>();

  request<T>(
    name: string,
    options: Readonly<{ mode: "exclusive"; signal: AbortSignal }>,
    callback: (lock: NoteEditLock | null) => T | PromiseLike<T>,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let started = false;
      const onAbort = () => {
        if (started) return;
        const queue = this.#queues.get(name);
        const index = queue?.indexOf(request) ?? -1;
        if (queue && index >= 0) queue.splice(index, 1);
        reject(new DOMException("The lock request was aborted", "AbortError"));
      };
      const request: PendingLockRequest = {
        signal: options.signal,
        start: () => {
          started = true;
          options.signal.removeEventListener("abort", onAbort);
          this.#active.add(name);
          const lock = Object.freeze({ name, mode: "exclusive" as const });
          void Promise.resolve(callback(lock))
            .then(resolve, reject)
            .finally(() => {
              this.#active.delete(name);
              this.#pump(name);
            });
        },
        abort: onAbort,
      };

      if (options.signal.aborted) {
        request.abort();
        return;
      }
      options.signal.addEventListener("abort", onAbort, { once: true });
      const queue = this.#queues.get(name) ?? [];
      queue.push(request);
      this.#queues.set(name, queue);
      this.#pump(name);
    });
  }

  #pump(name: string): void {
    if (this.#active.has(name)) return;
    const queue = this.#queues.get(name);
    const next = queue?.shift();
    if (!next) {
      this.#queues.delete(name);
      return;
    }
    next.start();
  }
}

class FakeBroadcastHub {
  readonly #channels = new Set<FakeBroadcastChannel>();

  readonly create = (_name: string): NoteEditBroadcastChannel => {
    const channel = new FakeBroadcastChannel(this);
    this.#channels.add(channel);
    return channel;
  };

  publish(sender: FakeBroadcastChannel, message: unknown): void {
    for (const channel of this.#channels) {
      if (channel !== sender && !channel.closed) {
        queueMicrotask(() => channel.onmessage?.({ data: message }));
      }
    }
  }

  remove(channel: FakeBroadcastChannel): void {
    this.#channels.delete(channel);
  }
}

class FakeBroadcastChannel implements NoteEditBroadcastChannel {
  onmessage: ((event: Readonly<{ data: unknown }>) => void) | null = null;
  closed = false;

  constructor(private readonly hub: FakeBroadcastHub) {}

  postMessage(message: unknown): void {
    if (this.closed) throw new Error("channel is closed");
    this.hub.publish(this, message);
  }

  close(): void {
    this.closed = true;
    this.hub.remove(this);
  }
}

function ids(...values: string[]): () => string {
  let index = 0;
  return () => values[index++] ?? `session-${index}`;
}

describe("note edit coordinator", () => {
  it("fails closed when Web Locks are unavailable", async () => {
    const acquired = vi.fn();
    const errors: NoteEditCoordinationError[] = [];
    const coordinator = createNoteEditCoordinator({
      lockManager: null,
      createBroadcastChannel: null,
      createSessionId: ids("unsupported-tab"),
    });

    const handle = coordinator.startNoteEditCoordination({
      noteId: "day-day1",
      onAcquired: acquired,
      onError: (error) => errors.push(error),
    });

    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]?.code).toBe("locks_unsupported");
    expect(acquired).not.toHaveBeenCalled();
    expect(handle.announceDraftChanged()).toBe(false);
    await handle.close();
  });

  it("grants one same-note writer, sends advisory changes, then hands off", async () => {
    const locks = new FakeLockManager();
    const broadcasts = new FakeBroadcastHub();
    const coordinator = createNoteEditCoordinator({
      lockManager: locks,
      createBroadcastChannel: broadcasts.create,
      createSessionId: ids("tab-a", "tab-b"),
    });
    const acquiredA = vi.fn();
    const acquiredB = vi.fn();
    const changedB = vi.fn();
    const releasedB = vi.fn();

    const first = coordinator.startNoteEditCoordination({
      noteId: "lesson-1.1",
      onAcquired: acquiredA,
      onError: vi.fn(),
    });
    const second = coordinator.startNoteEditCoordination({
      noteId: "lesson-1.1",
      onAcquired: acquiredB,
      onDraftChanged: changedB,
      onReleased: releasedB,
      onError: vi.fn(),
    });

    await vi.waitFor(() => expect(acquiredA).toHaveBeenCalledTimes(1));
    expect(acquiredB).not.toHaveBeenCalled();
    expect(first.announceDraftChanged()).toBe(true);
    expect(second.announceDraftChanged()).toBe(false);
    await vi.waitFor(() => expect(changedB).toHaveBeenCalledTimes(1));

    await first.close();
    await vi.waitFor(() => expect(releasedB).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(acquiredB).toHaveBeenCalledTimes(1));
    expect(second.announceDraftChanged()).toBe(true);
    await second.close();
  });

  it("aborts a closed waiting request without a later ghost acquisition", async () => {
    const locks = new FakeLockManager();
    const coordinator = createNoteEditCoordinator({
      lockManager: locks,
      createBroadcastChannel: null,
      createSessionId: ids("owner", "waiting"),
    });
    const waitingAcquired = vi.fn();
    const waitingError = vi.fn();
    const owner = coordinator.startNoteEditCoordination({
      noteId: "event-aisb-2026-055",
      onAcquired: vi.fn(),
      onError: vi.fn(),
    });
    const waiting = coordinator.startNoteEditCoordination({
      noteId: "event-aisb-2026-055",
      onAcquired: waitingAcquired,
      onError: waitingError,
    });

    await waiting.close();
    await owner.close();
    await Promise.resolve();

    expect(waitingAcquired).not.toHaveBeenCalled();
    expect(waitingError).not.toHaveBeenCalled();
  });

  it("allows different notes to be owned independently", async () => {
    const locks = new FakeLockManager();
    const broadcasts = new FakeBroadcastHub();
    const coordinator = createNoteEditCoordinator({
      lockManager: locks,
      createBroadcastChannel: broadcasts.create,
      createSessionId: ids("day-owner", "lesson-owner"),
    });
    const acquiredDay = vi.fn();
    const acquiredLesson = vi.fn();
    const dayChanged = vi.fn();
    const lessonChanged = vi.fn();
    const day = coordinator.startNoteEditCoordination({
      noteId: "day-day1",
      onAcquired: acquiredDay,
      onDraftChanged: dayChanged,
      onError: vi.fn(),
    });
    const lesson = coordinator.startNoteEditCoordination({
      noteId: "lesson-1.1",
      onAcquired: acquiredLesson,
      onDraftChanged: lessonChanged,
      onError: vi.fn(),
    });

    await vi.waitFor(() => expect(acquiredDay).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(acquiredLesson).toHaveBeenCalledTimes(1));
    expect(day.announceDraftChanged()).toBe(true);
    await Promise.resolve();
    expect(dayChanged).not.toHaveBeenCalled();
    expect(lessonChanged).not.toHaveBeenCalled();
    await Promise.all([day.close(), lesson.close()]);
  });

  it("keeps exclusive ownership when advisory messaging is unavailable", async () => {
    const coordinator = createNoteEditCoordinator({
      lockManager: new FakeLockManager(),
      createBroadcastChannel: null,
      createSessionId: ids("no-channel"),
    });
    const acquired = vi.fn();
    const handle = coordinator.startNoteEditCoordination({
      noteId: "day-day2",
      onAcquired: acquired,
      onError: vi.fn(),
    });

    await vi.waitFor(() => expect(acquired).toHaveBeenCalledTimes(1));
    expect(handle.announceDraftChanged()).toBe(false);
    await handle.close();
  });
});
