import { useEffect, useMemo, useState } from "react";

import type {
  LearningDayId,
  NoteListItemView,
  NoteListResponse,
  SavedNoteLaunchResponse,
  SavedNoteLaunchToken,
} from "../../shared/api.js";
import type { NoteSaveStatus } from "../hooks/use-note-draft.js";

export function slugifyQuickNoteName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
}

interface NoteControlsProps {
  readonly dayId: LearningDayId;
  readonly scopeMode: "today" | "study";
  readonly sectionIds: readonly string[];
  readonly currentNoteId: string;
  readonly currentRevision: number;
  readonly currentContentHash: string;
  readonly saveStatus: NoteSaveStatus;
  readonly onOpenNote: (noteId: string, routePath: string) => void;
}

interface SavedNoteCheckpoint {
  readonly revision: number;
  readonly contentHash: string;
}

const sha256Pattern = /^[a-f0-9]{64}$/;

function savedNoteCheckpoint(value: unknown, expectedNoteId: string): SavedNoteCheckpoint {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("The note service returned a malformed response");
  }
  const response = value as Record<string, unknown>;
  if (response.note_id !== expectedNoteId) {
    throw new Error("The note service responded for a different note");
  }
  if (
    typeof response.revision !== "number"
    || !Number.isSafeInteger(response.revision)
    || response.revision < 1
  ) {
    throw new Error("The note service returned a malformed revision");
  }
  if (typeof response.content_hash !== "string" || !sha256Pattern.test(response.content_hash)) {
    throw new Error("The note service returned a malformed content hash");
  }
  return { revision: response.revision, contentHash: response.content_hash };
}

async function payload<T>(response: Response, fallback: string): Promise<T> {
  const value = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(value.error ?? fallback);
  return value;
}

export function NoteControls({
  dayId,
  scopeMode,
  sectionIds,
  currentNoteId,
  currentRevision,
  currentContentHash,
  saveStatus,
  onOpenNote,
}: NoteControlsProps) {
  const [notes, setNotes] = useState<NoteListItemView[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openResult, setOpenResult] = useState<string | null>(null);

  const prefix = `${dayId}_quicknote_`;
  const slug = slugifyQuickNoteName(name).slice(0, Math.max(1, 127 - prefix.length));
  const proposedNoteId = `${prefix}${slug || "name"}`;
  const acknowledgedDiskCheckpoint =
    currentRevision > 0 && sha256Pattern.test(currentContentHash);
  const canOpenInVSCode =
    (saveStatus === "saved-disk" && acknowledgedDiskCheckpoint)
    || saveStatus === "conflict";

  const { options, quickNoteOptions, topicNoteOptions } = useMemo(() => {
    const nonArchivedNotes = notes.filter((note) => note.status !== "archived");
    const activeNotes = nonArchivedNotes.filter((note) => note.status === "active");
    const quickNotes = activeNotes.filter(
      (note) => note.noteKind === "ad_hoc" && note.noteId.startsWith(prefix),
    );

    if (scopeMode === "study") {
      const sectionOrder = new Map<string, number>(sectionIds.map((sectionId, index) => (
        [`notes/lessons/${sectionId}/notes.md`, index] as const
      )));
      const topicNotes = activeNotes
        .filter((note) => {
          if (note.noteKind !== "lesson") return false;
          return sectionOrder.has(note.logicalPath);
        })
        .sort((left, right) => (
          (sectionOrder.get(left.logicalPath) ?? Number.MAX_SAFE_INTEGER)
          - (sectionOrder.get(right.logicalPath) ?? Number.MAX_SAFE_INTEGER)
        ));
      return {
        options: [...topicNotes, ...quickNotes],
        quickNoteOptions: quickNotes,
        topicNoteOptions: topicNotes,
      };
    }

    const todayNotes = nonArchivedNotes.filter((note) => (
      note.noteId === currentNoteId
      || note.noteId.startsWith(prefix)
      || note.routePath === `/day/${dayId}`
      || note.routePath.startsWith(`/day/${dayId}/event/`)
    ));
    return { options: todayNotes, quickNoteOptions: [], topicNoteOptions: [] };
  }, [currentNoteId, dayId, notes, prefix, scopeMode, sectionIds]);
  const currentListed = options.some((note) => note.noteId === currentNoteId);
  const currentOption = options.find((note) => note.noteId === currentNoteId) ?? null;

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/notes", { signal: controller.signal })
      .then((response) => payload<NoteListResponse>(response, "The note list could not be loaded"))
      .then((result) => {
        const unreadable = Array.isArray(result.unreadable) ? result.unreadable : [];
        setNotes(result.notes);
        setError(unreadable.length === 0
          ? null
          : `${unreadable.length} Markdown note ${unreadable.length === 1 ? "file is" : "files are"} unreadable. ${unreadable[0]?.logicalPath ?? "Check the notes directory"}`);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : "The note list could not be loaded");
        }
      });
    return () => controller.abort();
  }, [currentNoteId, currentRevision]);

  const createQuickNote = async () => {
    const trimmed = name.trim();
    if (!trimmed || !slug || busy) return;
    setBusy(true);
    setError(null);
    try {
      await payload(
        await fetch("/api/notes", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ note_id: `${prefix}${slug}`, title: trimmed }),
        }),
        "The named note could not be created",
      );
      setShowCreate(false);
      setName("");
      onOpenNote(`${prefix}${slug}`, `/notes/${prefix}${slug}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The named note could not be created");
    } finally {
      setBusy(false);
    }
  };

  const openInVSCode = async () => {
    if (!canOpenInVSCode || busy) return;
    setBusy(true);
    setError(null);
    setOpenResult(null);
    try {
      // During a conflict, the browser checkpoint deliberately remains bound to
      // the preserved draft. Read a fresh disk checkpoint so VS Code can inspect
      // the current Markdown file without resolving or overwriting either copy.
      const checkpoint = saveStatus === "conflict"
        ? savedNoteCheckpoint(
            await payload<unknown>(
              await fetch(`/api/notes/${encodeURIComponent(currentNoteId)}`),
              "The current Markdown note could not be read",
            ),
            currentNoteId,
          )
        : { revision: currentRevision, contentHash: currentContentHash };
      const token = await payload<SavedNoteLaunchToken>(
        await fetch("/api/notes/vscode/prepare", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            note_id: currentNoteId,
            expected_revision: checkpoint.revision,
            expected_content_hash: checkpoint.contentHash,
          }),
        }),
        "The saved note could not be prepared for VS Code",
      );
      const result = await payload<SavedNoteLaunchResponse>(
        await fetch("/api/notes/vscode/launch", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
        }),
        "VS Code could not be launched",
      );
      setOpenResult(
        result.status === "opened"
          ? `Opened ${result.logical_path}`
          : `VS Code was not opened (${result.reason}); the note is still saved.`,
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "VS Code could not be launched");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="note-controls">
      <div className="note-controls-row">
        <label className="note-picker-label">
          <span className="sr-only">Choose a Markdown note</span>
          <select
            aria-label="Choose a Markdown note"
            aria-describedby="note-picker-key"
            title={currentOption
              ? `${currentOption.hasLearnerContent ? "* " : ""}${currentOption.title} · ${currentOption.logicalPath}`
              : undefined}
            value={currentListed ? currentNoteId : ""}
            onChange={(event) => {
              const selected = options.find((note) => note.noteId === event.currentTarget.value);
              if (selected) onOpenNote(selected.noteId, selected.routePath);
            }}
          >
            {!currentListed ? <option value="">Current note · loading index…</option> : null}
            {scopeMode === "study" ? (
              <>
                <optgroup label="Topic notes">
                  {topicNoteOptions.map((note) => (
                    <option key={note.noteId} value={note.noteId}>
                      {note.hasLearnerContent ? `* ${note.title}` : note.title} · {note.logicalPath}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Quick notes">
                  {quickNoteOptions.map((note) => (
                    <option key={note.noteId} value={note.noteId}>
                      {note.hasLearnerContent ? `* ${note.title}` : note.title} · {note.logicalPath}
                    </option>
                  ))}
                </optgroup>
              </>
            ) : options.map((note) => (
              <option key={note.noteId} value={note.noteId}>
                {note.hasLearnerContent ? `* ${note.title}` : note.title} · {note.logicalPath}
              </option>
            ))}
          </select>
          <span className="sr-only" id="note-picker-key">
            Notes prefixed with an asterisk differ from their blank template.
          </span>
        </label>
        <button className="text-button" type="button" onClick={() => setShowCreate((current) => !current)}>
          {showCreate ? "Cancel new note" : "New quick note"}
        </button>
        <button
          className="outline-button note-vscode-button"
          type="button"
          disabled={!canOpenInVSCode || busy}
          title={saveStatus === "conflict"
            ? "Open the current on-disk Markdown version without resolving the browser draft"
            : canOpenInVSCode
              ? "Open this saved Markdown note"
              : "Wait for disk autosave before opening"}
          onClick={() => void openInVSCode()}
        >
          Open notes in VS Code
        </button>
      </div>
      {showCreate ? (
        <form
          className="quick-note-form"
          onSubmit={(event) => {
            event.preventDefault();
            void createQuickNote();
          }}
        >
          <label htmlFor="quick-note-name">Quick-note filename</label>
          <div className="quick-note-name-row">
            <code>{prefix}</code>
            <input
              id="quick-note-name"
              autoFocus
              value={name}
              maxLength={96}
              placeholder="model editing questions"
              onChange={(event) => setName(event.currentTarget.value)}
            />
            <code>.md</code>
          </div>
          <small>Will save as {proposedNoteId}.md. Reusing a name reopens the existing note.</small>
          <button className="primary-button" type="submit" disabled={!name.trim() || !slug || busy}>
            {busy ? "Opening…" : "Create and open"}
          </button>
        </form>
      ) : null}
      {error ? <p className="note-control-message error" role="alert">{error}</p> : null}
      {openResult ? <p className="note-control-message" role="status">{openResult}</p> : null}
    </div>
  );
}
