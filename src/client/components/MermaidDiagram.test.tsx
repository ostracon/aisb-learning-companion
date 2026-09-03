// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mermaidMocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
}));

vi.mock("mermaid", () => ({
  default: {
    initialize: mermaidMocks.initialize,
    render: mermaidMocks.render,
  },
}));

import { MermaidDiagram } from "./MermaidDiagram.js";

afterEach(() => {
  cleanup();
  mermaidMocks.render.mockReset();
});

describe("MermaidDiagram", () => {
  it("renders source through Mermaid with strict security", async () => {
    mermaidMocks.render.mockResolvedValue({
      svg: '<svg viewBox="0 0 100 40"><text>Input → Output</text></svg>',
    });

    const source = "flowchart LR\nA --> B";
    const { container } = render(<MermaidDiagram source={source} />);
    expect(screen.getByRole("status").textContent).toContain("Rendering diagram");

    await waitFor(() => expect(container.querySelector("svg")?.textContent).toBe("Input → Output"));
    expect(mermaidMocks.initialize).toHaveBeenCalledWith(expect.objectContaining({
      securityLevel: "strict",
      startOnLoad: false,
      suppressErrorRendering: true,
    }));
    expect(mermaidMocks.render).toHaveBeenCalledWith(
      expect.stringMatching(/^aisb-mermaid-/u),
      source,
    );
  });

  it("preserves invalid source as a code fallback", async () => {
    mermaidMocks.render.mockRejectedValue(new Error("Invalid diagram"));

    const { container } = render(<MermaidDiagram source="not a valid diagram" />);
    await screen.findByText("Diagram could not be rendered; source shown below.");

    expect(container.querySelector(".markdown-code-block")?.textContent)
      .toContain("not a valid diagram");
  });
});
