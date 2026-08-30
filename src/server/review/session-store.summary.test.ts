import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FileReviewSessionStore,
  MemoryReviewSessionStore,
  type ReviewSessionSnapshot,
} from "./session-store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "aisb-review-summary-"));
  roots.push(root);
  return root;
}

function snapshot(sessionId: string, suffix: string): ReviewSessionSnapshot {
  const outcomeId = `outcome:${suffix}`;
  const outcomeVersionId = `version:${suffix}`;
  const provenance = {
    engine: "local-template" as const,
    transport: "in-process" as const,
    model: null,
    permissionProfile: null,
    threadId: `provider-thread:${suffix}`,
    turnId: `provider-turn:${suffix}`,
    disclosureId: `disclosure:${suffix}`,
    payloadHash: `sha256:${"a".repeat(64)}`,
    outputSchemaApplied: false,
  };
  return {
    schemaVersion: 1,
    revision: 0,
    sessionId,
    outcomes: [{
      outcomeId,
      outcomeVersionId,
      sectionId: "1.1",
      category: "security",
      ordinal: 0,
      text: `Explain the learner-visible boundary ${suffix}. ` + "detail ".repeat(80),
      sourcePath: `protected/${suffix}_solution.py`,
      sourceCommit: `commit:${suffix}`,
    }, {
      outcomeId: `outcome:${suffix}:second`,
      outcomeVersionId: `version:${suffix}:second`,
      sectionId: "1.2",
      category: "theory",
      ordinal: 1,
      text: "A second learner-visible outcome.",
      sourcePath: "protected/second_solution.py",
      sourceCommit: `commit:${suffix}:second`,
    }],
    modes: ["free_recall"],
    questionLimit: 3,
    responses: [{
      responseId: `response:${suffix}`,
      questionId: `question:${suffix}`,
      text: `raw learner answer ${suffix} must stay private`,
      learnerConfidence: 3,
      recordedAt: "2026-08-30T10:00:00.000Z",
    }],
    threadId: `provider-thread:${suffix}`,
    questionsAsked: 2,
    currentQuestion: null,
    lastFeedback: {
      feedbackId: `feedback:${suffix}`,
      questionId: `question:${suffix}`,
      responseId: `response:${suffix}`,
      text: `Advisory feedback ${suffix}: revisit the policy owner. ` + "steer ".repeat(80),
      outcomeIds: [outcomeId],
      citations: [{
        outcomeId,
        outcomeVersionId,
        category: "security",
        label: "Protected source label",
        sourcePath: `protected/${suffix}_solution.py`,
        sourceCommit: `commit:${suffix}`,
      }],
      assessmentAuthority: "advisory",
      provenance,
    },
    pendingResponseId: null,
    pendingOperation: null,
    complete: true,
  };
}

const limits = {
  maxSessions: 4,
  maxOutcomesPerSession: 1,
  maxOutcomeBytes: 128,
  maxFeedbackBytes: 128,
  maxTotalBytes: 1024,
} as const;

describe("review-session continuity summaries", () => {
  it("returns recent bounded advisory summaries without answers, sources, or provider state", async () => {
    const store = new MemoryReviewSessionStore();
    await store.create(snapshot("review-old", "old"));
    await store.create(snapshot("review-recent", "recent"));

    const listing = await store.listRecentSummaries({ ...limits, maxSessions: 1 });

    expect(listing.sessions).toHaveLength(1);
    expect(listing.sessions[0]).toMatchObject({
      sessionId: "review-recent",
      questionsAsked: 2,
      questionLimit: 3,
      responsesRecorded: 1,
      complete: true,
      outcomes: [{ sectionId: "1.1", truncated: true }],
      recentFeedback: { assessmentAuthority: "advisory", truncated: true },
    });
    expect(listing.truncated).toBe(true);
    expect(listing.omittedSessionCount).toBe(1);
    const serialized = JSON.stringify(listing);
    expect(serialized).not.toMatch(/raw learner answer|_solution\.py|sourcePath|sourceCommit|provider-thread|provider-turn|payloadHash|permissionProfile|Protected source label/u);
  });

  it("lists owner-only file sessions, ignores temporary files, and rejects links", async () => {
    const root = await temporaryRoot();
    const store = new FileReviewSessionStore(root);
    await store.create(snapshot("review-file", "file"));
    await writeFile(join(root, "review/sessions/.unfinished.tmp"), "partial");

    const listing = await store.listRecentSummaries(limits);
    expect(listing.sessions[0]).toMatchObject({
      sessionId: "review-file",
      updatedAt: expect.any(String),
      recentFeedback: { assessmentAuthority: "advisory" },
    });
    expect(JSON.stringify(listing)).not.toContain("raw learner answer file");

    const outside = await temporaryRoot();
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "outside.json"), "{}");
    await symlink(join(outside, "outside.json"), join(root, "review/sessions/linked.json"));
    await expect(store.listRecentSummaries(limits)).rejects.toMatchObject({ code: "corrupt_store" });
  });
});

