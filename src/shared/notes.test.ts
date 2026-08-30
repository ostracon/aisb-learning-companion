import { describe, expect, it } from "vitest";

import {
  assertNoteMatchesLocator,
  createNoteTemplate,
  makeAdHocTimestampSlug,
  noteHasLearnerContent,
  noteLogicalPath,
  parseNoteMarkdown,
  serializeNoteMarkdown,
  upgradeUntouchedNoteTemplate,
  validateNoteFrontmatter,
} from "./notes";

describe("note templates", () => {
  it("keeps questions and their inline answers together", () => {
    const markdown = createNoteTemplate("  Lesson   1.2  ");
    expect(markdown).toBe(
      "# Lesson 1.2\n\n## Raw Notes\n\n\n## Key ideas\n\n\n## Questions\n\n\n## Reflection\n\n",
    );
  });

  it("upgrades only exact untouched earlier templates", () => {
    const previous = "# Lesson 1.2\n\n## Raw Notes\n\n\n## Key ideas\n\n\n## Questions\n\n\n## Answers\n\n\n## Reflection\n\n";
    const preRawNotes = "# Lesson 1.2\n\n## Key ideas\n\n\n## Questions\n\n\n## Answers\n\n\n## Reflection\n\n";
    const oldest = "# Lesson 1.2\n\n## Key ideas\n\n\n## Questions\n\n\n## Reflection\n\n";
    expect(upgradeUntouchedNoteTemplate(previous, "Lesson 1.2")).toBe(createNoteTemplate("Lesson 1.2"));
    expect(upgradeUntouchedNoteTemplate(preRawNotes, "Lesson 1.2")).toBe(createNoteTemplate("Lesson 1.2"));
    expect(upgradeUntouchedNoteTemplate(oldest, "Lesson 1.2")).toBe(createNoteTemplate("Lesson 1.2"));

    for (const heading of ["Raw Notes", "Key ideas", "Questions", "Answers"]) {
      const authored = previous.replace(`## ${heading}\n\n\n`, `## ${heading}\n\nMy own text.\n\n`);
      expect(upgradeUntouchedNoteTemplate(authored, "Lesson 1.2")).toBeNull();
    }
    const authoredReflection = previous.replace("## Reflection\n\n", "## Reflection\n\nMy own text.\n");
    expect(upgradeUntouchedNoteTemplate(authoredReflection, "Lesson 1.2")).toBeNull();
    expect(
      upgradeUntouchedNoteTemplate(previous.replace("# Lesson 1.2", "# My  Lesson 1.2"), "Lesson 1.2"),
    ).toBeNull();
  });

  it("distinguishes blank templates from learner-authored notes", () => {
    const current = createNoteTemplate("Lesson 1.2");
    const previous = "# Lesson 1.2\n\n## Raw Notes\n\n\n## Key ideas\n\n\n## Questions\n\n\n## Answers\n\n\n## Reflection\n\n";
    const preRawNotes = "# Lesson 1.2\n\n## Key ideas\n\n\n## Questions\n\n\n## Answers\n\n\n## Reflection\n\n";
    const oldest = "# Lesson 1.2\n\n## Key ideas\n\n\n## Questions\n\n\n## Reflection\n\n";

    expect(noteHasLearnerContent(current)).toBe(false);
    expect(noteHasLearnerContent(previous)).toBe(false);
    expect(noteHasLearnerContent(preRawNotes)).toBe(false);
    expect(noteHasLearnerContent(oldest)).toBe(false);
    expect(noteHasLearnerContent("  \r\n\t\r\n")).toBe(false);
    expect(noteHasLearnerContent(current.replace("# Lesson 1.2", "# Renamed lesson"))).toBe(false);
    expect(noteHasLearnerContent(current.replace(/\n/gu, " \r\n"))).toBe(false);
    expect(noteHasLearnerContent(
      current.replace("## Raw Notes\n\n", "## Raw Notes\n\nMy own text.\n"),
    )).toBe(true);
    expect(noteHasLearnerContent(current.replace("## Key ideas", "## Main ideas")))
      .toBe(true);
    expect(noteHasLearnerContent(createNoteTemplate("Lesson 1.2"))).toBe(false);
  });
});

describe("note logical paths", () => {
  it("derives stable paths only from validated identities", () => {
    expect(noteLogicalPath({ kind: "day", programme_day_id: "day1" })).toBe(
      "notes/days/day1/overview.md",
    );
    expect(noteLogicalPath({ kind: "lesson", section_id: "1.2-model-evals" })).toBe(
      "notes/lessons/1.2-model-evals/notes.md",
    );
    expect(noteLogicalPath({ kind: "event", event_binding_id: "aisb-2026-017" })).toBe(
      "notes/events/aisb-2026-017/notes.md",
    );
    expect(
      noteLogicalPath({
        kind: "ad_hoc",
        creation_date: "2026-08-29",
        timestamp_slug: "20260829T163254123Z",
        note_id: "note-123",
      }),
    ).toBe("notes/ad-hoc/2026-08-29/20260829T163254123Z-note-123.md");
    expect(
      noteLogicalPath({
        kind: "ad_hoc",
        creation_date: "2026-08-29",
        note_id: "day0_quicknote_setup_questions",
      }),
    ).toBe("notes/ad-hoc/2026-08-29/day0_quicknote_setup_questions.md");
  });

  it("rejects traversal and malformed path identities", () => {
    expect(() => noteLogicalPath({ kind: "lesson", section_id: "../answers" })).toThrow(
      /section_id/,
    );
    expect(() =>
      noteLogicalPath({
        kind: "ad_hoc",
        creation_date: "2026-02-30",
        timestamp_slug: "20260829T163254123Z",
        note_id: "note-123",
      }),
    ).toThrow(/creation_date/);
  });
});

describe("note Markdown codec", () => {
  it("round-trips the deterministic YAML subset without changing the body", () => {
    const frontmatter = validateNoteFrontmatter({
      schema_version: 1,
      note_id: "note-day1",
      note_kind: "day",
      title: "Day 1 — Foundations",
      created_at: "2026-08-29T16:32:54.123Z",
      last_modified_at: "2026-08-29T16:32:54.123Z",
      revision: 1,
      status: "active",
      links: {
        programme_day_id: "day1",
        section_ids: ["1.1"],
        canonical_outcome_ids: ["day1.security.1"],
      },
    });
    const markdown = "# Notes\n\nA learner-authored thought.\n";
    const serialized = serializeNoteMarkdown({ frontmatter, markdown });

    expect(parseNoteMarkdown(serialized)).toEqual({ frontmatter, markdown });
    expect(makeAdHocTimestampSlug("2026-08-29T17:32:54.123+01:00")).toBe(
      "20260829T163254123Z",
    );
  });

  it("detects a frontmatter/path identity mismatch", () => {
    const frontmatter = validateNoteFrontmatter({
      schema_version: 1,
      note_id: "lesson-note",
      note_kind: "lesson",
      title: "Lesson notes",
      created_at: "2026-08-29T16:32:54.123Z",
      last_modified_at: "2026-08-29T16:32:54.123Z",
      revision: 1,
      status: "active",
      links: { section_ids: ["1.2"], canonical_outcome_ids: [] },
    });

    expect(() =>
      assertNoteMatchesLocator(frontmatter, { kind: "lesson", section_id: "1.3" }),
    ).toThrow(/lesson path/);
  });
});
