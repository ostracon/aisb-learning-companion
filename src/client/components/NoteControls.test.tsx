import { describe, expect, it } from "vitest";

import { slugifyQuickNoteName } from "./NoteControls.js";

describe("quick-note naming", () => {
  it("builds readable path-safe suffixes without traversal or filename spam", () => {
    expect(slugifyQuickNoteName("  Model editing questions  ")).toBe("model_editing_questions");
    expect(slugifyQuickNoteName("Café / ../ answers?!")).toBe("cafe_answers");
    expect(slugifyQuickNoteName("What's next?")).toBe("whats_next");
  });
});
