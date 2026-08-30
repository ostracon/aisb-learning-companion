import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import * as nodeFsPromises from "node:fs/promises";
import { spawn } from "node:child_process";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { z } from "zod";

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const SECTION_ID_PATTERN = /^\d+\.\d+$/;
const PARTICIPANT_FILENAME_PATTERN = /^(?:day\d+_answers|answers?)\.(?:py|md|ipynb)$/i;
const MAX_STARTER_BYTES = 1_000_000;

/**
 * Executables are a server-owned policy, not a request parameter. Discovery
 * may select one of these paths, but it cannot add another executable.
 */
export const VSCODE_EXECUTABLES = Object.freeze([
  "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
  "/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders",
] as const);

const VSCODE_DISCOVERY_CANDIDATES = Object.freeze([
  ...VSCODE_EXECUTABLES,
  "/opt/homebrew/bin/code",
  "/usr/local/bin/code",
] as const);

const participantDeclarationSchema = z
  .object({
    filename: z.string().min(1).max(255),
    declaration_hash: z.string().regex(HASH_PATTERN),
    starter: z
      .object({
        provenance: z.literal("application-sanitized-visible-scaffold-v1"),
        content: z.string().max(MAX_STARTER_BYTES),
        content_hash: z.string().regex(HASH_PATTERN),
      })
      .strict(),
    cursor_line: z.number().int().min(1).max(1_000_000),
  })
  .strict();

const linkedSectionSchema = z
  .object({
    section_id: z.string().regex(SECTION_ID_PATTERN),
    directory_relative_path: z.string().min(1).max(255),
    source_hash: z.string().regex(HASH_PATTERN),
    participant_files: z.array(participantDeclarationSchema).min(1).max(20),
  })
  .strict();

const repositoryStateSchema = z
  .object({
    repository_identity: z.string().min(1).max(500),
    revision: z.string().min(1).max(500),
  })
  .strict();

const resolveRequestSchema = z
  .object({
    section_id: z.string().regex(SECTION_ID_PATTERN),
    expected_section_source_hash: z.string().regex(HASH_PATTERN),
    expected_declaration_hash: z.string().regex(HASH_PATTERN),
    expected_starter_hash: z.string().regex(HASH_PATTERN),
    requested_filename: z.string().min(1).max(255).optional(),
  })
  .strict();

const resolutionTokenSchema = z
  .object({
    kind: z.literal("workspace-resolution-v1"),
    token_id: z.string().min(8).max(200),
    section_id: z.string().regex(SECTION_ID_PATTERN),
    target_relative_path: z.string().min(1).max(1_000),
    cursor_line: z.number().int().min(1).max(1_000_000),
  })
  .strict();

const createTokenSchema = z
  .object({
    kind: z.literal("workspace-create-v1"),
    token_id: z.string().min(8).max(200),
    section_id: z.string().regex(SECTION_ID_PATTERN),
    target_relative_path: z.string().min(1).max(1_000),
    starter_hash: z.string().regex(HASH_PATTERN),
  })
  .strict();

const launchTokenSchema = z
  .object({
    kind: z.literal("workspace-launch-v1"),
    token_id: z.string().min(8).max(200),
    section_id: z.string().regex(SECTION_ID_PATTERN),
    target_relative_path: z.string().min(1).max(1_000),
    content_hash: z.string().regex(HASH_PATTERN),
    cursor_line: z.number().int().min(1).max(1_000_000),
    created_by_service: z.boolean(),
  })
  .strict();

type ParticipantFileDeclaration = z.infer<typeof participantDeclarationSchema>;
export type LinkedSectionDescriptor = z.infer<typeof linkedSectionSchema>;
export type WorkspaceRepositoryState = z.infer<typeof repositoryStateSchema>;

export interface ParticipantFileDiscovery {
  /** Returns only sections explicitly linked by the companion's curriculum projection. */
  resolveLinkedSection(sectionId: string): Promise<unknown | null>;
}

export interface WorkspaceRepositoryStateReader {
  read(canonicalAisbRoot: string): Promise<unknown>;
}

export interface VSCodeExecutableDiscovery {
  discover(): Promise<string | null>;
}

export interface WorkspaceLaunchSpec {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly shell: false;
  readonly env: Readonly<Record<string, string>>;
}

export interface WorkspaceProcessLauncher {
  launch(spec: WorkspaceLaunchSpec): Promise<void>;
}

interface WorkspaceFileHandle {
  writeFile(data: string | Uint8Array): Promise<void>;
  readFile(): Promise<Buffer>;
  stat(): Promise<Stats>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface WorkspaceFileSystem {
  realpath(path: string): Promise<string>;
  lstat(path: string): Promise<Stats>;
  open(path: string, flags: string | number, mode?: number): Promise<WorkspaceFileHandle>;
  link(existingPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

const nodeFileSystem: WorkspaceFileSystem = {
  realpath: (path) => nodeFsPromises.realpath(path),
  lstat: (path) => nodeFsPromises.lstat(path),
  open: (path, flags, mode) => nodeFsPromises.open(path, flags, mode),
  link: (existingPath, newPath) => nodeFsPromises.link(existingPath, newPath),
  unlink: (path) => nodeFsPromises.unlink(path),
};

export interface WorkspaceLaunchServiceDependencies {
  readonly section_discovery: ParticipantFileDiscovery;
  readonly repository_state: WorkspaceRepositoryStateReader;
  readonly executable_discovery: VSCodeExecutableDiscovery;
  readonly launcher: WorkspaceProcessLauncher;
  readonly file_system?: WorkspaceFileSystem;
  /** Deterministic seam for tests. Production uses cryptographically random UUIDs. */
  readonly create_token_id?: () => string;
  /** Explicit source for the small child-process environment allowlist. */
  readonly process_environment?: Readonly<Record<string, string | undefined>>;
}

export type WorkspaceLaunchErrorCode =
  | "invalid_request"
  | "section_not_linked"
  | "ambiguous_filename"
  | "undeclared_filename"
  | "protected_filename"
  | "unsafe_path"
  | "stale_preview"
  | "invalid_token"
  | "invalid_target"
  | "filesystem_error";

export class WorkspaceLaunchError extends Error {
  constructor(
    readonly code: WorkspaceLaunchErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceLaunchError";
  }
}

export interface ResolveParticipantFileRequest {
  readonly section_id: string;
  readonly expected_section_source_hash: string;
  readonly expected_declaration_hash: string;
  readonly expected_starter_hash: string;
  readonly requested_filename?: string;
}

export interface ResolvedParticipantFileToken {
  readonly kind: "workspace-resolution-v1";
  readonly token_id: string;
  readonly section_id: string;
  readonly target_relative_path: string;
  readonly cursor_line: number;
}

export interface CreateParticipantFileToken {
  readonly kind: "workspace-create-v1";
  readonly token_id: string;
  readonly section_id: string;
  readonly target_relative_path: string;
  readonly starter_hash: string;
}

export interface LaunchParticipantFileToken {
  readonly kind: "workspace-launch-v1";
  readonly token_id: string;
  readonly section_id: string;
  readonly target_relative_path: string;
  readonly content_hash: string;
  readonly cursor_line: number;
  readonly created_by_service: boolean;
}

export type PreviewOpenResult =
  | {
      readonly status: "existing";
      readonly target_relative_path: string;
      readonly launch_token: LaunchParticipantFileToken;
    }
  | {
      readonly status: "absent";
      readonly target_relative_path: string;
      readonly starter_content: string;
      readonly create_token: CreateParticipantFileToken;
    };

export type CreateIfAbsentResult =
  | {
      readonly status: "created";
      readonly target_relative_path: string;
      readonly launch_token: LaunchParticipantFileToken;
    }
  | {
      readonly status: "already_existed";
      readonly target_relative_path: string;
      readonly requires_new_preview: true;
    };

export type LaunchVSCodeResult =
  | {
      readonly status: "opened";
      readonly target_relative_path: string;
      readonly created_by_service: boolean;
      readonly command: readonly string[];
    }
  | {
      readonly status: "launch_failed";
      readonly reason: "editor_not_found" | "editor_not_allowed" | "spawn_failed";
      readonly target_relative_path: string;
      readonly created_by_service: boolean;
      readonly retryable: true;
      readonly command: readonly string[];
    };

interface WorkspaceRoots {
  readonly canonical_root: string;
}

interface BoundTarget {
  readonly canonical_root: string;
  readonly repository: WorkspaceRepositoryState;
  readonly descriptor: LinkedSectionDescriptor;
  readonly declaration: ParticipantFileDeclaration;
  readonly section_absolute_path: string;
  readonly target_absolute_path: string;
  readonly target_relative_path: string;
}

interface FileFingerprint {
  readonly content_hash: string;
  readonly size: number;
  readonly device: number;
  readonly inode: number;
}

interface CreateRecord {
  readonly binding: BoundTarget;
  replay?: CreateIfAbsentResult;
}

interface LaunchRecord {
  readonly binding: BoundTarget;
  readonly fingerprint: FileFingerprint;
  readonly created_by_service: boolean;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

function isStrictDescendant(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function validateSectionDirectory(sectionId: string, directory: string): void {
  if (
    directory.includes("\0") ||
    directory.includes("/") ||
    directory.includes("\\") ||
    directory === "." ||
    directory === ".." ||
    !directory.startsWith(`${sectionId}-`) ||
    directory.length === sectionId.length + 1
  ) {
    throw new WorkspaceLaunchError("unsafe_path", "The linked section directory is unsafe");
  }
}

function validateParticipantFilename(filename: string): void {
  if (
    filename.includes("\0") ||
    filename.includes("/") ||
    filename.includes("\\") ||
    filename === "." ||
    filename === ".."
  ) {
    throw new WorkspaceLaunchError("unsafe_path", "The participant filename must be a single path component");
  }
  if (!PARTICIPANT_FILENAME_PATTERN.test(filename)) {
    throw new WorkspaceLaunchError(
      "protected_filename",
      "Only an explicitly declared participant answer filename may be opened",
    );
  }
  if (/(?:solution|reference|test|instructions?|secret|credential|token|private[_-]?key)/i.test(filename)) {
    throw new WorkspaceLaunchError("protected_filename", "The declared filename matches a protected pattern");
  }
}

function validateStarter(declaration: ParticipantFileDeclaration): void {
  const byteLength = Buffer.byteLength(declaration.starter.content, "utf8");
  if (byteLength > MAX_STARTER_BYTES || declaration.starter.content.includes("\0")) {
    throw new WorkspaceLaunchError("invalid_request", "The application starter is not a safe text scaffold");
  }
  if (sha256(declaration.starter.content) !== declaration.starter.content_hash) {
    throw new WorkspaceLaunchError("stale_preview", "The application starter hash is stale");
  }
  const foldedAnswer = /<summary\b[^>]*>[^<]*(?:answer|solution|reference)/i;
  const protectedMarker = /(?:\bREFERENCE_ONLY\b|\bTEST_FIXTURE\b|if\s+["']SOLUTION["']|_solution\.py|_reference\.py|_test\.py|_instructions\.md)/i;
  if (foldedAnswer.test(declaration.starter.content) || protectedMarker.test(declaration.starter.content)) {
    throw new WorkspaceLaunchError(
      "invalid_request",
      "The application starter contains protected curriculum markers",
    );
  }
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
  const result: Record<string, string> = {};
  for (const key of allowed) {
    const value = source[key];
    if (value !== undefined) result[key] = value;
  }
  return Object.freeze(result);
}

/**
 * Spawn adapter for production integration. It never invokes a shell and uses
 * only the already-validated immutable launch specification.
 */
export class NodeWorkspaceProcessLauncher implements WorkspaceProcessLauncher {
  async launch(spec: WorkspaceLaunchSpec): Promise<void> {
    await new Promise<void>((resolveLaunch, rejectLaunch) => {
      const child = spawn(spec.executable, [...spec.args], {
        cwd: spec.cwd,
        shell: false,
        detached: true,
        stdio: "ignore",
        env: { ...spec.env },
      });
      child.once("error", rejectLaunch);
      child.once("spawn", () => {
        child.unref();
        resolveLaunch();
      });
    });
  }
}

/**
 * Production discovery canonicalizes common CLI shims and returns only a
 * known VS Code application executable. The service repeats the allowlist
 * check so even a faulty injected discovery cannot select a shell.
 */
export class NodeVSCodeExecutableDiscovery implements VSCodeExecutableDiscovery {
  async discover(): Promise<string | null> {
    for (const candidate of VSCODE_DISCOVERY_CANDIDATES) {
      try {
        const canonical = await nodeFsPromises.realpath(candidate);
        if (!(VSCODE_EXECUTABLES as readonly string[]).includes(canonical)) continue;
        const stats = await nodeFsPromises.lstat(canonical);
        if (!stats.isFile() || stats.isSymbolicLink()) continue;
        await nodeFsPromises.access(canonical, fsConstants.X_OK);
        return canonical;
      } catch {
        // Try the next fixed candidate. Discovery never searches PATH.
      }
    }
    return null;
  }
}

/**
 * Capability-style workspace handoff. Returned tokens are opaque identifiers;
 * all security-sensitive bindings remain server-side and are revalidated at
 * create and launch time.
 */
export class WorkspaceLaunchService {
  readonly #configuredRoot: string;
  readonly #dependencies: WorkspaceLaunchServiceDependencies;
  readonly #fs: WorkspaceFileSystem;
  readonly #createTokenId: () => string;
  readonly #launchEnvironment: Readonly<Record<string, string>>;
  readonly #resolutions = new Map<string, BoundTarget>();
  readonly #creates = new Map<string, CreateRecord>();
  readonly #launches = new Map<string, LaunchRecord>();
  #rootsPromise: Promise<WorkspaceRoots> | undefined;

  constructor(aisbRoot: string, dependencies: WorkspaceLaunchServiceDependencies) {
    if (!isAbsolute(aisbRoot)) {
      throw new WorkspaceLaunchError("invalid_request", "The AISB root must be absolute");
    }
    this.#configuredRoot = resolve(aisbRoot);
    this.#dependencies = dependencies;
    this.#fs = dependencies.file_system ?? nodeFileSystem;
    this.#createTokenId = dependencies.create_token_id ?? randomUUID;
    this.#launchEnvironment = safeLaunchEnvironment(dependencies.process_environment ?? process.env);
  }

  async resolveParticipantFile(input: ResolveParticipantFileRequest | unknown): Promise<ResolvedParticipantFileToken> {
    const request = this.#parseResolveRequest(input);
    if (request.requested_filename !== undefined) validateParticipantFilename(request.requested_filename);

    const roots = await this.#roots();
    const repository = await this.#readRepositoryState(roots.canonical_root);
    const descriptor = await this.#readLinkedSection(request.section_id);

    if (descriptor.source_hash !== request.expected_section_source_hash) {
      throw new WorkspaceLaunchError("stale_preview", "The linked section source hash has changed");
    }

    const declaration = this.#selectDeclaration(descriptor, request.requested_filename);
    validateParticipantFilename(declaration.filename);
    validateStarter(declaration);
    if (
      declaration.declaration_hash !== request.expected_declaration_hash ||
      declaration.starter.content_hash !== request.expected_starter_hash
    ) {
      throw new WorkspaceLaunchError("stale_preview", "The participant file declaration has changed");
    }

    const binding = await this.#bindTarget(roots.canonical_root, repository, descriptor, declaration);
    const tokenId = this.#issueTokenId();
    this.#resolutions.set(tokenId, binding);
    return Object.freeze({
      kind: "workspace-resolution-v1",
      token_id: tokenId,
      section_id: descriptor.section_id,
      target_relative_path: binding.target_relative_path,
      cursor_line: declaration.cursor_line,
    });
  }

  async previewOpen(token: ResolvedParticipantFileToken | unknown): Promise<PreviewOpenResult> {
    const parsedToken = this.#parseToken(token, "workspace-resolution-v1");
    const initial = this.#resolutions.get(parsedToken.token_id);
    if (initial === undefined) throw new WorkspaceLaunchError("invalid_token", "The resolution token is invalid");
    if (
      parsedToken.section_id !== initial.descriptor.section_id ||
      parsedToken.target_relative_path !== initial.target_relative_path ||
      parsedToken.cursor_line !== initial.declaration.cursor_line
    ) {
      throw new WorkspaceLaunchError("invalid_token", "The resolution token binding is invalid");
    }
    const binding = await this.#revalidateBinding(initial);

    const targetState = await this.#targetState(binding.target_absolute_path);
    if (targetState === "absent") {
      const createTokenId = this.#issueTokenId();
      this.#creates.set(createTokenId, { binding });
      return Object.freeze({
        status: "absent",
        target_relative_path: binding.target_relative_path,
        starter_content: binding.declaration.starter.content,
        create_token: Object.freeze({
          kind: "workspace-create-v1",
          token_id: createTokenId,
          section_id: binding.descriptor.section_id,
          target_relative_path: binding.target_relative_path,
          starter_hash: binding.declaration.starter.content_hash,
        }),
      });
    }

    const fingerprint = await this.#fingerprintRegularFile(binding.target_absolute_path);
    const launchToken = this.#issueLaunchToken(binding, fingerprint, false);
    return Object.freeze({
      status: "existing",
      target_relative_path: binding.target_relative_path,
      launch_token: launchToken,
    });
  }

  async createIfAbsent(token: CreateParticipantFileToken | unknown): Promise<CreateIfAbsentResult> {
    const parsedToken = this.#parseToken(token, "workspace-create-v1");
    const tokenId = parsedToken.token_id;
    const record = this.#creates.get(tokenId);
    if (record === undefined) throw new WorkspaceLaunchError("invalid_token", "The create token is invalid");
    if (
      parsedToken.section_id !== record.binding.descriptor.section_id ||
      parsedToken.target_relative_path !== record.binding.target_relative_path ||
      parsedToken.starter_hash !== record.binding.declaration.starter.content_hash
    ) {
      throw new WorkspaceLaunchError("invalid_token", "The create token binding is invalid");
    }
    if (record.replay !== undefined) return record.replay;

    const binding = await this.#revalidateBinding(record.binding);
    if ((await this.#targetState(binding.target_absolute_path)) !== "absent") {
      const result = Object.freeze({
        status: "already_existed" as const,
        target_relative_path: binding.target_relative_path,
        requires_new_preview: true as const,
      });
      record.replay = result;
      return result;
    }

    const tempSuffix = sha256(tokenId).slice(0, 20);
    const tempPath = resolve(binding.section_absolute_path, `.${binding.declaration.filename}.${tempSuffix}.tmp`);
    if (!isStrictDescendant(binding.section_absolute_path, tempPath)) {
      throw new WorkspaceLaunchError("unsafe_path", "The temporary path is unsafe");
    }

    let tempExists = false;
    let published = false;
    try {
      const handle = await this.#fs.open(tempPath, "wx", 0o600);
      tempExists = true;
      try {
        await handle.writeFile(binding.declaration.starter.content);
        await handle.sync();
      } finally {
        await handle.close();
      }

      await this.#revalidateBinding(binding);
      try {
        await this.#fs.link(tempPath, binding.target_absolute_path);
        published = true;
      } catch (error) {
        if (isErrno(error, "EEXIST")) {
          const result = Object.freeze({
            status: "already_existed" as const,
            target_relative_path: binding.target_relative_path,
            requires_new_preview: true as const,
          });
          record.replay = result;
          return result;
        }
        throw error;
      }

      await this.#syncDirectory(binding.section_absolute_path);
      await this.#fs.unlink(tempPath);
      tempExists = false;
      await this.#syncDirectory(binding.section_absolute_path);

      const fingerprint = await this.#fingerprintRegularFile(binding.target_absolute_path);
      if (fingerprint.content_hash !== binding.declaration.starter.content_hash) {
        throw new WorkspaceLaunchError("filesystem_error", "The published participant file failed verification");
      }
      const launchToken = this.#issueLaunchToken(binding, fingerprint, true);
      const result = Object.freeze({
        status: "created" as const,
        target_relative_path: binding.target_relative_path,
        launch_token: launchToken,
      });
      record.replay = result;
      return result;
    } catch (error) {
      if (error instanceof WorkspaceLaunchError) throw error;
      throw new WorkspaceLaunchError("filesystem_error", "The participant file could not be created safely");
    } finally {
      if (tempExists) {
        try {
          await this.#fs.unlink(tempPath);
        } catch (error) {
          if (!isErrno(error, "ENOENT")) {
            // The target is never removed. A same-directory private temp is the
            // safer failure residue if cleanup itself fails.
          }
        }
      }
    }
  }

  async launchVSCode(token: LaunchParticipantFileToken | unknown): Promise<LaunchVSCodeResult> {
    const parsedToken = this.#parseToken(token, "workspace-launch-v1");
    const record = this.#launches.get(parsedToken.token_id);
    if (record === undefined) throw new WorkspaceLaunchError("invalid_token", "The launch token is invalid");
    if (
      parsedToken.section_id !== record.binding.descriptor.section_id ||
      parsedToken.target_relative_path !== record.binding.target_relative_path ||
      parsedToken.content_hash !== record.fingerprint.content_hash ||
      parsedToken.cursor_line !== record.binding.declaration.cursor_line ||
      parsedToken.created_by_service !== record.created_by_service
    ) {
      throw new WorkspaceLaunchError("invalid_token", "The launch token binding is invalid");
    }
    const binding = await this.#revalidateBinding(record.binding);
    const currentFingerprint = await this.#fingerprintRegularFile(binding.target_absolute_path);
    if (!sameFingerprint(currentFingerprint, record.fingerprint)) {
      throw new WorkspaceLaunchError("stale_preview", "The participant file changed after preview");
    }

    const args = Object.freeze([
      "--reuse-window",
      binding.canonical_root,
      "--goto",
      `${binding.target_absolute_path}:${binding.declaration.cursor_line}:1`,
    ]);

    const discovered = await this.#dependencies.executable_discovery.discover();
    if (discovered === null) {
      return this.#launchFailure(record, "editor_not_found", ["code", ...args]);
    }
    if (!isAbsolute(discovered) || !(VSCODE_EXECUTABLES as readonly string[]).includes(discovered)) {
      return this.#launchFailure(record, "editor_not_allowed", ["code", ...args]);
    }

    const spec: WorkspaceLaunchSpec = Object.freeze({
      executable: discovered,
      args,
      cwd: binding.canonical_root,
      shell: false as const,
      env: this.#launchEnvironment,
    });
    try {
      await this.#dependencies.launcher.launch(spec);
    } catch {
      return this.#launchFailure(record, "spawn_failed", [discovered, ...args]);
    }
    return Object.freeze({
      status: "opened",
      target_relative_path: binding.target_relative_path,
      created_by_service: record.created_by_service,
      command: Object.freeze([discovered, ...args]),
    });
  }

  #parseResolveRequest(input: unknown): z.infer<typeof resolveRequestSchema> {
    const parsed = resolveRequestSchema.safeParse(input);
    if (!parsed.success) throw new WorkspaceLaunchError("invalid_request", "The workspace request is invalid");
    return parsed.data;
  }

  #parseToken(input: unknown, expectedKind: "workspace-resolution-v1"): ResolvedParticipantFileToken;
  #parseToken(input: unknown, expectedKind: "workspace-create-v1"): CreateParticipantFileToken;
  #parseToken(input: unknown, expectedKind: "workspace-launch-v1"): LaunchParticipantFileToken;
  #parseToken(
    input: unknown,
    expectedKind: "workspace-resolution-v1" | "workspace-create-v1" | "workspace-launch-v1",
  ): ResolvedParticipantFileToken | CreateParticipantFileToken | LaunchParticipantFileToken {
    const schema =
      expectedKind === "workspace-resolution-v1"
        ? resolutionTokenSchema
        : expectedKind === "workspace-create-v1"
          ? createTokenSchema
          : launchTokenSchema;
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      throw new WorkspaceLaunchError("invalid_token", "The workspace capability token is invalid");
    }
    return parsed.data as ResolvedParticipantFileToken | CreateParticipantFileToken | LaunchParticipantFileToken;
  }

  async #roots(): Promise<WorkspaceRoots> {
    this.#rootsPromise ??= (async () => {
      let configuredStats: Stats;
      try {
        configuredStats = await this.#fs.lstat(this.#configuredRoot);
      } catch {
        throw new WorkspaceLaunchError("invalid_request", "The configured AISB root does not exist");
      }
      if (!configuredStats.isDirectory()) {
        throw new WorkspaceLaunchError("invalid_request", "The configured AISB root is not a directory");
      }
      const canonicalRoot = await this.#fs.realpath(this.#configuredRoot);
      return Object.freeze({ canonical_root: canonicalRoot });
    })();
    return this.#rootsPromise;
  }

  async #readRepositoryState(root: string): Promise<WorkspaceRepositoryState> {
    const parsed = repositoryStateSchema.safeParse(await this.#dependencies.repository_state.read(root));
    if (!parsed.success) {
      throw new WorkspaceLaunchError("invalid_request", "The AISB repository identity is unavailable");
    }
    return parsed.data;
  }

  async #readLinkedSection(sectionId: string): Promise<LinkedSectionDescriptor> {
    const discovered = await this.#dependencies.section_discovery.resolveLinkedSection(sectionId);
    if (discovered === null) {
      throw new WorkspaceLaunchError("section_not_linked", "The AISB section is not explicitly linked");
    }
    const parsed = linkedSectionSchema.safeParse(discovered);
    if (!parsed.success || parsed.data.section_id !== sectionId) {
      throw new WorkspaceLaunchError("invalid_request", "The linked section descriptor is invalid");
    }
    validateSectionDirectory(sectionId, parsed.data.directory_relative_path);
    return parsed.data;
  }

  #selectDeclaration(
    descriptor: LinkedSectionDescriptor,
    requestedFilename: string | undefined,
  ): ParticipantFileDeclaration {
    if (requestedFilename === undefined) {
      if (descriptor.participant_files.length !== 1) {
        throw new WorkspaceLaunchError(
          "ambiguous_filename",
          "The section declares more than one participant answer file",
        );
      }
      const only = descriptor.participant_files[0];
      if (only === undefined) throw new WorkspaceLaunchError("undeclared_filename", "No answer file is declared");
      return only;
    }

    const matches = descriptor.participant_files.filter(
      (candidate) => candidate.filename.toLocaleLowerCase("en-US") === requestedFilename.toLocaleLowerCase("en-US"),
    );
    if (matches.length === 0) {
      throw new WorkspaceLaunchError("undeclared_filename", "The requested answer file is not declared");
    }
    if (matches.length !== 1) {
      throw new WorkspaceLaunchError("ambiguous_filename", "The requested answer filename is ambiguous");
    }
    const match = matches[0];
    if (match === undefined) throw new WorkspaceLaunchError("undeclared_filename", "No answer file is declared");
    return match;
  }

  async #bindTarget(
    canonicalRoot: string,
    repository: WorkspaceRepositoryState,
    descriptor: LinkedSectionDescriptor,
    declaration: ParticipantFileDeclaration,
  ): Promise<BoundTarget> {
    const sectionPath = resolve(canonicalRoot, descriptor.directory_relative_path);
    if (!isStrictDescendant(canonicalRoot, sectionPath)) {
      throw new WorkspaceLaunchError("unsafe_path", "The section escapes the AISB root");
    }
    let sectionStats: Stats;
    try {
      sectionStats = await this.#fs.lstat(sectionPath);
    } catch {
      throw new WorkspaceLaunchError("invalid_target", "The linked section directory does not exist");
    }
    if (sectionStats.isSymbolicLink() || !sectionStats.isDirectory()) {
      throw new WorkspaceLaunchError("unsafe_path", "The linked section is not a regular directory");
    }
    const canonicalSection = await this.#fs.realpath(sectionPath);
    if (canonicalSection !== sectionPath || !isStrictDescendant(canonicalRoot, canonicalSection)) {
      throw new WorkspaceLaunchError("unsafe_path", "The linked section resolves outside the AISB root");
    }

    const targetPath = resolve(canonicalSection, declaration.filename);
    if (!isStrictDescendant(canonicalSection, targetPath) || !isStrictDescendant(canonicalRoot, targetPath)) {
      throw new WorkspaceLaunchError("unsafe_path", "The participant file escapes the linked section");
    }
    return Object.freeze({
      canonical_root: canonicalRoot,
      repository,
      descriptor,
      declaration,
      section_absolute_path: canonicalSection,
      target_absolute_path: targetPath,
      target_relative_path: relative(canonicalRoot, targetPath).split(sep).join("/"),
    });
  }

  async #revalidateBinding(binding: BoundTarget): Promise<BoundTarget> {
    const roots = await this.#roots();
    if (roots.canonical_root !== binding.canonical_root) {
      throw new WorkspaceLaunchError("stale_preview", "The AISB root changed after preview");
    }
    const repository = await this.#readRepositoryState(roots.canonical_root);
    if (
      repository.repository_identity !== binding.repository.repository_identity ||
      repository.revision !== binding.repository.revision
    ) {
      throw new WorkspaceLaunchError("stale_preview", "The AISB repository changed after preview");
    }
    const descriptor = await this.#readLinkedSection(binding.descriptor.section_id);
    if (
      descriptor.source_hash !== binding.descriptor.source_hash ||
      descriptor.directory_relative_path !== binding.descriptor.directory_relative_path
    ) {
      throw new WorkspaceLaunchError("stale_preview", "The linked section changed after preview");
    }
    const declaration = this.#selectDeclaration(descriptor, binding.declaration.filename);
    validateParticipantFilename(declaration.filename);
    validateStarter(declaration);
    if (
      declaration.declaration_hash !== binding.declaration.declaration_hash ||
      declaration.starter.content_hash !== binding.declaration.starter.content_hash ||
      declaration.cursor_line !== binding.declaration.cursor_line
    ) {
      throw new WorkspaceLaunchError("stale_preview", "The answer file declaration changed after preview");
    }
    const current = await this.#bindTarget(roots.canonical_root, repository, descriptor, declaration);
    if (
      current.section_absolute_path !== binding.section_absolute_path ||
      current.target_absolute_path !== binding.target_absolute_path
    ) {
      throw new WorkspaceLaunchError("stale_preview", "The answer file path changed after preview");
    }
    return current;
  }

  async #targetState(path: string): Promise<"absent" | "regular"> {
    let stats: Stats;
    try {
      stats = await this.#fs.lstat(path);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return "absent";
      throw new WorkspaceLaunchError("filesystem_error", "The participant file could not be inspected");
    }
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new WorkspaceLaunchError("invalid_target", "The participant target is not a regular file");
    }
    return "regular";
  }

  async #fingerprintRegularFile(path: string): Promise<FileFingerprint> {
    await this.#targetState(path);
    const canonical = await this.#fs.realpath(path);
    if (canonical !== path) {
      throw new WorkspaceLaunchError("unsafe_path", "The participant file resolves through a symlink");
    }
    let handle: WorkspaceFileHandle;
    try {
      handle = await this.#fs.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    } catch {
      throw new WorkspaceLaunchError("invalid_target", "The participant file could not be opened safely");
    }
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) throw new WorkspaceLaunchError("invalid_target", "The participant target is not a file");
      const bytes = await handle.readFile();
      return Object.freeze({
        content_hash: sha256(bytes),
        size: bytes.byteLength,
        device: stats.dev,
        inode: stats.ino,
      });
    } finally {
      await handle.close();
    }
  }

  async #syncDirectory(path: string): Promise<void> {
    const handle = await this.#fs.open(path, fsConstants.O_RDONLY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  #issueTokenId(): string {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const tokenId = this.#createTokenId();
      if (!/^[A-Za-z0-9_-]{8,200}$/.test(tokenId)) {
        throw new WorkspaceLaunchError("invalid_request", "The token generator returned an unsafe identifier");
      }
      if (!this.#resolutions.has(tokenId) && !this.#creates.has(tokenId) && !this.#launches.has(tokenId)) {
        return tokenId;
      }
    }
    throw new WorkspaceLaunchError("filesystem_error", "A unique workspace token could not be issued");
  }

  #issueLaunchToken(
    binding: BoundTarget,
    fingerprint: FileFingerprint,
    createdByService: boolean,
  ): LaunchParticipantFileToken {
    const tokenId = this.#issueTokenId();
    this.#launches.set(tokenId, { binding, fingerprint, created_by_service: createdByService });
    return Object.freeze({
      kind: "workspace-launch-v1",
      token_id: tokenId,
      section_id: binding.descriptor.section_id,
      target_relative_path: binding.target_relative_path,
      content_hash: fingerprint.content_hash,
      cursor_line: binding.declaration.cursor_line,
      created_by_service: createdByService,
    });
  }

  #launchFailure(
    record: LaunchRecord,
    reason: "editor_not_found" | "editor_not_allowed" | "spawn_failed",
    command: readonly string[],
  ): LaunchVSCodeResult {
    return Object.freeze({
      status: "launch_failed",
      reason,
      target_relative_path: record.binding.target_relative_path,
      created_by_service: record.created_by_service,
      retryable: true,
      command: Object.freeze([...command]),
    });
  }
}
