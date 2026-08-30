// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrowserRouter, useLocation, useNavigate } from "react-router-dom";

import {
  createWorkspaceScrollCarryState,
  historyWorkspaceScrollKey,
  readWorkspaceScrollSnapshot,
  useWorkspaceScrollRestoration,
} from "./use-workspace-scroll.js";

function Harness() {
  const location = useLocation();
  const navigate = useNavigate();
  const restoration = useWorkspaceScrollRestoration(location, "layout:default");
  return (
    <>
      <output aria-label="route">{location.pathname}</output>
      <output aria-label="route with query">{location.pathname}{location.search}</output>
      <output aria-label="arrived saved">
        {restoration.arrivedWithSavedPosition ? "yes" : "no"}
      </output>
      <button type="button" onClick={() => navigate("/scroll-b")}>Go to B</button>
      <button
        type="button"
        onClick={() => {
          const destination = {
            pathname: location.pathname,
            search: "?note=lesson-1.1",
            hash: location.hash,
          };
          navigate(destination, {
            state: createWorkspaceScrollCarryState(
              { unrelated: "kept" },
              destination,
              {
                top: restoration.scrollRef.current?.scrollTop ?? 0,
                left: restoration.scrollRef.current?.scrollLeft ?? 0,
              },
            ),
          });
        }}
      >
        Open earlier note
      </button>
      <div ref={restoration.scrollRef} data-testid="workspace-scroll" tabIndex={-1}>
        <div style={{ height: 2000 }}>content</div>
      </div>
    </>
  );
}

beforeEach(() => {
  window.history.replaceState({ aisbHistoryEntryId: "entry-a" }, "", "/scroll-a");
});

afterEach(cleanup);

describe("useWorkspaceScrollRestoration", () => {
  it("restores an exact position independently for each browser history entry", async () => {
    const user = userEvent.setup();
    render(
      <BrowserRouter>
        <Harness />
      </BrowserRouter>,
    );

    const scroller = screen.getByTestId("workspace-scroll");
    act(() => {
      scroller.scrollTop = 376;
      scroller.scrollLeft = 7;
      fireEvent.scroll(scroller);
    });
    await waitFor(() => expect(readWorkspaceScrollSnapshot({
      pathname: "/scroll-a",
      search: "",
      hash: "",
    })).toMatchObject({ top: 376, left: 7 }));
    const entryA = window.history.state as Record<string, unknown>;

    await user.click(screen.getByRole("button", { name: "Go to B" }));
    await waitFor(() => expect(screen.getByLabelText("route").textContent).toBe("/scroll-b"));
    expect(scroller.scrollTop).toBe(0);
    act(() => {
      scroller.scrollTop = 91;
      scroller.scrollLeft = 0;
      fireEvent.scroll(scroller);
    });
    await waitFor(() => expect(readWorkspaceScrollSnapshot({
      pathname: "/scroll-b",
      search: "",
      hash: "",
    })?.top).toBe(91));
    const entryB = window.history.state as Record<string, unknown>;

    act(() => {
      window.history.replaceState(entryA, "", "/scroll-a");
      window.dispatchEvent(new PopStateEvent("popstate", { state: entryA }));
    });
    await waitFor(() => expect(screen.getByLabelText("route").textContent).toBe("/scroll-a"));
    expect(scroller.scrollTop).toBe(376);
    expect(scroller.scrollLeft).toBe(7);
    expect(screen.getByLabelText("arrived saved").textContent).toBe("yes");

    act(() => {
      window.history.replaceState(entryB, "", "/scroll-b");
      window.dispatchEvent(new PopStateEvent("popstate", { state: entryB }));
    });
    await waitFor(() => expect(screen.getByLabelText("route").textContent).toBe("/scroll-b"));
    expect(scroller.scrollTop).toBe(91);
  });

  it("carries position into a query-only entry and keeps independent Back/Forward snapshots", async () => {
    const user = userEvent.setup();
    render(
      <BrowserRouter>
        <Harness />
      </BrowserRouter>,
    );

    const scroller = screen.getByTestId("workspace-scroll");
    act(() => {
      scroller.scrollTop = 376;
      scroller.scrollLeft = 7;
      fireEvent.scroll(scroller);
    });
    await waitFor(() => expect(readWorkspaceScrollSnapshot({
      pathname: "/scroll-a",
      search: "",
      hash: "",
    })).toMatchObject({ top: 376, left: 7 }));
    const defaultEntry = window.history.state as Record<string, unknown>;

    await user.click(screen.getByRole("button", { name: "Open earlier note" }));
    await waitFor(() => expect(screen.getByLabelText("route with query").textContent)
      .toBe("/scroll-a?note=lesson-1.1"));
    expect(scroller.scrollTop).toBe(376);
    expect(scroller.scrollLeft).toBe(7);
    expect(screen.getByLabelText("arrived saved").textContent).toBe("yes");
    expect(window.history.state.usr.unrelated).toBe("kept");
    await waitFor(() => expect(readWorkspaceScrollSnapshot({
      pathname: "/scroll-a",
      search: "?note=lesson-1.1",
      hash: "",
    })).toMatchObject({ top: 376, left: 7 }));

    act(() => {
      scroller.scrollTop = 612;
      scroller.scrollLeft = 3;
      fireEvent.scroll(scroller);
    });
    await waitFor(() => expect(readWorkspaceScrollSnapshot({
      pathname: "/scroll-a",
      search: "?note=lesson-1.1",
      hash: "",
    })).toMatchObject({ top: 612, left: 3 }));
    const selectedNoteEntry = window.history.state as Record<string, unknown>;

    act(() => {
      window.history.replaceState(defaultEntry, "", "/scroll-a");
      window.dispatchEvent(new PopStateEvent("popstate", { state: defaultEntry }));
    });
    await waitFor(() => expect(screen.getByLabelText("route with query").textContent)
      .toBe("/scroll-a"));
    expect(scroller.scrollTop).toBe(376);
    expect(scroller.scrollLeft).toBe(7);

    act(() => {
      window.history.replaceState(
        selectedNoteEntry,
        "",
        "/scroll-a?note=lesson-1.1",
      );
      window.dispatchEvent(new PopStateEvent("popstate", { state: selectedNoteEntry }));
    });
    await waitFor(() => expect(screen.getByLabelText("route with query").textContent)
      .toBe("/scroll-a?note=lesson-1.1"));
    expect(scroller.scrollTop).toBe(612);
    expect(scroller.scrollLeft).toBe(3);
  });

  it("retries a saved position when asynchronous descendants make it reachable", async () => {
    const user = userEvent.setup();
    render(
      <BrowserRouter>
        <Harness />
      </BrowserRouter>,
    );

    const scroller = screen.getByTestId("workspace-scroll");
    let scrollLimit = 1_000;
    let scrollTop = 0;
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = Math.min(value, scrollLimit);
      },
    });

    act(() => {
      scroller.scrollTop = 376;
      fireEvent.scroll(scroller);
    });
    await waitFor(() => expect(readWorkspaceScrollSnapshot({
      pathname: "/scroll-a",
      search: "",
      hash: "",
    })?.top).toBe(376));
    const entryA = window.history.state as Record<string, unknown>;

    await user.click(screen.getByRole("button", { name: "Go to B" }));
    await waitFor(() => expect(screen.getByLabelText("route").textContent).toBe("/scroll-b"));

    scrollLimit = 0;
    act(() => {
      window.history.replaceState(entryA, "", "/scroll-a");
      window.dispatchEvent(new PopStateEvent("popstate", { state: entryA }));
    });
    await waitFor(() => expect(screen.getByLabelText("route").textContent).toBe("/scroll-a"));
    expect(scroller.scrollTop).toBe(0);

    scrollLimit = 1_000;
    act(() => {
      scroller.firstElementChild?.setAttribute("data-loaded", "true");
    });
    await waitFor(() => expect(scroller.scrollTop).toBe(376));
    expect(screen.getByLabelText("arrived saved").textContent).toBe("yes");
  });

  it("ignores a snapshot copied from another route while preserving unrelated state", () => {
    window.history.replaceState({
      aisbHistoryEntryId: "entry-a",
      aisbNowAnchor: { capturedAt: "kept" },
      [historyWorkspaceScrollKey]: {
        version: 1,
        historyEntryId: "entry-a",
        route: "/another-route",
        top: 999,
        left: 0,
      },
    }, "", "/scroll-a");

    render(
      <BrowserRouter>
        <Harness />
      </BrowserRouter>,
    );

    const scroller = screen.getByTestId("workspace-scroll");
    expect(scroller.scrollTop).toBe(0);
    expect(window.history.state.aisbNowAnchor).toEqual({ capturedAt: "kept" });
    expect(readWorkspaceScrollSnapshot({ pathname: "/scroll-a", search: "", hash: "" }))
      .toMatchObject({ top: 0, left: 0, route: "/scroll-a" });
  });
});
