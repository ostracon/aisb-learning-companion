import { describe, expect, it } from "vitest";

import {
  materialHrefWithStudyNote,
  readStudyNoteOverride,
  studyNoteSelectionHref,
} from "./study-note-routing.js";

describe("Study note routing", () => {
  it("accepts current-day lesson and quick notes but rejects other scopes", () => {
    expect(readStudyNoteOverride("?note=lesson-1.0", "day1", ["1.0", "1.1"], "lesson-1.1"))
      .toEqual({ noteId: "lesson-1.0", shouldCanonicalize: false });
    expect(readStudyNoteOverride("?note=day1_quicknote_tokenizer", "day1", ["1.0"], "lesson-1.0"))
      .toEqual({ noteId: "day1_quicknote_tokenizer", shouldCanonicalize: false });

    for (const search of [
      "?note=lesson-2.0",
      "?note=day2_quicknote_other_day",
      "?note=event-aisb-2026-002",
      "?note=day1_quicknote_",
      "?note=../../private",
      "?note=lesson-1.0&note=lesson-1.1",
    ]) {
      expect(readStudyNoteOverride(search, "day1", ["1.0", "1.1"], "lesson-1.1"))
        .toEqual({ noteId: null, shouldCanonicalize: true });
    }
  });

  it("canonicalizes an explicit default note", () => {
    expect(readStudyNoteOverride("?note=lesson-1.1", "day1", ["1.0", "1.1"], "lesson-1.1"))
      .toEqual({ noteId: null, shouldCanonicalize: true });
  });

  it("changes only the note query and preserves other URL state", () => {
    const location = {
      pathname: "/study/day1/section/1.1/document/readme",
      search: "?view=compact",
      hash: "#exercise-1-1-1",
    };
    expect(studyNoteSelectionHref(location, "lesson-1.0", "lesson-1.1")).toBe(
      "/study/day1/section/1.1/document/readme?view=compact&note=lesson-1.0#exercise-1-1-1",
    );
    expect(studyNoteSelectionHref(
      { ...location, search: "?view=compact&note=lesson-1.0" },
      "lesson-1.1",
      "lesson-1.1",
    )).toBe("/study/day1/section/1.1/document/readme?view=compact#exercise-1-1-1");
  });

  it("preserves a selected note across same-day material links", () => {
    expect(materialHrefWithStudyNote(
      "/study/day1/section/1.1/document/exercises#part-a",
      "day1",
      "lesson-1.0",
    )).toBe("/study/day1/section/1.1/document/exercises?note=lesson-1.0#part-a");

    expect(materialHrefWithStudyNote(
      "/study/day1/section/1.0/document/readme?mode=wide",
      "day1",
      "lesson-1.0",
    )).toBe("/study/day1/section/1.0/document/readme?mode=wide");

    expect(materialHrefWithStudyNote(
      "/study/day2/section/2.0/document/readme?note=lesson-1.0",
      "day1",
      "lesson-1.0",
    )).toBe("/study/day2/section/2.0/document/readme");
  });
});
