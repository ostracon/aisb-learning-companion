// @vitest-environment jsdom

import { EditorView } from "@uiw/react-codemirror";
import { syntaxTree } from "@codemirror/language";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NoteMarkdownEditor } from "./NoteMarkdownEditor.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("NoteMarkdownEditor", () => {
  it("previews the exact live draft while keeping the source editor mounted", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <NoteMarkdownEditor
        value={"# Current draft\n\n**Unsaved** browser text."}
        readOnly={false}
        onChange={onChange}
      />,
    );

    const editor = screen.getByRole("textbox", { name: "Markdown note" });
    expect(editor.hasAttribute("hidden")).toBe(false);
    expect(screen.getByRole("button", { name: "Write" }).getAttribute("aria-pressed")).toBe("true");

    await user.click(screen.getByRole("button", { name: "Preview" }));

    expect(screen.getByRole("button", { name: "Preview" }).getAttribute("aria-pressed")).toBe("true");
    const preview = screen.getByRole("article", { name: "Rendered Markdown note preview" });
    expect(within(preview).getByRole("heading", { name: "Current draft" })).toBeTruthy();
    expect(within(preview).getByText("Unsaved").tagName).toBe("STRONG");
    const mountedEditor = document.getElementById("note-editor");
    expect(mountedEditor?.contains(editor)).toBe(true);
    expect(mountedEditor?.hasAttribute("hidden")).toBe(true);

    await user.click(screen.getByRole("button", { name: "Write" }));
    expect(screen.getByRole("textbox", { name: "Markdown note" })).toBe(editor);
    expect(screen.getByText(/Esc, then Tab exits/)).toBeTruthy();
  });

  it("opens ordinary preview links while keeping remote images inactive", async () => {
    const user = userEvent.setup();
    render(
      <NoteMarkdownEditor
        value={"[external](https://example.com)\n\n![diagram](https://example.com/a.png)"}
        readOnly
        describedBy="coordination-status"
        onChange={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Preview" }));
    const external = screen.getByRole("link", { name: "external" });
    expect(external.getAttribute("href")).toBe("https://example.com");
    expect(external.getAttribute("target")).toBe("_blank");
    expect(external.getAttribute("rel")).toBe("noreferrer");
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("Image omitted from note preview: diagram")).toBeTruthy();
    const editor = screen.getByRole("textbox", { name: "Markdown note", hidden: true });
    expect(editor.getAttribute("contenteditable")).toBe("false");
    expect(editor.getAttribute("aria-readonly")).toBe("true");
    expect(editor.getAttribute("aria-describedby")).toContain("coordination-status");
  });

  it("continues Markdown lists and indents them with Tab", () => {
    const onChange = vi.fn();
    render(
      <NoteMarkdownEditor
        value={"- first\n- second"}
        readOnly={false}
        onChange={onChange}
      />,
    );

    const editor = screen.getByRole("textbox", { name: "Markdown note" });
    const editorView = EditorView.findFromDOM(editor);
    expect(editorView).not.toBeNull();
    act(() => editorView?.dispatch({ selection: { anchor: editorView.state.doc.length } }));

    fireEvent.keyDown(editor, { key: "Enter", code: "Enter" });
    expect(editorView?.state.doc.toString()).toBe("- first\n- second\n- ");

    fireEvent.keyDown(editor, { key: "Tab", code: "Tab" });
    expect(editorView?.state.doc.toString()).toBe("- first\n- second\n  - ");

    fireEvent.keyDown(editor, { key: "Tab", code: "Tab", shiftKey: true });
    expect(editorView?.state.doc.toString()).toBe("- first\n- second\n- ");
    expect(onChange).toHaveBeenCalled();
  });

  it("loads the declared fenced-code language without changing the note", async () => {
    const onChange = vi.fn();
    const value = [
      "## Example",
      "",
      "```py",
      "def greet(name):",
      "    return f\"Hello {name}\"",
      "```",
    ].join("\n");
    render(
      <NoteMarkdownEditor
        value={value}
        readOnly={false}
        onChange={onChange}
      />,
    );

    const editor = screen.getByRole("textbox", { name: "Markdown note" });
    const editorView = EditorView.findFromDOM(editor);
    expect(editorView).not.toBeNull();
    const defPosition = value.indexOf("def") + 1;
    await waitFor(() => {
      expect(syntaxTree(editorView!.state).resolveInner(defPosition, 1).type.name).toBe("def");
    });
    expect(onChange).not.toHaveBeenCalled();
    expect(editorView?.state.doc.toString()).toBe(value);
  });

  it("keeps a follower immutable and enables the same editor after handoff", async () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <NoteMarkdownEditor
        value={"- mirrored item"}
        readOnly
        describedBy="coordination-status"
        onChange={onChange}
      />,
    );

    const editor = screen.getByRole("textbox", { name: "Markdown note" });
    const editorView = EditorView.findFromDOM(editor);
    expect(editorView).not.toBeNull();
    act(() => editorView?.dispatch({ selection: { anchor: editorView.state.doc.length } }));
    fireEvent.keyDown(editor, { key: "Enter", code: "Enter" });
    fireEvent.keyDown(editor, { key: "Tab", code: "Tab" });
    expect(editorView?.state.doc.toString()).toBe("- mirrored item");
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText("View only · select and copy")).toBeTruthy();

    rerender(
      <NoteMarkdownEditor
        value={"- mirrored item"}
        readOnly={false}
        onChange={onChange}
      />,
    );
    await waitFor(() => expect(editor.getAttribute("contenteditable")).toBe("true"));
    expect(EditorView.findFromDOM(editor)).toBe(editorView);
    fireEvent.keyDown(editor, { key: "Enter", code: "Enter" });
    expect(editorView?.state.doc.toString()).toBe("- mirrored item\n- ");
    expect(onChange).toHaveBeenCalled();
  });

  it("applies an externally supplied Markdown value immediately without echo or delayed rollback", async () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <NoteMarkdownEditor
        value={"# First note"}
        readOnly={false}
        onChange={onChange}
      />,
    );

    const editor = screen.getByRole("textbox", { name: "Markdown note" });
    const editorView = EditorView.findFromDOM(editor);
    expect(editorView).not.toBeNull();
    act(() => editorView?.dispatch({
      changes: { from: editorView.state.doc.length, insert: "\nlocal typing" },
    }));
    expect(onChange).toHaveBeenCalled();
    onChange.mockClear();

    rerender(
      <NoteMarkdownEditor
        value={"# Reconciled disk note"}
        readOnly={false}
        onChange={onChange}
      />,
    );

    expect(onChange).not.toHaveBeenCalled();
    expect(editorView?.state.doc.toString()).toBe("# Reconciled disk note");
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    expect(editorView?.state.doc.toString()).toBe("# Reconciled disk note");
  });
});
