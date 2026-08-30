// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TutorActiveTurnControls } from "./TutorActiveTurnControls.js";

afterEach(cleanup);

describe("TutorActiveTurnControls", () => {
  it("renders an in-transcript thinking message and exposes Stop", async () => {
    const user = userEvent.setup();
    const onStop = vi.fn();
    render(
      <TutorActiveTurnControls
        activeTurn={{
          turn_nonce: "turn-one",
          state: "running",
          started_at: "2026-08-30T09:00:00.000Z",
        }}
        sending
        stopping={false}
        onStop={onStop}
      />,
    );

    const status = screen.getByRole("status");
    expect(status.textContent).toMatch(/Tutor is thinking/i);
    expect(status.classList.contains("message")).toBe(true);
    expect(status.classList.contains("assistant")).toBe(true);
    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("does not claim completion while an acknowledged stop is pending", () => {
    render(
      <TutorActiveTurnControls
        activeTurn={{
          turn_nonce: "turn-one",
          state: "stopping",
          started_at: "2026-08-30T09:00:00.000Z",
        }}
        sending
        stopping
        onStop={() => undefined}
      />,
    );

    expect(screen.getByText(/after Codex confirms/i)).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Stopping…" }).disabled).toBe(true);
  });

  it("does not offer Stop before the server advertises an active turn", () => {
    render(
      <TutorActiveTurnControls
        activeTurn={null}
        sending
        stopping={false}
        onStop={() => undefined}
      />,
    );

    expect(screen.getByText(/Tutor is thinking/u)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });
});
