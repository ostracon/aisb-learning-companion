// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { PaneResizeHandle } from "./PaneResizeHandle.js";

describe("PaneResizeHandle", () => {
  it("offers keyboard adjustment and a double-click reset", async () => {
    const nudge = vi.fn();
    const reset = vi.fn();
    const pointerPosition = vi.fn();
    const resizeState = vi.fn();
    const user = userEvent.setup();
    render(
      <PaneResizeHandle
        label="Resize workspace and assistant"
        valueNow={424}
        valueMin={320}
        valueMax={800}
        valueText="424 pixels for the assistant"
        onPointerPosition={pointerPosition}
        onNudge={nudge}
        onReset={reset}
        onResizeStateChange={resizeState}
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
    expect(pointerPosition).not.toHaveBeenCalled();

    fireEvent.pointerDown(separator, { button: 0, clientX: 100, pointerId: 7 });
    fireEvent.pointerMove(separator, { clientX: 140, pointerId: 7 });
    fireEvent.pointerUp(separator, { clientX: 140, pointerId: 7 });
    expect(pointerPosition).toHaveBeenCalledWith(140);
    expect(resizeState).toHaveBeenLastCalledWith(false);
  });
});
