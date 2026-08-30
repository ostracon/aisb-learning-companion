import { link, mkdtemp, mkdir, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { noteSummary, type NoteRecord } from "../../shared/notes";
import { MarkdownNoteStore } from "./store";
import {
  SavedNoteVSCodeService,
  VSCODE_EXECUTABLES,
  type SavedNoteVSCodeServiceDependencies,
} from "./open-in-vscode-service";
import type { WorkspaceLaunchSpec } from "../workspace/service";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function idSequence(prefix: string): () => string {
  let sequence = 0;
  return () => `${prefix}-${String(++sequence).padStart(4, "0")}`;
}

interface Fixture {
  readonly base: string;
  readonly stateRoot: string;
  readonly companionRoot: string;
  readonly noteStore: MarkdownNoteStore;
  readonly service: SavedNoteVSCodeService;
  readonly launchCalls: WorkspaceLaunchSpec[];
  setExecutable(value: string | null): void;
  setDiscoveryFailure(value: boolean): void;
  setLaunchFailure(value: boolean): void;
}

async function makeFixture(
  noteStoreOverride?: ConstructorParameters<typeof SavedNoteVSCodeService>[0]["note_store"],
): Promise<Fixture> {
  const base = await mkdtemp(join(tmpdir(), "aisb-note-open-test-"));
  temporaryRoots.push(base);
  const stateRoot = join(base, "state root ;$(literal)");
  const companionRoot = join(base, "companion root ;$(literal)");
  await mkdir(companionRoot, { recursive: true });
  const noteStore = new MarkdownNoteStore(stateRoot, {
    now: () => new Date("2026-08-29T18:30:00.000Z"),
    create_id: idSequence("note-store-id"),
  });

  let executable: string | null = VSCODE_EXECUTABLES[0];
  let discoveryFailure = false;
  let launchFailure = false;
  const launchCalls: WorkspaceLaunchSpec[] = [];
  const dependencies: SavedNoteVSCodeServiceDependencies = {
    executable_discovery: {
      async discover() {
        if (discoveryFailure) throw new Error("deterministic discovery failure");
        return executable;
      },
    },
    launcher: {
      async launch(spec) {
        launchCalls.push(spec);
        if (launchFailure) throw new Error("deterministic launch failure");
      },
    },
    create_token_id: idSequence("saved-note-launch-token"),
    process_environment: {
      HOME: "/Users/learner",
      PATH: "/usr/bin:/bin",
      LANG: "en_GB.UTF-8",
      OPENAI_API_KEY: "must-not-propagate",
      CODEX_OPENAI_API_KEY: "must-not-propagate",
      UNRELATED_SECRET: "must-not-propagate",
    },
  };
  const service = new SavedNoteVSCodeService(
    {
      state_root: stateRoot,
      companion_root: companionRoot,
      note_store: noteStoreOverride ?? noteStore,
    },
    dependencies,
  );
  return {
    base,
    stateRoot,
    companionRoot,
    noteStore,
    service,
    launchCalls,
    setExecutable(value) {
      executable = value;
    },
    setDiscoveryFailure(value) {
      discoveryFailure = value;
    },
    setLaunchFailure(value) {
      launchFailure = value;
    },
  };
}

async function createDayNote(fixture: Fixture, markdown = "# Saved learner notes\n"): Promise<NoteRecord> {
  const created = await fixture.noteStore.create({
    kind: "day",
    programme_day_id: "day1",
    note_id: "day1-overview-note",
    title: "Day 1 notes",
    markdown,
  });
  return created.note;
}

function prepareRequest(note: NoteRecord) {
  return {
    note_id: note.frontmatter.note_id,
    expected_revision: note.frontmatter.revision,
    expected_content_hash: note.content_hash,
  };
}

describe("SavedNoteVSCodeService", () => {
  it("resolves a logical note ID through the store and opens the exact saved Markdown bytes", async () => {
    const fixture = await makeFixture();
    const note = await createDayNote(fixture, "# Orientation\n\nLearner-authored text.\n");
    const notePath = join(fixture.stateRoot, note.logical_path);
    const bytesBefore = await readFile(notePath);

    const token = await fixture.service.prepareOpen(prepareRequest(note));
    expect(token).toMatchObject({
      kind: "saved-note-vscode-launch-v1",
      note_id: note.frontmatter.note_id,
      logical_path: "notes/days/day1/overview.md",
      revision: 1,
      content_hash: note.content_hash,
    });
    const result = await fixture.service.launchVSCode(token);
    expect(result).toMatchObject({
      status: "opened",
      note_id: note.frontmatter.note_id,
      logical_path: note.logical_path,
    });

    expect(fixture.launchCalls).toHaveLength(1);
    const call = fixture.launchCalls[0];
    expect(call).toBeDefined();
    const canonicalCompanionRoot = await realpath(fixture.companionRoot);
    expect(call).toMatchObject({
      executable: VSCODE_EXECUTABLES[0],
      cwd: canonicalCompanionRoot,
      shell: false,
      env: {
        HOME: "/Users/learner",
        PATH: "/usr/bin:/bin",
        LANG: "en_GB.UTF-8",
      },
    });
    expect(call?.args).toEqual([
      "--reuse-window",
      canonicalCompanionRoot,
      "--goto",
      `${await realpath(notePath)}:1:1`,
    ]);
    expect(call?.args[1]).toContain(" ;$(literal)");
    expect(call?.args[3]).toContain(" ;$(literal)");
    expect(call?.env).not.toHaveProperty("OPENAI_API_KEY");
    expect(call?.env).not.toHaveProperty("CODEX_OPENAI_API_KEY");
    expect(await readFile(notePath)).toEqual(bytesBefore);
  });

  it("requires the current acknowledged disk revision and invalidates a prepared token after a later save", async () => {
    const fixture = await makeFixture();
    const first = await createDayNote(fixture, "First disk save\n");
    const token = await fixture.service.prepareOpen(prepareRequest(first));
    const saved = await fixture.noteStore.save(first.locator, {
      note_id: first.frontmatter.note_id,
      expected_revision: first.frontmatter.revision,
      expected_content_hash: first.content_hash,
      markdown: "Second disk save\n",
    });
    if (saved.status !== "saved") throw new Error("Expected the note save to succeed");

    await expect(fixture.service.launchVSCode(token)).rejects.toMatchObject({ code: "stale_note" });
    await expect(fixture.service.prepareOpen(prepareRequest(first))).rejects.toMatchObject({
      code: "stale_note",
    });
    const currentToken = await fixture.service.prepareOpen(prepareRequest(saved.note));
    expect(await fixture.service.launchVSCode(currentToken)).toMatchObject({ status: "opened" });
    expect(fixture.launchCalls).toHaveLength(1);
  });

  it("never creates a missing note and rejects client paths or launch parameters", async () => {
    const fixture = await makeFixture();
    const missingRequest = {
      note_id: "missing-note",
      expected_revision: 1,
      expected_content_hash: "0".repeat(64),
    };
    await expect(fixture.service.prepareOpen(missingRequest)).rejects.toMatchObject({
      code: "note_not_found",
    });
    expect((await fixture.noteStore.list()).some((note) => note.note_id === "missing-note")).toBe(false);

    const note = await createDayNote(fixture);
    await expect(
      fixture.service.prepareOpen({ ...prepareRequest(note), path: "/etc/passwd" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      fixture.service.prepareOpen({ ...prepareRequest(note), note_id: "../../outside" }),
    ).rejects.toMatchObject({ code: "invalid_request" });

    const token = await fixture.service.prepareOpen(prepareRequest(note));
    await expect(
      fixture.service.launchVSCode({
        ...token,
        executable: "/bin/sh",
        args: ["-c", "touch /tmp/never-run"],
        cwd: "/",
        env: { OPENAI_API_KEY: "steal-me" },
      }),
    ).rejects.toMatchObject({ code: "invalid_token" });
    expect(fixture.launchCalls).toHaveLength(0);
  });

  it("returns safe retryable failures for missing, forbidden, and failed editors", async () => {
    const fixture = await makeFixture();
    const note = await createDayNote(fixture);
    const token = await fixture.service.prepareOpen(prepareRequest(note));

    fixture.setExecutable(null);
    const missing = await fixture.service.launchVSCode(token);
    expect(missing).toMatchObject({
      status: "launch_failed",
      reason: "editor_not_found",
      retryable: true,
    });
    expect(missing.command[0]).toBe("code");
    expect(fixture.launchCalls).toHaveLength(0);

    fixture.setDiscoveryFailure(true);
    const discoveryFailure = await fixture.service.launchVSCode(token);
    expect(discoveryFailure).toMatchObject({
      status: "launch_failed",
      reason: "editor_not_found",
      retryable: true,
    });
    fixture.setDiscoveryFailure(false);

    fixture.setExecutable("/bin/sh");
    const forbidden = await fixture.service.launchVSCode(token);
    expect(forbidden).toMatchObject({ status: "launch_failed", reason: "editor_not_allowed" });
    expect(fixture.launchCalls).toHaveLength(0);

    fixture.setExecutable(VSCODE_EXECUTABLES[0]);
    fixture.setLaunchFailure(true);
    const failed = await fixture.service.launchVSCode(token);
    expect(failed).toMatchObject({ status: "launch_failed", reason: "spawn_failed", retryable: true });
    fixture.setLaunchFailure(false);
    expect(await fixture.service.launchVSCode(token)).toMatchObject({ status: "opened" });
    expect(fixture.launchCalls).toHaveLength(2);
  });

  it("rejects a symlinked note without touching its outside destination", async () => {
    const fixture = await makeFixture();
    const note = await createDayNote(fixture);
    const notePath = join(fixture.stateRoot, note.logical_path);
    const outside = join(fixture.base, "outside.md");
    await writeFile(outside, "outside bytes stay unchanged\n", "utf8");
    await unlink(notePath);
    await symlink(outside, notePath);

    await expect(fixture.service.prepareOpen(prepareRequest(note))).rejects.toMatchObject({
      code: "invalid_target",
    });
    expect(await readFile(outside, "utf8")).toBe("outside bytes stay unchanged\n");
    expect(fixture.launchCalls).toHaveLength(0);
  });

  it("rejects a hard-linked note so editing cannot mutate an outside alias", async () => {
    const fixture = await makeFixture();
    const note = await createDayNote(fixture);
    const notePath = join(fixture.stateRoot, note.logical_path);
    const original = await readFile(notePath);
    const outside = join(fixture.base, "outside-hard-link.md");
    await writeFile(outside, original);
    await unlink(notePath);
    await link(outside, notePath);

    await expect(fixture.service.prepareOpen(prepareRequest(note))).rejects.toMatchObject({
      code: "unsafe_path",
    });
    expect(await readFile(outside)).toEqual(original);
    expect(fixture.launchCalls).toHaveLength(0);
  });

  it("rejects a store projection that attempts to resolve a note ID to a protected logical area", async () => {
    const realFixture = await makeFixture();
    const note = await createDayNote(realFixture);
    const protectedRecord: NoteRecord = {
      ...note,
      logical_path: "notes/recovery/day1-overview-note/000000000001-secret.md",
    };
    const maliciousResolver = {
      async list() {
        return [noteSummary(protectedRecord)];
      },
      async read() {
        return protectedRecord;
      },
    };
    const fixture = await makeFixture(maliciousResolver);

    await expect(fixture.service.prepareOpen(prepareRequest(protectedRecord))).rejects.toMatchObject({
      code: "protected_target",
    });
    expect(fixture.launchCalls).toHaveLength(0);
  });

  it("rejects duplicate logical note IDs instead of choosing one", async () => {
    const realFixture = await makeFixture();
    const note = await createDayNote(realFixture);
    const duplicateResolver = {
      async list() {
        return [noteSummary(note), noteSummary(note)];
      },
      async read() {
        return note;
      },
    };
    const fixture = await makeFixture(duplicateResolver);

    await expect(fixture.service.prepareOpen(prepareRequest(note))).rejects.toMatchObject({
      code: "ambiguous_note",
    });
    expect(fixture.launchCalls).toHaveLength(0);
  });

  it("rejects a symlinked state root even when the note store can resolve a record", async () => {
    const fixture = await makeFixture();
    const note = await createDayNote(fixture);
    const linkedRoot = join(fixture.base, "linked-state-root");
    await symlink(fixture.stateRoot, linkedRoot);
    const service = new SavedNoteVSCodeService(
      {
        state_root: linkedRoot,
        companion_root: fixture.companionRoot,
        note_store: fixture.noteStore,
      },
      {
        executable_discovery: { async discover() { return VSCODE_EXECUTABLES[0]; } },
        launcher: { async launch() {} },
        create_token_id: idSequence("linked-root-token"),
      },
    );

    await expect(service.prepareOpen(prepareRequest(note))).rejects.toMatchObject({ code: "unsafe_path" });
  });
});
