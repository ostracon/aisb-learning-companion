// @vitest-environment jsdom

import { useState } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EventCurriculumBindingSnapshotResponse } from "../../shared/api.js";
import { EventMaterialLink } from "./EventMaterialLink.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const emptySnapshot: EventCurriculumBindingSnapshotResponse = {
  schemaVersion: 1,
  revision: "event-curriculum-bindings:r1:aaaaaaaaaaaaaaaa",
  bindings: [],
};

const event = {
  eventBindingId: "aisb-2026-016",
  programmeDayId: "day1" as const,
  title: "Pair programming",
  start: "2026-08-24T10:00:00+01:00",
  end: "2026-08-24T11:00:00+01:00",
  allDay: false,
  status: "scheduled" as const,
};

const sections = [
  { sectionId: "1.1", title: "Models", sourcePath: "1.1-models/README.md", outcomes: [] },
  { sectionId: "1.2", title: "Log probabilities", sourcePath: "1.2-log-probs/README.md", outcomes: [] },
];

function BindingHarness({
  initialSnapshot = emptySnapshot,
  onChanged,
}: {
  readonly initialSnapshot?: EventCurriculumBindingSnapshotResponse;
  readonly onChanged?: (snapshot: EventCurriculumBindingSnapshotResponse) => void;
}) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);

  return (
    <MemoryRouter>
      <EventMaterialLink
        event={event}
        sections={sections}
        scheduleRevision="schedule:r1"
        snapshot={snapshot}
        onChanged={(nextSnapshot) => {
          setSnapshot(nextSnapshot);
          onChanged?.(nextSnapshot);
        }}
      />
    </MemoryRouter>
  );
}

describe("EventMaterialLink", () => {
  it("saves only explicitly checked section IDs and exposes the saved Study route", async () => {
    const saved: EventCurriculumBindingSnapshotResponse = {
      schemaVersion: 1,
      revision: "event-curriculum-bindings:r2:bbbbbbbbbbbbbbbb",
      bindings: [{ eventBindingId: event.eventBindingId, sectionIds: ["1.2"], source: "explicit" }],
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(saved), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const onChanged = vi.fn();
    const user = userEvent.setup();

    const view = render(
      <MemoryRouter>
        <EventMaterialLink event={event} sections={sections} scheduleRevision="schedule:r1" snapshot={emptySnapshot} onChanged={onChanged} />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole("button", { name: "Link sections…" }));
    await user.click(screen.getByRole("checkbox", { name: /1\.2 Log probabilities/i }));
    await user.click(screen.getByRole("button", { name: "Save links" }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(saved));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/event-curriculum-bindings/aisb-2026-016",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          expected_revision: emptySnapshot.revision,
          expected_schedule_revision: "schedule:r1",
          section_ids: ["1.2"],
        }),
      }),
    );

    view.rerender(
      <MemoryRouter>
        <EventMaterialLink event={event} sections={sections} scheduleRevision="schedule:r1" snapshot={saved} onChanged={onChanged} />
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: /1\.2 Log probabilities/i }).getAttribute("href"))
      .toBe("/study/day1/section/1.2");
  });

  it("surfaces a stale saved section without silently discarding it", () => {
    const stale: EventCurriculumBindingSnapshotResponse = {
      schemaVersion: 1,
      revision: "event-curriculum-bindings:r2:bbbbbbbbbbbbbbbb",
      bindings: [{ eventBindingId: event.eventBindingId, sectionIds: ["1.9"], source: "explicit" }],
    };

    render(
      <MemoryRouter>
        <EventMaterialLink event={event} sections={sections} scheduleRevision="schedule:r1" snapshot={stale} onChanged={vi.fn()} />
      </MemoryRouter>,
    );

    expect(screen.getByRole("alert").textContent).toContain("1.9");
    expect(screen.queryByRole("link", { name: /Open 1\.9/ })).toBeNull();
  });

  it("opens a Day 5 programme link under the section's Day 4 repository identity", () => {
    const dayFiveEvent = { ...event, programmeDayId: "day5" as const };
    const dayFourSections = [
      { sectionId: "4.1", title: "Model editing", sourcePath: "4.1-model-editing/README.md", outcomes: [] },
    ];
    const linked: EventCurriculumBindingSnapshotResponse = {
      schemaVersion: 1,
      revision: "event-curriculum-bindings:r2:bbbbbbbbbbbbbbbb",
      bindings: [{ eventBindingId: event.eventBindingId, sectionIds: ["4.1"], source: "explicit" }],
    };

    render(
      <MemoryRouter>
        <EventMaterialLink event={dayFiveEvent} sections={dayFourSections} scheduleRevision="schedule:r1" snapshot={linked} onChanged={vi.fn()} />
      </MemoryRouter>,
    );

    expect(screen.getByRole("link", { name: /4\.1 Model editing/i }).getAttribute("href"))
      .toBe("/study/day4/section/4.1");
  });

  it("preserves the unsaved draft when a CAS conflict refreshes the persisted snapshot", async () => {
    const current: EventCurriculumBindingSnapshotResponse = {
      schemaVersion: 1,
      revision: "event-curriculum-bindings:r2:bbbbbbbbbbbbbbbb",
      bindings: [{ eventBindingId: event.eventBindingId, sectionIds: ["1.1"], source: "explicit" }],
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: "The study-material links changed in another window. Review the current links and try again.",
      current,
    }), {
      status: 409,
      headers: { "content-type": "application/json" },
    })));
    const user = userEvent.setup();

    render(<BindingHarness />);
    await user.click(screen.getByRole("button", { name: "Link sections…" }));
    const drafted = screen.getByRole("checkbox", { name: /1\.2 Log probabilities/i });
    await user.click(drafted);
    await user.click(screen.getByRole("button", { name: "Save links" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("another window"));
    expect((screen.getByRole("checkbox", { name: /1\.2 Log probabilities/i }) as HTMLInputElement).checked)
      .toBe(true);
    expect((screen.getByRole("checkbox", { name: /1\.1 Models/i }) as HTMLInputElement).checked)
      .toBe(false);
    expect(screen.getByRole("link", { name: /1\.1 Models/i })).not.toBeNull();
  });

  it("keeps a stable disclosure focus target across open, cancel, and save", async () => {
    const saved: EventCurriculumBindingSnapshotResponse = {
      schemaVersion: 1,
      revision: "event-curriculum-bindings:r2:bbbbbbbbbbbbbbbb",
      bindings: [{ eventBindingId: event.eventBindingId, sectionIds: ["1.2"], source: "explicit" }],
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(saved), {
      status: 200,
      headers: { "content-type": "application/json" },
    })));
    const user = userEvent.setup();

    render(<BindingHarness />);
    await user.click(screen.getByRole("button", { name: "Link sections…" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel changes" }));
    expect(screen.getByRole("button", { name: "Cancel changes" }).getAttribute("aria-expanded")).toBe("true");

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Link sections…" }));
    expect(screen.getByRole("button", { name: "Link sections…" }).getAttribute("aria-expanded")).toBe("false");

    await user.click(screen.getByRole("button", { name: "Link sections…" }));
    await user.click(screen.getByRole("checkbox", { name: /1\.2 Log probabilities/i }));
    await user.click(screen.getByRole("button", { name: "Save links" }));

    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Edit links" })));
    expect(screen.getByRole("button", { name: "Edit links" }).getAttribute("aria-expanded")).toBe("false");
  });
});
