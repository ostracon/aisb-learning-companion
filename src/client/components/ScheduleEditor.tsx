import { useEffect, useState } from "react";
import type {
  ProgrammeDayId,
  ProgrammeDaySummary,
  ScheduleEventView,
  ScheduleMutationRequest,
  ScheduleSnapshotResponse,
} from "../../shared/api.js";
import {
  fromProgrammeDateTimeLocal,
  toProgrammeDateTimeLocal,
} from "../time/programme-time.js";

interface Draft {
  title: string;
  programmeDayId: ProgrammeDayId;
  start: string;
  end: string;
  location: string;
  allDay: boolean;
}

export interface ScheduleEditorProps {
  selectedDay: ProgrammeDaySummary;
  selectedEvent: ScheduleEventView | null;
  scheduleRevision: string;
  onChanged: (snapshot: ScheduleSnapshotResponse, focusedEventId?: string) => void;
}

function newDraft(day: ProgrammeDaySummary): Draft {
  return {
    title: "",
    programmeDayId: day.dayId,
    start: `${day.date}T09:00`,
    end: `${day.date}T10:00`,
    location: "",
    allDay: false,
  };
}

function editDraft(event: ScheduleEventView, fallbackDay: ProgrammeDayId): Draft {
  return {
    title: event.title,
    programmeDayId: event.programmeDayId ?? fallbackDay,
    start: toProgrammeDateTimeLocal(event.start),
    end: toProgrammeDateTimeLocal(event.end),
    location: event.location ?? "",
    allDay: event.allDay,
  };
}

function newestMatchingEventId(
  events: readonly ScheduleEventView[],
  title: string,
  start: string,
): string | undefined {
  return events.reduce<string | undefined>((newest, event) => {
    if (event.title.localeCompare(title) !== 0 || event.start !== start) return newest;
    return newest === undefined || event.eventBindingId.localeCompare(newest) > 0
      ? event.eventBindingId
      : newest;
  }, undefined);
}

export function ScheduleEditor({
  selectedDay,
  selectedEvent,
  scheduleRevision,
  onChanged,
}: ScheduleEditorProps) {
  const [mode, setMode] = useState<"closed" | "add" | "edit">("closed");
  const [draft, setDraft] = useState<Draft>(() => newDraft(selectedDay));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setMode("closed");
    setDraft(newDraft(selectedDay));
    setError(null);
  }, [selectedDay.dayId, selectedDay.date, selectedEvent?.eventBindingId]);

  const openAdd = () => {
    if (busy) return;
    setDraft(newDraft(selectedDay));
    setError(null);
    setMode("add");
  };
  const openEdit = () => {
    if (busy || !selectedEvent) return;
    setDraft(editDraft(selectedEvent, selectedDay.dayId));
    setError(null);
    setMode("edit");
  };

  const request = async (path: string, method: "PATCH" | "POST", body: unknown) => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(path, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as ScheduleSnapshotResponse & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "The schedule update failed safely");
      return payload;
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    try {
      const start = fromProgrammeDateTimeLocal(draft.start);
      const end = fromProgrammeDateTimeLocal(draft.end);
      if (Date.parse(end) <= Date.parse(start)) throw new Error("End time must be after start time");
      const common = {
        programme_day_id: draft.programmeDayId,
        title: draft.title,
        start,
        end,
        all_day: draft.allDay,
      };
      let body: ScheduleMutationRequest;
      if (mode === "add") {
        body = {
          expected_revision: scheduleRevision,
          mutation: {
            kind: "add",
            event: { ...common, ...(draft.location.trim() ? { location: draft.location.trim() } : {}) },
          },
        };
      } else if (mode === "edit" && selectedEvent) {
        body = {
          expected_revision: scheduleRevision,
          mutation: {
            kind: "update",
            event_binding_id: selectedEvent.eventBindingId,
            changes: { ...common, location: draft.location.trim() || null },
          },
        };
      } else {
        return;
      }
      const snapshot = await request("/api/schedule", "PATCH", body);
      const focusedEventId = mode === "edit"
        ? selectedEvent?.eventBindingId
        : newestMatchingEventId(snapshot.events, draft.title, start);
      onChanged(snapshot, focusedEventId);
      setMode("closed");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The schedule update failed safely");
    }
  };

  const cancelSelected = async () => {
    if (!selectedEvent) return;
    try {
      const snapshot = await request("/api/schedule", "PATCH", {
        expected_revision: scheduleRevision,
        mutation: { kind: "cancel", event_binding_id: selectedEvent.eventBindingId },
      } satisfies ScheduleMutationRequest);
      onChanged(snapshot, selectedEvent.eventBindingId);
      setMode("closed");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The schedule update failed safely");
    }
  };

  const reimport = async () => {
    if (!window.confirm("Replace every local schedule edit with the tracked one-time calendar snapshot? Notes and chats are not changed.")) return;
    try {
      const snapshot = await request("/api/schedule/reimport", "POST", {
        expected_revision: scheduleRevision,
      });
      onChanged(snapshot);
      setMode("closed");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The schedule re-import failed safely");
    }
  };

  return (
    <div className="schedule-editor-wrap">
      <div className="schedule-editor-actions">
        <button className="text-button" type="button" onClick={openAdd} disabled={busy}>Add item</button>
        <button className="text-button" type="button" onClick={openEdit} disabled={busy || !selectedEvent}>Edit selected</button>
        <button className="text-button" type="button" onClick={() => void reimport()} disabled={busy}>Re-import seed</button>
      </div>
      {mode !== "closed" ? (
        <form className="schedule-editor" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <div className="schedule-editor-heading">
            <strong>{mode === "add" ? "Add a local schedule item" : "Edit this schedule item"}</strong>
            <button className="text-button" type="button" onClick={() => setMode("closed")}>Close</button>
          </div>
          <label className="schedule-field schedule-title-field">
            <span>Title</span>
            <input required maxLength={240} value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.currentTarget.value })} />
          </label>
          <label className="schedule-field">
            <span>Day</span>
            <select value={draft.programmeDayId} onChange={(event) => setDraft({ ...draft, programmeDayId: event.currentTarget.value as ProgrammeDayId })}>
              {Array.from({ length: 7 }, (_, index) => `day${index + 1}` as ProgrammeDayId).map((dayId) => (
                <option key={dayId} value={dayId}>Day {dayId.slice(3)}</option>
              ))}
            </select>
          </label>
          <label className="schedule-field">
            <span>Starts · London</span>
            <input required type="datetime-local" value={draft.start} onChange={(event) => setDraft({ ...draft, start: event.currentTarget.value })} />
          </label>
          <label className="schedule-field">
            <span>Ends · London</span>
            <input required type="datetime-local" value={draft.end} onChange={(event) => setDraft({ ...draft, end: event.currentTarget.value })} />
          </label>
          <label className="schedule-field schedule-location-field">
            <span>Location · optional</span>
            <input maxLength={500} value={draft.location} onChange={(event) => setDraft({ ...draft, location: event.currentTarget.value })} />
          </label>
          <label className="schedule-check">
            <input type="checkbox" checked={draft.allDay} onChange={(event) => setDraft({ ...draft, allDay: event.currentTarget.checked })} />
            <span>All-day item</span>
          </label>
          {error ? <p className="schedule-editor-error" role="alert">{error}</p> : null}
          <div className="schedule-editor-footer">
            {mode === "edit" && selectedEvent?.status !== "cancelled" ? (
              <button className="text-button danger-button" type="button" disabled={busy} onClick={() => void cancelSelected()}>Mark cancelled</button>
            ) : <span />}
            <button className="primary-button" type="submit" disabled={busy || !draft.title.trim()}>{busy ? "Saving…" : "Save schedule"}</button>
          </div>
        </form>
      ) : error ? <p className="schedule-editor-error" role="alert">{error}</p> : null}
    </div>
  );
}
