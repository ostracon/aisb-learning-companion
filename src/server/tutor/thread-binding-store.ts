import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, type Dirent, type Stats } from "node:fs";
import * as nodeFsPromises from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { z } from "zod";

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const VERSION_PATTERN = /^r(?:0|[1-9]\d*):[a-f0-9]{64}$/;
const SCOPE_KEY_PATTERN = /^[a-z][a-z0-9_-]{0,31}:[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/;
const RUNTIME_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,299}$/;
const CONFIG_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_DOCUMENT_BYTES = 2_000_000;

const credentialLikePattern = /^(?:sk|sess|ghp|gho|github_pat|AIza)[-_]/i;

const scopeKeySchema = z.string().max(272).regex(SCOPE_KEY_PATTERN);
const runtimeIdSchema = z
  .string()
  .max(300)
  .regex(RUNTIME_ID_PATTERN)
  .refine((value) => !credentialLikePattern.test(value), "credential-like values are forbidden");
const configIdSchema = z
  .string()
  .max(128)
  .regex(CONFIG_ID_PATTERN)
  .refine((value) => !credentialLikePattern.test(value), "credential-like values are forbidden");

const bindingFieldsSchema = z
  .object({
    chatId: runtimeIdSchema,
    threadId: runtimeIdSchema,
    model: configIdSchema,
    permissionProfile: configIdSchema,
  })
  .strict();

const storedBindingSchema = bindingFieldsSchema
  .extend({
    scopeKey: scopeKeySchema,
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

const documentPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.number().int().min(0).max(999_999_999_999),
    bindings: z.array(storedBindingSchema).max(10_000),
  })
  .strict();

const documentSchema = documentPayloadSchema
  .extend({ payloadHash: z.string().regex(HASH_PATTERN) })
  .strict()
  .superRefine((document, context) => {
    for (let index = 1; index < document.bindings.length; index += 1) {
      const previous = document.bindings[index - 1];
      const current = document.bindings[index];
      if (previous === undefined || current === undefined) continue;
      if (previous.scopeKey.localeCompare(current.scopeKey) >= 0) {
        context.addIssue({
          code: "custom",
          message: "binding scope keys must be unique and sorted",
          path: ["bindings", index, "scopeKey"],
        });
      }
    }
    if (payloadHash(document) !== document.payloadHash) {
      context.addIssue({ code: "custom", message: "document payload hash does not match", path: ["payloadHash"] });
    }
  });

const upsertRequestSchema = z
  .object({
    scopeKey: scopeKeySchema,
    expectedVersion: z.string().max(80).regex(VERSION_PATTERN),
    binding: bindingFieldsSchema,
  })
  .strict();

const deleteRequestSchema = z
  .object({
    scopeKey: scopeKeySchema,
    expectedVersion: z.string().max(80).regex(VERSION_PATTERN),
  })
  .strict();

type StoredDocument = z.infer<typeof documentSchema>;
type StoredBinding = z.infer<typeof storedBindingSchema>;

export interface TutorThreadBinding {
  readonly chatId: string;
  readonly threadId: string;
  readonly model: string;
  readonly permissionProfile: string;
  readonly updatedAt: string;
}

export interface TutorThreadBindingRecord extends TutorThreadBinding {
  readonly scopeKey: string;
}

export interface TutorThreadBindingSnapshot {
  readonly revision: number;
  /** CAS token: revision plus the full content hash. */
  readonly version: string;
  readonly bindings: readonly TutorThreadBindingRecord[];
  /** True only for the read operation that repaired the canonical file. */
  readonly recovered: boolean;
}

export interface UpsertTutorThreadBindingRequest {
  readonly scopeKey: string;
  readonly expectedVersion: string;
  readonly binding: {
    readonly chatId: string;
    readonly threadId: string;
    readonly model: string;
    readonly permissionProfile: string;
  };
}

export interface DeleteTutorThreadBindingRequest {
  readonly scopeKey: string;
  readonly expectedVersion: string;
}

export type UpsertTutorThreadBindingResult =
  | {
      readonly status: "saved";
      readonly binding: TutorThreadBindingRecord;
      readonly snapshot: TutorThreadBindingSnapshot;
      readonly previousVersion: string;
    }
  | {
      readonly status: "unchanged";
      readonly binding: TutorThreadBindingRecord;
      readonly snapshot: TutorThreadBindingSnapshot;
    }
  | {
      readonly status: "conflict";
      readonly current: TutorThreadBindingSnapshot;
    };

export type DeleteTutorThreadBindingResult =
  | {
      readonly status: "deleted";
      readonly snapshot: TutorThreadBindingSnapshot;
      readonly previousVersion: string;
    }
  | {
      readonly status: "unchanged";
      readonly snapshot: TutorThreadBindingSnapshot;
    }
  | {
      readonly status: "conflict";
      readonly current: TutorThreadBindingSnapshot;
    };

export type TutorThreadBindingAtomicStep =
  | "temporary_file_synced"
  | "before_publish"
  | "published"
  | "directory_synced";

interface BindingFileHandle {
  writeFile(data: string | Uint8Array): Promise<void>;
  readFile(): Promise<Buffer>;
  stat(): Promise<Stats>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface TutorThreadBindingFileSystem {
  mkdir(path: string, options: { readonly recursive?: boolean; readonly mode?: number }): Promise<void>;
  realpath(path: string): Promise<string>;
  lstat(path: string): Promise<Stats>;
  readdir(path: string, options: { readonly withFileTypes: true }): Promise<Dirent[]>;
  open(path: string, flags: string | number, mode?: number): Promise<BindingFileHandle>;
  rename(oldPath: string, newPath: string): Promise<void>;
  link(existingPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

const nodeFileSystem: TutorThreadBindingFileSystem = {
  mkdir: (path, options) => nodeFsPromises.mkdir(path, options).then(() => undefined),
  realpath: (path) => nodeFsPromises.realpath(path),
  lstat: (path) => nodeFsPromises.lstat(path),
  readdir: (path, options) => nodeFsPromises.readdir(path, options),
  open: (path, flags, mode) => nodeFsPromises.open(path, flags, mode),
  rename: (oldPath, newPath) => nodeFsPromises.rename(oldPath, newPath),
  link: (existingPath, newPath) => nodeFsPromises.link(existingPath, newPath),
  unlink: (path) => nodeFsPromises.unlink(path),
};

export interface TutorThreadBindingStoreDependencies {
  readonly now?: () => Date;
  readonly create_id?: () => string;
  readonly file_system?: TutorThreadBindingFileSystem;
  /** Deterministic fault-injection seam used by crash-recovery tests. */
  readonly on_atomic_step?: (
    step: TutorThreadBindingAtomicStep,
    details: Readonly<{ target: string; mode: "replace" | "exclusive" }>,
  ) => void | Promise<void>;
}

export type TutorThreadBindingStoreErrorCode =
  | "invalid_request"
  | "unsafe_path"
  | "corrupt_store"
  | "recovery_unavailable"
  | "filesystem_error";

export class TutorThreadBindingStoreError extends Error {
  constructor(
    readonly code: TutorThreadBindingStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TutorThreadBindingStoreError";
  }
}

interface StoreRoots {
  readonly stateRoot: string;
  readonly bindingRoot: string;
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

function canonicalPayload(document: Pick<StoredDocument, "schemaVersion" | "revision" | "bindings">): string {
  return JSON.stringify({
    schemaVersion: document.schemaVersion,
    revision: document.revision,
    bindings: document.bindings.map((binding) => ({
      scopeKey: binding.scopeKey,
      chatId: binding.chatId,
      threadId: binding.threadId,
      model: binding.model,
      permissionProfile: binding.permissionProfile,
      updatedAt: binding.updatedAt,
    })),
  });
}

function payloadHash(document: Pick<StoredDocument, "schemaVersion" | "revision" | "bindings">): string {
  return sha256(canonicalPayload(document));
}

function buildDocument(revision: number, bindings: readonly StoredBinding[]): StoredDocument {
  const payload = documentPayloadSchema.parse({
    schemaVersion: 1,
    revision,
    bindings: [...bindings].sort((left, right) => left.scopeKey.localeCompare(right.scopeKey)),
  });
  return documentSchema.parse({ ...payload, payloadHash: payloadHash(payload) });
}

function emptyDocument(): StoredDocument {
  return buildDocument(0, []);
}

function serializeDocument(document: StoredDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function versionFor(document: StoredDocument): string {
  return `r${document.revision}:${document.payloadHash}`;
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

function sameBinding(
  stored: StoredBinding,
  desired: z.infer<typeof bindingFieldsSchema>,
): boolean {
  return (
    stored.chatId === desired.chatId &&
    stored.threadId === desired.threadId &&
    stored.model === desired.model &&
    stored.permissionProfile === desired.permissionProfile
  );
}

function publicRecord(binding: StoredBinding): TutorThreadBindingRecord {
  return Object.freeze({
    scopeKey: binding.scopeKey,
    chatId: binding.chatId,
    threadId: binding.threadId,
    model: binding.model,
    permissionProfile: binding.permissionProfile,
    updatedAt: binding.updatedAt,
  });
}

/**
 * Durable metadata-only bindings from a tutor scope to a Codex thread. The
 * strict codec deliberately has no field capable of carrying turns, notes,
 * prompts, credentials, or auth state.
 */
export class TutorThreadBindingStore {
  readonly #configuredStateRoot: string;
  readonly #fs: TutorThreadBindingFileSystem;
  readonly #now: () => Date;
  readonly #createId: () => string;
  readonly #onAtomicStep: TutorThreadBindingStoreDependencies["on_atomic_step"];
  #rootsPromise: Promise<StoreRoots> | undefined;
  #operationTail: Promise<void> = Promise.resolve();

  constructor(stateRoot: string, dependencies: TutorThreadBindingStoreDependencies = {}) {
    if (!isAbsolute(stateRoot)) {
      throw new TutorThreadBindingStoreError("invalid_request", "The state root must be absolute");
    }
    this.#configuredStateRoot = resolve(stateRoot);
    this.#fs = dependencies.file_system ?? nodeFileSystem;
    this.#now = dependencies.now ?? (() => new Date());
    this.#createId = dependencies.create_id ?? randomUUID;
    this.#onAtomicStep = dependencies.on_atomic_step;
  }

  async read(): Promise<TutorThreadBindingSnapshot> {
    return this.#serializeOperation(async () => this.#snapshot(await this.#loadOrRecover()));
  }

  async readScope(scopeKey: string | unknown): Promise<{
    readonly version: string;
    readonly binding: TutorThreadBindingRecord | null;
    readonly recovered: boolean;
  }> {
    const parsedScopeKey = this.#parseScopeKey(scopeKey);
    return this.#serializeOperation(async () => {
      const loaded = await this.#loadOrRecover();
      const binding = loaded.document.bindings.find((candidate) => candidate.scopeKey === parsedScopeKey);
      return Object.freeze({
        version: versionFor(loaded.document),
        binding: binding === undefined ? null : publicRecord(binding),
        recovered: loaded.recovered,
      });
    });
  }

  async upsert(input: UpsertTutorThreadBindingRequest | unknown): Promise<UpsertTutorThreadBindingResult> {
    const parsed = upsertRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new TutorThreadBindingStoreError(
        "invalid_request",
        "The tutor thread binding request contains invalid or non-metadata fields",
      );
    }
    return this.#serializeOperation(async () => {
      const loaded = await this.#loadOrRecover();
      const current = loaded.document;
      if (parsed.data.expectedVersion !== versionFor(current)) {
        return Object.freeze({ status: "conflict" as const, current: this.#snapshot(loaded) });
      }

      const existing = current.bindings.find((candidate) => candidate.scopeKey === parsed.data.scopeKey);
      if (existing !== undefined && sameBinding(existing, parsed.data.binding)) {
        return Object.freeze({
          status: "unchanged" as const,
          binding: publicRecord(existing),
          snapshot: this.#snapshot(loaded),
        });
      }

      const updatedAt = this.#nextTimestamp(existing?.updatedAt);
      const replacement = storedBindingSchema.parse({
        scopeKey: parsed.data.scopeKey,
        ...parsed.data.binding,
        updatedAt,
      });
      const nextBindings = current.bindings.filter((candidate) => candidate.scopeKey !== parsed.data.scopeKey);
      nextBindings.push(replacement);
      const next = buildDocument(current.revision + 1, nextBindings);
      await this.#commit(current, next);
      const snapshot = this.#snapshot({ document: next, recovered: false });
      return Object.freeze({
        status: "saved" as const,
        binding: publicRecord(replacement),
        snapshot,
        previousVersion: versionFor(current),
      });
    });
  }

  async delete(input: DeleteTutorThreadBindingRequest | unknown): Promise<DeleteTutorThreadBindingResult> {
    const parsed = deleteRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new TutorThreadBindingStoreError("invalid_request", "The tutor thread binding delete request is invalid");
    }
    return this.#serializeOperation(async () => {
      const loaded = await this.#loadOrRecover();
      const current = loaded.document;
      if (parsed.data.expectedVersion !== versionFor(current)) {
        return Object.freeze({ status: "conflict" as const, current: this.#snapshot(loaded) });
      }
      if (!current.bindings.some((candidate) => candidate.scopeKey === parsed.data.scopeKey)) {
        return Object.freeze({ status: "unchanged" as const, snapshot: this.#snapshot(loaded) });
      }

      const next = buildDocument(
        current.revision + 1,
        current.bindings.filter((candidate) => candidate.scopeKey !== parsed.data.scopeKey),
      );
      await this.#commit(current, next);
      return Object.freeze({
        status: "deleted" as const,
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
      if (error instanceof TutorThreadBindingStoreError && error.code === "corrupt_store") {
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
      if (newestSnapshot.revision === primary.revision && newestSnapshot.payloadHash !== primary.payloadHash) {
        throw new TutorThreadBindingStoreError(
          "recovery_unavailable",
          "The canonical binding store conflicts with its recovery history",
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
        throw new TutorThreadBindingStoreError(
          "recovery_unavailable",
          "The tutor thread binding store has no valid recoverable document",
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

  #snapshot(loaded: LoadedDocument): TutorThreadBindingSnapshot {
    return Object.freeze({
      revision: loaded.document.revision,
      version: versionFor(loaded.document),
      bindings: Object.freeze(loaded.document.bindings.map(publicRecord)),
      recovered: loaded.recovered,
    });
  }

  #parseScopeKey(input: unknown): string {
    const parsed = scopeKeySchema.safeParse(input);
    if (!parsed.success) throw new TutorThreadBindingStoreError("invalid_request", "The tutor scope key is invalid");
    return parsed.data;
  }

  #parseDocument(raw: string): StoredDocument {
    if (Buffer.byteLength(raw, "utf8") > MAX_DOCUMENT_BYTES) {
      throw new TutorThreadBindingStoreError("corrupt_store", "The tutor thread binding store is too large");
    }
    try {
      return documentSchema.parse(JSON.parse(raw) as unknown);
    } catch {
      throw new TutorThreadBindingStoreError("corrupt_store", "The tutor thread binding store is invalid");
    }
  }

  #nextTimestamp(previous: string | undefined): string {
    const date = this.#now();
    if (!(date instanceof Date) || Number.isNaN(date.valueOf())) {
      throw new TutorThreadBindingStoreError("invalid_request", "The binding-store clock returned an invalid date");
    }
    let milliseconds = date.valueOf();
    if (previous !== undefined) milliseconds = Math.max(milliseconds, Date.parse(previous) + 1);
    const value = new Date(milliseconds).toISOString();
    if (!z.iso.datetime({ offset: true }).safeParse(value).success) {
      throw new TutorThreadBindingStoreError("invalid_request", "The binding timestamp is invalid");
    }
    return value;
  }

  async #roots(): Promise<StoreRoots> {
    this.#rootsPromise ??= (async () => {
      await this.#fs.mkdir(this.#configuredStateRoot, { recursive: true, mode: 0o700 });
      const stateStats = await this.#fs.lstat(this.#configuredStateRoot);
      if (!stateStats.isDirectory()) {
        throw new TutorThreadBindingStoreError("unsafe_path", "The state root is not a directory");
      }
      const stateRoot = await this.#fs.realpath(this.#configuredStateRoot);
      const tutorRoot = await this.#ensurePrivateDirectory(stateRoot, "tutor", stateRoot);
      const bindingRoot = await this.#ensurePrivateDirectory(tutorRoot, "thread-bindings", stateRoot);
      const recoveryRoot = await this.#ensurePrivateDirectory(bindingRoot, "recovery", stateRoot);
      return Object.freeze({
        stateRoot,
        bindingRoot,
        recoveryRoot,
        primaryPath: resolve(bindingRoot, "bindings.json"),
      });
    })();
    return this.#rootsPromise;
  }

  async #ensurePrivateDirectory(parent: string, component: string, stateRoot: string): Promise<string> {
    const target = resolve(parent, component);
    if (!isWithin(stateRoot, target)) {
      throw new TutorThreadBindingStoreError("unsafe_path", "The binding directory escapes the state root");
    }
    try {
      await this.#fs.mkdir(target, { mode: 0o700 });
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
    }
    const stats = await this.#fs.lstat(target);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new TutorThreadBindingStoreError("unsafe_path", "A binding-store directory is unsafe");
    }
    const canonical = await this.#fs.realpath(target);
    if (canonical !== target || !isWithin(stateRoot, canonical)) {
      throw new TutorThreadBindingStoreError("unsafe_path", "A binding-store directory escapes the state root");
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
      throw new TutorThreadBindingStoreError("unsafe_path", "A binding-store file is unsafe");
    }
    const canonical = await this.#fs.realpath(path);
    if (canonical !== path) {
      throw new TutorThreadBindingStoreError("unsafe_path", "A binding-store file resolves through a link");
    }
    const handle = await this.#fs.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const openedStats = await handle.stat();
      if (!openedStats.isFile() || openedStats.size > MAX_DOCUMENT_BYTES) {
        throw new TutorThreadBindingStoreError("corrupt_store", "A binding-store file is invalid");
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
    const entries = (await this.#fs.readdir(roots.recoveryRoot, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    const byRevision = new Map<number, StoredDocument>();
    let hadCandidateFiles = false;
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        throw new TutorThreadBindingStoreError("unsafe_path", "A recovery snapshot is a symbolic link");
      }
      const match = /^(\d{12})-([a-f0-9]{16})\.json$/.exec(entry.name);
      if (!entry.isFile() || match === null) continue;
      hadCandidateFiles = true;
      const path = resolve(roots.recoveryRoot, entry.name);
      if (!isWithin(roots.recoveryRoot, path)) {
        throw new TutorThreadBindingStoreError("unsafe_path", "A recovery snapshot escapes its directory");
      }
      try {
        const raw = await this.#readFileIfPresent(path);
        if (raw === undefined) continue;
        const document = this.#parseDocument(raw);
        if (
          document.revision !== Number.parseInt(match[1] ?? "", 10) ||
          document.payloadHash.slice(0, 16) !== match[2]
        ) {
          continue;
        }
        const prior = byRevision.get(document.revision);
        if (prior !== undefined && prior.payloadHash !== document.payloadHash) {
          throw new TutorThreadBindingStoreError(
            "recovery_unavailable",
            "Recovery history contains divergent documents for one revision",
          );
        }
        byRevision.set(document.revision, document);
      } catch (error) {
        if (
          error instanceof TutorThreadBindingStoreError &&
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
    const filename = `${String(document.revision).padStart(12, "0")}-${document.payloadHash.slice(0, 16)}.json`;
    const path = resolve(roots.recoveryRoot, filename);
    const serialized = serializeDocument(document);
    const created = await this.#atomicWrite(path, serialized, "exclusive", roots);
    if (!created) {
      const existing = await this.#readFileIfPresent(path);
      if (existing === undefined || existing !== serialized) {
        throw new TutorThreadBindingStoreError("recovery_unavailable", "A recovery snapshot collision occurred");
      }
    }
  }

  async #atomicWrite(
    target: string,
    value: string,
    mode: "replace" | "exclusive",
    roots: StoreRoots,
  ): Promise<boolean> {
    if (!isWithin(roots.bindingRoot, target)) {
      throw new TutorThreadBindingStoreError("unsafe_path", "The binding write escapes its state directory");
    }
    await this.#assertSafeTargetOrAbsent(target);
    const rawId = this.#createId();
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(rawId)) {
      throw new TutorThreadBindingStoreError("invalid_request", "The temporary-file identifier is unsafe");
    }
    const temporary = resolve(roots.bindingRoot, `.binding-${rawId}.tmp`);
    if (!isWithin(roots.bindingRoot, temporary)) {
      throw new TutorThreadBindingStoreError("unsafe_path", "The temporary binding path is unsafe");
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
    if (parent !== roots.bindingRoot && parent !== roots.recoveryRoot) {
      throw new TutorThreadBindingStoreError("unsafe_path", "The binding target has an unsafe parent");
    }
    const stats = await this.#fs.lstat(parent);
    if (stats.isSymbolicLink() || !stats.isDirectory() || (await this.#fs.realpath(parent)) !== parent) {
      throw new TutorThreadBindingStoreError("unsafe_path", "The binding target parent is unsafe");
    }
  }

  async #assertSafeTargetOrAbsent(target: string): Promise<void> {
    try {
      const stats = await this.#fs.lstat(target);
      if (stats.isSymbolicLink() || !stats.isFile()) {
        throw new TutorThreadBindingStoreError("unsafe_path", "The binding target is not a regular file");
      }
    } catch (error) {
      if (isErrno(error, "ENOENT")) return;
      throw error;
    }
  }

  async #syncDirectory(path: string): Promise<void> {
    let handle: BindingFileHandle | undefined;
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
    step: TutorThreadBindingAtomicStep,
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
