// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { highlightMarkdownCode } from "./MarkdownCodeBlock.js";
import { normalizeMarkdownMathDelimiters, SafeMarkdown } from "./SafeMarkdown.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SafeMarkdown", () => {
  it.each([
    ["python", "print('hello')", "python", "Python"],
    ["py", "def greet():\n    return 'hello'", "python", "Python"],
    ["bash", "printf '%s\\n' hello", "bash", "Shell"],
    ["text", "literal text", "plaintext", "Code"],
    ["docker", "FROM python:3.13-slim", "dockerfile", "Dockerfile"],
    ["c", "int main(void) { return 0; }", "c", "C"],
    ["md", "# Heading", "markdown", "Markdown"],
    ["pwsh", "Write-Output 'hello'", "powershell", "PowerShell"],
  ])("highlights the declared %s fence with its canonical grammar", (
    fence,
    source,
    language,
    label,
  ) => {
    const result = highlightMarkdownCode(source, `language-${fence}`);
    expect(result.source).toBe("declared");
    expect(result.language).toBe(language);
    expect(result.label).toBe(label);
  });

  it("renders unsupported declared fences as escaped plain code", () => {
    const result = highlightMarkdownCode("<script>alert(1)</script>", "language-mermaid");
    expect(result.source).toBe("declared");
    expect(result.language).toBeNull();
    expect(result.label).toBe("Mermaid");
    expect(result.html).toContain("&lt;script&gt;");
    expect(result.html).not.toContain("<script>");
  });

  it("renders GFM while keeping HTML, links, and remote images inert", () => {
    const { container } = render(
      <SafeMarkdown
        markdown={[
          "# Learner note",
          "",
          "- [x] reviewed",
          "",
          "[untrusted link](javascript:alert(1))",
          "",
          "![tracking pixel](https://tracker.example/pixel.png)",
          "",
          "<script>window.compromised = true</script>",
        ].join("\n")}
        headingIdPrefix="test-heading-"
        inertLinkTitle="Links are inactive"
        omittedImageLabel="Image omitted"
      />,
    );

    expect(screen.getByRole("heading", { name: "Learner note" }).id).toBe(
      "test-heading-learner-note",
    );
    expect(screen.getByRole("checkbox").hasAttribute("checked")).toBe(true);
    expect(screen.queryByRole("link", { name: "untrusted link" })).toBeNull();
    expect(screen.getByText("untrusted link").getAttribute("title")).toBe("Links are inactive");
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("Image omitted: tracking pixel")).toBeTruthy();
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).not.toContain("window.compromised");
  });

  it("can omit remote images without rendering a placeholder", () => {
    const { container } = render(
      <SafeMarkdown
        markdown={"Before\n\n![Inspect view](https://tracker.example/image.png)\n\nAfter"}
        headingIdPrefix="silent-image-heading-"
        inertLinkTitle="Links are inactive"
        omittedImageLabel={null}
      />,
    );

    expect(screen.queryByRole("img")).toBeNull();
    expect(container.textContent?.replace(/\s+/gu, "")).toBe("BeforeAfter");
    expect(container.textContent).not.toContain("Inspect view");
  });

  it("uses punctuation-safe GitHub-style slugs and stable duplicate suffixes", () => {
    render(
      <SafeMarkdown
        markdown={"## Threat Models & Boundaries\n\n## Threat Models & Boundaries"}
        headingIdPrefix="material-heading-"
        inertLinkTitle="Links are inactive"
        omittedImageLabel="Image omitted"
      />,
    );

    const headings = screen.getAllByRole("heading", { name: "Threat Models & Boundaries" });
    expect(headings.map(({ id }) => id)).toEqual([
      "material-heading-threat-models-boundaries",
      "material-heading-threat-models-boundaries-1",
    ]);
  });

  it("can show model-authored tag syntax as escaped text without creating HTML nodes", () => {
    const { container } = render(
      <SafeMarkdown
        markdown={"Use <system>policy</system> and <document>data</document>. <script>unsafe()</script>"}
        headingIdPrefix="model-html-heading-"
        inertLinkTitle="Links are inactive"
        omittedImageLabel="Image omitted"
        showRawHtmlSource
      />,
    );

    expect(container.textContent).toContain("<system>policy</system>");
    expect(container.textContent).toContain("<document>data</document>");
    expect(container.textContent).toContain("<script>unsafe()</script>");
    expect(container.querySelector("system")).toBeNull();
    expect(container.querySelector("document")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
  });

  it("activates ordinary links without reviving unsafe schemes", () => {
    render(
      <SafeMarkdown
        markdown={[
          "[Guide](https://example.com/guide)",
          "",
          "[Jump](#details)",
          "",
          "[Unsafe](javascript:alert(1))",
          "",
          "## Details",
        ].join("\n")}
        headingIdPrefix="active-heading-"
        inertLinkTitle="Link unavailable"
        omittedImageLabel="Image omitted"
        activateLinks
      />,
    );

    const guide = screen.getByRole("link", { name: "Guide" });
    expect(guide.getAttribute("href")).toBe("https://example.com/guide");
    expect(guide.getAttribute("target")).toBe("_blank");
    expect(screen.getByRole("link", { name: "Jump" }).getAttribute("href"))
      .toBe("#active-heading-details");
    expect(screen.queryByRole("link", { name: "Unsafe" })).toBeNull();
    expect(screen.getByText("Unsafe").getAttribute("title")).toBe("Link unavailable");
  });

  it("highlights declared and confidently detected code without guessing plain blocks", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    const { container } = render(
      <SafeMarkdown
        markdown={[
          "```python",
          "def greet(name):",
          "    return f\"Hello {name}\"",
          "```",
          "",
          "```",
          "import json",
          "from pathlib import Path",
          "print(json.dumps({\"root\": str(Path.cwd())}))",
          "```",
          "",
          "```",
          "one short line",
          "```",
        ].join("\n")}
        headingIdPrefix="code-heading-"
        inertLinkTitle="Links are inactive"
        omittedImageLabel="Image omitted"
      />,
    );

    const blocks = [...container.querySelectorAll<HTMLElement>(".markdown-code-block")];
    expect(blocks).toHaveLength(3);
    expect(blocks[0]?.dataset.languageSource).toBe("declared");
    expect(within(blocks[0]!).getByText("Python")).toBeTruthy();
    expect(blocks[0]?.querySelector(".hljs-keyword")?.textContent).toBe("def");
    expect(blocks[1]?.dataset.languageSource).toBe("detected");
    expect(within(blocks[1]!).getByText("Python · detected")).toBeTruthy();
    expect(blocks[2]?.dataset.languageSource).toBe("plain");
    expect(within(blocks[2]!).getByText("Code")).toBeTruthy();

    await user.click(within(blocks[0]!).getByRole("button", { name: "Copy python code" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(
      "def greet(name):\n    return f\"Hello {name}\"",
    ));
    expect(within(blocks[0]!).getByRole("button", { name: "Copy python code" }).textContent)
      .toBe("Copied");
  });

  it("keeps highlighted HTML source inert and leaves inline code inline", () => {
    const { container } = render(
      <SafeMarkdown
        markdown={[
          "Use `print(value)` here.",
          "",
          "```html",
          "<img src=x onerror=\"window.compromised=true\">",
          "```",
        ].join("\n")}
        headingIdPrefix="safe-code-heading-"
        inertLinkTitle="Links are inactive"
        omittedImageLabel="Image omitted"
      />,
    );

    expect(screen.getByText("print(value)").closest(".markdown-code-block")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=");
    expect((window as unknown as { compromised?: boolean }).compromised).toBeUndefined();
  });

  it("renders common model math delimiters without changing stored-style code text", () => {
    const { container } = render(
      <SafeMarkdown
        markdown={[
          "Temperature reshapes the whole next-token probability distribution before sampling:",
          "",
          "\\[",
          "P(token_i)=\\operatorname{softmax}(logit_i/T)",
          "\\]",
          "",
          "- `T < 1`: sharpens the distribution",
          "- Inline \\(p_i\\) and explicit $$q_i$$ both work.",
        ].join("\n")}
        headingIdPrefix="math-heading-"
        inertLinkTitle="Links are inactive"
        omittedImageLabel="Image omitted"
      />,
    );

    const display = container.querySelector(".katex-display");
    expect(display).toBeTruthy();
    expect(display?.closest(".markdown-code-block")).toBeNull();
    expect(display?.querySelector("annotation")?.textContent).toContain(
      "P(token_i)=\\operatorname{softmax}(logit_i/T)",
    );
    expect(container.querySelectorAll(".katex")).toHaveLength(3);
    expect(screen.getByText("T < 1").tagName).toBe("CODE");
  });

  it("keeps bracket delimiters literal inside code and when they are unmatched", () => {
    const markdown = [
      "Outside \\(x + y\\).",
      "",
      "Inline `\\(literal\\)` code.",
      "",
      "```text",
      "\\[literal fenced math\\]",
      "```",
      "",
      "    \\(literal indented math\\)",
      "",
      "An unmatched \\[ stays literal.",
    ].join("\n");
    const normalized = normalizeMarkdownMathDelimiters(markdown);

    expect(normalized).toContain("Outside $$x + y$$.");
    expect(normalized).toContain("`\\(literal\\)`");
    expect(normalized).toContain("\\[literal fenced math\\]");
    expect(normalized).toContain("    \\(literal indented math\\)");
    expect(normalized).toContain("An unmatched \\[ stays literal.");

    const { container } = render(
      <SafeMarkdown
        markdown={markdown}
        headingIdPrefix="literal-math-heading-"
        inertLinkTitle="Links are inactive"
        omittedImageLabel="Image omitted"
      />,
    );
    expect(container.querySelectorAll(".katex")).toHaveLength(1);
    expect(container.querySelectorAll(".markdown-code-block")).toHaveLength(2);
    expect(container.textContent).toContain("\\[literal fenced math\\]");
    expect(container.textContent).toContain("\\(literal indented math\\)");
    expect(container.textContent).toContain("An unmatched [ stays literal.");
  });

  it("does not let untrusted math create links or remote media", () => {
    const { container } = render(
      <SafeMarkdown
        markdown={String.raw`$$\href{https://tracker.example/}{linked}$$ and $$\includegraphics{https://tracker.example/pixel.png}$$`}
        headingIdPrefix="untrusted-math-heading-"
        inertLinkTitle="Links are inactive"
        omittedImageLabel="Image omitted"
      />,
    );

    expect(container.querySelector(".katex")).toBeTruthy();
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });

  it("does not mistake ordinary currency for inline math", () => {
    const markdown = "Costs $12/month and $50/month; formulas such as $P(x)$ stay literal unless explicitly delimited.";
    const { container } = render(
      <SafeMarkdown
        markdown={markdown}
        headingIdPrefix="currency-heading-"
        inertLinkTitle="Links are inactive"
        omittedImageLabel="Image omitted"
      />,
    );

    expect(container.textContent).toBe(markdown);
    expect(container.querySelector(".katex")).toBeNull();
  });

  it("keeps fenced code exact inside Markdown containers", () => {
    const markdown = [
      "> ```text",
      "> \\(literal quoted code\\)",
      "> ```",
      "",
      "  - ```text",
      "    \\[literal listed code\\]",
      "    ```",
    ].join("\n");
    const normalized = normalizeMarkdownMathDelimiters(markdown);

    expect(normalized).toBe(markdown);
    const { container } = render(
      <SafeMarkdown
        markdown={markdown}
        headingIdPrefix="nested-code-heading-"
        inertLinkTitle="Links are inactive"
        omittedImageLabel="Image omitted"
      />,
    );
    expect(container.querySelectorAll(".markdown-code-block")).toHaveLength(2);
    expect(container.querySelector(".katex")).toBeNull();
    expect(container.textContent).toContain("\\(literal quoted code\\)");
    expect(container.textContent).toContain("\\[literal listed code\\]");
  });

  it("preserves Markdown containers around display math", () => {
    const markdown = [
      "> A quoted formula:",
      ">",
      "> \\[",
      "> p_i = \\operatorname{softmax}(z_i / T)",
      "> \\]",
      "",
      "- A listed formula:",
      "  \\[",
      "  q_i = z_i / T",
      "  \\]",
    ].join("\n");
    const normalized = normalizeMarkdownMathDelimiters(markdown);
    expect(normalized).toContain("> $$\n> p_i");
    expect(normalized).toContain("  $$\n  q_i");

    const { container } = render(
      <SafeMarkdown
        markdown={markdown}
        headingIdPrefix="contained-math-heading-"
        inertLinkTitle="Links are inactive"
        omittedImageLabel="Image omitted"
      />,
    );
    expect(container.querySelector("blockquote .katex-display")).toBeTruthy();
    expect(container.querySelector("li .katex-display")).toBeTruthy();
  });
});
