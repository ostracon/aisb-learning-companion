import { useMemo, useRef, useState } from "react";

import type {
  EventCurriculumBindingSnapshotResponse,
  EventCurriculumBindingView,
} from "../../shared/api.js";

export interface OrphanedEventLinksProps {
  readonly snapshot: EventCurriculumBindingSnapshotResponse;
  readonly currentScheduleEventIds: readonly string[];
  readonly scheduleRevision: string;
  readonly onChanged: (snapshot: EventCurriculumBindingSnapshotResponse) => void;
}

interface ErrorPayload {
  readonly error?: string;
  readonly current?: unknown;
}

function isBindingSnapshot(
  value: unknown,
): value is EventCurriculumBindingSnapshotResponse {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<EventCurriculumBindingSnapshotResponse>;
  if (
    candidate.schemaVersion !== 1 ||
    typeof candidate.revision !== "string" ||
    !Array.isArray(candidate.bindings)
  ) {
    return false;
  }
  return candidate.bindings.every((binding) => {
    if (typeof binding !== "object" || binding === null) return false;
    const entry = binding as Partial<EventCurriculumBindingView>;
    return typeof entry.eventBindingId === "string" &&
      entry.source === "explicit" &&
      Array.isArray(entry.sectionIds) &&
      entry.sectionIds.every((sectionId) => typeof sectionId === "string");
  });
}

async function responsePayload(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function responseError(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const error = (payload as ErrorPayload).error;
  return typeof error === "string" && error.trim() ? error : null;
}

export function OrphanedEventLinks({
  snapshot,
  currentScheduleEventIds,
  scheduleRevision,
  onChanged,
}: OrphanedEventLinksProps) {
  const summaryRef = useRef<HTMLElement>(null);
  const [busyEventId, setBusyEventId] = useState<string | null>(null);
  const [error, setError] = useState<{
    readonly eventBindingId: string;
    readonly message: string;
  } | null>(null);
  const orphanedBindings = useMemo(() => {
    const currentIds = new Set(currentScheduleEventIds);
    return snapshot.bindings.filter(
      (binding) => !currentIds.has(binding.eventBindingId),
    );
  }, [currentScheduleEventIds, snapshot.bindings]);

  if (orphanedBindings.length === 0) return null;

  const clearBinding = async (eventBindingId: string) => {
    if (busyEventId !== null) return;
    setBusyEventId(eventBindingId);
    setError(null);
    try {
      const response = await fetch(
        `/api/event-curriculum-bindings/${encodeURIComponent(eventBindingId)}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            expected_revision: snapshot.revision,
            expected_schedule_revision: scheduleRevision,
            section_ids: [],
          }),
        },
      );
      const payload = await responsePayload(response);
      if (!response.ok) {
        const current = typeof payload === "object" && payload !== null
          ? (payload as ErrorPayload).current
          : null;
        if (isBindingSnapshot(current)) onChanged(current);
        throw new Error(
          responseError(payload) ??
            "The orphaned Study link could not be cleared safely.",
        );
      }
      if (!isBindingSnapshot(payload)) {
        throw new Error("The local service returned an invalid binding snapshot.");
      }
      summaryRef.current?.focus();
      onChanged(payload);
    } catch (reason) {
      setError({
        eventBindingId,
        message: reason instanceof Error
          ? reason.message
          : "The orphaned Study link could not be cleared safely.",
      });
    } finally {
      setBusyEventId(null);
    }
  };

  return (
    <details
      className="orphaned-event-links"
      aria-busy={busyEventId !== null}
    >
      <summary ref={summaryRef}>
        <span className="orphaned-event-links-summary">
          <span>Repair orphaned Study links</span>
          <span className="orphaned-event-links-count">
            {orphanedBindings.length}
          </span>
        </span>
      </summary>
      <p className="orphaned-event-links-help">
        These saved links belong to schedule items that are no longer present.
        Clear one only when you no longer need its event-to-section association.
      </p>
      <ul className="orphaned-event-links-list">
        {orphanedBindings.map((binding) => (
          <li key={binding.eventBindingId}>
            <span className="orphaned-event-links-identity">
              <strong>{binding.eventBindingId}</strong>
              <span>
                {binding.sectionIds.length > 0
                  ? binding.sectionIds.join(" · ")
                  : "No saved sections"}
              </span>
            </span>
            <button
              className="text-button"
              type="button"
              disabled={busyEventId !== null}
              aria-label={`Clear orphaned Study link for ${binding.eventBindingId}`}
              onClick={() => void clearBinding(binding.eventBindingId)}
            >
              {busyEventId === binding.eventBindingId ? "Clearing…" : "Clear link"}
            </button>
          </li>
        ))}
      </ul>
      {error ? (
        <p className="orphaned-event-links-error" role="alert">
          <strong>{error.eventBindingId}</strong>: {error.message}
        </p>
      ) : null}
    </details>
  );
}
