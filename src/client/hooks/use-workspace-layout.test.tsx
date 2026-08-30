// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrowserRouter, useLocation, useNavigate } from "react-router-dom";
import { historyLayoutKey, type WorkspaceLayout } from "../state/layout.js";
import { useWorkspaceLayout } from "./use-workspace-layout.js";

function Harness() {
  const { layout, dispatch } = useWorkspaceLayout();
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output aria-label="route">{location.pathname}</output>
      <output aria-label="navigation panel">
        {layout.panels.navigation ? "open" : "closed"}
      </output>
      <button
        type="button"
        onClick={() => dispatch({ type: "toggle-panel", panel: "navigation" })}
      >
        Toggle navigation
      </button>
      <button type="button" onClick={() => navigate("/layout-b")}>Go to B</button>
    </>
  );
}

function historyLayout(): WorkspaceLayout | undefined {
  return window.history.state?.[historyLayoutKey] as WorkspaceLayout | undefined;
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState({}, "", "/layout-a");
});

afterEach(() => {
  cleanup();
});

describe("useWorkspaceLayout", () => {
  it("snapshots and restores the layout for each browser history entry", async () => {
    const user = userEvent.setup();
    render(
      <BrowserRouter>
        <Harness />
      </BrowserRouter>,
    );

    await waitFor(() => expect(historyLayout()?.panels.navigation).toBe(true));
    await user.click(screen.getByRole("button", { name: "Toggle navigation" }));
    await waitFor(() => expect(historyLayout()?.panels.navigation).toBe(false));
    const entryA = window.history.state as Record<string, unknown>;

    await user.click(screen.getByRole("button", { name: "Go to B" }));
    await waitFor(() => expect(screen.getByLabelText("route").textContent).toBe("/layout-b"));
    await waitFor(() => expect(historyLayout()?.panels.navigation).toBe(false));
    await user.click(screen.getByRole("button", { name: "Toggle navigation" }));
    await waitFor(() => expect(historyLayout()?.panels.navigation).toBe(true));
    const entryB = window.history.state as Record<string, unknown>;

    act(() => {
      window.history.replaceState(entryA, "", "/layout-a");
      window.dispatchEvent(new PopStateEvent("popstate", { state: entryA }));
    });
    await waitFor(() => expect(screen.getByLabelText("route").textContent).toBe("/layout-a"));
    await waitFor(() => expect(screen.getByLabelText("navigation panel").textContent).toBe("closed"));

    act(() => {
      window.history.replaceState(entryB, "", "/layout-b");
      window.dispatchEvent(new PopStateEvent("popstate", { state: entryB }));
    });
    await waitFor(() => expect(screen.getByLabelText("route").textContent).toBe("/layout-b"));
    await waitFor(() => expect(screen.getByLabelText("navigation panel").textContent).toBe("open"));
  });
});
