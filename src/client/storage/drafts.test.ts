// @vitest-environment jsdom

import "fake-indexeddb/auto";

import { beforeEach, describe, expect, it } from "vitest";

import {
  claimDraftWriterEpoch,
  deleteDraft,
  readDraft,
  resetDraftDatabaseForTests,
  StaleDraftWriterError,
  writeDraft,
} from "./drafts.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

beforeEach(async () => {
  await resetDraftDatabaseForTests();
});

describe("browser draft writer fencing", () => {
  it("reopens storage after another context deletes the database", async () => {
    await expect(readDraft("version-change-note")).resolves.toBeNull();

    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase("aisb-learning-companion");
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error("Could not delete draft storage"));
      request.onblocked = () => reject(new Error("Draft storage deletion was blocked"));
    });

    const writerEpoch = await claimDraftWriterEpoch("version-change-note");
    await writeDraft({
      noteId: "version-change-note",
      content: "Draft after a version change",
      baseRevision: 1,
      baseContentHash: HASH_A,
      updatedAt: "2026-08-29T12:00:00.000Z",
      writerEpoch,
      editSequence: 1,
    });

    await expect(readDraft("version-change-note")).resolves.toMatchObject({
      content: "Draft after a version change",
      writerEpoch,
    });
  });

  it("keeps legacy unfenced drafts readable before the first ownership claim", async () => {
    await writeDraft({
      noteId: "legacy-note",
      content: "Legacy recovery text",
      baseRevision: 1,
      baseContentHash: HASH_A,
      updatedAt: "2026-08-29T12:00:00.000Z",
    });

    await expect(readDraft("legacy-note")).resolves.toMatchObject({
      content: "Legacy recovery text",
      writerEpoch: 0,
      editSequence: 0,
    });
  });

  it("rejects an older edit sequence within the active writer epoch", async () => {
    const writerEpoch = await claimDraftWriterEpoch("sequence-note");
    await writeDraft({
      noteId: "sequence-note",
      content: "Newest accepted edit",
      baseRevision: 1,
      baseContentHash: HASH_A,
      updatedAt: "2026-08-29T12:00:02.000Z",
      writerEpoch,
      editSequence: 2,
    });

    await expect(writeDraft({
      noteId: "sequence-note",
      content: "Delayed older edit",
      baseRevision: 1,
      baseContentHash: HASH_A,
      updatedAt: "2026-08-29T12:00:01.000Z",
      writerEpoch,
      editSequence: 1,
    })).rejects.toBeInstanceOf(StaleDraftWriterError);
    await expect(readDraft("sequence-note")).resolves.toMatchObject({
      content: "Newest accepted edit",
      editSequence: 2,
    });
  });

  it("rejects every old-epoch write as soon as a successor claims ownership", async () => {
    const firstEpoch = await claimDraftWriterEpoch("handoff-note");
    await writeDraft({
      noteId: "handoff-note",
      content: "Owner A draft",
      baseRevision: 1,
      baseContentHash: HASH_A,
      updatedAt: "2026-08-29T12:00:01.000Z",
      writerEpoch: firstEpoch,
      editSequence: 1,
    });
    const successorEpoch = await claimDraftWriterEpoch("handoff-note");

    await expect(writeDraft({
      noteId: "handoff-note",
      content: "Late owner A acknowledgement",
      baseRevision: 2,
      baseContentHash: HASH_B,
      updatedAt: "2026-08-29T12:00:03.000Z",
      writerEpoch: firstEpoch,
      editSequence: 1,
    })).rejects.toBeInstanceOf(StaleDraftWriterError);

    await writeDraft({
      noteId: "handoff-note",
      content: "Owner B draft",
      baseRevision: 1,
      baseContentHash: HASH_A,
      updatedAt: "2026-08-29T12:00:04.000Z",
      writerEpoch: successorEpoch,
      editSequence: 1,
    });
    await expect(readDraft("handoff-note")).resolves.toMatchObject({
      content: "Owner B draft",
      writerEpoch: successorEpoch,
      editSequence: 1,
    });
  });

  it("allows an equal-sequence disk acknowledgement to rebase the same content", async () => {
    const writerEpoch = await claimDraftWriterEpoch("rebase-note");
    await writeDraft({
      noteId: "rebase-note",
      content: "Accepted edit",
      baseRevision: 1,
      baseContentHash: HASH_A,
      updatedAt: "2026-08-29T12:00:01.000Z",
      writerEpoch,
      editSequence: 1,
    });
    await writeDraft({
      noteId: "rebase-note",
      content: "Accepted edit",
      baseRevision: 2,
      baseContentHash: HASH_B,
      updatedAt: "2026-08-29T12:00:02.000Z",
      writerEpoch,
      editSequence: 1,
    });

    await expect(readDraft("rebase-note")).resolves.toMatchObject({
      content: "Accepted edit",
      baseRevision: 2,
      baseContentHash: HASH_B,
      writerEpoch,
      editSequence: 1,
    });
  });

  it("rejects different content that reuses an accepted edit sequence", async () => {
    const writerEpoch = await claimDraftWriterEpoch("duplicate-sequence-note");
    await writeDraft({
      noteId: "duplicate-sequence-note",
      content: "Accepted edit",
      baseRevision: 1,
      baseContentHash: HASH_A,
      updatedAt: "2026-08-29T12:00:01.000Z",
      writerEpoch,
      editSequence: 1,
    });

    await expect(writeDraft({
      noteId: "duplicate-sequence-note",
      content: "Different bytes with a reused sequence",
      baseRevision: 2,
      baseContentHash: HASH_B,
      updatedAt: "2026-08-29T12:00:02.000Z",
      writerEpoch,
      editSequence: 1,
    })).rejects.toBeInstanceOf(StaleDraftWriterError);
    await expect(readDraft("duplicate-sequence-note")).resolves.toMatchObject({
      content: "Accepted edit",
      baseRevision: 1,
      writerEpoch,
      editSequence: 1,
    });
  });

  it("preserves the epoch high-water mark when a recovery draft is cleared", async () => {
    const firstEpoch = await claimDraftWriterEpoch("cleared-note");
    await writeDraft({
      noteId: "cleared-note",
      content: "Owner A draft",
      baseRevision: 1,
      baseContentHash: HASH_A,
      updatedAt: "2026-08-29T12:00:01.000Z",
      writerEpoch: firstEpoch,
      editSequence: 1,
    });
    await deleteDraft("cleared-note");

    const successorEpoch = await claimDraftWriterEpoch("cleared-note");
    expect(successorEpoch).toBe(firstEpoch + 1);
    await expect(writeDraft({
      noteId: "cleared-note",
      content: "Late owner A draft",
      baseRevision: 1,
      baseContentHash: HASH_A,
      updatedAt: "2026-08-29T12:00:02.000Z",
      writerEpoch: firstEpoch,
      editSequence: 2,
    })).rejects.toBeInstanceOf(StaleDraftWriterError);
  });
});
