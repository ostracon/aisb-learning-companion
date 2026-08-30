import { createHash, randomUUID } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import * as nodeFsPromises from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import {
  NOTE_SCHEMA_VERSION,
  NoteValidationError,
  assertNoteMatchesLocator,
  makeAdHocTimestampSlug,
  noteLogicalPath,
  noteSummary,
  parseNoteMarkdown,
  serializeNoteMarkdown,
  validateAdHocTimestampSlug,
  validateCalendarDate,
  validateInstant,
  validateNoteFrontmatter,
  validateNoteMarkdown,
  validatePathIdentifier,
  type NoteFrontmatter,
  type NoteLinks,
  type NoteLocator,
  type NoteRecord,
  type NoteStatus,
  type NoteSummary,
} from "../../shared/notes";

export type CreateNoteRequest =
  | (CreateNoteBase & {
      readonly kind: "day";
      readonly programme_day_id: string;
    })
  | (CreateNoteBase & {
      readonly kind: "lesson";
      readonly section_id: string;
    })
  | (CreateNoteBase & {
      readonly kind: "event";
      readonly event_binding_id: string;
    })
  | (CreateNoteBase & {
      readonly kind: "ad_hoc";
      /** Defaults to the UTC date of created_at; callers may supply local date. */
      readonly creation_date?: string;
      /** Named quick notes use their immutable note ID as the exact filename. */
      readonly filename_style?: "timestamped" | "named";
    });

export interface CreateNoteBase {
  readonly title?: string;
  readonly markdown?: string;
  /** Primarily for replay-safe operations and deterministic tests. */
  readonly note_id?: string;
  readonly created_at?: string;
  readonly status?: NoteStatus;
  readonly links?: Partial<NoteLinks>;
}

export interface CreateNoteResult {
  readonly status: "created" | "existing";
  readonly note: NoteRecord;
}

export interface SaveNoteRequest {
  readonly note_id: string;
  readonly expected_revision: number;
  readonly expected_content_hash: string;
  readonly markdown: string;
  readonly title?: string;
  readonly status?: NoteStatus;
  readonly links?: NoteLinks;
}

export type SaveNoteResult =
  | {
      readonly status: "saved";
      readonly note: NoteRecord;
      readonly previous_content_hash: string;
    }
  | {
      readonly status: "unchanged";
      readonly note: NoteRecord;
    }
  | {
      readonly status: "conflict";
      readonly current: NoteRecord;
      /** State-root-relative path containing the unaccepted submitted draft. */
      readonly conflict_copy_path: string;
    };

export type RecoverNoteResult =
  | {
      readonly status: "recovered";
      readonly note: NoteRecord;
      readonly recovery_snapshot_path: string;
      readonly displaced_copy_path?: string;
    }
  | {
      readonly status: "not_needed";
      readonly note: NoteRecord;
      readonly recovery_snapshot_path: string;
    };

export type NoteAtomicStep =
  | "temporary_file_synced"
  | "before_publish"
  | "published"
  | "directory_synced"
  | "revision_journal_synced";

export interface UnreadableNoteFile {
  readonly logical_path: string;
  readonly reason: string;
}

export interface NoteInventory {
  readonly notes: readonly NoteSummary[];
  readonly unreadable: readonly UnreadableNoteFile[];
}

export interface NoteStoreDependencies {
  readonly now?: () => Date;
  readonly create_id?: () => string;
  readonly file_system?: NoteStoreFileSystem;
  /** Test/fault-injection seam; production leaves it undefined. */
  readonly on_atomic_step?: (
    step: NoteAtomicStep,
    details: Readonly<{ target: string }>,
  ) => void | Promise<void>;
}

interface NoteFileHandle {
  writeFile(data: string, options?: { readonly encoding?: BufferEncoding }): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface NoteStoreFileSystem {
  mkdir(path: string, options: { readonly recursive: boolean; readonly mode?: number }): Promise<void>;
  realpath(path: string): Promise<string>;
  lstat(path: string): Promise<Stats>;
  readdir(path: string, options: { readonly withFileTypes: true }): Promise<Dirent[]>;
  readFile(path: string, encoding: BufferEncoding): Promise<string>;
  open(path: string, flags: string, mode?: number): Promise<NoteFileHandle>;
  rename(oldPath: string, newPath: string): Promise<void>;
  link(existingPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

const nodeFileSystem: NoteStoreFileSystem = {
  async mkdir(path, options) {
    await nodeFsPromises.mkdir(path, options);
  },
  realpath: (path) => nodeFsPromises.realpath(path),
  lstat: (path) => nodeFsPromises.lstat(path),
  readdir: (path, options) => nodeFsPromises.readdir(path, options),
  readFile: (path, encoding) => nodeFsPromises.readFile(path, encoding),
  open: (path, flags, mode) => nodeFsPromises.open(path, flags, mode),
  rename: (oldPath, newPath) => nodeFsPromises.rename(oldPath, newPath),
  link: (existingPath, newPath) => nodeFsPromises.link(existingPath, newPath),
  unlink: (path) => nodeFsPromises.unlink(path),
};

export class NoteStoreError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "unsafe_path"
      | "identity_mismatch"
      | "duplicate_note_id"
      | "invalid_request"
      | "recovery_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "NoteStoreError";
  }
}

interface StoreRoots {
  readonly state_root: string;
  readonly notes_root: string;
}

interface RevisionJournalEntry {
  readonly schema_version: 1;
  readonly note_id: string;
  readonly revision: number;
  readonly content_hash: string;
  readonly logical_path: string;
  readonly operation: "create" | "save" | "recover";
  readonly recorded_at: string;
}

const HASH_PATTERN = /^[a-f0-9]{64}$/;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

function defaultTitle(request: CreateNoteRequest): string {
  switch (request.kind) {
    case "day":
      return `${request.programme_day_id.replace(/^day/, "Day ")} notes`;
    case "lesson":
      return `Section ${request.section_id} notes`;
    case "event":
      return "Event notes";
    case "ad_hoc":
      return "Quick note";
  }
}

function normalizedLinks(value: Partial<NoteLinks> | undefined): NoteLinks {
  const links: {
    section_ids: string[];
    canonical_outcome_ids: string[];
    programme_day_id?: string;
    event_binding_id?: string;
    event_start?: string;
    event_end?: string;
    time_zone?: string;
    creation_date?: string;
  } = {
    section_ids: [...(value?.section_ids ?? [])],
    canonical_outcome_ids: [...(value?.canonical_outcome_ids ?? [])],
  };
  if (value?.programme_day_id !== undefined) links.programme_day_id = value.programme_day_id;
  if (value?.event_binding_id !== undefined) links.event_binding_id = value.event_binding_id;
  if (value?.event_start !== undefined) links.event_start = value.event_start;
  if (value?.event_end !== undefined) links.event_end = value.event_end;
  if (value?.time_zone !== undefined) links.time_zone = value.time_zone;
  if (value?.creation_date !== undefined) links.creation_date = value.creation_date;
  return links;
}

function sameLinks(left: NoteLinks, right: NoteLinks): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Durable Markdown-note storage. The state root is canonicalized once; all
 * descendants are component-checked and symlinks are rejected before access.
 */
export class MarkdownNoteStore {
  readonly #configuredStateRoot: string;
  readonly #now: () => Date;
  readonly #createId: () => string;
  readonly #fs: NoteStoreFileSystem;
  readonly #onAtomicStep: NoteStoreDependencies["on_atomic_step"];
  readonly #locks = new Map<string, Promise<void>>();
  #rootsPromise: Promise<StoreRoots> | undefined;

  constructor(stateRoot: string, dependencies: NoteStoreDependencies = {}) {
    if (!isAbsolute(stateRoot)) {
      throw new NoteStoreError("invalid_request", "state root must be an absolute path");
    }
    this.#configuredStateRoot = resolve(stateRoot);
    this.#now = dependencies.now ?? (() => new Date());
    this.#createId = dependencies.create_id ?? randomUUID;
    this.#fs = dependencies.file_system ?? nodeFileSystem;
    this.#onAtomicStep = dependencies.on_atomic_step;
  }

  async create(request: CreateNoteRequest): Promise<CreateNoteResult> {
    const prepared = this.#prepareCreate(request);
    const logicalPath = noteLogicalPath(prepared.locator);
    return this.#withLock(logicalPath, async () => {
      const existing = await this.#readIfPresent(prepared.locator);
      if (existing !== undefined) {
        await this.#ensureRecoverySnapshot(existing);
        return Object.freeze({ status: "existing" as const, note: existing });
      }

      const duplicate = (await this.list()).find(
        (candidate) => candidate.note_id === prepared.frontmatter.note_id,
      );
      if (duplicate !== undefined) {
        throw new NoteStoreError(
          "duplicate_note_id",
          `note_id ${prepared.frontmatter.note_id} already belongs to ${duplicate.logical_path}`,
        );
      }

      const serialized = serializeNoteMarkdown({
        frontmatter: prepared.frontmatter,
        markdown: prepared.markdown,
      });
      const published = await this.#writeExclusive(logicalPath, serialized);
      if (!published) {
        const raced = await this.read(prepared.locator);
        await this.#ensureRecoverySnapshot(raced);
        return Object.freeze({ status: "existing" as const, note: raced });
      }
      const note = this.#record(prepared.locator, logicalPath, serialized);
      await this.#ensureRecoverySnapshot(note);
      await this.#appendRevision(note, "create");
      return Object.freeze({ status: "created" as const, note });
    });
  }

  async read(locator: NoteLocator): Promise<NoteRecord> {
    const logicalPath = noteLogicalPath(locator);
    const raw = await this.#readLogicalFile(logicalPath);
    return this.#record(locator, logicalPath, raw);
  }

  async list(): Promise<readonly NoteSummary[]> {
    return (await this.inventory()).notes;
  }

  /**
   * Scan independently-authored Markdown without allowing one malformed file
   * to hide every other note. Unsafe filesystem entries and I/O failures still
   * fail closed; only note-codec validation is isolated and reported.
   */
  async inventory(): Promise<NoteInventory> {
    const roots = await this.#roots();
    const logicalPaths: string[] = [];
    for (const category of ["days", "lessons", "events", "ad-hoc"] as const) {
      const categoryPath = resolve(roots.notes_root, category);
      if (!(await this.#exists(categoryPath))) continue;
      await this.#assertSafeExistingDirectory(categoryPath, roots.notes_root);
      await this.#walkMarkdown(categoryPath, roots.notes_root, logicalPaths);
    }

    const records: NoteRecord[] = [];
    const unreadable: UnreadableNoteFile[] = [];
    const byId = new Map<string, string>();
    for (const logicalPath of logicalPaths.sort()) {
      const raw = await this.#readLogicalFile(logicalPath);
      let record: NoteRecord;
      try {
        const parsed = parseNoteMarkdown(raw);
        const locator = this.#locatorForDiscoveredPath(logicalPath, parsed.frontmatter);
        record = this.#record(locator, logicalPath, raw);
      } catch (error) {
        if (!(error instanceof NoteValidationError)) throw error;
        unreadable.push(Object.freeze({
          logical_path: logicalPath,
          reason: error.message,
        }));
        continue;
      }
      const priorPath = byId.get(record.frontmatter.note_id);
      if (priorPath !== undefined && priorPath !== logicalPath) {
        throw new NoteStoreError(
          "duplicate_note_id",
          `note_id ${record.frontmatter.note_id} appears at ${priorPath} and ${logicalPath}`,
        );
      }
      byId.set(record.frontmatter.note_id, logicalPath);
      records.push(record);
    }
    return Object.freeze({
      notes: Object.freeze(records.map(noteSummary)),
      unreadable: Object.freeze(unreadable),
    });
  }

  async save(locator: NoteLocator, request: SaveNoteRequest): Promise<SaveNoteResult> {
    validatePathIdentifier(request.note_id, "note_id");
    validateNoteMarkdown(request.markdown);
    if (!Number.isSafeInteger(request.expected_revision) || request.expected_revision < 1) {
      throw new NoteStoreError("invalid_request", "expected_revision must be a positive integer");
    }
    if (!HASH_PATTERN.test(request.expected_content_hash)) {
      throw new NoteStoreError(
        "invalid_request",
        "expected_content_hash must be a lowercase SHA-256 digest",
      );
    }

    const logicalPath = noteLogicalPath(locator);
    return this.#withLock(logicalPath, async () => {
      const current = await this.read(locator);
      if (current.frontmatter.note_id !== request.note_id) {
        throw new NoteStoreError(
          "identity_mismatch",
          `note_id ${request.note_id} does not match ${current.frontmatter.note_id}`,
        );
      }

      const desiredLinks = request.links ?? current.frontmatter.links;
      const desiredTitle = request.title ?? current.frontmatter.title;
      const desiredStatus = request.status ?? current.frontmatter.status;
      const unchanged =
        request.markdown === current.markdown &&
        desiredTitle === current.frontmatter.title &&
        desiredStatus === current.frontmatter.status &&
        sameLinks(desiredLinks, current.frontmatter.links);

      if (unchanged) {
        await this.#ensureRecoverySnapshot(current);
        return Object.freeze({ status: "unchanged" as const, note: current });
      }

      const candidateFrontmatter = validateNoteFrontmatter({
        ...current.frontmatter,
        title: desiredTitle,
        status: desiredStatus,
        links: desiredLinks,
        last_modified_at: this.#nextModifiedAt(current.frontmatter),
        revision: current.frontmatter.revision + 1,
      });
      assertNoteMatchesLocator(candidateFrontmatter, locator);

      if (
        request.expected_revision !== current.frontmatter.revision ||
        request.expected_content_hash !== current.content_hash
      ) {
        const conflictPath = await this.#writeConflictCopy(
          current,
          request.markdown,
          candidateFrontmatter,
        );
        return Object.freeze({
          status: "conflict" as const,
          current,
          conflict_copy_path: conflictPath,
        });
      }

      await this.#ensureRecoverySnapshot(current);
      const serialized = serializeNoteMarkdown({
        frontmatter: candidateFrontmatter,
        markdown: request.markdown,
      });
      await this.#writeReplace(logicalPath, serialized);
      const saved = this.#record(locator, logicalPath, serialized);
      await this.#ensureRecoverySnapshot(saved);
      await this.#appendRevision(saved, "save");
      return Object.freeze({
        status: "saved" as const,
        note: saved,
        previous_content_hash: current.content_hash,
      });
    });
  }

  /** Restore the newest valid immutable snapshot, preserving displaced bytes. */
  async recover(locator: NoteLocator, noteId: string): Promise<RecoverNoteResult> {
    validatePathIdentifier(noteId, "note_id");
    const logicalPath = noteLogicalPath(locator);
    return this.#withLock(logicalPath, async () => {
      const snapshots = await this.#readRecoverySnapshots(noteId, locator);
      const latest = snapshots.at(0);
      if (latest === undefined) {
        throw new NoteStoreError(
          "recovery_unavailable",
          `no valid recovery snapshot exists for note_id ${noteId}`,
        );
      }

      let currentRaw: string | undefined;
      try {
        currentRaw = await this.#readLogicalFile(logicalPath);
      } catch (error) {
        if (!(error instanceof NoteStoreError && error.code === "not_found")) throw error;
      }

      if (currentRaw !== undefined) {
        try {
          const current = this.#record(locator, logicalPath, currentRaw);
          if (
            current.frontmatter.note_id === noteId &&
            current.frontmatter.revision >= latest.note.frontmatter.revision
          ) {
            return Object.freeze({
              status: "not_needed" as const,
              note: current,
              recovery_snapshot_path: latest.path,
            });
          }
        } catch {
          // The exact invalid bytes are copied below before canonical recovery.
        }
      }

      let displacedCopyPath: string | undefined;
      if (currentRaw !== undefined && currentRaw !== latest.raw) {
        displacedCopyPath = await this.#writeRawConflictCopy(noteId, currentRaw, "displaced");
      }
      await this.#writeReplace(logicalPath, latest.raw);
      const recovered = this.#record(locator, logicalPath, latest.raw);
      await this.#appendRevision(recovered, "recover");
      return Object.freeze({
        status: "recovered" as const,
        note: recovered,
        recovery_snapshot_path: latest.path,
        ...(displacedCopyPath === undefined
          ? {}
          : { displaced_copy_path: displacedCopyPath }),
      });
    });
  }

  #prepareCreate(request: CreateNoteRequest): {
    readonly locator: NoteLocator;
    readonly frontmatter: NoteFrontmatter;
    readonly markdown: string;
  } {
    const createdAt = validateInstant(request.created_at ?? this.#nowIso(), "created_at");
    const noteId = validatePathIdentifier(request.note_id ?? this.#createId(), "note_id");
    const links = normalizedLinks(request.links);
    let locator: NoteLocator;

    switch (request.kind) {
      case "day": {
        const dayId = validatePathIdentifier(request.programme_day_id, "programme_day_id");
        if (links.programme_day_id !== undefined && links.programme_day_id !== dayId) {
          throw new NoteStoreError(
            "identity_mismatch",
            "links.programme_day_id does not match the requested day",
          );
        }
        (links as { programme_day_id: string }).programme_day_id = dayId;
        locator = { kind: "day", programme_day_id: dayId };
        break;
      }
      case "lesson": {
        const sectionId = validatePathIdentifier(request.section_id, "section_id");
        if (links.section_ids.length === 0) {
          (links.section_ids as string[]).push(sectionId);
        } else if (links.section_ids[0] !== sectionId) {
          throw new NoteStoreError(
            "identity_mismatch",
            "the first links.section_ids value must own the lesson note path",
          );
        }
        locator = { kind: "lesson", section_id: sectionId };
        break;
      }
      case "event": {
        const eventId = validatePathIdentifier(request.event_binding_id, "event_binding_id");
        if (links.event_binding_id !== undefined && links.event_binding_id !== eventId) {
          throw new NoteStoreError(
            "identity_mismatch",
            "links.event_binding_id does not match the requested event",
          );
        }
        (links as { event_binding_id: string }).event_binding_id = eventId;
        locator = { kind: "event", event_binding_id: eventId };
        break;
      }
      case "ad_hoc": {
        const creationDate = validateCalendarDate(
          request.creation_date ?? createdAt.slice(0, 10),
          "creation_date",
        );
        if (links.creation_date !== undefined && links.creation_date !== creationDate) {
          throw new NoteStoreError(
            "identity_mismatch",
            "links.creation_date does not match the requested ad-hoc creation date",
          );
        }
        (links as { creation_date: string }).creation_date = creationDate;
        locator = {
          kind: "ad_hoc",
          creation_date: creationDate,
          note_id: noteId,
          ...(request.filename_style === "named"
            ? {}
            : { timestamp_slug: makeAdHocTimestampSlug(createdAt) }),
        };
        break;
      }
    }

    const frontmatter = validateNoteFrontmatter({
      schema_version: NOTE_SCHEMA_VERSION,
      note_id: noteId,
      note_kind: request.kind,
      title: request.title ?? defaultTitle(request),
      created_at: createdAt,
      last_modified_at: createdAt,
      revision: 1,
      status: request.status ?? "active",
      links,
    });
    assertNoteMatchesLocator(frontmatter, locator);
    return Object.freeze({
      locator,
      frontmatter,
      markdown: validateNoteMarkdown(request.markdown ?? ""),
    });
  }

  #nextModifiedAt(current: NoteFrontmatter): string {
    const observed = validateInstant(this.#nowIso());
    return Date.parse(observed) < Date.parse(current.last_modified_at)
      ? current.last_modified_at
      : observed;
  }

  #nowIso(): string {
    const observed = this.#now();
    if (!Number.isFinite(observed.getTime())) {
      throw new NoteStoreError("invalid_request", "injected clock returned an invalid Date");
    }
    return observed.toISOString();
  }

  async #roots(): Promise<StoreRoots> {
    this.#rootsPromise ??= this.#initializeRoots();
    return this.#rootsPromise;
  }

  async #initializeRoots(): Promise<StoreRoots> {
    await this.#fs.mkdir(this.#configuredStateRoot, { recursive: true, mode: 0o700 });
    const configuredStat = await this.#fs.lstat(this.#configuredStateRoot);
    if (configuredStat.isSymbolicLink() || !configuredStat.isDirectory()) {
      throw new NoteStoreError("unsafe_path", "configured state root must be a real directory");
    }
    const stateRoot = await this.#fs.realpath(this.#configuredStateRoot);
    const notesRoot = resolve(stateRoot, "notes");
    await this.#ensureSafeDirectory(notesRoot, stateRoot);
    return Object.freeze({ state_root: stateRoot, notes_root: notesRoot });
  }

  async #ensureSafeDirectory(target: string, boundary: string): Promise<void> {
    this.#assertWithin(target, boundary);
    const rel = relative(boundary, target);
    let current = boundary;
    for (const component of rel.split(sep).filter(Boolean)) {
      validatePathIdentifier(component, "directory component");
      current = resolve(current, component);
      try {
        await this.#fs.mkdir(current, { recursive: false, mode: 0o700 });
      } catch (error) {
        if (!isErrno(error, "EEXIST")) throw error;
      }
      const stat = await this.#fs.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new NoteStoreError("unsafe_path", `${current} is not a real directory`);
      }
      const canonical = await this.#fs.realpath(current);
      if (canonical !== current) {
        throw new NoteStoreError("unsafe_path", `${current} resolves through a symlink`);
      }
    }
  }

  async #assertSafeExistingDirectory(target: string, boundary: string): Promise<void> {
    this.#assertWithin(target, boundary);
    const rel = relative(boundary, target);
    let current = boundary;
    for (const component of rel.split(sep).filter(Boolean)) {
      current = resolve(current, component);
      let stat: Stats;
      try {
        stat = await this.#fs.lstat(current);
      } catch (error) {
        if (isErrno(error, "ENOENT")) {
          throw new NoteStoreError("not_found", `${current} does not exist`);
        }
        throw error;
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new NoteStoreError("unsafe_path", `${current} is not a real directory`);
      }
      if ((await this.#fs.realpath(current)) !== current) {
        throw new NoteStoreError("unsafe_path", `${current} resolves through a symlink`);
      }
    }
  }

  #assertWithin(target: string, boundary: string): void {
    const rel = relative(boundary, target);
    if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) return;
    throw new NoteStoreError("unsafe_path", `${target} escapes ${boundary}`);
  }

  async #logicalTarget(logicalPath: string, createParents: boolean): Promise<string> {
    const roots = await this.#roots();
    if (!logicalPath.startsWith("notes/")) {
      throw new NoteStoreError("unsafe_path", "logical note path must begin with notes/");
    }
    const components = logicalPath.slice("notes/".length).split("/");
    if (components.length < 2) {
      throw new NoteStoreError("unsafe_path", "logical note path is incomplete");
    }
    for (const component of components) validatePathIdentifier(component, "path component");
    const target = resolve(roots.notes_root, ...components);
    this.#assertWithin(target, roots.notes_root);
    const parent = dirname(target);
    if (createParents) {
      await this.#ensureSafeDirectory(parent, roots.notes_root);
    } else {
      await this.#assertSafeExistingDirectory(parent, roots.notes_root);
    }
    return target;
  }

  async #readLogicalFile(logicalPath: string): Promise<string> {
    const target = await this.#logicalTarget(logicalPath, false);
    let stat: Stats;
    try {
      stat = await this.#fs.lstat(target);
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        throw new NoteStoreError("not_found", `${logicalPath} does not exist`);
      }
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new NoteStoreError("unsafe_path", `${logicalPath} is not a regular file`);
    }
    return this.#fs.readFile(target, "utf8");
  }

  async #readIfPresent(locator: NoteLocator): Promise<NoteRecord | undefined> {
    try {
      return await this.read(locator);
    } catch (error) {
      if (error instanceof NoteStoreError && error.code === "not_found") return undefined;
      throw error;
    }
  }

  #record(locator: NoteLocator, logicalPath: string, raw: string): NoteRecord {
    let parsed;
    try {
      parsed = parseNoteMarkdown(raw);
      assertNoteMatchesLocator(parsed.frontmatter, locator);
    } catch (error) {
      throw new NoteStoreError(
        "identity_mismatch",
        `${logicalPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return Object.freeze({
      ...parsed,
      locator: Object.freeze({ ...locator }),
      logical_path: logicalPath,
      content_hash: sha256(raw),
    });
  }

  async #writeExclusive(logicalPath: string, value: string): Promise<boolean> {
    return this.#atomicWrite(logicalPath, value, "exclusive");
  }

  async #writeReplace(logicalPath: string, value: string): Promise<void> {
    await this.#atomicWrite(logicalPath, value, "replace");
  }

  async #atomicWrite(
    logicalPath: string,
    value: string,
    mode: "exclusive" | "replace",
  ): Promise<boolean> {
    const target = await this.#logicalTarget(logicalPath, true);
    await this.#assertSafeTargetOrAbsent(target);
    const tempName = `.aisb-note-${validatePathIdentifier(this.#createId(), "temporary id")}.tmp`;
    const tempPath = resolve(dirname(target), tempName);
    let tempExists = false;
    try {
      const handle = await this.#fs.open(tempPath, "wx", 0o600);
      tempExists = true;
      try {
        await handle.writeFile(value, { encoding: "utf8" });
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.#step("temporary_file_synced", logicalPath);
      await this.#assertSafeExistingDirectory(dirname(target), (await this.#roots()).notes_root);
      await this.#assertSafeTargetOrAbsent(target);
      await this.#step("before_publish", logicalPath);

      if (mode === "exclusive") {
        try {
          await this.#fs.link(tempPath, target);
        } catch (error) {
          if (isErrno(error, "EEXIST")) return false;
          throw error;
        }
      } else {
        await this.#fs.rename(tempPath, target);
        tempExists = false;
      }
      await this.#step("published", logicalPath);

      if (tempExists) {
        await this.#fs.unlink(tempPath);
        tempExists = false;
      }
      await this.#syncDirectory(dirname(target));
      await this.#step("directory_synced", logicalPath);
      return true;
    } finally {
      if (tempExists) {
        try {
          await this.#fs.unlink(tempPath);
        } catch (error) {
          if (!isErrno(error, "ENOENT")) throw error;
        }
      }
    }
  }

  async #assertSafeTargetOrAbsent(target: string): Promise<void> {
    try {
      const stat = await this.#fs.lstat(target);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new NoteStoreError("unsafe_path", `${target} is not a regular file`);
      }
    } catch (error) {
      if (isErrno(error, "ENOENT")) return;
      throw error;
    }
  }

  async #syncDirectory(directory: string): Promise<void> {
    let handle: NoteFileHandle | undefined;
    try {
      handle = await this.#fs.open(directory, "r");
      await handle.sync();
    } catch (error) {
      if (!isErrno(error, "EINVAL") && !isErrno(error, "ENOTSUP")) throw error;
    } finally {
      await handle?.close();
    }
  }

  async #ensureRecoverySnapshot(note: NoteRecord): Promise<string> {
    const snapshotPath = `notes/recovery/${validatePathIdentifier(note.frontmatter.note_id, "note_id")}/${String(note.frontmatter.revision).padStart(12, "0")}-${note.content_hash.slice(0, 16)}.md`;
    // Preserve exact valid manual edits (including harmless YAML/line-ending
    // choices) when the canonical bytes still match this record. Store-owned
    // writes fall back to the deterministic codec only if the source moved.
    let serialized = serializeNoteMarkdown(note);
    try {
      const canonical = await this.#readLogicalFile(note.logical_path);
      if (sha256(canonical) === note.content_hash) serialized = canonical;
    } catch (error) {
      if (!(error instanceof NoteStoreError && error.code === "not_found")) throw error;
    }
    const created = await this.#writeExclusive(snapshotPath, serialized);
    if (!created) {
      const existing = await this.#readLogicalFile(snapshotPath);
      if (existing !== serialized) {
        throw new NoteStoreError(
          "identity_mismatch",
          `recovery snapshot collision at ${snapshotPath}`,
        );
      }
    }
    return snapshotPath;
  }

  async #writeConflictCopy(
    current: NoteRecord,
    markdown: string,
    candidateFrontmatter: NoteFrontmatter,
  ): Promise<string> {
    return this.#writeRawConflictCopy(
      current.frontmatter.note_id,
      serializeNoteMarkdown({ frontmatter: candidateFrontmatter, markdown }),
      "conflict",
    );
  }

  async #writeRawConflictCopy(
    noteId: string,
    raw: string,
    label: "conflict" | "displaced",
  ): Promise<string> {
    const timestamp = makeAdHocTimestampSlug(this.#nowIso());
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const copyPath = `notes/conflicts/${validatePathIdentifier(noteId, "note_id")}/${timestamp}-${label}-${validatePathIdentifier(this.#createId(), "conflict id")}.md`;
      if (await this.#writeExclusive(copyPath, raw)) return copyPath;
    }
    throw new NoteStoreError("invalid_request", "could not allocate a conflict-copy path");
  }

  async #appendRevision(
    note: NoteRecord,
    operation: RevisionJournalEntry["operation"],
  ): Promise<void> {
    const logicalPath = `notes/revisions/${validatePathIdentifier(note.frontmatter.note_id, "note_id")}.jsonl`;
    const target = await this.#logicalTarget(logicalPath, true);
    await this.#assertSafeTargetOrAbsent(target);
    const entry: RevisionJournalEntry = Object.freeze({
      schema_version: 1,
      note_id: note.frontmatter.note_id,
      revision: note.frontmatter.revision,
      content_hash: note.content_hash,
      logical_path: note.logical_path,
      operation,
      recorded_at: this.#nowIso(),
    });
    const handle = await this.#fs.open(target, "a", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(entry)}\n`, { encoding: "utf8" });
      await handle.sync();
    } finally {
      await handle.close();
    }
    await this.#syncDirectory(dirname(target));
    await this.#step("revision_journal_synced", logicalPath);
  }

  async #readRecoverySnapshots(
    noteId: string,
    locator: NoteLocator,
  ): Promise<readonly { readonly path: string; readonly raw: string; readonly note: NoteRecord }[]> {
    const roots = await this.#roots();
    const directory = resolve(roots.notes_root, "recovery", noteId);
    if (!(await this.#exists(directory))) return Object.freeze([]);
    await this.#assertSafeExistingDirectory(directory, roots.notes_root);
    const entries = await this.#fs.readdir(directory, { withFileTypes: true });
    const snapshots: { path: string; raw: string; note: NoteRecord }[] = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        throw new NoteStoreError("unsafe_path", `recovery entry ${entry.name} is a symlink`);
      }
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      validatePathIdentifier(entry.name, "recovery filename");
      const logicalPath = `notes/recovery/${noteId}/${entry.name}`;
      const raw = await this.#readLogicalFile(logicalPath);
      try {
        const parsed = parseNoteMarkdown(raw);
        if (parsed.frontmatter.note_id !== noteId) continue;
        assertNoteMatchesLocator(parsed.frontmatter, locator);
        snapshots.push({
          path: logicalPath,
          raw,
          note: Object.freeze({
            ...parsed,
            locator: Object.freeze({ ...locator }),
            logical_path: noteLogicalPath(locator),
            content_hash: sha256(raw),
          }),
        });
      } catch {
        // A malformed snapshot is never chosen over an older valid one.
      }
    }
    snapshots.sort((left, right) => right.note.frontmatter.revision - left.note.frontmatter.revision);
    return Object.freeze(snapshots);
  }

  async #walkMarkdown(
    directory: string,
    notesRoot: string,
    output: string[],
  ): Promise<void> {
    const entries = (await this.#fs.readdir(directory, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      const target = resolve(directory, entry.name);
      this.#assertWithin(target, notesRoot);
      if (entry.isSymbolicLink()) {
        throw new NoteStoreError("unsafe_path", `${target} is a symlink`);
      }
      if (entry.isDirectory()) {
        await this.#assertSafeExistingDirectory(target, notesRoot);
        await this.#walkMarkdown(target, notesRoot, output);
        continue;
      }
      if (!entry.isFile()) {
        throw new NoteStoreError("unsafe_path", `${target} is not a regular file`);
      }
      if (!entry.name.endsWith(".md")) continue;
      const rel = relative(notesRoot, target).split(sep).join("/");
      output.push(`notes/${rel}`);
    }
  }

  #locatorForDiscoveredPath(logicalPath: string, frontmatter: NoteFrontmatter): NoteLocator {
    const components = logicalPath.split("/");
    if (
      components.length === 4 &&
      components[0] === "notes" &&
      components[1] === "days" &&
      components[3] === "overview.md"
    ) {
      return {
        kind: "day",
        programme_day_id: validatePathIdentifier(components[2] ?? "", "programme_day_id"),
      };
    }
    if (
      components.length === 4 &&
      components[0] === "notes" &&
      components[1] === "lessons" &&
      components[3] === "notes.md"
    ) {
      return {
        kind: "lesson",
        section_id: validatePathIdentifier(components[2] ?? "", "section_id"),
      };
    }
    if (
      components.length === 4 &&
      components[0] === "notes" &&
      components[1] === "events" &&
      components[3] === "notes.md"
    ) {
      return {
        kind: "event",
        event_binding_id: validatePathIdentifier(components[2] ?? "", "event_binding_id"),
      };
    }
    if (
      components.length === 4 &&
      components[0] === "notes" &&
      components[1] === "ad-hoc"
    ) {
      const creationDate = validateCalendarDate(components[2] ?? "", "creation_date");
      const filename = components[3] ?? "";
      if (filename === `${frontmatter.note_id}.md`) {
        return {
          kind: "ad_hoc",
          creation_date: creationDate,
          note_id: frontmatter.note_id,
        };
      }
      const suffix = `-${frontmatter.note_id}.md`;
      if (!filename.endsWith(suffix)) {
        throw new NoteStoreError(
          "identity_mismatch",
          `${logicalPath}: ad-hoc filename does not contain its immutable note_id`,
        );
      }
      return {
        kind: "ad_hoc",
        creation_date: creationDate,
        timestamp_slug: validateAdHocTimestampSlug(filename.slice(0, -suffix.length)),
        note_id: frontmatter.note_id,
      };
    }
    throw new NoteStoreError("identity_mismatch", `${logicalPath}: unexpected canonical path shape`);
  }

  async #exists(path: string): Promise<boolean> {
    try {
      await this.#fs.lstat(path);
      return true;
    } catch (error) {
      if (isErrno(error, "ENOENT")) return false;
      throw error;
    }
  }

  async #step(step: NoteAtomicStep, target: string): Promise<void> {
    await this.#onAtomicStep?.(step, Object.freeze({ target }));
  }

  async #withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(key) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const tail = previous.then(() => gate);
    this.#locks.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
      if (this.#locks.get(key) === tail) this.#locks.delete(key);
    }
  }
}
