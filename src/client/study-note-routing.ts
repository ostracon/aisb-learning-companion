import type { LearningDayId } from "../shared/api.js";

export interface StudyNoteOverride {
  readonly noteId: string | null;
  readonly shouldCanonicalize: boolean;
}

interface RouteLocation {
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
}

const safeNoteIdPattern = /^[A-Za-z0-9._-]{1,180}$/;

/**
 * Accepts only note IDs that the current repository day is allowed to expose.
 * Existence is still checked by the note GET endpoint; this guard prevents a
 * copied or hand-edited URL from crossing a day/section boundary.
 */
export function readStudyNoteOverride(
  search: string,
  dayId: LearningDayId,
  sectionIds: readonly string[],
  defaultNoteId: string,
): StudyNoteOverride {
  const query = new URLSearchParams(search);
  const values = query.getAll("note");
  if (values.length === 0) return { noteId: null, shouldCanonicalize: false };
  if (values.length !== 1) return { noteId: null, shouldCanonicalize: true };

  const noteId = values[0] ?? "";
  const lessonAllowed = sectionIds.some((sectionId) => noteId === `lesson-${sectionId}`);
  const quickPrefix = `${dayId}_quicknote_`;
  const quickAllowed = noteId.startsWith(quickPrefix)
    && noteId.length > quickPrefix.length
    && safeNoteIdPattern.test(noteId);
  if (!lessonAllowed && !quickAllowed) {
    return { noteId: null, shouldCanonicalize: true };
  }
  if (noteId === defaultNoteId) {
    return { noteId: null, shouldCanonicalize: true };
  }
  return { noteId, shouldCanonicalize: false };
}

/** Builds a same-page history target for changing only the Study note. */
export function studyNoteSelectionHref(
  location: RouteLocation,
  noteId: string,
  defaultNoteId: string,
): string {
  const query = new URLSearchParams(location.search);
  if (noteId === defaultNoteId) query.delete("note");
  else query.set("note", noteId);
  const search = query.toString();
  return `${location.pathname}${search ? `?${search}` : ""}${location.hash}`;
}

/**
 * Keeps an explicitly selected note while following material links within the
 * same repository day. Crossing days drops it, and arriving at that lesson's
 * own section canonicalizes back to the ordinary route.
 */
export function materialHrefWithStudyNote(
  target: string,
  currentDayId: LearningDayId,
  noteId: string | null,
): string {
  if (noteId === null) return target;
  const url = new URL(target, "https://aisb-companion.invalid");
  const match = url.pathname.match(/^\/study\/(day[0-7])\/section\/([^/]+)(?:\/|$)/);
  if (match?.[1] !== currentDayId) {
    url.searchParams.delete("note");
  } else {
    let targetSectionId: string;
    try {
      targetSectionId = decodeURIComponent(match[2] ?? "");
    } catch {
      targetSectionId = match[2] ?? "";
    }
    if (noteId === `lesson-${targetSectionId}`) url.searchParams.delete("note");
    else url.searchParams.set("note", noteId);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}
