// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EventCurriculumBindingSnapshotResponse } from "../../shared/api.js";
import { OrphanedEventLinks } from "./OrphanedEventLinks.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const snapshot: EventCurriculumBindingSnapshotResponse = {
  schemaVersion: 1,
  revision: "event-curriculum-bindings:r3:cccccccccccccccc",
  bindings: [
    {
      eventBindingId: "aisb-2026-016",
      sectionIds: ["1.1"],
      source: "explicit",
    },
    {
      eventBindingId: "aisb-2026-094",
      sectionIds: ["1.2", "1.3"],
      source: "explicit",
    },
  ],
};

function renderRepair(input: {
  readonly value?: EventCurriculumBindingSnapshotResponse;
  readonly currentEventIds?: readonly string[];
  readonly onChanged?: (value: EventCurriculumBindingSnapshotResponse) => void;
} = {}) {
  return render(
    <OrphanedEventLinks
      snapshot={input.value ?? snapshot}
      currentScheduleEventIds={input.currentEventIds ?? ["aisb-2026-016"]}
      scheduleRevision="aisb-london-2026:r7:dddddddddddd"
      onChanged={input.onChanged ?? vi.fn()}
    />,
  );
}

describe("OrphanedEventLinks", () => {
  it("renders nothing when every binding still has a schedule event", () => {
    const view = renderRepair({
      currentEventIds: ["aisb-2026-016", "aisb-2026-094"],
    });

    expect(view.container.childElementCount).toBe(0);
  });

  it("uses a native disclosure and lists only missing event identities", async () => {
    const user = userEvent.setup();
    renderRepair();

    const disclosure = screen.getByText("Repair orphaned Study links").closest("summary");
    expect(disclosure).not.toBeNull();
    expect(disclosure?.parentElement?.tagName).toBe("DETAILS");
    await user.click(disclosure!);

    expect(screen.getByText("aisb-2026-094")).toBeTruthy();
    expect(screen.getByText("1.2 · 1.3")).toBeTruthy();
    expect(screen.queryByText("aisb-2026-016")).toBeNull();
    expect(screen.getByRole("button", {
      name: "Clear orphaned Study link for aisb-2026-094",
    })).toBeTruthy();
  });

  it("clears one orphan through the binding and schedule CAS contract", async () => {
    const next: EventCurriculumBindingSnapshotResponse = {
      schemaVersion: 1,
      revision: "event-curriculum-bindings:r4:eeeeeeeeeeeeeeee",
      bindings: [snapshot.bindings[0]!],
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(next), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const onChanged = vi.fn();
    const user = userEvent.setup();
    renderRepair({ onChanged });

    await user.click(screen.getByText("Repair orphaned Study links"));
    await user.click(screen.getByRole("button", {
      name: "Clear orphaned Study link for aisb-2026-094",
    }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(next));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/event-curriculum-bindings/aisb-2026-094",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          expected_revision: snapshot.revision,
          expected_schedule_revision: "aisb-london-2026:r7:dddddddddddd",
          section_ids: [],
        }),
      }),
    );
  });

  it("consumes a CAS conflict snapshot while retaining its useful error", async () => {
    const current: EventCurriculumBindingSnapshotResponse = {
      schemaVersion: 1,
      revision: "event-curriculum-bindings:r4:eeeeeeeeeeeeeeee",
      bindings: snapshot.bindings,
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: "Study links changed in another window; review them before retrying.",
      current,
    }), {
      status: 409,
      headers: { "content-type": "application/json" },
    })));
    const onChanged = vi.fn();
    const user = userEvent.setup();
    renderRepair({ onChanged });

    await user.click(screen.getByText("Repair orphaned Study links"));
    await user.click(screen.getByRole("button", {
      name: "Clear orphaned Study link for aisb-2026-094",
    }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(current));
    expect(screen.getByRole("alert").textContent).toContain(
      "changed in another window",
    );
  });

  it("reports malformed success responses instead of accepting them", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })));
    const user = userEvent.setup();
    renderRepair();

    await user.click(screen.getByText("Repair orphaned Study links"));
    await user.click(screen.getByRole("button", {
      name: "Clear orphaned Study link for aisb-2026-094",
    }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(
      "invalid binding snapshot",
    ));
  });
});
