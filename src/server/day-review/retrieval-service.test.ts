import { describe, expect, it, vi } from "vitest";

import type { CurriculumSectionView, LearningDayId, ScheduleSnapshotResponse } from "../../shared/api.js";
import type { NoteRecord, NoteSummary } from "../../shared/notes.js";
import { createDayReviewToolHandler, SEARCH_DAY_REVIEW_SOURCES_TOOL } from "./tool.js";
import { DayReviewRetrievalService, type DayReviewRetrievalSources } from "./retrieval-service.js";

const sections: Record<LearningDayId, readonly CurriculumSectionView[]> = {
  day0: [],
  day1: [{
    sectionId: "1.1",
    title: "Serialization",
    sourcePath: "1.1-serialization/README.md",
    outcomes: [{ outcomeId: "1.1:security:1", versionId: "v1", category: "security", text: "Explain the boundary", sourcePath: "1.1-serialization/README.md" }],
  }],
  day2: [{ sectionId: "2.1", title: "Agents", sourcePath: "2.1-agents/README.md", outcomes: [] }],
  day3: [], day4: [], day5: [], day6: [], day7: [],
};

function note(dayId: "day1" | "day2", sectionId: "1.1" | "2.1"): NoteRecord {
  const noteId = `${dayId}-note`;
  return {
    locator: { kind: "lesson", section_id: sectionId },
    logical_path: `notes/lessons/${sectionId}/notes.md`,
    content_hash: dayId === "day1" ? "a".repeat(64) : "b".repeat(64),
    frontmatter: {
      schema_version: 1,
      note_id: noteId,
      note_kind: "lesson",
      title: `${dayId} note`,
      created_at: "2026-08-30T10:00:00.000Z",
      last_modified_at: "2026-08-30T10:00:00.000Z",
      revision: 2,
      status: "active",
      links: { section_ids: [sectionId], canonical_outcome_ids: [] },
    },
    markdown: dayId === "day1" ? "Transformer boundary and token stream notes." : "Agent loop notes.",
  };
}

function summary(record: NoteRecord): NoteSummary {
  return {
    note_id: record.frontmatter.note_id,
    note_kind: record.frontmatter.note_kind,
    title: record.frontmatter.title,
    revision: record.frontmatter.revision,
    status: record.frontmatter.status,
    last_modified_at: record.frontmatter.last_modified_at,
    locator: record.locator,
    logical_path: record.logical_path,
    content_hash: record.content_hash,
    has_learner_content: true,
  };
}

function sources(): DayReviewRetrievalSources {
  const records = [note("day1", "1.1"), note("day2", "2.1")];
  return {
    schedule: {
      async read() {
        return {
          runtimeSchedule: {} as ScheduleSnapshotResponse["runtimeSchedule"],
          scheduleRevision: "schedule-v1",
          programmeTimeZone: "Europe/London",
          programmeDays: [
            { dayId: "day1", date: "2026-08-30", curriculumKind: "content", title: "Day 1" },
            { dayId: "day2", date: "2026-08-31", curriculumKind: "content", title: "Day 2" },
          ],
          events: [
            { eventBindingId: "event-1", programmeDayId: "day1", title: "Talk", start: "2026-08-30T10:00:00+01:00", end: "2026-08-30T11:00:00+01:00", allDay: false, status: "scheduled" },
          ],
        };
      },
    },
    curriculum: { async readDay(dayId) { return sections[dayId]; } },
    notes: {
      async list() { return records.map(summary); },
      async read(locator) { return records.find((record) => JSON.stringify(record.locator) === JSON.stringify(locator))!; },
    },
    materials: {
      async manifest(sectionId) {
        return {
          sectionId,
          revision: `manifest-${sectionId}`,
          rootDocumentId: `doc-${sectionId}`,
          documents: [{
            documentId: `doc-${sectionId}`,
            title: "README",
            filename: "README.md",
            kind: "participant_instructions",
            accessClassification: "human_reader_only",
            contentHash: `hash-${sectionId}`,
            byteLength: 100,
            links: [],
            linksTruncated: false,
          }],
          truncated: false,
          limits: { maxDepth: 4, maxDocuments: 32, maxDocumentBytes: 1000, maxTotalBytes: 1000, maxLinksPerDocument: 10, maxTotalLinks: 10 },
        };
      },
      async readForModelContext(input) {
        return {
          audience: "model_context",
          sectionId: input.sectionId,
          manifestRevision: input.expectedManifestRevision,
          document: {
            documentId: input.documentId,
            title: "README",
            filename: "README.md",
            kind: "participant_instructions",
            accessClassification: "human_reader_only",
            contentHash: `hash-${input.sectionId}`,
            byteLength: 100,
            links: [],
            linksTruncated: false,
          },
          modelSafeMarkdown: input.sectionId === "1.1" ? "Learner-visible serialization question." : "Learner-visible agent question.",
          modelProjection: "spoiler_stripped_instructions",
          omittedProtectedBlocks: 3,
        };
      },
    },
    preparedReferences: {
      async listForSections(sectionIds) {
        return sectionIds.includes("1.1") ? [{
          sourceId: `source_${"c".repeat(64)}`,
          title: "Paper",
          requestedUrl: "https://example.com/paper.pdf",
          finalUrl: "https://example.com/paper.pdf",
          status: "cached",
          mediaType: "pdf",
          sourceContentHash: `sha256:${"d".repeat(64)}`,
          projectionContentHash: `sha256:${"e".repeat(64)}`,
          projectionStatus: "complete",
          pageCount: 2,
          detail: "Indexed two pages.",
          sectionIds: ["1.1"],
        }] : [];
      },
      async readProjectionForSections(sourceId, sectionIds) {
        return sourceId === `source_${"c".repeat(64)}` && sectionIds.includes("1.1") ? {
          sourceId,
          title: "Paper",
          requestedUrl: "https://example.com/paper.pdf",
          finalUrl: "https://example.com/paper.pdf",
          sourceContentHash: `sha256:${"d".repeat(64)}`,
          projectionContentHash: `sha256:${"e".repeat(64)}`,
          mediaType: "pdf",
          pageCount: 2,
          markdown: "## Page 1\n\nSerialized messages share one token channel.",
          sectionIds: ["1.1"],
        } : null;
      },
    },
    tutorHistory: {
      async listScopeExcerpts() {
        return {
          scopes: [
            { scopeKey: "study:section:1.1", latestActivityAt: "2026-08-30T12:00:00.000Z", messages: [{ role: "learner", text: "I tried serialization.", occurredAt: "2026-08-30T12:00:00.000Z", truncated: false }] },
            { scopeKey: "study:section:2.1", latestActivityAt: "2026-08-31T12:00:00.000Z", messages: [{ role: "learner", text: "Other day.", occurredAt: "2026-08-31T12:00:00.000Z", truncated: false }] },
          ],
          truncated: false,
          omittedScopeCount: 0,
        };
      },
    },
    reviewHistory: {
      async listRecentSummaries() {
        return {
          sessions: [{
            sessionId: "review-1",
            updatedAt: "2026-08-30T13:00:00.000Z",
            outcomes: [{ outcomeId: "1.1:security:1", sectionId: "1.1", category: "security", text: "Explain the boundary", truncated: false }],
            questionsAsked: 1,
            questionLimit: 3,
            responsesRecorded: 1,
            complete: false,
            recentFeedback: { text: "Good boundary identification.", outcomeIds: ["1.1:security:1"], assessmentAuthority: "advisory", truncated: false },
          }],
          truncated: false,
          omittedSessionCount: 0,
        };
      },
    },
    continuity: { async selectForDay(dayId) { return { targetDayId: dayId, summaries: [], totalTextBytes: 0 }; } },
  };
}

describe("DayReviewRetrievalService", () => {
  it("builds a day-only opaque inventory and excludes protected/raw answer content", async () => {
    const service = new DayReviewRetrievalService(sources());
    const inventory = await service.inventory("day1");

    expect(inventory.resources.map(({ kind }) => kind)).toEqual(expect.arrayContaining([
      "note", "curriculum", "prepared_reference", "tutor_history", "review_history",
    ]));
    expect(inventory.resources.every(({ resourceId }) => /^dayres_[a-f0-9]{48}$/u.test(resourceId))).toBe(true);
    expect(inventory.resources.some(({ citation }) => citation.includes("2.1"))).toBe(false);
    await expect(service.search({ dayId: "day1", query: "reference solution" })).resolves.toEqual([]);
  });

  it("searches and reads bounded day resources with citations", async () => {
    const service = new DayReviewRetrievalService(sources());
    const results = await service.search({ dayId: "day1", query: "serialized token", limit: 4 });

    expect(results[0]).toMatchObject({ kind: "prepared_reference", title: "Paper" });
    expect(results[0]?.citation).toContain("2 pages");
    const read = await service.read({ dayId: "day1", resourceId: results[0]!.resourceId, maxBytes: 512 });
    expect(read?.text).toContain("## Page 1");
    expect(read?.provenance).toMatchObject({ pageCount: 2, sectionIds: ["1.1"] });
  });

  it("rejects paths and cannot reuse another day's opaque resource ID", async () => {
    const service = new DayReviewRetrievalService(sources());
    const day2 = await service.inventory("day2");
    const day2Note = day2.resources.find(({ kind }) => kind === "note")!;

    await expect(service.read({ dayId: "day1", resourceId: day2Note.resourceId })).resolves.toBeNull();
    await expect(service.read({ dayId: "day1", resourceId: "/tmp/notes.md" })).rejects.toThrow("resource ID");
    await expect(service.read({ dayId: "day1", resourceId: "https://example.com" })).rejects.toThrow("resource ID");
  });

  it("binds dynamic tool searches to the server-selected day", async () => {
    const retrieval = new DayReviewRetrievalService(sources());
    const search = vi.spyOn(retrieval, "search");
    const handler = createDayReviewToolHandler(retrieval, "day1");
    const response = await handler({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      namespace: null,
      tool: SEARCH_DAY_REVIEW_SOURCES_TOOL,
      arguments: { query: "serialization" },
    });

    expect(search).toHaveBeenCalledWith(expect.objectContaining({ dayId: "day1" }));
    expect(response.success).toBe(true);
    expect(response.contentItems[0]?.type).toBe("inputText");
  });
});

