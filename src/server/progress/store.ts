import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, type Dirent, type Stats } from "node:fs";
import * as nodeFsPromises from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { z } from "zod";

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const VERSION_PATTERN = /^r(?:0|[1-9]\d*):[a-f0-9]{64}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,254}[A-Za-z0-9])?$/;
const MAX_COMPLETIONS = 10_000;
const MAX_DOCUMENT_BYTES = 2_000_000;

const credentialLikePattern = /^(?:sk|sess|ghp|gho|github_pat|AIza)[-_]/i;

const canonicalIdentifierSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(IDENTIFIER_PATTERN)
  .refine((value) => !value.includes(".."), "path-like identifiers are forbidden")
  .refine((value) => !credentialLikePattern.test(value), "credential-like identifiers are forbidden");

const storedCompletionSchema = z
  .object({
    outcome_id: canonicalIdentifierSchema,
    outcome_version_id: canonicalIdentifierSchema,
    completed: z.boolean(),
    completed_at: z.iso.datetime({ offset: true }).nullable(),
  })
  .strict()
  .superRefine((completion, context) => {
    if (completion.completed !== (completion.completed_at !== null)) {
      context.addIssue({
        code: "custom",
        message: "completed_at must be present exactly when completed is true",
        path: ["completed_at"],
      });
    }
  });

const documentPayloadSchema = z
  .object({
    schema_version: z.literal(1),
    revision: z.number().int().min(0).max(999_999_999_999),
    completions: z.array(storedCompletionSchema).max(MAX_COMPLETIONS),
  })
  .strict();

const documentSchema = documentPayloadSchema
  .extend({ payload_hash: z.string().regex(HASH_PATTERN) })
  .strict()
  .superRefine((document, context) => {
    for (let index = 1; index < document.completions.length; index += 1) {
      const previous = document.completions[index - 1];
      const current = document.completions[index];
      if (previous === undefined || current === undefined) continue;
      if (compareCompletionKeys(previous, current) >= 0) {
        context.addIssue({
          code: "custom",
          message: "completion keys must be unique and sorted",
          path: ["completions", index, "outcome_id"],
        });
      }
    }
    if (payloadHash(document) !== document.payload_hash) {
      context.addIssue({
        code: "custom",
        message: "document payload hash does not match",
        path: ["payload_hash"],
      });
    }
  });

const setCompletionRequestSchema = z
  .object({
    expectedVersion: z.string().max(80).regex(VERSION_PATTERN),
    outcomeId: canonicalIdentifierSchema,
    outcomeVersionId: canonicalIdentifierSchema,
    completed: z.boolean(),
  })
  .strict();

type StoredDocument = z.infer<typeof documentSchema>;
type StoredCompletion = z.infer<typeof storedCompletionSchema>;

export interface LearningOutcomeCompletion {
  readonly outcomeId: string;
  readonly outcomeVersionId: string;
  /** A learner-declared checklist state; it is not an assessment of mastery. */
  readonly completed: boolean;
  readonly completedAt: string | null;
}

export interface LearningProgressSnapshot {
  readonly revision: number;
  /** CAS token containing the revision and complete payload hash. */
  readonly version: string;
  readonly completions: readonly LearningOutcomeCompletion[];
  /** True only for the read/mutation that repaired the canonical document. */
  readonly recovered: boolean;
}

export interface SetLearningOutcomeCompletionRequest {
  readonly expectedVersion: string;
  readonly outcomeId: string;
  readonly outcomeVersionId: string;
  readonly completed: boolean;
}

export type SetLearningOutcomeCompletionResult =
  | {
      readonly status: "saved";
      readonly completion: LearningOutcomeCompletion;
      readonly snapshot: LearningProgressSnapshot;
      readonly previousVersion: string;
    }
  | {
      readonly status: "unchanged";
      readonly completion: LearningOutcomeCompletion;
      readonly snapshot: LearningProgressSnapshot;
    }
  | {
      readonly status: "conflict";
      readonly current: LearningProgressSnapshot;
    };

export type LearningProgressAtomicStep =
  | "temporary_file_synced"
  | "before_publish"
  | "published"
  | "directory_synced";

interface ProgressFileHandle {
  writeFile(data: string | Uint8Array): Promise<void>;
  readFile(): Promise<Buffer>;
  stat(): Promise<Stats>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface LearningProgressFileSystem {
  mkdir(path: string, options: { readonly recursive?: boolean; readonly mode?: number }): Promise<void>;
  realpath(path: string): Promise<string>;
  lstat(path: string): Promise<Stats>;
  readdir(path: string, options: { readonly withFileTypes: true }): Promise<Dirent[]>;
  open(path: string, flags: string | number, mode?: number): Promise<ProgressFileHandle>;
  rename(oldPath: string, newPath: string): Promise<void>;
  link(existingPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

const nodeFileSystem: LearningProgressFileSystem = {
  mkdir: (path, options) => nodeFsPromises.mkdir(path, options).then(() => undefined),
  realpath: (path) => nodeFsPromises.realpath(path),
  lstat: (path) => nodeFsPromises.lstat(path),
  readdir: (path, options) => nodeFsPromises.readdir(path, options),
  open: (path, flags, mode) => nodeFsPromises.open(path, flags, mode),
  rename: (oldPath, newPath) => nodeFsPromises.rename(oldPath, newPath),
  link: (existingPath, newPath) => nodeFsPromises.link(existingPath, newPath),
  unlink: (path) => nodeFsPromises.unlink(path),
};

export interface LearningProgressStoreDependencies {
  readonly now?: () => Date;
  readonly create_id?: () => string;
  readonly file_system?: LearningProgressFileSystem;
  /** Deterministic fault-injection seam used by crash-safety tests. */
  readonly on_atomic_step?: (
    step: LearningProgressAtomicStep,
    details: Readonly<{ target: string; mode: "replace" | "exclusive" }>,
  ) => void | Promise<void>;
}

export type LearningProgressStoreErrorCode =
  | "invalid_request"
  | "unsafe_path"
  | "corrupt_store"
  | "recovery_unavailable";

export class LearningProgressStoreError extends Error {
  constructor(
    readonly code: LearningProgressStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LearningProgressStoreError";
  }
}

interface StoreRoots {
  readonly stateRoot: string;
  readonly progressRoot: string;
  readonly recoveryRoot: string;
  readonly primaryPath: string;
}

interface LoadedDocument {
  readonly document: StoredDocument;
  readonly recovered: boolean;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalPayload(
  document: Pick<StoredDocument, "schema_version" | "revision" | "completions">,
): string {
  return JSON.stringify({
    schema_version: document.schema_version,
    revision: document.revision,
    completions: document.completions.map((completion) => ({
      outcome_id: completion.outcome_id,
      outcome_version_id: completion.outcome_version_id,
      completed: completion.completed,
      completed_at: completion.completed_at,
    })),
  });
}

function payloadHash(
  document: Pick<StoredDocument, "schema_version" | "revision" | "completions">,
): string {
  return sha256(canonicalPayload(document));
}

function compareCompletionKeys(
  left: Pick<StoredCompletion, "outcome_id" | "outcome_version_id">,
  right: Pick<StoredCompletion, "outcome_id" | "outcome_version_id">,
): number {
  const outcomeOrder = left.outcome_id.localeCompare(right.outcome_id);
  return outcomeOrder === 0
    ? left.outcome_version_id.localeCompare(right.outcome_version_id)
    : outcomeOrder;
}

function sameKey(
  completion: Pick<StoredCompletion, "outcome_id" | "outcome_version_id">,
  outcomeId: string,
  outcomeVersionId: string,
): boolean {
  return completion.outcome_id === outcomeId && completion.outcome_version_id === outcomeVersionId;
}

function buildDocument(revision: number, completions: readonly StoredCompletion[]): StoredDocument {
  const payload = documentPayloadSchema.parse({
    schema_version: 1,
    revision,
    completions: [...completions].sort(compareCompletionKeys),
  });
  return documentSchema.parse({ ...payload, payload_hash: payloadHash(payload) });
}

function emptyDocument(): StoredDocument {
  return buildDocument(0, []);
}

function serializeDocument(document: StoredDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function versionFor(document: StoredDocument): string {
  return `r${document.revision}:${document.payload_hash}`;
}

function publicCompletion(completion: StoredCompletion): LearningOutcomeCompletion {
  return Object.freeze({
    outcomeId: completion.outcome_id,
    outcomeVersionId: completion.outcome_version_id,
    completed: completion.completed,
    completedAt: completion.completed_at,
  });
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

function isWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

/**
 * Durable storage for learner-declared outcome checkboxes. The strict codec
 * can persist only canonical outcome identities, a boolean, and its server-set
 * completion timestamp; it has no field for outcome text, notes, or model data.
 */
export class LearningProgressStore {
  readonly #configuredStateRoot: string;
  readonly #fs: LearningProgressFileSystem;
  readonly #now: () => Date;
  readonly #createId: () => string;
  readonly #onAtomicStep: LearningProgressStoreDependencies["on_atomic_step"];
  #rootsPromise: Promise<StoreRoots> | undefined;
  #operationTail: Promise<void> = Promise.resolve();

  constructor(stateRoot: string, dependencies: LearningProgressStoreDependencies = {}) {
    if (!isAbsolute(stateRoot)) {
      throw new LearningProgressStoreError("invalid_request", "The state root must be absolute");
    }
    this.#configuredStateRoot = resolve(stateRoot);
    this.#fs = dependencies.file_system ?? nodeFileSystem;
    this.#now = dependencies.now ?? (() => new Date());
    this.#createId = dependencies.create_id ?? randomUUID;
    this.#onAtomicStep = dependencies.on_atomic_step;
  }

  async read(): Promise<LearningProgressSnapshot> {
    return this.#serializeOperation(async () => this.#snapshot(await this.#loadOrRecover()));
  }

  async setCompletion(
    input: SetLearningOutcomeCompletionRequest | unknown,
  ): Promise<SetLearningOutcomeCompletionResult> {
    const parsed = setCompletionRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new LearningProgressStoreError(
        "invalid_request",
        "The learning-progress request contains invalid or non-progress fields",
      );
    }

    return this.#serializeOperation(async () => {
      const loaded = await this.#loadOrRecover();
      const current = loaded.document;
      if (parsed.data.expectedVersion !== versionFor(current)) {
        return Object.freeze({ status: "conflict" as const, current: this.#snapshot(loaded) });
      }

      const existing = current.completions.find((candidate) =>
        sameKey(candidate, parsed.data.outcomeId, parsed.data.outcomeVersionId),
      );
      if (existing !== undefined && existing.completed === parsed.data.completed) {
        return Object.freeze({
          status: "unchanged" as const,
          completion: publicCompletion(existing),
          snapshot: this.#snapshot(loaded),
        });
      }
      if (existing === undefined && current.completions.length >= MAX_COMPLETIONS) {
        throw new LearningProgressStoreError(
          "invalid_request",
          "The learning-progress record limit has been reached",
        );
      }

      const replacement = storedCompletionSchema.parse({
        outcome_id: parsed.data.outcomeId,
        outcome_version_id: parsed.data.outcomeVersionId,
        completed: parsed.data.completed,
        completed_at: parsed.data.completed ? this.#completionTimestamp() : null,
      });
      const nextCompletions = current.completions.filter(
        (candidate) =>
          !sameKey(candidate, parsed.data.outcomeId, parsed.data.outcomeVersionId),
      );
      nextCompletions.push(replacement);
      const next = buildDocument(current.revision + 1, nextCompletions);
      await this.#commit(current, next);

      return Object.freeze({
        status: "saved" as const,
        completion: publicCompletion(replacement),
        snapshot: this.#snapshot({ document: next, recovered: false }),
        previousVersion: versionFor(current),
      });
    });
  }

  async #loadOrRecover(): Promise<LoadedDocument> {
    const roots = await this.#roots();
    let primary: StoredDocument | undefined;
    let primaryInvalid = false;
    try {
      const raw = await this.#readFileIfPresent(roots.primaryPath);
      if (raw !== undefined) primary = this.#parseDocument(raw);
    } catch (error) {
      if (error instanceof LearningProgressStoreError && error.code === "corrupt_store") {
        primaryInvalid = true;
      } else {
        throw error;
      }
    }

    const recovery = await this.#readRecoverySnapshots(roots);
    const newestSnapshot = recovery.documents.at(-1);
    let selected: StoredDocument | undefined = primary;
    let recovered = false;

    if (primary !== undefined && newestSnapshot !== undefined) {
      if (
        newestSnapshot.revision === primary.revision &&
        newestSnapshot.payload_hash !== primary.payload_hash
      ) {
        throw new LearningProgressStoreError(
          "recovery_unavailable",
          "The canonical progress store conflicts with its recovery history",
        );
      }
      if (newestSnapshot.revision > primary.revision) {
        selected = newestSnapshot;
        recovered = true;
      }
    } else if (primary === undefined && newestSnapshot !== undefined) {
      selected = newestSnapshot;
      recovered = true;
    }

    if (selected === undefined) {
      if (primaryInvalid || recovery.hadCandidateFiles) {
        throw new LearningProgressStoreError(
          "recovery_unavailable",
          "The learning-progress store has no valid recoverable document",
        );
      }
      return Object.freeze({ document: emptyDocument(), recovered: false });
    }

    if (recovered) {
      await this.#atomicWrite(roots.primaryPath, serializeDocument(selected), "replace", roots);
    }
    await this.#ensureRecoverySnapshot(selected, roots);
    return Object.freeze({ document: selected, recovered });
  }

  async #commit(current: StoredDocument, next: StoredDocument): Promise<void> {
    const roots = await this.#roots();
    await this.#ensureRecoverySnapshot(current, roots);
    await this.#atomicWrite(roots.primaryPath, serializeDocument(next), "replace", roots);
    await this.#ensureRecoverySnapshot(next, roots);
  }

  #snapshot(loaded: LoadedDocument): LearningProgressSnapshot {
    return Object.freeze({
      revision: loaded.document.revision,
      version: versionFor(loaded.document),
      completions: Object.freeze(loaded.document.completions.map(publicCompletion)),
      recovered: loaded.recovered,
    });
  }

  #parseDocument(raw: string): StoredDocument {
    if (Buffer.byteLength(raw, "utf8") > MAX_DOCUMENT_BYTES) {
      throw new LearningProgressStoreError("corrupt_store", "The learning-progress store is too large");
    }
    try {
      return documentSchema.parse(JSON.parse(raw) as unknown);
    } catch {
      throw new LearningProgressStoreError("corrupt_store", "The learning-progress store is invalid");
    }
  }

  #completionTimestamp(): string {
    const date = this.#now();
    if (!(date instanceof Date) || Number.isNaN(date.valueOf())) {
      throw new LearningProgressStoreError(
        "invalid_request",
        "The learning-progress clock returned an invalid date",
      );
    }
    const value = date.toISOString();
    if (!z.iso.datetime({ offset: true }).safeParse(value).success) {
      throw new LearningProgressStoreError("invalid_request", "The completion timestamp is invalid");
    }
    return value;
  }

  async #roots(): Promise<StoreRoots> {
    this.#rootsPromise ??= (async () => {
      await this.#fs.mkdir(this.#configuredStateRoot, { recursive: true, mode: 0o700 });
      const stateStats = await this.#fs.lstat(this.#configuredStateRoot);
      if (stateStats.isSymbolicLink() || !stateStats.isDirectory()) {
        throw new LearningProgressStoreError("unsafe_path", "The state root is not a safe directory");
      }
      const stateRoot = await this.#fs.realpath(this.#configuredStateRoot);
      const progressRoot = await this.#ensurePrivateDirectory(stateRoot, "progress", stateRoot);
      const recoveryRoot = await this.#ensurePrivateDirectory(progressRoot, "recovery", stateRoot);
      return Object.freeze({
        stateRoot,
        progressRoot,
        recoveryRoot,
        primaryPath: resolve(progressRoot, "learning-outcomes.json"),
      });
    })();
    return this.#rootsPromise;
  }

  async #ensurePrivateDirectory(parent: string, component: string, stateRoot: string): Promise<string> {
    const target = resolve(parent, component);
    if (!isWithin(stateRoot, target)) {
      throw new LearningProgressStoreError("unsafe_path", "The progress directory escapes the state root");
    }
    try {
      await this.#fs.mkdir(target, { mode: 0o700 });
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
    }
    const stats = await this.#fs.lstat(target);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new LearningProgressStoreError("unsafe_path", "A progress-store directory is unsafe");
    }
    const canonical = await this.#fs.realpath(target);
    if (canonical !== target || !isWithin(stateRoot, canonical)) {
      throw new LearningProgressStoreError("unsafe_path", "A progress-store directory escapes the state root");
    }
    return canonical;
  }

  async #readFileIfPresent(path: string): Promise<string | undefined> {
    let stats: Stats;
    try {
      stats = await this.#fs.lstat(path);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return undefined;
      throw error;
    }
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new LearningProgressStoreError("unsafe_path", "A progress-store file is unsafe");
    }
    const canonical = await this.#fs.realpath(path);
    if (canonical !== path) {
      throw new LearningProgressStoreError("unsafe_path", "A progress-store file resolves through a link");
    }
    const handle = await this.#fs.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const openedStats = await handle.stat();
      if (!openedStats.isFile() || openedStats.size > MAX_DOCUMENT_BYTES) {
        throw new LearningProgressStoreError("corrupt_store", "A progress-store file is invalid");
      }
      return (await handle.readFile()).toString("utf8");
    } finally {
      await handle.close();
    }
  }

  async #readRecoverySnapshots(roots: StoreRoots): Promise<{
    readonly documents: readonly StoredDocument[];
    readonly hadCandidateFiles: boolean;
  }> {
    const entries = (await this.#fs.readdir(roots.recoveryRoot, { withFileTypes: true })).sort(
      (left, right) => left.name.localeCompare(right.name),
    );
    const byRevision = new Map<number, StoredDocument>();
    let hadCandidateFiles = false;

    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        throw new LearningProgressStoreError("unsafe_path", "A progress recovery snapshot is a link");
      }
      const match = /^(\d{12})-([a-f0-9]{16})\.json$/.exec(entry.name);
      if (!entry.isFile() || match === null) continue;
      hadCandidateFiles = true;
      const path = resolve(roots.recoveryRoot, entry.name);
      if (!isWithin(roots.recoveryRoot, path)) {
        throw new LearningProgressStoreError("unsafe_path", "A recovery snapshot escapes its directory");
      }
      try {
        const raw = await this.#readFileIfPresent(path);
        if (raw === undefined) continue;
        const document = this.#parseDocument(raw);
        if (
          document.revision !== Number.parseInt(match[1] ?? "", 10) ||
          document.payload_hash.slice(0, 16) !== match[2]
        ) {
          continue;
        }
        const prior = byRevision.get(document.revision);
        if (prior !== undefined && prior.payload_hash !== document.payload_hash) {
          throw new LearningProgressStoreError(
            "recovery_unavailable",
            "Recovery history contains divergent documents for one revision",
          );
        }
        byRevision.set(document.revision, document);
      } catch (error) {
        if (
          error instanceof LearningProgressStoreError &&
          (error.code === "corrupt_store" || error.code === "unsafe_path")
        ) {
          if (error.code === "unsafe_path") throw error;
          continue;
        }
        throw error;
      }
    }

    return Object.freeze({
      documents: Object.freeze(
        [...byRevision.values()].sort((left, right) => left.revision - right.revision),
      ),
      hadCandidateFiles,
    });
  }

  async #ensureRecoverySnapshot(document: StoredDocument, roots: StoreRoots): Promise<void> {
    const filename = `${String(document.revision).padStart(12, "0")}-${document.payload_hash.slice(0, 16)}.json`;
    const path = resolve(roots.recoveryRoot, filename);
    const serialized = serializeDocument(document);
    const created = await this.#atomicWrite(path, serialized, "exclusive", roots);
    if (!created) {
      const existing = await this.#readFileIfPresent(path);
      if (existing === undefined || existing !== serialized) {
        throw new LearningProgressStoreError(
          "recovery_unavailable",
          "A progress recovery snapshot collision occurred",
        );
      }
    }
  }

  async #atomicWrite(
    target: string,
    value: string,
    mode: "replace" | "exclusive",
    roots: StoreRoots,
  ): Promise<boolean> {
    if (!isWithin(roots.progressRoot, target)) {
      throw new LearningProgressStoreError("unsafe_path", "The progress write escapes its state directory");
    }
    await this.#assertSafeTargetOrAbsent(target);
    const rawId = this.#createId();
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(rawId)) {
      throw new LearningProgressStoreError("invalid_request", "The temporary-file identifier is unsafe");
    }
    const temporary = resolve(roots.progressRoot, `.progress-${rawId}.tmp`);
    if (!isWithin(roots.progressRoot, temporary)) {
      throw new LearningProgressStoreError("unsafe_path", "The temporary progress path is unsafe");
    }

    let tempExists = false;
    try {
      const handle = await this.#fs.open(temporary, "wx", 0o600);
      tempExists = true;
      try {
        await handle.writeFile(value);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.#step("temporary_file_synced", target, mode, roots);
      await this.#assertSafeParent(target, roots);
      await this.#assertSafeTargetOrAbsent(target);
      await this.#step("before_publish", target, mode, roots);

      if (mode === "replace") {
        await this.#fs.rename(temporary, target);
        tempExists = false;
      } else {
        try {
          await this.#fs.link(temporary, target);
        } catch (error) {
          if (isErrno(error, "EEXIST")) return false;
          throw error;
        }
        await this.#fs.unlink(temporary);
        tempExists = false;
      }
      await this.#step("published", target, mode, roots);
      await this.#syncDirectory(resolve(target, ".."));
      await this.#step("directory_synced", target, mode, roots);
      return true;
    } finally {
      if (tempExists) {
        try {
          await this.#fs.unlink(temporary);
        } catch (error) {
          if (!isErrno(error, "ENOENT")) throw error;
        }
      }
    }
  }

  async #assertSafeParent(target: string, roots: StoreRoots): Promise<void> {
    const parent = resolve(target, "..");
    if (parent !== roots.progressRoot && parent !== roots.recoveryRoot) {
      throw new LearningProgressStoreError("unsafe_path", "The progress target has an unsafe parent");
    }
    const stats = await this.#fs.lstat(parent);
    if (stats.isSymbolicLink() || !stats.isDirectory() || (await this.#fs.realpath(parent)) !== parent) {
      throw new LearningProgressStoreError("unsafe_path", "The progress target parent is unsafe");
    }
  }

  async #assertSafeTargetOrAbsent(target: string): Promise<void> {
    try {
      const stats = await this.#fs.lstat(target);
      if (stats.isSymbolicLink() || !stats.isFile()) {
        throw new LearningProgressStoreError("unsafe_path", "The progress target is not a regular file");
      }
    } catch (error) {
      if (isErrno(error, "ENOENT")) return;
      throw error;
    }
  }

  async #syncDirectory(path: string): Promise<void> {
    let handle: ProgressFileHandle | undefined;
    try {
      handle = await this.#fs.open(path, fsConstants.O_RDONLY);
      await handle.sync();
    } catch (error) {
      if (!isErrno(error, "EINVAL") && !isErrno(error, "ENOTSUP")) throw error;
    } finally {
      await handle?.close();
    }
  }

  async #step(
    step: LearningProgressAtomicStep,
    target: string,
    mode: "replace" | "exclusive",
    roots: StoreRoots,
  ): Promise<void> {
    if (this.#onAtomicStep === undefined) return;
    const logicalTarget = relative(roots.stateRoot, target).split(sep).join("/");
    await this.#onAtomicStep(step, Object.freeze({ target: logicalTarget, mode }));
  }

  #serializeOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operationTail.then(operation, operation);
    this.#operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
