import type {
  CurriculumSectionView,
  LearningDayId,
  LearningProgressSnapshotResponse,
  ScheduleSnapshotResponse,
} from "../../shared/api.js";
import type {
  DayReviewContextProjection,
  DayReviewResourceKind,
} from "../../shared/day-review.js";
import type { DayReviewRetrievalService } from "./retrieval-service.js";

export interface DayReviewContextScheduleSource {
  read(): Promise<ScheduleSnapshotResponse>;
}

export interface DayReviewContextCurriculumSource {
  readDay(dayId: LearningDayId): Promise<readonly CurriculumSectionView[]>;
}

export interface DayReviewContextProgressSource {
  read(): Promise<LearningProgressSnapshotResponse>;
}

const RESOURCE_KINDS: readonly DayReviewResourceKind[] = Object.freeze([
  "note",
  "curriculum",
  "prepared_reference",
  "tutor_history",
  "review_history",
  "continuity",
]);

/** Compact day map; detailed content is available only through scoped tools. */
export class DayReviewContextService {
  public constructor(
    private readonly dayId: LearningDayId,
    private readonly schedule: DayReviewContextScheduleSource,
    private readonly curriculum: DayReviewContextCurriculumSource,
    private readonly progress: DayReviewContextProgressSource,
    private readonly retrieval: DayReviewRetrievalService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async build(): Promise<DayReviewContextProjection> {
    const [schedule, sections, progress, inventory] = await Promise.all([
      this.schedule.read(),
      this.curriculum.readDay(this.dayId),
      this.progress.read(),
      this.retrieval.inventory(this.dayId),
    ]);
    const day = schedule.programmeDays.find(({ dayId }) => dayId === this.dayId);
    const completed = new Set(progress.completions
      .filter(({ completed }) => completed)
      .map(({ outcomeId, outcomeVersionId }) => `${outcomeId}\0${outcomeVersionId}`));
    const counts = Object.fromEntries(RESOURCE_KINDS.map((kind) => [
      kind,
      inventory.resources.filter((resource) => resource.kind === kind).length,
    ])) as Record<DayReviewResourceKind, number>;

    return Object.freeze({
      schema: "aisb-learning-companion.day-review-context.v1" as const,
      generatedAt: this.now().toISOString(),
      dayId: this.dayId,
      schedule: Object.freeze({
        revision: schedule.scheduleRevision,
        title: day?.title ?? (this.dayId === "day0" ? "Day 0 · Preparation" : `Day ${this.dayId.slice(3)}`),
        date: day?.date ?? null,
        events: Object.freeze(schedule.events
          .filter(({ programmeDayId }) => programmeDayId === this.dayId)
          .map((event) => Object.freeze({
            title: event.title,
            start: event.start,
            end: event.end,
            status: event.status,
          }))),
      }),
      sections: Object.freeze(sections.map((section) => Object.freeze({
        sectionId: section.sectionId,
        title: section.title,
      }))),
      outcomes: Object.freeze(sections.flatMap((section) => section.outcomes.map((outcome) => Object.freeze({
        outcomeId: outcome.outcomeId,
        versionId: outcome.versionId,
        sectionId: section.sectionId,
        category: outcome.category,
        text: outcome.text,
        checked: completed.has(`${outcome.outcomeId}\0${outcome.versionId}`),
      })))),
      resources: inventory.resources,
      resourceCounts: Object.freeze(counts),
      omissions: inventory.omissions,
    });
  }
}

