import {
  deleteMarkupBackward,
  insertNewlineContinueMarkupCommand,
  markdown,
} from "@codemirror/lang-markdown";
import { HighlightStyle, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import CodeMirror, {
  EditorState,
  EditorSelection,
  EditorView,
  ExternalChange,
  Prec,
  Transaction,
  keymap,
  type ReactCodeMirrorRef,
  type StateCommand,
} from "@uiw/react-codemirror";
import { tags } from "@lezer/highlight";
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

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

const continueMarkdownList = insertNewlineContinueMarkupCommand({ nonTightLists: false });

const continueTightMarkdownList: StateCommand = (target) => {
  const { state, dispatch } = target;
  if (dispatch === undefined || state.selection.ranges.length !== 1) {
    return continueMarkdownList(target);
  }

  const generatedHolder: { transaction: Transaction | null } = { transaction: null };
  const handled = continueMarkdownList({
    state,
    dispatch(transaction) {
      generatedHolder.transaction = transaction;
    },
  });
  const generated = generatedHolder.transaction;
  if (!handled || generated === null) return handled;

  const lineBreak = state.lineBreak;
  const edits: { from: number; to: number; insert: string }[] = [];
  let tightened = false;
  generated.changes.iterChanges((from, to, _fromNew, _toNew, inserted) => {
    let insert = inserted.toString();
    if (!tightened && insert.startsWith(lineBreak)) {
      const afterFirstBreak = insert.slice(lineBreak.length);
      const secondBreak = afterFirstBreak.indexOf(lineBreak);
      const blankContinuation = secondBreak < 0
        ? null
        : afterFirstBreak.slice(0, secondBreak);
      const continuedMarkup = secondBreak < 0
        ? ""
        : afterFirstBreak.slice(secondBreak + lineBreak.length);
      if (
        blankContinuation !== null
        && /^[\t >]*$/u.test(blankContinuation)
        && /^[\t >]*(?:[-+*]|\d+[.)])(?:\s|$)/u.test(continuedMarkup)
      ) {
        insert = lineBreak + continuedMarkup;
        tightened = true;
      }
    }
    edits.push({ from, to, insert });
  });

  if (!tightened) {
    dispatch(generated);
    return true;
  }

  const changes = state.changes(edits);
  dispatch(state.update({
    changes,
    selection: EditorSelection.cursor(changes.mapPos(state.selection.main.head, 1)),
    scrollIntoView: true,
    userEvent: "input",
  }));
  return true;
};

const editableMarkdownSupport = [
  markdown({
    addKeymap: false,
    codeLanguages: notebookCodeLanguages,
    completeHTMLTags: false,
    pasteURLAsLink: false,
  }),
  Prec.high(keymap.of([
    {
      key: "Enter",
      // CodeMirror defaults to making a tight list loose when Enter is
      // pressed on its first empty continuation marker. Notes should instead
      // match VS Code: outdent a nested marker or exit a top-level list.
      // Existing loose lists also continue with one source line rather than
      // propagating their historical blank-line spacing.
      run: continueTightMarkdownList,
    },
    { key: "Backspace", run: deleteMarkupBackward },
  ])),
];
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

export const NoteMarkdownEditor = memo(function NoteMarkdownEditor({
  value,
  readOnly,
  describedBy,
  onChange,
}: NoteMarkdownEditorProps) {
  const [view, setView] = useState<NoteView>("write");
  const editorRef = useRef<ReactCodeMirrorRef>(null);
  const initialValueRef = useRef(value);
  const latestValueRef = useRef(value);
  const editorValueRef = useRef(value);
  const [previewValue, setPreviewValue] = useState(value);
  const viewRef = useRef(view);
  viewRef.current = view;
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

  const handleChange = useCallback((nextValue: string) => {
    editorValueRef.current = nextValue;
    onChange(nextValue);
  }, [onChange]);

  useLayoutEffect(() => {
    const editorView = editorRef.current?.view;
    if (editorView) {
      synchronizeExternalValue(editorView, value);
    }
    editorValueRef.current = value;
    if (viewRef.current === "preview") setPreviewValue(value);
  }, [synchronizeExternalValue, value]);

  const chooseView = (nextView: NoteView) => {
    if (nextView === "preview") setPreviewValue(editorValueRef.current);
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
        onChange={handleChange}
        hidden={view !== "write"}
      />
      <article
        className="note-markdown-preview markdown-reader"
        aria-label="Rendered Markdown note preview"
        tabIndex={0}
        hidden={view !== "preview"}
      >
        {view !== "preview" ? null : previewValue.trim() ? (
          <SafeMarkdown
            markdown={previewValue}
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
});
