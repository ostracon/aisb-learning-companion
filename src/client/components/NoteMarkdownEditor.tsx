import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import CodeMirror, {
  EditorState,
  EditorView,
  ExternalChange,
  Transaction,
  type ReactCodeMirrorRef,
} from "@uiw/react-codemirror";
import { tags } from "@lezer/highlight";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

import { SafeMarkdown } from "./SafeMarkdown.js";

export interface NoteMarkdownEditorProps {
  readonly value: string;
  readonly readOnly: boolean;
  readonly describedBy?: string | undefined;
  readonly onChange: (value: string) => void;
}

type NoteView = "write" | "preview";

function languageAliases(name: string, aliases: readonly string[]): readonly LanguageDescription[] {
  const target = languages.find((description) => description.name === name);
  return target
    ? [LanguageDescription.of({
      name: `${name} shorthand`,
      alias: aliases,
      load: () => target.load(),
    })]
    : [];
}

const notebookCodeLanguages = [
  ...languageAliases("Python", ["py", "python3"]),
  ...languageAliases("Markdown", ["md"]),
  ...languages,
];

const editableMarkdownSupport = markdown({
  codeLanguages: notebookCodeLanguages,
  completeHTMLTags: false,
  pasteURLAsLink: false,
});
const readOnlyMarkdownSupport = markdown({
  addKeymap: false,
  codeLanguages: notebookCodeLanguages,
  completeHTMLTags: false,
  pasteURLAsLink: false,
});

const notebookMarkdownHighlight = HighlightStyle.define([
  { tag: tags.heading, color: "var(--ink)", fontWeight: "700" },
  { tag: tags.strong, fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: [tags.link, tags.url], color: "var(--cobalt)", textDecoration: "underline" },
  { tag: tags.quote, color: "var(--muted)" },
  { tag: [tags.meta, tags.contentSeparator], color: "var(--faint)" },
  { tag: tags.monospace, color: "var(--ink)", backgroundColor: "var(--paper-quiet)" },
  { tag: [tags.keyword, tags.operatorKeyword], color: "var(--cobalt)", fontWeight: "620" },
  { tag: [tags.string, tags.regexp], color: "var(--success)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--warning)" },
  { tag: tags.comment, color: "var(--muted)", fontStyle: "italic" },
  { tag: [tags.typeName, tags.className], color: "var(--cobalt)" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], fontWeight: "650" },
  { tag: tags.operator, color: "var(--faint)" },
  { tag: tags.invalid, color: "var(--danger)", textDecoration: "underline wavy" },
]);

const editorSetup = {
  lineNumbers: false,
  highlightActiveLineGutter: false,
  foldGutter: false,
  drawSelection: false,
  syntaxHighlighting: false,
  allowMultipleSelections: false,
  autocompletion: false,
  rectangularSelection: false,
  crosshairCursor: false,
  highlightActiveLine: false,
  highlightSelectionMatches: false,
  searchKeymap: false,
  foldKeymap: false,
  completionKeymap: false,
  lintKeymap: false,
  tabSize: 2,
} as const;

export function NoteMarkdownEditor({
  value,
  readOnly,
  describedBy,
  onChange,
}: NoteMarkdownEditorProps) {
  const [view, setView] = useState<NoteView>("write");
  const editorRef = useRef<ReactCodeMirrorRef>(null);
  const initialValueRef = useRef(value);
  const latestValueRef = useRef(value);
  latestValueRef.current = value;
  const editorDescription = describedBy
    ? `note-editor-help ${describedBy}`
    : "note-editor-help";
  const editorExtensions = useMemo(() => {
    const contentAttributes: Record<string, string> = {
      "aria-describedby": editorDescription,
      "aria-label": "Markdown note",
      "aria-multiline": "true",
      "aria-readonly": String(readOnly),
      spellcheck: "true",
    };
    if (readOnly) {
      contentAttributes.tabindex = "0";
    }
    return [
      readOnly ? readOnlyMarkdownSupport : editableMarkdownSupport,
      EditorState.tabSize.of(2),
      EditorView.lineWrapping,
      syntaxHighlighting(notebookMarkdownHighlight),
      EditorView.contentAttributes.of(contentAttributes),
    ];
  }, [editorDescription, readOnly]);
  const synchronizeExternalValue = useCallback((editorView: EditorView, nextValue: string) => {
    const currentValue = editorView.state.doc.toString();
    if (currentValue === nextValue) {
      return;
    }
    editorView.dispatch({
      changes: { from: 0, to: currentValue.length, insert: nextValue },
      annotations: [
        ExternalChange.of(true),
        Transaction.addToHistory.of(false),
      ],
    });
  }, []);
  const handleCreateEditor = useCallback(
    (editorView: EditorView) => synchronizeExternalValue(editorView, latestValueRef.current),
    [synchronizeExternalValue],
  );

  useLayoutEffect(() => {
    const editorView = editorRef.current?.view;
    if (editorView) {
      synchronizeExternalValue(editorView, value);
    }
  }, [synchronizeExternalValue, value]);

  const chooseView = (nextView: NoteView) => {
    setView(nextView);
    if (nextView === "write") {
      window.requestAnimationFrame(() => {
        editorRef.current?.view?.requestMeasure();
        editorRef.current?.view?.focus();
      });
    }
  };

  return (
    <div className="note-editor-surface">
      <div className="editor-toolbar">
        <div className="editor-view-switch" role="group" aria-label="Note view">
          <button
            type="button"
            aria-pressed={view === "write"}
            onClick={() => chooseView("write")}
          >
            Write
          </button>
          <button
            type="button"
            aria-pressed={view === "preview"}
            onClick={() => chooseView("preview")}
          >
            Preview
          </button>
        </div>
        <span className="editor-format-help" id="note-editor-help">
          {view === "write"
            ? readOnly
              ? "View only · select and copy"
              : "Enter continues lists · Tab indents · Esc, then Tab exits"
            : "Rendered locally · links work · remote images stay omitted"}
        </span>
      </div>
      <CodeMirror
        ref={editorRef}
        id="note-editor"
        className="note-editor"
        value={initialValueRef.current}
        theme="none"
        basicSetup={editorSetup}
        extensions={editorExtensions}
        indentWithTab={!readOnly}
        editable={!readOnly}
        readOnly={readOnly}
        onCreateEditor={handleCreateEditor}
        onChange={onChange}
        hidden={view !== "write"}
      />
      <article
        className="note-markdown-preview markdown-reader"
        aria-label="Rendered Markdown note preview"
        tabIndex={0}
        hidden={view !== "preview"}
      >
        {view !== "preview" ? null : value.trim() ? (
          <SafeMarkdown
            markdown={value}
            headingIdPrefix="note-preview-heading-"
            inertLinkTitle="Links stay inactive in note preview"
            omittedImageLabel="Image omitted from note preview"
            activateLinks
          />
        ) : (
          <p className="note-preview-empty">Nothing to preview yet.</p>
        )}
      </article>
    </div>
  );
}
