import type {
  CurriculumSectionView,
  EventCurriculumBindingSnapshotResponse,
} from "../../shared/api.js";

export function curriculumSectionsForTodaySelection(
  daySections: readonly CurriculumSectionView[],
  selectedEventBindingId: string | null,
  snapshot: EventCurriculumBindingSnapshotResponse,
): CurriculumSectionView[] {
  // Today is schedule-led: without an explicitly selected event there is no
  // curriculum scope to project. Day-wide outcomes belong in Study/manager
  // context, not as sticky content beneath the schedule.
  if (selectedEventBindingId === null) return [];
  const linkedIds = snapshot.bindings.find(
    (binding) => binding.eventBindingId === selectedEventBindingId,
  )?.sectionIds ?? [];
  const byId = new Map(daySections.map((section) => [section.sectionId, section]));
  return linkedIds.flatMap((sectionId) => {
    const section = byId.get(sectionId);
    return section ? [section] : [];
  });
}
