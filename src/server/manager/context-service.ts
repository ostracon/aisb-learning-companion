import type {
  CurriculumSectionView,
  LearningProgressSnapshotResponse,
  ScheduleSnapshotResponse,
} from "../../shared/api.js";
import type { ManagerContextProjection } from "../../shared/manager.js";
import type { NoteLocator, NoteRecord, NoteSummary } from "../../shared/notes.js";
import type {
  ApprovedContinuitySummary,
  ContinuitySummarySelection,
} from "../tutor/continuity-store.js";
import type {
  TutorSessionScopeExcerptListing,
  TutorSessionScopeExcerptOptions,
} from "../tutor/session-log-store.js";
import type {
  ReviewSessionSummaryListing,
  ReviewSessionSummaryOptions,
} from "../review/session-store.js";

const MAX_NOTES = 40;
const MAX_NOTE_EXCERPT_BYTES = 6 * 1024;
const MAX_NOTE_TOTAL_BYTES = 64 * 1024;
const MAX_OUTCOMES = 300;
const TUTOR_HISTORY_LIMITS: TutorSessionScopeExcerptOptions = Object.freeze({
  maxScopes: 6,
  maxMessagesPerScope: 6,
  maxMessageBytes: 2 * 1024,
  maxTotalBytes: 32 * 1024,
  excludeScopeKeys: ["manager:overall"],
});
const REVIEW_HISTORY_LIMITS: ReviewSessionSummaryOptions = Object.freeze({
  maxSessions: 6,
  maxOutcomesPerSession: 6,
  maxOutcomeBytes: 1024,
  maxFeedbackBytes: 2 * 1024,
  maxTotalBytes: 24 * 1024,
});

export interface ManagerScheduleSource {
  read(): Promise<ScheduleSnapshotResponse>;
}

export interface ManagerCurriculumSource {
  readAllRepositoryDays(): Promise<Partial<Record<string, readonly CurriculumSectionView[]>>>;
}

export interface ManagerProgressSource {
  read(): Promise<LearningProgressSnapshotResponse>;
}

export interface ManagerNoteSource {
  list(): Promise<readonly NoteSummary[]>;
  read(locator: NoteLocator): Promise<NoteRecord>;
}

export interface ManagerContinuitySource {
  selectForDay(dayId: string): Promise<ContinuitySummarySelection>;
}

export interface ManagerPreparedReference {
  readonly sourceId: string;
  readonly title: string;
  readonly url: string;
  readonly status: "cached" | "not_fetched" | "unsupported" | "failed";
  readonly contentHash: string | null;
  readonly excerpt: string | null;
  readonly truncated: boolean;
  readonly detail: string;
}

export interface ManagerPreparationContextSource {
  read(): Promise<readonly ManagerPreparedReference[]>;
}

export interface ManagerTutorHistorySource {
  listScopeExcerpts(options: TutorSessionScopeExcerptOptions): Promise<TutorSessionScopeExcerptListing>;
}

export interface ManagerReviewHistorySource {
  listRecentSummaries(options: ReviewSessionSummaryOptions): Promise<ReviewSessionSummaryListing>;
}

export interface ManagerContextSources {
  readonly schedule: ManagerScheduleSource;
  readonly curriculum: ManagerCurriculumSource;
  readonly progress: ManagerProgressSource;
  readonly notes: ManagerNoteSource;
  readonly continuity: ManagerContinuitySource;
  readonly tutorHistory: ManagerTutorHistorySource;
  readonly reviewHistory: ManagerReviewHistorySource;
  readonly preparation?: ManagerPreparationContextSource;
}

/**
 * Builds a compact, learner-visible manager envelope. It deliberately excludes
 * answer files, raw review responses, protected curriculum projections,
 * recovery copies, credentials, and provider state. Prior tutor text and
 * review feedback arrive only through their safe bounded projections.
 */
export class ManagerContextService {
  public constructor(
    private readonly sources: ManagerContextSources,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async build(): Promise<ManagerContextProjection> {
    const [
      schedule,
      curriculum,
      progress,
      noteSummaries,
      continuity,
      preparedReferences,
      tutorHistory,
      reviewHistory,
    ] = await Promise.all([
      this.sources.schedule.read(),
      this.sources.curriculum.readAllRepositoryDays(),
      this.sources.progress.read(),
      this.sources.notes.list(),
      // day7 safely selects bounded, explicitly approved summaries from prior
      // days. Day-7 reflections remain in ordinary notes until a later day
      // exists to carry them forward.
      this.sources.continuity.selectForDay("day7"),
      this.sources.preparation?.read() ?? Promise.resolve([]),
      this.sources.tutorHistory.listScopeExcerpts(TUTOR_HISTORY_LIMITS),
      this.sources.reviewHistory.listRecentSummaries(REVIEW_HISTORY_LIMITS),
    ]);
    const omissions: string[] = [];

    const completed = new Set(
      progress.completions
        .filter((item) => item.completed)
        .map((item) => `${item.outcomeId}\u0000${item.outcomeVersionId}`),
    );
    const outcomes = Object.entries(curriculum)
      .sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }))
      .flatMap(([, sections]) => sections ?? [])
      .flatMap((section) => section.outcomes.map((outcome) => ({
        outcomeId: outcome.outcomeId,
        versionId: outcome.versionId,
        sectionId: section.sectionId,
        category: outcome.category,
        text: outcome.text,
        checked: completed.has(`${outcome.outcomeId}\u0000${outcome.versionId}`),
      })))
      .slice(0, MAX_OUTCOMES);
    const totalOutcomeCount = Object.values(curriculum)
      .flatMap((sections) => sections ?? [])
      .reduce((total, section) => total + section.outcomes.length, 0);
    if (totalOutcomeCount > outcomes.length) {
      omissions.push(`outcomes limited to ${MAX_OUTCOMES}`);
    }

    const activeNotes = [...noteSummaries]
      .filter((note) => note.status === "active")
      .sort((left, right) => right.last_modified_at.localeCompare(left.last_modified_at));
    if (activeNotes.length > MAX_NOTES) omissions.push(`notes limited to ${MAX_NOTES}`);
    const notes: ManagerContextProjection["notes"][number][] = [];
    let noteBytes = 0;
    for (const summary of activeNotes.slice(0, MAX_NOTES)) {
      if (noteBytes >= MAX_NOTE_TOTAL_BYTES) {
        omissions.push(`note excerpts limited to ${MAX_NOTE_TOTAL_BYTES} UTF-8 bytes`);
        break;
      }
      const record = await this.sources.notes.read(summary.locator);
      const remaining = Math.min(MAX_NOTE_EXCERPT_BYTES, MAX_NOTE_TOTAL_BYTES - noteBytes);
      const excerpt = truncateUtf8(record.markdown, remaining);
      const originalBytes = Buffer.byteLength(record.markdown, "utf8");
      const excerptBytes = Buffer.byteLength(excerpt, "utf8");
      noteBytes += excerptBytes;
      notes.push(Object.freeze({
        noteId: summary.note_id,
        title: summary.title,
        logicalPath: summary.logical_path,
        revision: summary.revision,
        excerpt,
        truncated: excerptBytes < originalBytes,
      }));
    }
    if (tutorHistory.truncated) {
      omissions.push("prior tutor excerpts were bounded");
    }
    if (reviewHistory.truncated) {
      omissions.push("review summaries were bounded");
    }

    return Object.freeze({
      schema: "aisb-learning-companion.manager-context.v1" as const,
      generatedAt: this.now().toISOString(),
      schedule: Object.freeze({
        revision: schedule.scheduleRevision,
        events: Object.freeze(schedule.events.map((event) => Object.freeze({
          dayId: event.programmeDayId,
          title: event.title,
          start: event.start,
          end: event.end,
          status: event.status,
        }))),
      }),
      outcomes: Object.freeze(outcomes),
      notes: Object.freeze(notes),
      approvedContinuity: Object.freeze(
        continuity.summaries.map((summary: ApprovedContinuitySummary) => Object.freeze({
          sourceDayId: summary.sourceDayId,
          approvedAt: summary.approvedAt,
          text: summary.text,
        })),
      ),
      preparedReferences: Object.freeze(
        preparedReferences.map((reference) => Object.freeze({ ...reference })),
      ),
      priorTutorChats: Object.freeze(
        tutorHistory.scopes
          .filter(({ scopeKey }) => scopeKey !== "manager:overall")
          .map((scope) => Object.freeze({
            scopeKey: scope.scopeKey,
            latestActivityAt: scope.latestActivityAt,
            messages: Object.freeze(scope.messages.map((message) => Object.freeze({ ...message }))),
          })),
      ),
      reviewSummaries: Object.freeze(
        reviewHistory.sessions.map((session) => Object.freeze({
          sessionId: session.sessionId,
          updatedAt: session.updatedAt,
          outcomes: Object.freeze(session.outcomes.map((outcome) => Object.freeze({ ...outcome }))),
          questionsAsked: session.questionsAsked,
          questionLimit: session.questionLimit,
          responsesRecorded: session.responsesRecorded,
          complete: session.complete,
          recentFeedback: session.recentFeedback === null
            ? null
            : Object.freeze({
                ...session.recentFeedback,
                outcomeIds: Object.freeze([...session.recentFeedback.outcomeIds]),
              }),
        })),
      ),
      omissions: Object.freeze(omissions),
    });
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let lower = 0;
  let upper = value.length;
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= maxBytes) lower = middle;
    else upper = middle - 1;
  }
  return value.slice(0, lower).trimEnd();
}
