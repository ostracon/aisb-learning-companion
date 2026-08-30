// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScheduleSnapshotResponse } from "../../shared/api.js";
import { ScheduleEditor } from "./ScheduleEditor.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const selectedDay = {
  dayId: "day1" as const,
  date: "2026-08-31",
  curriculumKind: "content" as const,
  title: "Day 1",
};

function snapshot(): ScheduleSnapshotResponse {
  return {
    scheduleRevision: "seed:r2:abcdef123456",
    programmeTimeZone: "Europe/London",
    programmeDays: [selectedDay],
    events: [
      {
        eventBindingId: "aisb-2026-094",
        programmeDayId: "day1",
        title: "Office hours",
        start: "2026-08-31T08:00:00.000Z",
        end: "2026-08-31T09:00:00.000Z",
        allDay: false,
        status: "scheduled",
      },
    ],
    runtimeSchedule: {
      schemaVersion: 1,
      scheduleId: "seed",
      scheduleRevision: "seed:r2:abcdef123456",
      seedId: "seed",
      sourceLabel: "fixture",
      programmeWindow: {
        start: "2026-08-31T00:00:00+01:00",
        end: "2026-09-01T00:00:00+01:00",
        timeZone: "Europe/London",
      },
      programmeDays: [{ dayId: "day1", date: "2026-08-31", curriculumKind: "content" }],
      nonProgrammeDates: [],
      events: [],
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("ScheduleEditor", () => {
  it("adds a London-time item against the exact loaded revision", async () => {
    const next = snapshot();
    next.events.unshift({
      ...next.events[0]!,
      eventBindingId: "aisb-2026-050",
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => next,
    });
    vi.stubGlobal("fetch", fetchMock);
    const onChanged = vi.fn();
    const user = userEvent.setup();
    render(
      <ScheduleEditor
        selectedDay={selectedDay}
        selectedEvent={null}
        scheduleRevision="seed:r1:123456abcdef"
        onChanged={onChanged}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Add item" }));
    await user.type(screen.getByRole("textbox", { name: "Title" }), "Office hours");
    await user.click(screen.getByRole("button", { name: "Save schedule" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init.body))).toMatchObject({
      expected_revision: "seed:r1:123456abcdef",
      mutation: {
        kind: "add",
        event: {
          programme_day_id: "day1",
          title: "Office hours",
          start: "2026-08-31T08:00:00.000Z",
          end: "2026-08-31T09:00:00.000Z",
        },
      },
    });
    expect(onChanged).toHaveBeenCalledWith(next, "aisb-2026-094");
  });

  it("requires an explicit confirmation before replacing edits from the tracked seed", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const user = userEvent.setup();
    render(
      <ScheduleEditor
        selectedDay={selectedDay}
        selectedEvent={null}
        scheduleRevision="seed:r1:123456abcdef"
        onChanged={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Re-import seed" }));
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cannot replace the active draft while a schedule save is in flight", async () => {
    const pending = deferred<{ ok: true; json: () => Promise<ScheduleSnapshotResponse> }>();
    vi.stubGlobal("fetch", vi.fn(() => pending.promise));
    const user = userEvent.setup();
    render(
      <ScheduleEditor
        selectedDay={selectedDay}
        selectedEvent={snapshot().events[0]!}
        scheduleRevision="seed:r1:123456abcdef"
        onChanged={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Add item" }));
    await user.type(screen.getByRole("textbox", { name: "Title" }), "Office hours");
    await user.click(screen.getByRole("button", { name: "Save schedule" }));

    expect((screen.getByRole("button", { name: "Add item" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Edit selected" }) as HTMLButtonElement).disabled).toBe(true);

    pending.resolve({ ok: true, json: async () => snapshot() });
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Title" })).toBeNull());
  });

  it("closes and discards an edit draft when the selected schedule event changes", async () => {
    const firstEvent = {
      eventBindingId: "aisb-2026-010",
      programmeDayId: "day1" as const,
      title: "First session",
      start: "2026-08-31T08:00:00.000Z",
      end: "2026-08-31T09:00:00.000Z",
      allDay: false,
      status: "scheduled" as const,
    };
    const secondEvent = {
      ...firstEvent,
      eventBindingId: "aisb-2026-011",
      title: "Second session",
      start: "2026-08-31T09:00:00.000Z",
      end: "2026-08-31T10:00:00.000Z",
    };
    const user = userEvent.setup();
    const view = render(
      <ScheduleEditor
        selectedDay={selectedDay}
        selectedEvent={firstEvent}
        scheduleRevision="seed:r1:123456abcdef"
        onChanged={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Edit selected" }));
    const title = screen.getByRole("textbox", { name: "Title" }) as HTMLInputElement;
    await user.clear(title);
    await user.type(title, "Unsaved first-session edit");

    view.rerender(
      <ScheduleEditor
        selectedDay={selectedDay}
        selectedEvent={secondEvent}
        scheduleRevision="seed:r1:123456abcdef"
        onChanged={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Title" })).toBeNull());
    await user.click(screen.getByRole("button", { name: "Edit selected" }));
    expect((screen.getByRole("textbox", { name: "Title" }) as HTMLInputElement).value).toBe(
      "Second session",
    );
  });
});
