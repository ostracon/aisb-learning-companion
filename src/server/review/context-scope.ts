import type {
  CurriculumSectionView,
  EventCurriculumBindingSnapshotResponse,
  LearningDayId,
  ScheduleEventView,
} from "../../shared/api.js";
import { ReviewCoachServiceError } from "./service.js";

export interface TodayReviewSectionScopeInput {
  readonly dayId: LearningDayId;
  readonly eventBindingId: string | null;
  readonly sections: readonly CurriculumSectionView[];
  readonly events: readonly ScheduleEventView[];
  readonly eventCurriculumBindings: EventCurriculumBindingSnapshotResponse;
}

export interface StudyReviewSectionScopeInput {
  readonly dayId: LearningDayId;
  readonly sectionId: string | null;
  readonly sections: readonly CurriculumSectionView[];
}

/**
 * Restrict a Today review to the currently selected event's explicit material
 * links. Day-level review remains broad; selected events never fall back to all
 * outcomes for the day.
 */
export function scopeTodayReviewSections(
  input: Readonly<TodayReviewSectionScopeInput>,
): readonly CurriculumSectionView[] {
  if (input.eventBindingId === null) return input.sections;

  const event = input.events.find(
    (candidate) => candidate.eventBindingId === input.eventBindingId,
  );
  if (
    event === undefined ||
    event.status !== "scheduled" ||
    event.programmeDayId !== input.dayId
  ) {
    throw new ReviewCoachServiceError(
      "conflict",
      "The selected schedule event changed before Review started. Refresh and try again.",
      409,
    );
  }

  const binding = input.eventCurriculumBindings.bindings.find(
    (candidate) => candidate.eventBindingId === input.eventBindingId,
  );
  if (binding === undefined || binding.sectionIds.length === 0) {
    throw new ReviewCoachServiceError(
      "conflict",
      "Link this schedule event to Study material before starting Review.",
      409,
    );
  }

  const sectionsById = new Map(
    input.sections.map((section) => [section.sectionId, section]),
  );
  const missingSectionIds = binding.sectionIds.filter(
    (sectionId) => !sectionsById.has(sectionId),
  );
  if (missingSectionIds.length > 0) {
    throw new ReviewCoachServiceError(
      "conflict",
      `The event's Study material link is stale (${missingSectionIds.join(", ")}). Repair the link before starting Review.`,
      409,
    );
  }

  return binding.sectionIds.map((sectionId) => sectionsById.get(sectionId)!);
}

/**
 * Restrict a Study review to the selected section from the current repository
 * day. A null section is reserved for the repository-day overview route.
 */
export function scopeStudyReviewSections(
  input: Readonly<StudyReviewSectionScopeInput>,
): readonly CurriculumSectionView[] {
  if (input.sectionId === null) return input.sections;

  const matchingSections = input.sections.filter(
    (section) => section.sectionId === input.sectionId,
  );
  if (matchingSections.length !== 1) {
    throw new ReviewCoachServiceError(
      "conflict",
      "The selected Study section no longer belongs to this repository day. Refresh and try again.",
      409,
    );
  }
  return matchingSections;
}
