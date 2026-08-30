import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, readdir, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { z } from "zod";

export const EVENT_CURRICULUM_BINDINGS_LOGICAL_PATH = "curriculum/event-bindings.json";
export const EVENT_CURRICULUM_BINDINGS_RECOVERY_LOGICAL_ROOT =
  "curriculum/recovery/event-bindings";

const EVENT_BINDING_ID_PATTERN = /^aisb-\d{4}-\d{3}$/;
const SECTION_ID_PATTERN = /^(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})$/;
const REVISION_PATTERN = /^event-curriculum-bindings:r[1-9]\d*:[a-f0-9]{16}$/;
const TEMPORARY_ID_PATTERN = /^[A-Za-z0-9._-]{1,120}$/;
const RECOVERY_FILENAME_PATTERN = /^(\d{12})-([a-f0-9]{16})\.json$/;

const eventBindingIdSchema = z.string().regex(EVENT_BINDING_ID_PATTERN);
const sectionIdSchema = z.string().regex(SECTION_ID_PATTERN);

const bindingFileRecordSchema = z
  .object({
    event_binding_id: eventBindingIdSchema,
    section_ids: z.array(sectionIdSchema).min(1).max(64),
  })
  .strict()
  .superRefine((binding, context) => {
    if (new Set(binding.section_ids).size !== binding.section_ids.length) {
      context.addIssue({
        code: "custom",
        path: ["section_ids"],
        message: "section_ids must be unique while preserving their declared order",
      });
    }
  });

const bindingFileSchema = z
  .object({
    schema_version: z.literal(1),
    revision: z.number().int().positive(),
    bindings: z.array(bindingFileRecordSchema).max(10_000),
  })
  .strict()
  .superRefine((file, context) => {
    for (let index = 1; index < file.bindings.length; index += 1) {
      const previous = file.bindings[index - 1]!.event_binding_id;
      const current = file.bindings[index]!.event_binding_id;
      if (previous.localeCompare(current) >= 0) {
        context.addIssue({
          code: "custom",
          path: ["bindings", index, "event_binding_id"],
          message: "bindings must have unique event IDs in ascending order",
        });
      }
    }
  });

type BindingFile = z.infer<typeof bindingFileSchema>;

export interface EventCurriculumBinding {
  readonly eventBindingId: string;
  /** Explicitly authored order; it is never sorted or model-derived. */
  readonly sectionIds: readonly string[];
  readonly source: "explicit";
}

export interface EventCurriculumBindingSnapshot {
  readonly schemaVersion: 1;
  readonly revision: string;
  readonly bindings: readonly EventCurriculumBinding[];
}

export type EventCurriculumBindingResolution =
  | {
      readonly status: "mapped";
      readonly source: "explicit";
      readonly eventBindingId: string;
      readonly sectionIds: readonly string[];
      readonly revision: string;
    }
  | {
      readonly status: "unmapped";
      readonly eventBindingId: string;
      readonly sectionIds: readonly [];
      readonly revision: string;
    };

export type EventCurriculumBindingMutation =
  | {
      readonly kind: "add";
      readonly eventBindingId: string;
      readonly sectionId: string;
    }
  | {
      readonly kind: "replace";
      readonly eventBindingId: string;
      readonly sectionIds: readonly string[];
    }
  | {
      readonly kind: "clear";
      readonly eventBindingId: string;
    };

export type EventCurriculumBindingAtomicStep =
  | "temporary_file_synced"
  | "before_publish"
  | "published"
  | "directory_synced"
  | "recovery_snapshot_synced";

export interface EventCurriculumBindingStoreDependencies {
  /** Deterministic seam for temporary names in tests. */
  readonly createId?: () => string;
  /** Fault-injection/observation seam; production leaves it undefined. */
  readonly onAtomicStep?: (
    step: EventCurriculumBindingAtomicStep,
    details: Readonly<{ logicalPath: string }>,
  ) => void | Promise<void>;
}

export type RecoverEventCurriculumBindingsResult =
  | {
      readonly status: "recovered";
      readonly snapshot: EventCurriculumBindingSnapshot;
      readonly recoveryLogicalPath: string;
    }
  | {
      readonly status: "not_needed";
      readonly snapshot: EventCurriculumBindingSnapshot;
      readonly recoveryLogicalPath: string;
    };

export class EventCurriculumBindingStoreError extends Error {
  constructor(
    readonly code:
      | "conflict"
      | "invalid_request"
      | "invalid_state"
      | "recovery_unavailable"
      | "unsafe_path",
    message: string,
    readonly currentRevision?: string,
  ) {
    super(message);
    this.name = "EventCurriculumBindingStoreError";
  }
}

interface StorePaths {
  readonly stateRoot: string;
  readonly statePath: string;
  readonly recoveryRoot: string;
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function serializeFile(file: BindingFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

function revisionFor(file: BindingFile): string {
  const bindingHash = sha256(JSON.stringify(file.bindings)).slice(0, 16);
  return `event-curriculum-bindings:r${file.revision}:${bindingHash}`;
}

function parseEventBindingId(value: unknown): string {
  const result = eventBindingIdSchema.safeParse(value);
  if (!result.success) {
    throw new EventCurriculumBindingStoreError(
      "invalid_request",
      "eventBindingId must match aisb-YYYY-NNN",
    );
  }
  return result.data;
}

function parseSectionId(value: unknown): string {
  const result = sectionIdSchema.safeParse(value);
  if (!result.success) {
    throw new EventCurriculumBindingStoreError(
      "invalid_request",
      "sectionId must be an unpadded numeric identifier such as 2.1",
    );
  }
  return result.data;
}

function parseSectionIds(value: unknown): string[] {
  const result = z.array(sectionIdSchema).min(1).max(64).safeParse(value);
  if (!result.success) {
    throw new EventCurriculumBindingStoreError(
      "invalid_request",
      "sectionIds must contain between 1 and 64 valid section identifiers",
    );
  }
  if (new Set(result.data).size !== result.data.length) {
    throw new EventCurriculumBindingStoreError(
      "invalid_request",
      "sectionIds must be unique while preserving their declared order",
    );
  }
  return result.data;
}

function parseExpectedRevision(value: unknown): string {
  if (typeof value !== "string" || !REVISION_PATTERN.test(value)) {
    throw new EventCurriculumBindingStoreError(
      "invalid_request",
      "expectedRevision does not match the binding-store revision contract",
    );
  }
  return value;
}

function parseState(raw: string, logicalPath: string): BindingFile {
  try {
    return bindingFileSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw new EventCurriculumBindingStoreError(
      "invalid_state",
      `${logicalPath} is not a valid event-to-curriculum binding file: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function freezeSnapshot(file: BindingFile): EventCurriculumBindingSnapshot {
  const bindings = file.bindings.map((binding) =>
    Object.freeze({
      eventBindingId: binding.event_binding_id,
      sectionIds: Object.freeze([...binding.section_ids]),
      source: "explicit" as const,
    }),
  );
  return Object.freeze({
    schemaVersion: 1 as const,
    revision: revisionFor(file),
    bindings: Object.freeze(bindings),
  });
}

/**
 * Durable, explicit event-to-curriculum bindings.
 *
 * This store validates identifier syntax and persistence integrity. It does not
 * infer mappings or silently validate them against a mutable curriculum scan;
 * integration code can surface stale/missing schedule or section references
 * without losing the participant's explicit binding.
 */
export class EventCurriculumBindingStore {
  readonly #configuredStateRoot: string;
  readonly #createId: () => string;
  readonly #onAtomicStep: EventCurriculumBindingStoreDependencies["onAtomicStep"];
  #pathsPromise: Promise<StorePaths> | undefined;
  #mutationTail: Promise<void> = Promise.resolve();

  constructor(stateRoot: string, dependencies: EventCurriculumBindingStoreDependencies = {}) {
    if (!isAbsolute(stateRoot)) {
      throw new EventCurriculumBindingStoreError(
        "invalid_request",
        "stateRoot must be an absolute path",
      );
    }
    this.#configuredStateRoot = resolve(stateRoot);
    this.#createId = dependencies.createId ?? randomUUID;
    this.#onAtomicStep = dependencies.onAtomicStep;
  }

  async read(): Promise<EventCurriculumBindingSnapshot> {
    return freezeSnapshot(await this.#readOrInitialize());
  }

  async resolve(eventBindingId: string): Promise<EventCurriculumBindingResolution> {
    const parsedEventBindingId = parseEventBindingId(eventBindingId);
    const snapshot = await this.read();
    const binding = snapshot.bindings.find(
      (candidate) => candidate.eventBindingId === parsedEventBindingId,
    );
    if (!binding) {
      return Object.freeze({
        status: "unmapped" as const,
        eventBindingId: parsedEventBindingId,
        sectionIds: Object.freeze([]) as readonly [],
        revision: snapshot.revision,
      });
    }
    return Object.freeze({
      status: "mapped" as const,
      source: "explicit" as const,
      eventBindingId: parsedEventBindingId,
      sectionIds: Object.freeze([...binding.sectionIds]),
      revision: snapshot.revision,
    });
  }

  async add(
    expectedRevision: string,
    eventBindingId: string,
    sectionId: string,
  ): Promise<EventCurriculumBindingSnapshot> {
    return this.mutate(expectedRevision, { kind: "add", eventBindingId, sectionId });
  }

  async replace(
    expectedRevision: string,
    eventBindingId: string,
    sectionIds: readonly string[],
  ): Promise<EventCurriculumBindingSnapshot> {
    return this.mutate(expectedRevision, { kind: "replace", eventBindingId, sectionIds });
  }

  async clear(
    expectedRevision: string,
    eventBindingId: string,
  ): Promise<EventCurriculumBindingSnapshot> {
    return this.mutate(expectedRevision, { kind: "clear", eventBindingId });
  }

  async mutate(
    expectedRevision: string,
    mutation: EventCurriculumBindingMutation,
  ): Promise<EventCurriculumBindingSnapshot> {
    const parsedRevision = parseExpectedRevision(expectedRevision);
    const parsedEventBindingId = parseEventBindingId(mutation.eventBindingId);
    const parsedMutation: EventCurriculumBindingMutation =
      mutation.kind === "add"
        ? {
            kind: "add",
            eventBindingId: parsedEventBindingId,
            sectionId: parseSectionId(mutation.sectionId),
          }
        : mutation.kind === "replace"
          ? {
              kind: "replace",
              eventBindingId: parsedEventBindingId,
              sectionIds: parseSectionIds(mutation.sectionIds),
            }
          : { kind: "clear", eventBindingId: parsedEventBindingId };

    return this.#serializeMutation(async () => {
      const current = await this.#readOrInitialize();
      const currentRevision = revisionFor(current);
      if (parsedRevision !== currentRevision) {
        throw new EventCurriculumBindingStoreError(
          "conflict",
          "Event curriculum bindings changed after they were read; refresh before retrying",
          currentRevision,
        );
      }

      const bindings = new Map(
        current.bindings.map((binding) => [binding.event_binding_id, [...binding.section_ids]]),
      );
      const existing = bindings.get(parsedEventBindingId);

      if (parsedMutation.kind === "add") {
        if (existing?.includes(parsedMutation.sectionId)) {
          throw new EventCurriculumBindingStoreError(
            "invalid_request",
            `${parsedMutation.sectionId} is already bound to ${parsedEventBindingId}`,
          );
        }
        bindings.set(parsedEventBindingId, [...(existing ?? []), parsedMutation.sectionId]);
      } else if (parsedMutation.kind === "replace") {
        if (
          existing !== undefined &&
          existing.length === parsedMutation.sectionIds.length &&
          existing.every((sectionId, index) => sectionId === parsedMutation.sectionIds[index])
        ) {
          return freezeSnapshot(current);
        }
        bindings.set(parsedEventBindingId, [...parsedMutation.sectionIds]);
      } else {
        if (existing === undefined) return freezeSnapshot(current);
        bindings.delete(parsedEventBindingId);
      }

      const next = bindingFileSchema.parse({
        schema_version: 1,
        revision: current.revision + 1,
        bindings: [...bindings.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([eventBindingId, sectionIds]) => ({
            event_binding_id: eventBindingId,
            section_ids: sectionIds,
          })),
      });
      await this.#publish(next, "replace");
      return freezeSnapshot(next);
    });
  }

  async recover(): Promise<RecoverEventCurriculumBindingsResult> {
    return this.#serializeMutation(async () => {
      let current: BindingFile | undefined;
      try {
        current = await this.#readExisting();
      } catch (error) {
        if (
          !isErrno(error, "ENOENT") &&
          (!(error instanceof EventCurriculumBindingStoreError) || error.code !== "invalid_state")
        ) {
          throw error;
        }
      }

      if (current) {
        const recoveryLogicalPath = await this.#ensureRecoverySnapshot(current);
        return Object.freeze({
          status: "not_needed" as const,
          snapshot: freezeSnapshot(current),
          recoveryLogicalPath,
        });
      }

      const candidates = await this.#readRecoveryCandidates();
      const selected = candidates[0];
      if (!selected) {
        throw new EventCurriculumBindingStoreError(
          "recovery_unavailable",
          "No valid event curriculum binding recovery snapshot is available",
        );
      }
      const paths = await this.#paths();
      await this.#atomicWrite(
        paths.statePath,
        selected.raw,
        "replace",
        EVENT_CURRICULUM_BINDINGS_LOGICAL_PATH,
      );
      return Object.freeze({
        status: "recovered" as const,
        snapshot: freezeSnapshot(selected.file),
        recoveryLogicalPath: selected.logicalPath,
      });
    });
  }

  async #readOrInitialize(): Promise<BindingFile> {
    try {
      return await this.#readExisting();
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }

    const initial = bindingFileSchema.parse({ schema_version: 1, revision: 1, bindings: [] });
    const paths = await this.#paths();
    const created = await this.#atomicWrite(
      paths.statePath,
      serializeFile(initial),
      "exclusive",
      EVENT_CURRICULUM_BINDINGS_LOGICAL_PATH,
    );
    const accepted = created ? initial : await this.#readExisting();
    await this.#ensureRecoverySnapshot(accepted);
    return accepted;
  }

  async #readExisting(): Promise<BindingFile> {
    const paths = await this.#paths();
    await this.#assertSafeFile(paths.statePath);
    return parseState(
      await readFile(paths.statePath, "utf8"),
      EVENT_CURRICULUM_BINDINGS_LOGICAL_PATH,
    );
  }

  async #publish(file: BindingFile, mode: "replace"): Promise<void> {
    const paths = await this.#paths();
    await this.#atomicWrite(
      paths.statePath,
      serializeFile(file),
      mode,
      EVENT_CURRICULUM_BINDINGS_LOGICAL_PATH,
    );
    await this.#ensureRecoverySnapshot(file);
  }

  async #ensureRecoverySnapshot(file: BindingFile): Promise<string> {
    const raw = serializeFile(file);
    const filename = `${String(file.revision).padStart(12, "0")}-${sha256(raw).slice(0, 16)}.json`;
    const logicalPath = `${EVENT_CURRICULUM_BINDINGS_RECOVERY_LOGICAL_ROOT}/${filename}`;
    const paths = await this.#paths();
    const target = resolve(paths.recoveryRoot, filename);
    const created = await this.#atomicWrite(target, raw, "exclusive", logicalPath);
    if (!created) {
      await this.#assertSafeFile(target);
      if ((await readFile(target, "utf8")) !== raw) {
        throw new EventCurriculumBindingStoreError(
          "invalid_state",
          `Recovery snapshot collision at ${logicalPath}`,
        );
      }
    }
    await this.#step("recovery_snapshot_synced", logicalPath);
    return logicalPath;
  }

  async #readRecoveryCandidates(): Promise<
    readonly { readonly file: BindingFile; readonly raw: string; readonly logicalPath: string }[]
  > {
    const paths = await this.#paths();
    await this.#ensureSafeDirectory(paths.recoveryRoot, paths.stateRoot);
    const entries = await readdir(paths.recoveryRoot, { withFileTypes: true });
    const candidates: { file: BindingFile; raw: string; logicalPath: string }[] = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        throw new EventCurriculumBindingStoreError(
          "unsafe_path",
          `Recovery entry ${entry.name} is a symbolic link`,
        );
      }
      if (!entry.isFile()) continue;
      const filenameMatch = entry.name.match(RECOVERY_FILENAME_PATTERN);
      if (!filenameMatch) continue;
      const logicalPath = `${EVENT_CURRICULUM_BINDINGS_RECOVERY_LOGICAL_ROOT}/${entry.name}`;
      const target = resolve(paths.recoveryRoot, entry.name);
      await this.#assertSafeFile(target);
      const raw = await readFile(target, "utf8");
      try {
        const file = parseState(raw, logicalPath);
        if (Number(filenameMatch[1]) !== file.revision) continue;
        if (filenameMatch[2] !== sha256(raw).slice(0, 16)) continue;
        candidates.push({ file, raw, logicalPath });
      } catch (error) {
        if (!(error instanceof EventCurriculumBindingStoreError)) throw error;
        // A malformed snapshot is ignored in favor of an older valid one.
      }
    }
    candidates.sort((left, right) => right.file.revision - left.file.revision);
    return Object.freeze(candidates);
  }

  async #paths(): Promise<StorePaths> {
    this.#pathsPromise ??= this.#initializePaths();
    return this.#pathsPromise;
  }

  async #initializePaths(): Promise<StorePaths> {
    await mkdir(this.#configuredStateRoot, { recursive: true, mode: 0o700 });
    const configuredStat = await lstat(this.#configuredStateRoot);
    if (configuredStat.isSymbolicLink() || !configuredStat.isDirectory()) {
      throw new EventCurriculumBindingStoreError(
        "unsafe_path",
        "Configured state root must be a real directory",
      );
    }
    const stateRoot = await realpath(this.#configuredStateRoot);
    const statePath = resolve(stateRoot, EVENT_CURRICULUM_BINDINGS_LOGICAL_PATH);
    const recoveryRoot = resolve(stateRoot, EVENT_CURRICULUM_BINDINGS_RECOVERY_LOGICAL_ROOT);
    await this.#ensureSafeDirectory(dirname(statePath), stateRoot);
    await this.#ensureSafeDirectory(recoveryRoot, stateRoot);
    return Object.freeze({ stateRoot, statePath, recoveryRoot });
  }

  async #ensureSafeDirectory(target: string, boundary: string): Promise<void> {
    this.#assertWithin(target, boundary);
    const pathRelativeToBoundary = relative(boundary, target);
    let current = boundary;
    for (const component of pathRelativeToBoundary.split(sep).filter(Boolean)) {
      current = resolve(current, component);
      try {
        await mkdir(current, { recursive: false, mode: 0o700 });
      } catch (error) {
        if (!isErrno(error, "EEXIST")) throw error;
      }
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink() || !metadata.isDirectory() || (await realpath(current)) !== current) {
        throw new EventCurriculumBindingStoreError(
          "unsafe_path",
          `${current} must be a real directory within the state root`,
        );
      }
    }
  }

  async #assertSafeFile(target: string): Promise<void> {
    const paths = await this.#paths();
    this.#assertWithin(target, paths.stateRoot);
    const metadata = await lstat(target);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new EventCurriculumBindingStoreError(
        "unsafe_path",
        `${target} must be a regular file within the state root`,
      );
    }
  }

  #assertWithin(target: string, boundary: string): void {
    const pathRelativeToBoundary = relative(boundary, target);
    if (
      pathRelativeToBoundary === "" ||
      (!pathRelativeToBoundary.startsWith(`..${sep}`) &&
        pathRelativeToBoundary !== ".." &&
        !isAbsolute(pathRelativeToBoundary))
    ) {
      return;
    }
    throw new EventCurriculumBindingStoreError(
      "unsafe_path",
      `${target} escapes the configured state root`,
    );
  }

  async #atomicWrite(
    target: string,
    raw: string,
    mode: "exclusive" | "replace",
    logicalPath: string,
  ): Promise<boolean> {
    const paths = await this.#paths();
    await this.#ensureSafeDirectory(dirname(target), paths.stateRoot);
    await this.#assertSafeTargetOrAbsent(target);
    const temporaryId = this.#createId();
    if (!TEMPORARY_ID_PATTERN.test(temporaryId)) {
      throw new EventCurriculumBindingStoreError(
        "invalid_request",
        "createId returned an invalid temporary identifier",
      );
    }
    const temporaryPath = join(dirname(target), `.${basename(target)}-${temporaryId}.tmp`);
    let temporaryExists = false;
    try {
      const handle = await open(temporaryPath, "wx", 0o600);
      temporaryExists = true;
      try {
        await handle.writeFile(raw, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.#step("temporary_file_synced", logicalPath);
      await this.#assertSafeTargetOrAbsent(target);
      await this.#step("before_publish", logicalPath);

      if (mode === "exclusive") {
        try {
          await link(temporaryPath, target);
        } catch (error) {
          if (isErrno(error, "EEXIST")) return false;
          throw error;
        }
      } else {
        await rename(temporaryPath, target);
        temporaryExists = false;
      }
      await this.#step("published", logicalPath);

      if (temporaryExists) {
        await unlink(temporaryPath);
        temporaryExists = false;
      }
      await this.#syncDirectory(dirname(target));
      await this.#step("directory_synced", logicalPath);
      return true;
    } finally {
      if (temporaryExists) {
        try {
          await unlink(temporaryPath);
        } catch (error) {
          if (!isErrno(error, "ENOENT")) throw error;
        }
      }
    }
  }

  async #assertSafeTargetOrAbsent(target: string): Promise<void> {
    try {
      const metadata = await lstat(target);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new EventCurriculumBindingStoreError(
          "unsafe_path",
          `${target} must be a regular file within the state root`,
        );
      }
    } catch (error) {
      if (isErrno(error, "ENOENT")) return;
      throw error;
    }
  }

  async #syncDirectory(directory: string): Promise<void> {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } catch (error) {
      if (!isErrno(error, "EINVAL") && !isErrno(error, "ENOTSUP")) throw error;
    } finally {
      await handle.close();
    }
  }

  async #step(step: EventCurriculumBindingAtomicStep, logicalPath: string): Promise<void> {
    await this.#onAtomicStep?.(step, Object.freeze({ logicalPath }));
  }

  #serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutationTail.then(operation, operation);
    this.#mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
