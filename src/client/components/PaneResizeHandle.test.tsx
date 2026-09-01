// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { PaneResizeHandle } from "./PaneResizeHandle.js";

describe("PaneResizeHandle", () => {
  it("offers keyboard adjustment and a double-click reset", async () => {
    const nudge = vi.fn();
    const reset = vi.fn();
    const user = userEvent.setup();
    render(
      <PaneResizeHandle
        label="Resize workspace and assistant"
        valueNow={424}
        valueMin={320}
        valueMax={800}
        valueText="424 pixels for the assistant"
        onPointerPosition={vi.fn()}
        onNudge={nudge}
        onReset={reset}
        onResizeStateChange={vi.fn()}
      />,
    );

    const separator = screen.getByRole("separator", {
      name: "Resize workspace and assistant",
    });
    expect(separator.getAttribute("aria-valuetext")).toBe("424 pixels for the assistant");
    separator.focus();
    await user.keyboard("{ArrowLeft}{Shift>}{ArrowRight}{/Shift}");
    expect(nudge).toHaveBeenNthCalledWith(1, -12);
    expect(nudge).toHaveBeenNthCalledWith(2, 48);

    await user.dblClick(separator);
    expect(reset).toHaveBeenCalledOnce();
  });
});
