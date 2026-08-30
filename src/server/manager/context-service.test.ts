import { describe, expect, it } from "vitest";

import type { CurriculumSectionView } from "../../shared/api.js";
import type { NoteRecord, NoteSummary } from "../../shared/notes.js";
import { ManagerContextService } from "./context-service.js";

const section: CurriculumSectionView = {
  sectionId: "1.1",
  title: "Boundaries",
  sourcePath: "1.1-boundaries/README.md",
  outcomes: [{
    outcomeId: "outcome:1.1:1",
    versionId: "version:1",
    category: "security",
    text: "Explain where model output crosses a trust boundary.",
    sourcePath: "1.1-boundaries/README.md",
  }],
};

const noteSummary: NoteSummary = {
  note_id: "lesson-1.1",
  note_kind: "lesson",
  title: "Boundaries",
  revision: 3,
  status: "active",
  last_modified_at: "2026-08-30T09:00:00.000Z",
  locator: { kind: "lesson", section_id: "1.1" },
  logical_path: "notes/lessons/1.1/lesson-1.1.md",
  content_hash: "a".repeat(64),
  has_learner_content: true,
};

describe("ManagerContextService", () => {
  it("projects only bounded learner-visible state and checked workflow status", async () => {
    const context = await new ManagerContextService({
      schedule: {
        async read() {
          return {
            runtimeSchedule: {
              schemaVersion: 1,
              scheduleId: "aisb-london-2026",
              scheduleRevision: "schedule:r1",
              seedId: "google-calendar-snapshot",
              sourceLabel: "One-time calendar import",
              programmeWindow: {
                start: "2026-08-31",
                end: "2026-09-06",
                timeZone: "Europe/London",
              },
              programmeDays: [],
              nonProgrammeDates: [],
              events: [],
            },
            scheduleRevision: "schedule:r1",
            programmeTimeZone: "Europe/London" as const,
            programmeDays: [],
            events: [{
              eventBindingId: "aisb-2026-001",
              programmeDayId: "day1" as const,
              title: "Trust boundaries",
              start: "2026-08-31T09:00:00+01:00",
              end: "2026-08-31T10:00:00+01:00",
              allDay: false,
              status: "scheduled" as const,
            }],
          };
        },
      },
      curriculum: { async readAllRepositoryDays() { return { day1: [section] }; } },
      progress: {
        async read() {
          return {
            revision: 2,
            version: `r2:${"b".repeat(64)}`,
            recovered: false,
            completions: [{
              outcomeId: "outcome:1.1:1",
              outcomeVersionId: "version:1",
              completed: true,
              completedAt: "2026-08-30T09:00:00.000Z",
            }],
          };
        },
      },
      notes: {
        async list() { return [noteSummary]; },
        async read() {
          return {
            frontmatter: {
              schema_version: 1,
              note_id: noteSummary.note_id,
              note_kind: "lesson",
              title: noteSummary.title,
              created_at: "2026-08-30T08:00:00.000Z",
              last_modified_at: noteSummary.last_modified_at,
              revision: 3,
              status: "active",
              links: { section_ids: ["1.1"], canonical_outcome_ids: [] },
            },
            markdown: "## Notes\n\nModel output remains untrusted.",
            locator: noteSummary.locator,
            logical_path: noteSummary.logical_path,
            content_hash: noteSummary.content_hash,
          } as NoteRecord;
        },
      },
      continuity: {
        async selectForDay() {
          return {
            targetDayId: "day7",
            totalTextBytes: 24,
            summaries: [{
              schemaVersion: 1 as const,
              status: "approved" as const,
              authoredBy: "learner" as const,
              summaryId: "day1-summary",
              sourceDayId: "day1",
              sourceScopeKey: "day:day1",
              sourceChatId: "chat:one",
              sourceTurnId: "turn:one",
              sectionIds: ["1.1"],
              outcomeVersionIds: [],
              approvedAt: "2026-08-30T10:00:00.000Z",
              contentHash: "c".repeat(64),
              text: "I need to revisit policy ownership.",
            }],
          };
        },
      },
      tutorHistory: {
        async listScopeExcerpts(options) {
          expect(options).toMatchObject({
            maxScopes: 6,
            maxMessagesPerScope: 6,
            excludeScopeKeys: ["manager:overall"],
          });
          return {
            truncated: false,
            omittedScopeCount: 0,
            scopes: [{
              scopeKey: "study:day1:1.1",
              latestActivityAt: "2026-08-30T10:30:00.000Z",
              messages: [{
                role: "tutor" as const,
                text: "Try naming the boundary before choosing a control.",
                occurredAt: "2026-08-30T10:30:00.000Z",
                truncated: false,
              }],
            }, {
              scopeKey: "manager:overall",
              latestActivityAt: "2026-08-30T10:31:00.000Z",
              messages: [{
                role: "learner" as const,
                text: "This manager self-history must not be re-injected.",
                occurredAt: "2026-08-30T10:31:00.000Z",
                truncated: false,
              }],
            }],
          };
        },
      },
      reviewHistory: {
        async listRecentSummaries(options) {
          expect(options).toMatchObject({ maxSessions: 6, maxOutcomesPerSession: 6 });
          return {
            truncated: false,
            omittedSessionCount: 0,
            sessions: [{
              sessionId: "review-day1",
              updatedAt: "2026-08-30T10:40:00.000Z",
              outcomes: [{
                outcomeId: "outcome:1.1:1",
                sectionId: "1.1",
                category: "security" as const,
                text: "Explain where model output crosses a trust boundary.",
                truncated: false,
              }],
              questionsAsked: 3,
              questionLimit: 3,
              responsesRecorded: 3,
              complete: true,
              recentFeedback: {
                text: "You identified the data boundary; revisit ownership of policy enforcement.",
                outcomeIds: ["outcome:1.1:1"],
                assessmentAuthority: "advisory" as const,
                truncated: false,
              },
            }],
          };
        },
      },
    }, () => new Date("2026-08-30T11:00:00.000Z")).build();

    expect(context.outcomes[0]).toMatchObject({ sectionId: "1.1", checked: true });
    expect(context.notes[0]).toMatchObject({
      logicalPath: noteSummary.logical_path,
      excerpt: expect.stringContaining("remains untrusted"),
    });
    expect(context.approvedContinuity[0]?.text).toContain("policy ownership");
    expect(context.priorTutorChats).toEqual([expect.objectContaining({
      scopeKey: "study:day1:1.1",
    })]);
    expect(context.reviewSummaries[0]).toMatchObject({
      sessionId: "review-day1",
      complete: true,
      recentFeedback: { assessmentAuthority: "advisory" },
    });
    expect(JSON.stringify(context)).not.toContain("_solution.py");
    expect(JSON.stringify(context)).not.toContain("manager self-history");
  });
});
