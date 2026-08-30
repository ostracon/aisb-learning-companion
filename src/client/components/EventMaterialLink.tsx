import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";

import type {
  CurriculumSectionView,
  EventCurriculumBindingSnapshotResponse,
  ScheduleEventView,
} from "../../shared/api.js";
import { sectionTitleWithoutRepeatedId } from "../curriculum/section-label.js";

export interface EventMaterialLinkProps {
  readonly event: ScheduleEventView;
  readonly sections: readonly CurriculumSectionView[];
  readonly scheduleRevision: string;
  readonly snapshot: EventCurriculumBindingSnapshotResponse;
  readonly onChanged: (snapshot: EventCurriculumBindingSnapshotResponse) => void;
}

function sectionStudyRoute(sectionId: string): string | null {
  const day = Number(sectionId.split(".")[0]);
  if (!Number.isInteger(day) || day < 0 || day > 7) return null;
  return `/study/day${day}/section/${encodeURIComponent(sectionId)}`;
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function currentIds(
  snapshot: EventCurriculumBindingSnapshotResponse,
  eventBindingId: string,
): readonly string[] {
  return snapshot.bindings.find((binding) => binding.eventBindingId === eventBindingId)?.sectionIds ?? [];
}

export function EventMaterialLink({
  event,
  sections,
  scheduleRevision,
  snapshot,
  onChanged,
}: EventMaterialLinkProps) {
  const persistedIds = currentIds(snapshot, event.eventBindingId);
  const [draftIds, setDraftIds] = useState<readonly string[]>(persistedIds);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editorToggleRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setEditing(false);
    setError(null);
  }, [event.eventBindingId]);

  useEffect(() => {
    if (!editing) setDraftIds(currentIds(snapshot, event.eventBindingId));
  }, [editing, event.eventBindingId, snapshot]);

  const sectionsById = useMemo(
    () => new Map(sections.map((section) => [section.sectionId, section])),
    [sections],
  );
  const staleIds = persistedIds.filter((sectionId) => !sectionsById.has(sectionId));
  const dirty = !sameIds(draftIds, persistedIds);

  const toggle = (sectionId: string, checked: boolean) => {
    setDraftIds((current) =>
      checked
        ? current.includes(sectionId) ? current : [...current, sectionId]
        : current.filter((candidate) => candidate !== sectionId),
    );
  };

  const cancelEditing = () => {
    setDraftIds(persistedIds);
    setEditing(false);
    editorToggleRef.current?.focus();
  };

  const save = async () => {
    if (!dirty || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/event-curriculum-bindings/${encodeURIComponent(event.eventBindingId)}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            expected_revision: snapshot.revision,
            expected_schedule_revision: scheduleRevision,
            section_ids: draftIds,
          }),
        },
      );
      const payload = (await response.json()) as
        | EventCurriculumBindingSnapshotResponse
        | {
            readonly error?: string;
            readonly current?: EventCurriculumBindingSnapshotResponse;
          };
      if (!response.ok) {
        if ("current" in payload && payload.current) onChanged(payload.current);
        throw new Error("error" in payload && payload.error
          ? payload.error
          : "The related material link could not be saved safely");
      }
      onChanged(payload as EventCurriculumBindingSnapshotResponse);
      setEditing(false);
      editorToggleRef.current?.focus();
    } catch (reason) {
      setError(reason instanceof Error
        ? reason.message
        : "The related material link could not be saved safely");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="event-material-link" aria-labelledby="event-material-link-heading">
      <div className="event-material-link-heading">
        <div>
          <p className="page-kicker" id="event-material-link-heading">Study material</p>
          <div className="event-material-current">
            {persistedIds.length === 0 ? <span>Not linked</span> : persistedIds.map((sectionId) => {
              const route = sectionStudyRoute(sectionId);
              const section = sectionsById.get(sectionId);
              return route && section ? (
                <Link key={sectionId} to={route}>
                  <strong>{sectionId}</strong> {sectionTitleWithoutRepeatedId(sectionId, section.title)}
                </Link>
              ) : <span key={sectionId} className="event-material-stale-link">{sectionId} · unavailable</span>;
            })}
          </div>
        </div>
        {sections.length > 0 || persistedIds.length > 0 ? (
          <button
            ref={editorToggleRef}
            className="text-button"
            type="button"
            aria-controls="event-material-link-editor"
            aria-expanded={editing}
            onClick={() => {
              if (editing) {
                cancelEditing();
                return;
              }
              setEditing(true);
              setError(null);
            }}
          >
            {editing
              ? "Cancel changes"
              : persistedIds.length === 0
                ? "Link sections…"
                : "Edit links"}
          </button>
        ) : <span className="event-material-empty">No repository sections for this day</span>}
      </div>
      {editing ? (
        <div className="event-material-editor" id="event-material-link-editor">
          <p className="event-material-link-help">
            Choose the AISB section or sections covered by this calendar item. Titles are never matched automatically.
          </p>
          <div className="event-material-options">
            {staleIds.map((sectionId) => (
              <label key={sectionId} className="selected stale">
                <input
                  type="checkbox"
                  checked={draftIds.includes(sectionId)}
                  disabled={busy}
                  onChange={(change) => toggle(sectionId, change.currentTarget.checked)}
                />
                <span><strong>{sectionId}</strong> unavailable on this programme day</span>
              </label>
            ))}
            {sections.map((section) => (
              <label key={section.sectionId} className={draftIds.includes(section.sectionId) ? "selected" : ""}>
                <input
                  type="checkbox"
                  checked={draftIds.includes(section.sectionId)}
                  disabled={busy}
                  onChange={(change) => toggle(section.sectionId, change.currentTarget.checked)}
                />
                <span>
                  <strong>{section.sectionId}</strong>
                  {" "}
                  {sectionTitleWithoutRepeatedId(section.sectionId, section.title)}
                </span>
              </label>
            ))}
          </div>
          <div className="event-material-link-footer">
            <span className="event-link-source" title="Only links you select are saved. Calendar titles are never matched automatically.">
              Explicit links only
            </span>
            <div className="event-material-actions">
              <button
                className="text-button"
                type="button"
                disabled={busy}
                onClick={cancelEditing}
              >
                Cancel
              </button>
              <button
                className="primary-button"
                type="button"
                disabled={!dirty || busy}
                onClick={() => void save()}
              >
                {busy ? "Saving…" : draftIds.length === 0 ? "Clear link" : "Save links"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {staleIds.length > 0 ? (
        <p className="event-material-error" role="alert">
          The saved link references material no longer present on this day ({staleIds.join(", ")}). Choose a current section or clear the link.
        </p>
      ) : null}
      {error ? <p className="event-material-error" role="alert">{error}</p> : null}
    </section>
  );
}
