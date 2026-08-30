import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import * as nodeFsPromises from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { z } from "zod";

import { noteLogicalPath, validatePathIdentifier, type NoteRecord } from "../../shared/notes";
import type { MarkdownNoteStore } from "./store";
import {
  VSCODE_EXECUTABLES,
  type VSCodeExecutableDiscovery,
  type WorkspaceLaunchSpec,
  type WorkspaceProcessLauncher,
} from "../workspace/service";

export {
  NodeVSCodeExecutableDiscovery,
  NodeWorkspaceProcessLauncher,
} from "../workspace/service";
export { VSCODE_EXECUTABLES };

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const MAX_NOTE_BYTES = 20_000_000;

const prepareRequestSchema = z
  .object({
    note_id: z.string().min(1).max(128),
    expected_revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    expected_content_hash: z.string().regex(HASH_PATTERN),
  })
  .strict();

const launchTokenSchema = z
  .object({
    kind: z.literal("saved-note-vscode-launch-v1"),
    token_id: z.string().min(8).max(200),
    note_id: z.string().min(1).max(128),
    logical_path: z.string().min(1).max(1_000),
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    content_hash: z.string().regex(HASH_PATTERN),
  })
  .strict();

export interface PrepareSavedNoteOpenRequest {
  readonly note_id: string;
  /** Last disk revision acknowledged by the note-save response. */
  readonly expected_revision: number;
  /** Last complete-file hash acknowledged by the note-save response. */
  readonly expected_content_hash: string;
}

export interface SavedNoteLaunchToken {
  readonly kind: "saved-note-vscode-launch-v1";
  readonly token_id: string;
  readonly note_id: string;
  readonly logical_path: string;
  readonly revision: number;
  readonly content_hash: string;
}

export type OpenSavedNoteInVSCodeResult =
  | {
      readonly status: "opened";
      readonly note_id: string;
      readonly logical_path: string;
      readonly command: readonly string[];
    }
  | {
      readonly status: "launch_failed";
      readonly reason: "editor_not_found" | "editor_not_allowed" | "spawn_failed";
      readonly note_id: string;
      readonly logical_path: string;
      readonly retryable: true;
      readonly command: readonly string[];
    };

interface NoteOpenFileHandle {
  readFile(): Promise<Buffer>;
  stat(): Promise<Stats>;
  close(): Promise<void>;
}

export interface NoteOpenFileSystem {
  lstat(path: string): Promise<Stats>;
  realpath(path: string): Promise<string>;
  open(path: string, flags: number): Promise<NoteOpenFileHandle>;
}

const nodeFileSystem: NoteOpenFileSystem = {
  lstat: (path) => nodeFsPromises.lstat(path),
  realpath: (path) => nodeFsPromises.realpath(path),
  open: (path, flags) => nodeFsPromises.open(path, flags),
};

export interface SavedNoteVSCodeServiceDependencies {
  readonly executable_discovery: VSCodeExecutableDiscovery;
  readonly launcher: WorkspaceProcessLauncher;
  readonly file_system?: NoteOpenFileSystem;
  readonly create_token_id?: () => string;
  readonly process_environment?: Readonly<Record<string, string | undefined>>;
}

export type SavedNoteVSCodeServiceErrorCode =
  | "invalid_request"
  | "note_not_found"
  | "ambiguous_note"
  | "stale_note"
  | "unsafe_path"
  | "protected_target"
  | "invalid_target"
  | "invalid_token";

export class SavedNoteVSCodeServiceError extends Error {
  constructor(
    readonly code: SavedNoteVSCodeServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SavedNoteVSCodeServiceError";
  }
}

interface ServiceRoots {
  readonly state_root: string;
  readonly notes_root: string;
  readonly companion_root: string;
}

interface FileFingerprint {
  readonly content_hash: string;
  readonly size: number;
  readonly device: number;
  readonly inode: number;
}

interface BoundSavedNote {
  readonly note_id: string;
  readonly locator: NoteRecord["locator"];
  readonly logical_path: string;
  readonly revision: number;
  readonly content_hash: string;
  readonly target_path: string;
  readonly roots: ServiceRoots;
  readonly fingerprint: FileFingerprint;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function sameFingerprint(left: FileFingerprint, right: FileFingerprint): boolean {
  return (
    left.content_hash === right.content_hash &&
    left.size === right.size &&
    left.device === right.device &&
    left.inode === right.inode
  );
}

function safeLaunchEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  const allowed = ["HOME", "USER", "LOGNAME", "PATH", "TMPDIR", "LANG", "LC_ALL", "DISPLAY"] as const;
  const output: Record<string, string> = {};
  for (const key of allowed) {
    const value = source[key];
    if (value !== undefined) output[key] = value;
  }
  return Object.freeze(output);
}

/**
 * Opens only a current, store-resolved Markdown note. This service has no
 * create or save operation: callers must first persist the note through
 * MarkdownNoteStore and pass the acknowledged revision plus complete-file
 * hash to prepareOpen().
 */
export class SavedNoteVSCodeService {
  readonly #configuredStateRoot: string;
  readonly #configuredCompanionRoot: string;
  readonly #noteStore: Pick<MarkdownNoteStore, "list" | "read">;
  readonly #dependencies: SavedNoteVSCodeServiceDependencies;
  readonly #fs: NoteOpenFileSystem;
  readonly #createTokenId: () => string;
  readonly #launchEnvironment: Readonly<Record<string, string>>;
  readonly #launches = new Map<string, BoundSavedNote>();
  #rootsPromise: Promise<ServiceRoots> | undefined;

  constructor(
    input: {
      readonly state_root: string;
      readonly companion_root: string;
      readonly note_store: Pick<MarkdownNoteStore, "list" | "read">;
    },
    dependencies: SavedNoteVSCodeServiceDependencies,
  ) {
    if (!isAbsolute(input.state_root) || !isAbsolute(input.companion_root)) {
      throw new SavedNoteVSCodeServiceError("invalid_request", "State and companion roots must be absolute");
    }
    this.#configuredStateRoot = resolve(input.state_root);
    this.#configuredCompanionRoot = resolve(input.companion_root);
    this.#noteStore = input.note_store;
    this.#dependencies = dependencies;
    this.#fs = dependencies.file_system ?? nodeFileSystem;
    this.#createTokenId = dependencies.create_token_id ?? randomUUID;
    this.#launchEnvironment = safeLaunchEnvironment(dependencies.process_environment ?? process.env);
  }

  async prepareOpen(input: PrepareSavedNoteOpenRequest | unknown): Promise<SavedNoteLaunchToken> {
    const parsed = prepareRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new SavedNoteVSCodeServiceError("invalid_request", "The saved-note open request is invalid");
    }
    try {
      validatePathIdentifier(parsed.data.note_id, "note_id");
    } catch {
      throw new SavedNoteVSCodeServiceError("invalid_request", "The logical note ID is invalid");
    }

    const record = await this.#resolveCurrentRecord(
      parsed.data.note_id,
      parsed.data.expected_revision,
      parsed.data.expected_content_hash,
    );
    const roots = await this.#roots();
    const targetPath = await this.#resolveCanonicalNoteTarget(record, roots);
    const fingerprint = await this.#fingerprintRegularFile(targetPath);
    if (fingerprint.content_hash !== record.content_hash) {
      throw new SavedNoteVSCodeServiceError("stale_note", "The note changed after the disk save was resolved");
    }

    const binding: BoundSavedNote = Object.freeze({
      note_id: record.frontmatter.note_id,
      locator: record.locator,
      logical_path: record.logical_path,
      revision: record.frontmatter.revision,
      content_hash: record.content_hash,
      target_path: targetPath,
      roots,
      fingerprint,
    });
    const tokenId = this.#issueTokenId();
    this.#launches.set(tokenId, binding);
    return Object.freeze({
      kind: "saved-note-vscode-launch-v1",
      token_id: tokenId,
      note_id: binding.note_id,
      logical_path: binding.logical_path,
      revision: binding.revision,
      content_hash: binding.content_hash,
    });
  }

  async launchVSCode(token: SavedNoteLaunchToken | unknown): Promise<OpenSavedNoteInVSCodeResult> {
    const parsed = launchTokenSchema.safeParse(token);
    if (!parsed.success) {
      throw new SavedNoteVSCodeServiceError("invalid_token", "The saved-note launch token is invalid");
    }
    const binding = this.#launches.get(parsed.data.token_id);
    if (binding === undefined || !this.#tokenMatchesBinding(parsed.data, binding)) {
      throw new SavedNoteVSCodeServiceError("invalid_token", "The saved-note launch token binding is invalid");
    }

    await this.#revalidateRoots(binding.roots);
    const current = await this.#resolveCurrentRecord(
      binding.note_id,
      binding.revision,
      binding.content_hash,
    );
    const currentTarget = await this.#resolveCanonicalNoteTarget(current, binding.roots);
    if (currentTarget !== binding.target_path || current.logical_path !== binding.logical_path) {
      throw new SavedNoteVSCodeServiceError("stale_note", "The logical note path changed after preparation");
    }
    const fingerprint = await this.#fingerprintRegularFile(currentTarget);
    if (!sameFingerprint(fingerprint, binding.fingerprint)) {
      throw new SavedNoteVSCodeServiceError("stale_note", "The saved note changed after preparation");
    }

    const args = Object.freeze([
      "--reuse-window",
      binding.roots.companion_root,
      "--goto",
      `${binding.target_path}:1:1`,
    ]);
    let discovered: string | null;
    try {
      discovered = await this.#dependencies.executable_discovery.discover();
    } catch {
      return this.#launchFailure(binding, "editor_not_found", ["code", ...args]);
    }
    if (discovered === null) {
      return this.#launchFailure(binding, "editor_not_found", ["code", ...args]);
    }
    if (!isAbsolute(discovered) || !(VSCODE_EXECUTABLES as readonly string[]).includes(discovered)) {
      return this.#launchFailure(binding, "editor_not_allowed", ["code", ...args]);
    }

    const spec: WorkspaceLaunchSpec = Object.freeze({
      executable: discovered,
      args,
      cwd: binding.roots.companion_root,
      shell: false as const,
      env: this.#launchEnvironment,
    });
    try {
      await this.#dependencies.launcher.launch(spec);
    } catch {
      return this.#launchFailure(binding, "spawn_failed", [discovered, ...args]);
    }
    return Object.freeze({
      status: "opened",
      note_id: binding.note_id,
      logical_path: binding.logical_path,
      command: Object.freeze([discovered, ...args]),
    });
  }

  async #resolveCurrentRecord(
    noteId: string,
    expectedRevision: number,
    expectedContentHash: string,
  ): Promise<NoteRecord> {
    let summaries;
    try {
      summaries = await this.#noteStore.list();
    } catch {
      throw new SavedNoteVSCodeServiceError("invalid_target", "The note index could not be read safely");
    }
    const matches = summaries.filter((summary) => summary.note_id === noteId);
    if (matches.length === 0) {
      throw new SavedNoteVSCodeServiceError("note_not_found", "The saved note does not exist");
    }
    if (matches.length !== 1) {
      throw new SavedNoteVSCodeServiceError("ambiguous_note", "The logical note ID is not unique");
    }
    const summary = matches[0];
    if (summary === undefined) {
      throw new SavedNoteVSCodeServiceError("note_not_found", "The saved note does not exist");
    }
    if (summary.revision !== expectedRevision || summary.content_hash !== expectedContentHash) {
      throw new SavedNoteVSCodeServiceError("stale_note", "The browser has not acknowledged the current disk save");
    }

    let record: NoteRecord;
    try {
      record = await this.#noteStore.read(summary.locator);
    } catch {
      throw new SavedNoteVSCodeServiceError("invalid_target", "The saved note could not be read safely");
    }
    const canonicalLogicalPath = noteLogicalPath(record.locator);
    if (
      record.frontmatter.note_id !== noteId ||
      record.logical_path !== summary.logical_path ||
      record.logical_path !== canonicalLogicalPath
    ) {
      throw new SavedNoteVSCodeServiceError("protected_target", "The note index resolved a non-canonical target");
    }
    if (
      record.frontmatter.revision !== expectedRevision ||
      record.content_hash !== expectedContentHash ||
      record.frontmatter.revision !== summary.revision ||
      record.content_hash !== summary.content_hash
    ) {
      throw new SavedNoteVSCodeServiceError("stale_note", "The note changed while its disk save was resolved");
    }
    return record;
  }

  async #roots(): Promise<ServiceRoots> {
    this.#rootsPromise ??= (async () => {
      const stateRoot = await this.#canonicalRealDirectory(this.#configuredStateRoot, "state root");
      const companionRoot = await this.#canonicalRealDirectory(this.#configuredCompanionRoot, "companion root");
      const notesRoot = resolve(stateRoot, "notes");
      await this.#assertRealDirectory(notesRoot);
      if (!isWithin(stateRoot, notesRoot)) {
        throw new SavedNoteVSCodeServiceError("unsafe_path", "The notes directory escapes the state root");
      }
      return Object.freeze({ state_root: stateRoot, notes_root: notesRoot, companion_root: companionRoot });
    })();
    return this.#rootsPromise;
  }

  async #canonicalRealDirectory(path: string, label: string): Promise<string> {
    let stats: Stats;
    try {
      stats = await this.#fs.lstat(path);
    } catch {
      throw new SavedNoteVSCodeServiceError("invalid_target", `The ${label} does not exist`);
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new SavedNoteVSCodeServiceError("unsafe_path", `The ${label} is not a real directory`);
    }
    return this.#fs.realpath(path);
  }

  async #assertRealDirectory(path: string): Promise<void> {
    let stats: Stats;
    try {
      stats = await this.#fs.lstat(path);
    } catch {
      throw new SavedNoteVSCodeServiceError("invalid_target", "A note directory does not exist");
    }
    if (stats.isSymbolicLink() || !stats.isDirectory() || (await this.#fs.realpath(path)) !== path) {
      throw new SavedNoteVSCodeServiceError("unsafe_path", "A note directory is unsafe");
    }
  }

  async #resolveCanonicalNoteTarget(record: NoteRecord, roots: ServiceRoots): Promise<string> {
    const canonicalLogicalPath = noteLogicalPath(record.locator);
    if (record.logical_path !== canonicalLogicalPath || !record.logical_path.startsWith("notes/")) {
      throw new SavedNoteVSCodeServiceError("protected_target", "The note does not have a canonical logical path");
    }
    if (!record.logical_path.endsWith(".md")) {
      throw new SavedNoteVSCodeServiceError("protected_target", "Only companion Markdown notes may be opened");
    }
    const components = record.logical_path.split("/");
    if (components.length < 4 || components[0] !== "notes") {
      throw new SavedNoteVSCodeServiceError("protected_target", "The logical note path is incomplete");
    }
    for (const component of components) {
      try {
        validatePathIdentifier(component, "note path component");
      } catch {
        throw new SavedNoteVSCodeServiceError("unsafe_path", "The logical note path contains an unsafe component");
      }
    }
    if (!["days", "lessons", "events", "ad-hoc"].includes(components[1] ?? "")) {
      throw new SavedNoteVSCodeServiceError("protected_target", "The logical note path names a protected note area");
    }

    let current = roots.state_root;
    for (const component of components.slice(0, -1)) {
      current = resolve(current, component);
      if (!isWithin(roots.state_root, current)) {
        throw new SavedNoteVSCodeServiceError("unsafe_path", "The logical note path escapes the state root");
      }
      await this.#assertRealDirectory(current);
    }
    const filename = components.at(-1);
    if (filename === undefined) {
      throw new SavedNoteVSCodeServiceError("protected_target", "The logical note path has no filename");
    }
    const target = resolve(current, filename);
    if (!isWithin(roots.notes_root, target) || !isWithin(roots.state_root, target)) {
      throw new SavedNoteVSCodeServiceError("unsafe_path", "The logical note target escapes the notes directory");
    }
    return target;
  }

  async #fingerprintRegularFile(path: string): Promise<FileFingerprint> {
    let stats: Stats;
    try {
      stats = await this.#fs.lstat(path);
    } catch {
      throw new SavedNoteVSCodeServiceError("invalid_target", "The saved note does not exist on disk");
    }
    if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1) {
      throw new SavedNoteVSCodeServiceError("unsafe_path", "The saved note target is not a regular file");
    }
    if (stats.size > MAX_NOTE_BYTES || (await this.#fs.realpath(path)) !== path) {
      throw new SavedNoteVSCodeServiceError("invalid_target", "The saved note target is invalid");
    }

    let handle: NoteOpenFileHandle;
    try {
      handle = await this.#fs.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    } catch {
      throw new SavedNoteVSCodeServiceError("invalid_target", "The saved note could not be opened safely");
    }
    try {
      const openedStats = await handle.stat();
      if (!openedStats.isFile() || openedStats.nlink !== 1 || openedStats.size > MAX_NOTE_BYTES) {
        throw new SavedNoteVSCodeServiceError("invalid_target", "The saved note is not a regular Markdown file");
      }
      const bytes = await handle.readFile();
      if (bytes.byteLength !== openedStats.size) {
        throw new SavedNoteVSCodeServiceError("stale_note", "The saved note changed while it was read");
      }
      return Object.freeze({
        content_hash: sha256(bytes),
        size: bytes.byteLength,
        device: openedStats.dev,
        inode: openedStats.ino,
      });
    } finally {
      await handle.close();
    }
  }

  async #revalidateRoots(expected: ServiceRoots): Promise<void> {
    const stateRoot = await this.#canonicalRealDirectory(this.#configuredStateRoot, "state root");
    const companionRoot = await this.#canonicalRealDirectory(this.#configuredCompanionRoot, "companion root");
    if (stateRoot !== expected.state_root || companionRoot !== expected.companion_root) {
      throw new SavedNoteVSCodeServiceError("stale_note", "A configured root changed after preparation");
    }
    await this.#assertRealDirectory(expected.notes_root);
  }

  #tokenMatchesBinding(token: z.infer<typeof launchTokenSchema>, binding: BoundSavedNote): boolean {
    return (
      token.note_id === binding.note_id &&
      token.logical_path === binding.logical_path &&
      token.revision === binding.revision &&
      token.content_hash === binding.content_hash
    );
  }

  #issueTokenId(): string {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const tokenId = this.#createTokenId();
      if (!/^[A-Za-z0-9_-]{8,200}$/.test(tokenId)) {
        throw new SavedNoteVSCodeServiceError("invalid_request", "The launch-token generator is unsafe");
      }
      if (!this.#launches.has(tokenId)) return tokenId;
    }
    throw new SavedNoteVSCodeServiceError("invalid_request", "A unique note launch token could not be issued");
  }

  #launchFailure(
    binding: BoundSavedNote,
    reason: "editor_not_found" | "editor_not_allowed" | "spawn_failed",
    command: readonly string[],
  ): OpenSavedNoteInVSCodeResult {
    return Object.freeze({
      status: "launch_failed",
      reason,
      note_id: binding.note_id,
      logical_path: binding.logical_path,
      retryable: true,
      command: Object.freeze([...command]),
    });
  }
}
