import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseNoteMarkdown, type NoteLocator } from "../../shared/notes";
import { MarkdownNoteStore, NoteStoreError } from "./store";

const temporaryRoots: string[] = [];

async function temporaryStateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "aisb-notes-test-"));
  temporaryRoots.push(root);
  return root;
}

function idSequence(prefix = "generated"): () => string {
  let sequence = 0;
  return () => `${prefix}-${String(++sequence).padStart(4, "0")}`;
}

afterEach(async () => {
  const roots = temporaryRoots.splice(0);
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe("MarkdownNoteStore create/read/list", () => {
  it("creates a canonical note exclusively and treats repeated open as idempotent", async () => {
    const stateRoot = await temporaryStateRoot();
    const store = new MarkdownNoteStore(stateRoot, {
      now: () => new Date("2026-08-29T16:32:54.123Z"),
      create_id: idSequence(),
    });

    const first = await store.create({
      kind: "day",
      programme_day_id: "day1",
      note_id: "note-day1",
      title: "Day 1 — Foundations",
      markdown: "# Orientation\n",
      links: { section_ids: ["1.1"], canonical_outcome_ids: ["day1.theory.1"] },
    });
    const repeated = await store.create({
      kind: "day",
      programme_day_id: "day1",
      note_id: "a-different-request-id",
      title: "This cannot rename the existing note",
    });

    expect(first.status).toBe("created");
    expect(first.note.logical_path).toBe("notes/days/day1/overview.md");
    expect(first.note.frontmatter).toMatchObject({
      note_id: "note-day1",
      note_kind: "day",
      revision: 1,
    });
    expect(repeated.status).toBe("existing");
    expect(repeated.note.frontmatter.note_id).toBe("note-day1");
    expect(await store.read({ kind: "day", programme_day_id: "day1" })).toEqual(first.note);
    expect(await store.list()).toEqual([
      expect.objectContaining({
        note_id: "note-day1",
        logical_path: "notes/days/day1/overview.md",
        revision: 1,
      }),
    ]);

    const journal = await readFile(join(stateRoot, "notes/revisions/note-day1.jsonl"), "utf8");
    expect(journal.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(journal) as unknown).toMatchObject({ operation: "create", revision: 1 });
  });

  it("creates replay-safe ad-hoc identities at their immutable creation-date path", async () => {
    const stateRoot = await temporaryStateRoot();
    const store = new MarkdownNoteStore(stateRoot, { create_id: idSequence() });
    const request = {
      kind: "ad_hoc" as const,
      creation_date: "2026-08-30",
      created_at: "2026-08-29T23:15:00.000Z",
      note_id: "quick-capture-1",
      markdown: "Something to remember.",
    };

    const created = await store.create(request);
    const replayed = await store.create(request);

    expect(created.note.logical_path).toBe(
      "notes/ad-hoc/2026-08-30/20260829T231500000Z-quick-capture-1.md",
    );
    expect(replayed.status).toBe("existing");
    expect(replayed.note.content_hash).toBe(created.note.content_hash);
  });

  it("creates named quick notes at an exact stable filename and rediscovers them", async () => {
    const stateRoot = await temporaryStateRoot();
    const store = new MarkdownNoteStore(stateRoot, { create_id: idSequence() });
    const created = await store.create({
      kind: "ad_hoc",
      creation_date: "2026-08-29",
      created_at: "2026-08-29T20:00:00.000Z",
      note_id: "day0_quicknote_setup_questions",
      filename_style: "named",
      markdown: "Remember this.",
    });

    expect(created.note.logical_path).toBe(
      "notes/ad-hoc/2026-08-29/day0_quicknote_setup_questions.md",
    );
    expect((await store.list()).find((note) => note.note_id === created.note.frontmatter.note_id)).toMatchObject({
      logical_path: created.note.logical_path,
      locator: { kind: "ad_hoc", note_id: "day0_quicknote_setup_questions" },
    });
  });

  it("reports one malformed Markdown file without hiding valid notes", async () => {
    const stateRoot = await temporaryStateRoot();
    const store = new MarkdownNoteStore(stateRoot, { create_id: idSequence() });
    await store.create({
      kind: "day",
      programme_day_id: "day1",
      note_id: "day-day1",
      markdown: "Valid note",
    });
    const malformedDirectory = join(stateRoot, "notes/days/day2");
    await mkdir(malformedDirectory, { recursive: true });
    await writeFile(join(malformedDirectory, "overview.md"), "not YAML frontmatter", "utf8");

    const inventory = await store.inventory();
    expect(inventory.notes.map((note) => note.note_id)).toEqual(["day-day1"]);
    expect(inventory.unreadable).toEqual([{
      logical_path: "notes/days/day2/overview.md",
      reason: "note file must start with YAML frontmatter",
    }]);
    await expect(store.list()).resolves.toHaveLength(1);
  });
});

describe("MarkdownNoteStore conditional saves", () => {
  it("increments revisions and preserves a stale divergent draft as a conflict copy", async () => {
    const stateRoot = await temporaryStateRoot();
    const times = [
      new Date("2026-08-29T16:00:00.000Z"),
      new Date("2026-08-29T16:00:01.000Z"),
      new Date("2026-08-29T16:00:02.000Z"),
      new Date("2026-08-29T16:00:03.000Z"),
      new Date("2026-08-29T16:00:04.000Z"),
      new Date("2026-08-29T16:00:05.000Z"),
    ];
    let timeIndex = 0;
    const store = new MarkdownNoteStore(stateRoot, {
      now: () => times[Math.min(timeIndex++, times.length - 1)] ?? times[0]!,
      create_id: idSequence(),
    });
    const locator: NoteLocator = { kind: "event", event_binding_id: "aisb-2026-017" };
    const created = await store.create({
      ...locator,
      note_id: "event-note-17",
      markdown: "Initial thought",
    });

    const saved = await store.save(locator, {
      note_id: "event-note-17",
      expected_revision: 1,
      expected_content_hash: created.note.content_hash,
      markdown: "Revised thought",
    });
    expect(saved.status).toBe("saved");
    if (saved.status !== "saved") throw new Error("expected saved result");
    expect(saved.note.frontmatter.revision).toBe(2);

    const conflict = await store.save(locator, {
      note_id: "event-note-17",
      expected_revision: 1,
      expected_content_hash: created.note.content_hash,
      markdown: "Unsaved text from a stale tab",
    });
    expect(conflict.status).toBe("conflict");
    if (conflict.status !== "conflict") throw new Error("expected conflict result");
    expect((await store.read(locator)).markdown).toBe("Revised thought");
    const preserved = await readFile(join(stateRoot, conflict.conflict_copy_path), "utf8");
    expect(parseNoteMarkdown(preserved).markdown).toBe("Unsaved text from a stale tab");

    const idempotentRetry = await store.save(locator, {
      note_id: "event-note-17",
      expected_revision: 1,
      expected_content_hash: created.note.content_hash,
      markdown: "Revised thought",
    });
    expect(idempotentRetry.status).toBe("unchanged");
  });

  it("leaves the accepted file intact when publication fails before rename", async () => {
    const stateRoot = await temporaryStateRoot();
    let injectFailure = false;
    const store = new MarkdownNoteStore(stateRoot, {
      now: () => new Date("2026-08-29T16:32:54.123Z"),
      create_id: idSequence(),
      on_atomic_step(step, details) {
        if (
          injectFailure &&
          step === "before_publish" &&
          details.target === "notes/days/day2/overview.md"
        ) {
          throw new Error("simulated process failure before publish");
        }
      },
    });
    const locator: NoteLocator = { kind: "day", programme_day_id: "day2" };
    const created = await store.create({ ...locator, note_id: "note-day2", markdown: "Accepted" });
    injectFailure = true;

    await expect(
      store.save(locator, {
        note_id: "note-day2",
        expected_revision: created.note.frontmatter.revision,
        expected_content_hash: created.note.content_hash,
        markdown: "Write that never published",
      }),
    ).rejects.toThrow(/simulated process failure/);

    const afterFailure = await store.read(locator);
    expect(afterFailure.markdown).toBe("Accepted");
    expect(afterFailure.frontmatter.revision).toBe(1);
  });
});

describe("MarkdownNoteStore recovery and confinement", () => {
  it("restores the latest accepted snapshot and preserves corrupt displaced bytes", async () => {
    const stateRoot = await temporaryStateRoot();
    const store = new MarkdownNoteStore(stateRoot, {
      now: () => new Date("2026-08-29T16:32:54.123Z"),
      create_id: idSequence(),
    });
    const locator: NoteLocator = { kind: "lesson", section_id: "1.2-model-evals" };
    const created = await store.create({
      ...locator,
      note_id: "lesson-note-12",
      markdown: "First version",
    });
    const saved = await store.save(locator, {
      note_id: created.note.frontmatter.note_id,
      expected_revision: created.note.frontmatter.revision,
      expected_content_hash: created.note.content_hash,
      markdown: "Second version",
    });
    if (saved.status !== "saved") throw new Error("expected saved result");

    const canonicalPath = join(stateRoot, saved.note.logical_path);
    await writeFile(canonicalPath, "not valid frontmatter\nvaluable damaged bytes", "utf8");
    await expect(store.read(locator)).rejects.toMatchObject({ code: "identity_mismatch" });

    const recovery = await store.recover(locator, "lesson-note-12");
    expect(recovery.status).toBe("recovered");
    if (recovery.status !== "recovered") throw new Error("expected recovered result");
    expect(recovery.note.markdown).toBe("Second version");
    expect(recovery.note.frontmatter.revision).toBe(2);
    expect(recovery.displaced_copy_path).toBeDefined();
    expect(
      await readFile(join(stateRoot, recovery.displaced_copy_path ?? "missing"), "utf8"),
    ).toContain("valuable damaged bytes");
  });

  it("rejects traversal identities before touching disk", async () => {
    const stateRoot = await temporaryStateRoot();
    const store = new MarkdownNoteStore(stateRoot);

    await expect(
      store.create({ kind: "lesson", section_id: "../../outside", note_id: "safe-id" }),
    ).rejects.toThrow(/section_id/);
  });

  it("rejects a symlinked parent instead of writing outside the notes root", async () => {
    const stateRoot = await temporaryStateRoot();
    const outside = await temporaryStateRoot();
    const store = new MarkdownNoteStore(stateRoot, { create_id: idSequence() });
    await store.list(); // Initializes the canonical notes root.
    await symlink(outside, join(stateRoot, "notes/days"));

    await expect(
      store.create({ kind: "day", programme_day_id: "day1", note_id: "note-day1" }),
    ).rejects.toBeInstanceOf(NoteStoreError);
    await expect(readFile(join(outside, "day1/overview.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
