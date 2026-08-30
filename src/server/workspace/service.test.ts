import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  VSCODE_EXECUTABLES,
  WorkspaceLaunchError,
  WorkspaceLaunchService,
  type LinkedSectionDescriptor,
  type ResolveParticipantFileRequest,
  type WorkspaceLaunchSpec,
} from "./service";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function declaration(filename: string, content = "# My answers\n\n# TODO: work here\n") {
  return {
    filename,
    declaration_hash: hash(`declaration:${filename}:${content}`),
    starter: {
      provenance: "application-sanitized-visible-scaffold-v1" as const,
      content,
      content_hash: hash(content),
    },
    cursor_line: 4,
  };
}

interface Fixture {
  readonly root: string;
  readonly canonicalRoot: string;
  readonly sectionPath: string;
  readonly targetPath: string;
  readonly service: WorkspaceLaunchService;
  readonly launchCalls: WorkspaceLaunchSpec[];
  descriptor(): LinkedSectionDescriptor;
  replaceDescriptor(value: LinkedSectionDescriptor): void;
  setRevision(value: string): void;
  setExecutable(value: string | null): void;
  setLaunchFailure(value: boolean): void;
  request(requestedFilename?: string): ResolveParticipantFileRequest;
}

async function makeFixture(options: { readonly filename?: string; readonly starter?: string } = {}): Promise<Fixture> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "aisb-workspace-service-"));
  temporaryRoots.push(temporaryRoot);
  const root = join(temporaryRoot, "AISB root ;$(literal argument)");
  const directory = "1.1-section with spaces ;$(literal argument)";
  const sectionPath = join(root, directory);
  await mkdir(sectionPath, { recursive: true });
  const canonicalRoot = await realpath(root);

  const initialDeclaration = declaration(options.filename ?? "day1_answers.py", options.starter);
  let currentDescriptor: LinkedSectionDescriptor = {
    section_id: "1.1",
    directory_relative_path: directory,
    source_hash: hash("visible-section-projection-v1"),
    participant_files: [initialDeclaration],
  };
  let revision = "head-v1";
  let executable: string | null = VSCODE_EXECUTABLES[0];
  let launchFailure = false;
  let tokenCounter = 0;
  const launchCalls: WorkspaceLaunchSpec[] = [];

  const service = new WorkspaceLaunchService(root, {
    section_discovery: {
      async resolveLinkedSection(sectionId) {
        return sectionId === currentDescriptor.section_id ? structuredClone(currentDescriptor) : null;
      },
    },
    repository_state: {
      async read(readRoot) {
        expect(readRoot).toBe(canonicalRoot);
        return { repository_identity: "fixture-repository-id", revision };
      },
    },
    executable_discovery: {
      async discover() {
        return executable;
      },
    },
    launcher: {
      async launch(spec) {
        launchCalls.push(spec);
        if (launchFailure) throw new Error("deterministic launch failure");
      },
    },
    create_token_id() {
      tokenCounter += 1;
      return `workspace-token-${String(tokenCounter).padStart(4, "0")}`;
    },
    process_environment: {
      HOME: "/Users/learner",
      PATH: "/usr/bin:/bin",
      LANG: "en_GB.UTF-8",
      CODEX_OPENAI_API_KEY: "must-not-propagate",
      OPENAI_API_KEY: "must-not-propagate",
      UNRELATED_SECRET: "must-not-propagate",
    },
  });

  return {
    root,
    canonicalRoot,
    sectionPath,
    targetPath: join(sectionPath, initialDeclaration.filename),
    service,
    launchCalls,
    descriptor: () => currentDescriptor,
    replaceDescriptor(value) {
      currentDescriptor = value;
    },
    setRevision(value) {
      revision = value;
    },
    setExecutable(value) {
      executable = value;
    },
    setLaunchFailure(value) {
      launchFailure = value;
    },
    request(requestedFilename) {
      const selected =
        requestedFilename === undefined
          ? currentDescriptor.participant_files[0]
          : currentDescriptor.participant_files.find(
              (candidate) => candidate.filename.toLowerCase() === requestedFilename.toLowerCase(),
            );
      if (selected === undefined) throw new Error("Fixture request refers to a missing declaration");
      const base = {
        section_id: currentDescriptor.section_id,
        expected_section_source_hash: currentDescriptor.source_hash,
        expected_declaration_hash: selected.declaration_hash,
        expected_starter_hash: selected.starter.content_hash,
      };
      return requestedFilename === undefined ? base : { ...base, requested_filename: requestedFilename };
    },
  };
}

async function expectWorkspaceError(promise: Promise<unknown>, code: WorkspaceLaunchError["code"]): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: "WorkspaceLaunchError", code });
}

describe("WorkspaceLaunchService", () => {
  it("opens an existing declared answer file with a fixed literal argument array and never changes its bytes", async () => {
    const fixture = await makeFixture();
    const original = Buffer.from("# Existing learner work\n\nprint('untouched')\n", "utf8");
    await writeFile(fixture.targetPath, original);

    const resolved = await fixture.service.resolveParticipantFile(fixture.request());
    const preview = await fixture.service.previewOpen(resolved);
    expect(preview.status).toBe("existing");
    if (preview.status !== "existing") throw new Error("Expected an existing-file preview");

    const result = await fixture.service.launchVSCode(preview.launch_token);
    expect(result).toMatchObject({
      status: "opened",
      created_by_service: false,
      target_relative_path: `${fixture.descriptor().directory_relative_path}/day1_answers.py`,
    });
    expect(fixture.launchCalls).toHaveLength(1);
    const spec = fixture.launchCalls[0];
    expect(spec).toBeDefined();
    expect(spec).toMatchObject({
      executable: VSCODE_EXECUTABLES[0],
      cwd: fixture.canonicalRoot,
      shell: false,
    });
    expect(spec?.args).toEqual([
      "--reuse-window",
      fixture.canonicalRoot,
      "--goto",
      `${await realpath(fixture.targetPath)}:4:1`,
    ]);
    expect(spec?.args[1]).toContain(" ;$(literal argument)");
    expect(spec?.args[3]).toContain(" ;$(literal argument)");
    expect(spec?.env).toEqual({
      HOME: "/Users/learner",
      PATH: "/usr/bin:/bin",
      LANG: "en_GB.UTF-8",
    });
    expect(await readFile(fixture.targetPath)).toEqual(original);
  });

  it("atomically creates an absent file exactly once and preserves it across launch failure and retry", async () => {
    const starter = "# Day 1 answers\n\n# TODO: learner work starts here\n";
    const fixture = await makeFixture({ starter });
    const resolved = await fixture.service.resolveParticipantFile(fixture.request());
    const preview = await fixture.service.previewOpen(resolved);
    expect(preview.status).toBe("absent");
    if (preview.status !== "absent") throw new Error("Expected an absent-file preview");
    expect(preview.starter_content).toBe(starter);

    const created = await fixture.service.createIfAbsent(preview.create_token);
    expect(created.status).toBe("created");
    if (created.status !== "created") throw new Error("Expected a created file");
    expect(await readFile(fixture.targetPath, "utf8")).toBe(starter);

    const replay = await fixture.service.createIfAbsent(preview.create_token);
    expect(replay).toEqual(created);
    expect(await readFile(fixture.targetPath, "utf8")).toBe(starter);

    fixture.setLaunchFailure(true);
    const failed = await fixture.service.launchVSCode(created.launch_token);
    expect(failed).toMatchObject({
      status: "launch_failed",
      reason: "spawn_failed",
      created_by_service: true,
      retryable: true,
    });
    expect(await readFile(fixture.targetPath, "utf8")).toBe(starter);

    fixture.setLaunchFailure(false);
    const retried = await fixture.service.launchVSCode(created.launch_token);
    expect(retried).toMatchObject({ status: "opened", created_by_service: true });
    expect(fixture.launchCalls).toHaveLength(2);
    expect(await readFile(fixture.targetPath, "utf8")).toBe(starter);
  });

  it("loses an absent-target race without overwriting the winner", async () => {
    const fixture = await makeFixture();
    const resolved = await fixture.service.resolveParticipantFile(fixture.request());
    const preview = await fixture.service.previewOpen(resolved);
    if (preview.status !== "absent") throw new Error("Expected an absent-file preview");

    const winner = "# Work created by another process\n";
    await writeFile(fixture.targetPath, winner, "utf8");
    const result = await fixture.service.createIfAbsent(preview.create_token);
    expect(result).toEqual({
      status: "already_existed",
      target_relative_path: `${fixture.descriptor().directory_relative_path}/day1_answers.py`,
      requires_new_preview: true,
    });
    expect(await fixture.service.createIfAbsent(preview.create_token)).toEqual(result);
    expect(await readFile(fixture.targetPath, "utf8")).toBe(winner);
    expect(fixture.launchCalls).toHaveLength(0);
  });

  it.each([
    ["../day1_answers.py", "unsafe_path"],
    ["nested/day1_answers.py", "unsafe_path"],
    ["day1_answers.py\\escape", "unsafe_path"],
    ["exercise_solution.py", "protected_filename"],
    ["exercise_reference.py", "protected_filename"],
    ["exercise_test.py", "protected_filename"],
    ["exercise_instructions.md", "protected_filename"],
  ] as const)("rejects unsafe or protected declaration %s", async (filename, code) => {
    const fixture = await makeFixture({ filename });
    await expectWorkspaceError(fixture.service.resolveParticipantFile(fixture.request()), code);
  });

  it("rejects ambiguous declarations, including case-folded duplicate filenames", async () => {
    const fixture = await makeFixture();
    const first = fixture.descriptor().participant_files[0];
    if (first === undefined) throw new Error("Fixture declaration missing");
    fixture.replaceDescriptor({
      ...fixture.descriptor(),
      participant_files: [first, declaration("DAY1_ANSWERS.PY", "# Other starter\n")],
    });

    await expectWorkspaceError(fixture.service.resolveParticipantFile(fixture.request()), "ambiguous_filename");
    await expectWorkspaceError(
      fixture.service.resolveParticipantFile(fixture.request("day1_answers.py")),
      "ambiguous_filename",
    );
  });

  it("rejects directory and symlink targets and leaves their destinations untouched", async () => {
    const directoryFixture = await makeFixture();
    await mkdir(directoryFixture.targetPath);
    const directoryResolution = await directoryFixture.service.resolveParticipantFile(directoryFixture.request());
    await expectWorkspaceError(directoryFixture.service.previewOpen(directoryResolution), "invalid_target");

    const symlinkFixture = await makeFixture();
    const outside = join(temporaryRoots[temporaryRoots.length - 1] ?? tmpdir(), "outside learner bytes.py");
    await writeFile(outside, "outside stays unchanged\n", "utf8");
    await symlink(outside, symlinkFixture.targetPath);
    const symlinkResolution = await symlinkFixture.service.resolveParticipantFile(symlinkFixture.request());
    await expectWorkspaceError(symlinkFixture.service.previewOpen(symlinkResolution), "invalid_target");
    expect(await readFile(outside, "utf8")).toBe("outside stays unchanged\n");
  });

  it("rejects a symlinked linked-section directory", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "aisb-workspace-symlink-section-"));
    temporaryRoots.push(temporaryRoot);
    const root = join(temporaryRoot, "root");
    const realSection = join(temporaryRoot, "real-section");
    await mkdir(root);
    await mkdir(realSection);
    await symlink(realSection, join(root, "1.1-linked"));
    const item = declaration("day1_answers.py");
    const service = new WorkspaceLaunchService(root, {
      section_discovery: {
        async resolveLinkedSection() {
          return {
            section_id: "1.1",
            directory_relative_path: "1.1-linked",
            source_hash: hash("source"),
            participant_files: [item],
          };
        },
      },
      repository_state: {
        async read() {
          return { repository_identity: "fixture", revision: "head" };
        },
      },
      executable_discovery: { async discover() { return VSCODE_EXECUTABLES[0]; } },
      launcher: { async launch() {} },
      create_token_id: () => "workspace-token-symlink",
    });

    await expectWorkspaceError(
      service.resolveParticipantFile({
        section_id: "1.1",
        expected_section_source_hash: hash("source"),
        expected_declaration_hash: item.declaration_hash,
        expected_starter_hash: item.starter.content_hash,
      }),
      "unsafe_path",
    );
  });

  it("rejects stale projection, repository, declaration, and file-content bindings", async () => {
    const staleRequestFixture = await makeFixture();
    await expectWorkspaceError(
      staleRequestFixture.service.resolveParticipantFile({
        ...staleRequestFixture.request(),
        expected_section_source_hash: hash("old projection"),
      }),
      "stale_preview",
    );

    const staleRepositoryFixture = await makeFixture();
    const resolved = await staleRepositoryFixture.service.resolveParticipantFile(staleRepositoryFixture.request());
    const absentPreview = await staleRepositoryFixture.service.previewOpen(resolved);
    if (absentPreview.status !== "absent") throw new Error("Expected absent preview");
    staleRepositoryFixture.setRevision("head-v2");
    await expectWorkspaceError(
      staleRepositoryFixture.service.createIfAbsent(absentPreview.create_token),
      "stale_preview",
    );

    const staleDescriptorFixture = await makeFixture();
    const descriptorResolution = await staleDescriptorFixture.service.resolveParticipantFile(
      staleDescriptorFixture.request(),
    );
    const descriptorPreview = await staleDescriptorFixture.service.previewOpen(descriptorResolution);
    if (descriptorPreview.status !== "absent") throw new Error("Expected absent preview");
    const current = staleDescriptorFixture.descriptor();
    staleDescriptorFixture.replaceDescriptor({ ...current, source_hash: hash("projection-v2") });
    await expectWorkspaceError(
      staleDescriptorFixture.service.createIfAbsent(descriptorPreview.create_token),
      "stale_preview",
    );

    const changedFileFixture = await makeFixture();
    await writeFile(changedFileFixture.targetPath, "version one\n", "utf8");
    const fileResolution = await changedFileFixture.service.resolveParticipantFile(changedFileFixture.request());
    const filePreview = await changedFileFixture.service.previewOpen(fileResolution);
    if (filePreview.status !== "existing") throw new Error("Expected existing preview");
    await writeFile(changedFileFixture.targetPath, "version two\n", "utf8");
    await expectWorkspaceError(
      changedFileFixture.service.launchVSCode(filePreview.launch_token),
      "stale_preview",
    );
    expect(changedFileFixture.launchCalls).toHaveLength(0);
  });

  it("rejects protected material in an application starter before creating anything", async () => {
    const fixture = await makeFixture({
      starter: '# Scaffold\n\nif "SOLUTION":\n    return "protected"\n',
    });
    await expectWorkspaceError(fixture.service.resolveParticipantFile(fixture.request()), "invalid_request");
    await expect(readFile(fixture.targetPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not execute forbidden binaries or accept client-authored launch parameters", async () => {
    const fixture = await makeFixture();
    await writeFile(fixture.targetPath, "# Existing\n", "utf8");
    const resolved = await fixture.service.resolveParticipantFile(fixture.request());
    const preview = await fixture.service.previewOpen(resolved);
    if (preview.status !== "existing") throw new Error("Expected existing preview");

    fixture.setExecutable("/bin/sh");
    const forbidden = await fixture.service.launchVSCode(preview.launch_token);
    expect(forbidden).toMatchObject({ status: "launch_failed", reason: "editor_not_allowed" });
    expect(fixture.launchCalls).toHaveLength(0);

    await expectWorkspaceError(
      fixture.service.launchVSCode({
        ...preview.launch_token,
        executable: "/bin/sh",
        args: ["-c", "touch /tmp/should-not-run"],
        cwd: "/",
        env: { OPENAI_API_KEY: "steal-me" },
      }),
      "invalid_token",
    );
    expect(fixture.launchCalls).toHaveLength(0);
  });

  it("keeps create and launch capabilities type-separated", async () => {
    const fixture = await makeFixture();
    const resolved = await fixture.service.resolveParticipantFile(fixture.request());
    const preview = await fixture.service.previewOpen(resolved);
    if (preview.status !== "absent") throw new Error("Expected absent preview");
    await expectWorkspaceError(fixture.service.launchVSCode(preview.create_token), "invalid_token");
    await expectWorkspaceError(fixture.service.createIfAbsent(resolved), "invalid_token");
    expect(fixture.launchCalls).toHaveLength(0);
  });

  it("returns a retryable command hint when VS Code is not installed", async () => {
    const fixture = await makeFixture();
    await writeFile(fixture.targetPath, "# Existing\n", "utf8");
    const resolved = await fixture.service.resolveParticipantFile(fixture.request());
    const preview = await fixture.service.previewOpen(resolved);
    if (preview.status !== "existing") throw new Error("Expected existing preview");
    fixture.setExecutable(null);

    const result = await fixture.service.launchVSCode(preview.launch_token);
    expect(result).toMatchObject({
      status: "launch_failed",
      reason: "editor_not_found",
      retryable: true,
      created_by_service: false,
    });
    expect(result.command[0]).toBe("code");
    expect(result.command).toContain("--goto");
    expect(fixture.launchCalls).toHaveLength(0);
  });
});
