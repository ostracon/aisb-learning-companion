import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  deleteDraft,
  readDraft,
  resetDraftDatabaseForTests,
  writeDraft,
} from "../../src/client/storage/drafts.js";

describe("browser note drafts", () => {
  beforeEach(async () => resetDraftDatabaseForTests());

  it("commits every draft through an IndexedDB transaction", async () => {
    await writeDraft({
      noteId: "day-day1",
      content: "live text",
      baseRevision: 2,
      baseContentHash: "a".repeat(64),
      updatedAt: "2026-08-29T12:00:00Z",
    });
    await expect(readDraft("day-day1")).resolves.toMatchObject({
      content: "live text",
      baseRevision: 2,
      baseContentHash: "a".repeat(64),
    });
    await deleteDraft("day-day1");
    await expect(readDraft("day-day1")).resolves.toBeNull();
  });

  it("preserves a never-persisted offline draft without inventing a base hash", async () => {
    await writeDraft({
      noteId: "offline-note",
      content: "captured while the server was unavailable",
      baseRevision: 0,
      baseContentHash: "",
      updatedAt: "2026-08-29T12:01:00Z",
    });

    await expect(readDraft("offline-note")).resolves.toMatchObject({
      baseRevision: 0,
      baseContentHash: "",
    });
  });
});
