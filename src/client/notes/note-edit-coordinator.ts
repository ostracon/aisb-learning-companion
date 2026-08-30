const CHANNEL_NAME = "aisb-learning-companion:note-edit:v1";
const LOCK_PREFIX = "aisb-learning-companion:note-edit:v1:";

export type NoteEditCoordinationErrorCode =
  | "locks_unsupported"
  | "lock_request_failed"
  | "lock_not_granted"
  | "acquired_callback_failed";

export class NoteEditCoordinationError extends Error {
  constructor(
    readonly code: NoteEditCoordinationErrorCode,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "NoteEditCoordinationError";
  }
}

export interface NoteEditLock {
  readonly name: string;
  readonly mode: "exclusive" | "shared";
}

export interface NoteEditLockManager {
  request<T>(
    name: string,
    options: Readonly<{ mode: "exclusive"; signal: AbortSignal }>,
    callback: (lock: NoteEditLock | null) => T | PromiseLike<T>,
  ): Promise<T>;
}

export interface NoteEditBroadcastChannel {
  onmessage: ((event: Readonly<{ data: unknown }>) => void) | null;
  postMessage(message: unknown): void;
  close(): void;
}

export interface NoteEditCoordinatorDependencies {
  /** `null` deliberately selects the fail-closed unsupported state. */
  readonly lockManager?: NoteEditLockManager | null;
  /** `null` disables advisory updates without weakening exclusive ownership. */
  readonly createBroadcastChannel?:
    | ((name: string) => NoteEditBroadcastChannel)
    | null;
  readonly createSessionId?: () => string;
}

export interface StartNoteEditCoordinationOptions {
  readonly noteId: string;
  /** Called exactly once if this session receives the exclusive note lock. */
  readonly onAcquired: () => void;
  /** Advisory only: the owner committed a newer recovery draft to IndexedDB. */
  readonly onDraftChanged?: () => void;
  /** Advisory only: an owner gracefully released this note. */
  readonly onReleased?: () => void;
  /** Authority failures are fail-closed and never followed by `onAcquired`. */
  readonly onError: (error: NoteEditCoordinationError) => void;
}

export interface NoteEditCoordinationHandle {
  /**
   * Announces an already-committed IndexedDB change. This never transfers
   * content and returns false when this session is not the owner or advisory
   * messaging is unavailable.
   */
  announceDraftChanged(): boolean;
  /**
   * Aborts a queued request or gracefully releases an acquired lock. Closing
   * is idempotent and resolves after the browser lock request has settled.
   */
  close(): Promise<void>;
}

export interface NoteEditCoordinator {
  startNoteEditCoordination(
    options: StartNoteEditCoordinationOptions,
  ): NoteEditCoordinationHandle;
}

type AdvisoryMessage =
  | Readonly<{
      version: 1;
      type: "draft-committed";
      noteId: string;
      senderId: string;
    }>
  | Readonly<{
      version: 1;
      type: "lease-released";
      noteId: string;
      senderId: string;
    }>;

function validateIdentifier(value: string, label: string): string {
  if (
    value.length < 1 ||
    value.length > 180 ||
    !/^[A-Za-z0-9._-]+$/.test(value)
  ) {
    throw new TypeError(`${label} must be a path-safe identifier`);
  }
  return value;
}

function parseAdvisoryMessage(value: unknown): AdvisoryMessage | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    (record.type !== "draft-committed" && record.type !== "lease-released") ||
    typeof record.noteId !== "string" ||
    typeof record.senderId !== "string"
  ) {
    return null;
  }
  try {
    return Object.freeze({
      version: 1,
      type: record.type,
      noteId: validateIdentifier(record.noteId, "noteId"),
      senderId: validateIdentifier(record.senderId, "senderId"),
    });
  } catch {
    return null;
  }
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { readonly name?: unknown }).name === "AbortError"
  );
}

function browserLockManager(): NoteEditLockManager | null {
  if (typeof navigator === "undefined" || !("locks" in navigator) || !navigator.locks) {
    return null;
  }
  return navigator.locks as unknown as NoteEditLockManager;
}

function browserBroadcastChannel(name: string): NoteEditBroadcastChannel {
  return new BroadcastChannel(name) as unknown as NoteEditBroadcastChannel;
}

function browserChannelFactory(): ((name: string) => NoteEditBroadcastChannel) | null {
  return typeof BroadcastChannel === "undefined" ? null : browserBroadcastChannel;
}

function browserSessionId(): string {
  return `tab-${crypto.randomUUID()}`;
}

function hasOwn<Key extends PropertyKey>(value: object, key: Key): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * Creates a same-origin note coordinator.
 *
 * Web Locks are the sole ownership authority. BroadcastChannel messages are
 * deliberately advisory: receivers must re-read IndexedDB and ownership never
 * changes because of a message.
 */
export function createNoteEditCoordinator(
  dependencies: NoteEditCoordinatorDependencies = {},
): NoteEditCoordinator {
  const lockManager = hasOwn(dependencies, "lockManager")
    ? dependencies.lockManager ?? null
    : browserLockManager();
  const createChannel = hasOwn(dependencies, "createBroadcastChannel")
    ? dependencies.createBroadcastChannel ?? null
    : browserChannelFactory();
  const createSessionId = dependencies.createSessionId ?? browserSessionId;

  return Object.freeze({
    startNoteEditCoordination(
      options: StartNoteEditCoordinationOptions,
    ): NoteEditCoordinationHandle {
      const noteId = validateIdentifier(options.noteId, "noteId");
      const senderId = validateIdentifier(createSessionId(), "senderId");
      const abortController = new AbortController();
      let channel: NoteEditBroadcastChannel | null = null;
      let owner = false;
      let closed = false;
      let releaseOwner: (() => void) | null = null;
      let closePromise: Promise<void> | null = null;

      const reportError = (error: NoteEditCoordinationError): void => {
        if (closed) return;
        try {
          options.onError(error);
        } catch {
          // A consumer callback cannot turn a coordination failure into an
          // unhandled rejection or accidentally grant edit ownership.
        }
      };

      if (createChannel !== null) {
        try {
          channel = createChannel(CHANNEL_NAME);
          channel.onmessage = (event) => {
            if (closed) return;
            const message = parseAdvisoryMessage(event.data);
            if (
              message === null ||
              message.noteId !== noteId ||
              message.senderId === senderId
            ) {
              return;
            }
            try {
              if (message.type === "draft-committed") {
                options.onDraftChanged?.();
              } else {
                options.onReleased?.();
              }
            } catch {
              // Advisory callbacks do not affect lock ownership.
            }
          };
        } catch {
          // Advisory messaging may be unavailable (for example, a restricted
          // browser context). The exclusive Web Lock remains sufficient.
          channel = null;
        }
      }

      const postAdvisory = (type: AdvisoryMessage["type"]): boolean => {
        if (channel === null || closed) return false;
        try {
          channel.postMessage(Object.freeze({
            version: 1,
            type,
            noteId,
            senderId,
          } satisfies AdvisoryMessage));
          return true;
        } catch {
          return false;
        }
      };

      let requestPromise: Promise<void>;
      if (lockManager === null) {
        requestPromise = Promise.resolve().then(() => {
          reportError(new NoteEditCoordinationError(
            "locks_unsupported",
            "This browser cannot safely coordinate note editing across tabs.",
          ));
        });
      } else {
        requestPromise = Promise.resolve()
          .then(() => lockManager.request(
            `${LOCK_PREFIX}${noteId}`,
            { mode: "exclusive", signal: abortController.signal },
            async (lock) => {
              if (closed) return;
              if (lock === null) {
                reportError(new NoteEditCoordinationError(
                  "lock_not_granted",
                  "The browser did not grant exclusive note-edit ownership.",
                ));
                return;
              }

              owner = true;
              const released = new Promise<void>((resolve) => {
                releaseOwner = resolve;
              });
              try {
                options.onAcquired();
              } catch (cause) {
                reportError(new NoteEditCoordinationError(
                  "acquired_callback_failed",
                  "The note editor could not initialize after ownership was granted.",
                  { cause },
                ));
                releaseOwner?.();
              }
              await released;
              owner = false;
              releaseOwner = null;
            },
          ))
          .catch((cause: unknown) => {
            if (closed && isAbortError(cause)) return;
            reportError(new NoteEditCoordinationError(
              "lock_request_failed",
              "The browser could not establish exclusive note-edit ownership.",
              { cause },
            ));
          });
      }

      const close = (): Promise<void> => {
        closePromise ??= (async () => {
          if (!closed) {
            if (owner) postAdvisory("lease-released");
            closed = true;
            abortController.abort();
            releaseOwner?.();
            channel?.close();
            channel = null;
          }
          await requestPromise;
        })();
        return closePromise;
      };

      return Object.freeze({
        announceDraftChanged(): boolean {
          return owner && postAdvisory("draft-committed");
        },
        close,
      });
    },
  });
}

let defaultCoordinator: NoteEditCoordinator | null = null;

/** Browser-default convenience entrypoint; tests should inject a factory. */
export function startNoteEditCoordination(
  options: StartNoteEditCoordinationOptions,
): NoteEditCoordinationHandle {
  defaultCoordinator ??= createNoteEditCoordinator();
  return defaultCoordinator.startNoteEditCoordination(options);
}
