// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { TutorSessionMessageView } from "../../shared/api.js";
import { TutorMessageContent } from "./TutorMessageContent.js";

function message(
  role: TutorSessionMessageView["role"],
  text: string,
  citations: TutorSessionMessageView["citations"] = [],
): TutorSessionMessageView {
  return {
    message_id: `message-${role}`,
    role,
    status: role === "assistant" ? "completed" : "accepted",
    text,
    occurred_at: "2026-08-30T12:00:00.000Z",
    turn_nonce: "turn-nonce",
    turn_id: role === "assistant" ? "turn-id" : null,
    citations,
  };
}

afterEach(cleanup);

describe("TutorMessageContent", () => {
  it("renders the assistant output vocabulary through the safe shared projection", () => {
    const { container } = render(
      <TutorMessageContent message={message("assistant", [
        "## Why it differs",
        "",
        "> Sampling changes after **both** filters; keep `<system>` distinct from `<user>`.",
        "",
        "| Control | Effect |",
        "| --- | --- |",
        "| top-k | fixed count |",
        "| top-p | cumulative mass |",
        "",
        "- [x] compare them",
        "",
        "\\[",
        "p_i = \\operatorname{softmax}(z_i / T)",
        "\\]",
        "",
        "```python",
        "temperature = 0.7",
        "```",
      ].join("\n"))} />,
    );

    expect(screen.getByRole("heading", { name: "Why it differs" })).toBeTruthy();
    expect(container.querySelector("blockquote strong")?.textContent).toBe("both");
    expect(container.textContent).toContain("<system>");
    expect(screen.getByRole("table")).toBeTruthy();
    expect(screen.getByRole("checkbox").hasAttribute("checked")).toBe(true);
    expect(container.querySelector(".katex-display")).toBeTruthy();
    expect(container.querySelector(".hljs-keyword")?.textContent).toBeUndefined();
    expect(screen.getByRole("button", { name: "Copy python code" })).toBeTruthy();
  });

  it("keeps learner and status records literal", () => {
    const { container, rerender } = render(
      <TutorMessageContent message={message("user", "**not bold** `not code`")} />,
    );
    expect(container.textContent).toBe("**not bold** `not code`");
    expect(container.querySelector("strong")).toBeNull();
    expect(container.querySelector("code")).toBeNull();

    rerender(<TutorMessageContent message={message("status", "## literal status")} />);
    expect(container.textContent).toBe("## literal status");
    expect(container.querySelector("h2")).toBeNull();
  });

  it("shows only credential-free HTTP(S) citations as application-owned source links", () => {
    render(
      <TutorMessageContent message={message("assistant", "Use the source.", [
        { label: "Course guide", url: "https://example.test/guide" },
        { label: "Unsafe local file", url: "file:///private/answer.md" },
        { label: "Credential-bearing", url: "https://user:secret@example.test/" },
      ])} />,
    );

    const sources = screen.getByRole("contentinfo", { name: "Sources for tutor reply" });
    const links = within(sources).getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]?.textContent).toBe("Course guide");
    expect(links[0]?.getAttribute("href")).toBe("https://example.test/guide");
    expect(screen.queryByText("Unsafe local file")).toBeNull();
    expect(screen.queryByText("Credential-bearing")).toBeNull();
  });

  it("shows saved application visuals inline while keeping remote images inert", () => {
    const { container } = render(
      <TutorMessageContent message={message("assistant", [
        "![Attention projection](/api/visuals/visual_12345678-1234-1234-1234-123456789abc/image)",
        "",
        "![Untrusted diagram](https://example.test/diagram.png)",
      ].join("\n"))} />,
    );

    const visual = screen.getByRole("img", { name: "Attention projection" });
    expect(visual.getAttribute("src")).toBe(
      "/api/visuals/visual_12345678-1234-1234-1234-123456789abc/image",
    );
    expect(visual.classList.contains("assistant-generated-visual")).toBe(true);
    expect(container.textContent).toContain(
      "Remote image omitted; use Useful visuals for generated learning aids: Untrusted diagram",
    );
    expect(container.querySelector('img[src="https://example.test/diagram.png"]')).toBeNull();
  });
});
