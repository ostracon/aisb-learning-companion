import { lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from "react-router-dom";
import type {
  AbandonUncertainTutorTurnResponseBody,
  BootstrapResponse,
  CurriculumSectionView,
  EventCurriculumBindingSnapshotResponse,
  LearningDayId,
  ScheduleEventView,
  ScheduleSnapshotResponse,
  SaveTutorContinuityRequestBody,
  TutorContinuitySelectionResponse,
  TutorContinuitySummaryView,
  TutorSessionScopeRequest,
} from "../shared/api.js";
import { isMealScheduleEvent } from "../shared/schedule.js";
import { EventMaterialLink } from "./components/EventMaterialLink.js";
import { OrphanedEventLinks } from "./components/OrphanedEventLinks.js";
import { ScheduleEditor } from "./components/ScheduleEditor.js";
import { ReviewPanel, reviewPanelScopeKey } from "./components/ReviewPanel.js";
import { WorkspaceLauncher } from "./components/WorkspaceLauncher.js";
import { NoteControls } from "./components/NoteControls.js";
import { MaterialReader } from "./components/MaterialReader.js";
import { NoteMarkdownEditor } from "./components/NoteMarkdownEditor.js";
import { TutorActiveTurnControls } from "./components/TutorActiveTurnControls.js";
import { TutorMessageContent } from "./components/TutorMessageContent.js";
import { CodexSelfTestPanel } from "./components/CodexSelfTestPanel.js";
import { DeferredRoute } from "./components/DeferredRoute.js";
import { UtilityBackLink } from "./components/UtilityBackLink.js";
import {
  captureClockSample,
  isSampleCurrent,
  resolveNowAnchor,
  type NowAnchor,
} from "./time/now-anchor.js";
import {
  useNoteDraft,
  type NoteCoordinationStatus,
  type NoteSaveStatus,
} from "./hooks/use-note-draft.js";
import { useLearningProgress } from "./hooks/use-learning-progress.js";
import { useLearningOutcomesDisclosure } from "./hooks/use-learning-outcomes-disclosure.js";
import { useWorkspaceLayout } from "./hooks/use-workspace-layout.js";
import {
  createWorkspaceScrollCarryState,
  useWorkspaceScrollRestoration,
} from "./hooks/use-workspace-scroll.js";
import { useTutorSession } from "./hooks/use-tutor-session.js";
import { curriculumSectionsForTodaySelection } from "./curriculum/today-sections.js";
import {
  materialHrefWithStudyNote,
  readStudyNoteOverride,
  studyNoteSelectionHref,
} from "./study-note-routing.js";

const PreparePage = lazy(async () => {
  const module = await import("./components/PreparePage.js");
  return { default: module.PreparePage };
});

const ManagerPage = lazy(async () => {
  const module = await import("./components/ManagerPage.js");
  return { default: module.ManagerPage };
});

const DayReviewPage = lazy(async () => {
  const module = await import("./components/DayReviewPage.js");
  return { default: module.DayReviewPage };
});

const VisualAidPage = lazy(async () => {
  const module = await import("./components/VisualAidPage.js");
  return { default: module.VisualAidPage };
});

const BackupPage = lazy(async () => {
  const module = await import("./components/BackupPage.js");
  return { default: module.BackupPage };
});

const bootstrapId = crypto.randomUUID();
const initialHistoryEntryId = (() => {
  const existing = window.history.state?.aisbHistoryEntryId as string | undefined;
  const value = existing ?? crypto.randomUUID();
  window.history.replaceState(
    { ...(window.history.state ?? {}), aisbHistoryEntryId: value, aisbBootstrapId: bootstrapId },
    "",
  );
  return value;
})();
const loadClockSample = captureClockSample(
  { now: () => new Date() },
  "load",
  initialHistoryEntryId,
  bootstrapId,
);

function formatProgrammeDate(date: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "Europe/London",
  }).format(new Date(`${date}T12:00:00+01:00`));
}

function formatEventTime(value: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Europe/London",
  }).format(new Date(value));
}

function writeAnchorToHistory(anchor: NowAnchor): void {
  window.history.replaceState(
    {
      ...(window.history.state ?? {}),
      aisbHistoryEntryId: anchor.historyEntryId,
      aisbBootstrapId: anchor.bootstrapId,
      aisbNowAnchor: anchor,
    },
    "",
  );
}

function ensureHistoryEntryId(): string {
  const existing = window.history.state?.aisbHistoryEntryId as string | undefined;
  if (existing) return existing;
  const created = crypto.randomUUID();
  window.history.replaceState(
    { ...(window.history.state ?? {}), aisbHistoryEntryId: created, aisbBootstrapId: bootstrapId },
    "",
  );
  return created;
}

function useCompactViewport(): boolean {
  const query = "(max-width: 58rem)";
  const [compact, setCompact] = useState(
    () => typeof window.matchMedia === "function" && window.matchMedia(query).matches,
  );

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(query);
    const update = () => setCompact(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return compact;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Reads the exact body of the first level-two `Reflection` section. Markdown
 * headings inside fenced code are ignored, and any real following heading ends
 * the section.
 */
export function extractReflectionBody(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  let reflectionStart = -1;
  let fence: { marker: "`" | "~"; length: number } | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      const sequence = fenceMatch[1]!;
      const marker = sequence[0] as "`" | "~";
      if (fence === null) {
        fence = { marker, length: sequence.length };
      } else if (fence.marker === marker && sequence.length >= fence.length) {
        fence = null;
      }
      continue;
    }
    if (fence !== null) continue;

    if (reflectionStart < 0) {
      if (/^ {0,3}##[ \t]+Reflection(?:[ \t]+#*)?[ \t]*$/i.test(line)) {
        reflectionStart = index + 1;
      }
      continue;
    }

    if (/^ {0,3}#{1,6}(?:[ \t]+|$)/.test(line)) {
      return lines.slice(reflectionStart, index).join("\n").trim();
    }
  }

  return reflectionStart < 0 ? "" : lines.slice(reflectionStart).join("\n").trim();
}

function isReflectionAutosaved(status: NoteSaveStatus): boolean {
  return ["saved-locally", "saving-disk", "saved-disk", "offline", "conflict"].includes(status);
}

function parseContinuitySelection(
  value: unknown,
  targetDayId: LearningDayId,
): TutorContinuitySelectionResponse {
  const payload = record(value);
  if (
    payload?.target_day_id !== targetDayId
    || typeof payload.total_text_bytes !== "number"
    || !Array.isArray(payload.summaries)
  ) {
    throw new Error("The continuity service returned malformed data");
  }
  for (const candidate of payload.summaries) {
    const summary = record(candidate);
    if (
      !summary
      || typeof summary.summary_id !== "string"
      || !isLearningDayId(typeof summary.source_day_id === "string" ? summary.source_day_id : undefined)
      || typeof summary.source_scope_key !== "string"
      || typeof summary.source_turn_id !== "string"
      || typeof summary.approved_at !== "string"
      || !Number.isFinite(Date.parse(summary.approved_at))
      || typeof summary.content_hash !== "string"
      || typeof summary.text !== "string"
    ) {
      throw new Error("The continuity service returned a malformed summary");
    }
  }
  return value as TutorContinuitySelectionResponse;
}

async function apiError(response: Response, fallback: string): Promise<Error> {
  try {
    const payload = record(await response.json());
    return new Error(typeof payload?.error === "string" ? payload.error : fallback);
  } catch {
    return new Error(fallback);
  }
}

export function NoteSaveControls({
  status,
  onRetry,
  onResolveConflict,
  diskRecoveryAvailable = false,
  onRecoverDiskFile,
}: {
  readonly status: NoteSaveStatus;
  readonly onRetry: () => void;
  readonly onResolveConflict?: (choice: "keep-local" | "use-disk") => void;
  readonly diskRecoveryAvailable?: boolean;
  readonly onRecoverDiskFile?: () => void;
}) {
  const canRetry = status === "offline" || status === "error";
  const presentation = status === "saved-disk"
    ? { label: "Saved to disk", tone: "saved" }
    : status === "saving-local" || status === "saved-locally" || status === "saving-disk"
      ? { label: "Saving note…", tone: "autosaving" }
      : status === "loading"
        ? { label: "Opening note…", tone: "pending" }
        : status === "view-only"
          ? { label: "View only", tone: "view-only" }
          : { label: status, tone: status };
  return (
    <div className={`note-save-controls ${status === "conflict" || diskRecoveryAvailable ? "needs-action" : ""}`.trim()}>
      <div className="note-save-summary">
        <span
          className={`note-status ${presentation.tone}`}
          data-save-state={status}
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <span className="status-dot" aria-hidden="true" />
          {presentation.label}
        </span>
        {canRetry && !diskRecoveryAvailable ? (
          <button
            className="text-button"
            type="button"
            onClick={onRetry}
            aria-label="Retry saving note to its Markdown file"
          >
            Retry save
          </button>
        ) : null}
      </div>
      {status === "conflict" && onResolveConflict ? (
        <div className="note-recovery-panel" role="alert">
          <p>
            <strong>Choose which note to continue with.</strong> The browser draft is already protected in local
            recovery storage. Keeping it rebases that text onto the latest Markdown revision; using the Markdown
            version first preserves the displaced browser text as a separate conflict copy.
          </p>
          <div className="note-recovery-actions">
            <button className="outline-button" type="button" onClick={() => onResolveConflict("keep-local")}>
              Keep browser draft
            </button>
            <button className="outline-button" type="button" onClick={() => onResolveConflict("use-disk")}>
              Use Markdown version
            </button>
          </div>
        </div>
      ) : null}
      {diskRecoveryAvailable && onRecoverDiskFile ? (
        <div className="note-recovery-panel" role="alert">
          <p>
            <strong>The Markdown file cannot be read.</strong> Restore its last valid saved snapshot. The current
            unreadable bytes will be preserved as a displaced copy before recovery.
          </p>
          <button className="outline-button" type="button" onClick={onRecoverDiskFile}>
            Recover last saved Markdown
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function useScopedComposerDraft(scopeKey: string | null): {
  readonly value: string;
  readonly setValue: (value: string) => void;
  readonly storageError: string | null;
} {
  const [initial] = useState(() => {
    if (scopeKey === null) {
      return { drafts: {} as Record<string, string>, errors: {} as Record<string, string> };
    }
    try {
      const saved = window.localStorage.getItem(tutorComposerStorageKey(scopeKey));
      return {
        drafts: saved === null ? {} : { [scopeKey]: saved },
        errors: {},
      };
    } catch {
      return {
        drafts: {},
        errors: {
          [scopeKey]: "Tutor draft recovery storage is unavailable. New text will remain only in this open page.",
        },
      };
    }
  });
  const [drafts, setDrafts] = useState<Record<string, string>>(initial.drafts);
  const [storageErrors, setStorageErrors] = useState<Record<string, string>>(initial.errors);
  const loadedScopesRef = useRef(new Set(scopeKey === null ? [] : [scopeKey]));

  useEffect(() => {
    if (scopeKey === null || loadedScopesRef.current.has(scopeKey)) return;
    loadedScopesRef.current.add(scopeKey);
    try {
      const saved = window.localStorage.getItem(tutorComposerStorageKey(scopeKey));
      if (saved !== null) {
        setDrafts((current) => current[scopeKey] === undefined
          ? { ...current, [scopeKey]: saved }
          : current);
      }
      setStorageErrors((current) => {
        if (current[scopeKey] === undefined) return current;
        const next = { ...current };
        delete next[scopeKey];
        return next;
      });
    } catch {
      setStorageErrors((current) => ({
        ...current,
        [scopeKey]: "Tutor draft recovery storage is unavailable. New text will remain only in this open page.",
      }));
    }
  }, [scopeKey]);

  const value = scopeKey === null ? "" : drafts[scopeKey] ?? "";
  const setValue = useCallback((nextValue: string) => {
    if (scopeKey === null) return;
    setDrafts((current) => {
      if ((current[scopeKey] ?? "") === nextValue) return current;
      if (nextValue === "") {
        const next = { ...current };
        delete next[scopeKey];
        return next;
      }
      return { ...current, [scopeKey]: nextValue };
    });
    try {
      const key = tutorComposerStorageKey(scopeKey);
      if (nextValue === "") window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, nextValue);
      setStorageErrors((current) => {
        if (current[scopeKey] === undefined) return current;
        const next = { ...current };
        delete next[scopeKey];
        return next;
      });
    } catch {
      setStorageErrors((current) => ({
        ...current,
        [scopeKey]: "Tutor draft could not be saved in browser recovery storage. Keep this page open; the current text is still held in memory.",
      }));
    }
  }, [scopeKey]);
  return {
    value,
    setValue,
    storageError: scopeKey === null ? null : storageErrors[scopeKey] ?? null,
  };
}

export function tutorComposerStorageKey(scopeKey: string): string {
  return `aisb-companion:tutor-composer:${scopeKey}`;
}

export function shouldRestoreUncertainTutorText(
  result: AbandonUncertainTutorTurnResponseBody | false,
): boolean {
  return result !== false && result.restore_text;
}

export function uncertainTutorComposerAction(
  result: AbandonUncertainTutorTurnResponseBody | false,
  routeIsCurrent: boolean,
): "restore" | "clear" | "leave" {
  if (result === false) return "leave";
  if (!result.restore_text) return "clear";
  return routeIsCurrent ? "restore" : "leave";
}

export function DisclosureInspector({
  disclosure,
  pending,
}: {
  readonly disclosure: unknown;
  readonly pending: Record<string, unknown>;
}) {
  const manifest = record(disclosure);
  const blocks = Array.isArray(manifest?.blocks)
    ? manifest.blocks
        .map(record)
        .filter((block): block is Record<string, unknown> => block !== null)
    : [];

  if (!manifest || blocks.length === 0) {
    return (
      <details className="context-inspector">
        <summary>Context for next send</summary>
        <pre>{JSON.stringify(pending, null, 2)}</pre>
      </details>
    );
  }

  const noteDisclosure = record(manifest.noteDisclosure);
  const toolBoundary = record(manifest.toolBoundary);
  const readableFiles = Array.isArray(toolBoundary?.readableFiles)
    ? toolBoundary.readableFiles.filter((value): value is string => typeof value === "string")
    : [];
  const protectedClasses = Array.isArray(toolBoundary?.protectedClasses)
    ? toolBoundary.protectedClasses.filter((value): value is string => typeof value === "string")
    : [];

  return (
    <details className="context-inspector">
      <summary>Context sent · {blocks.length} frozen blocks</summary>
      <div className="context-overview">
        <dl>
          <div><dt>Binding</dt><dd>{String(manifest.bindingHash ?? "unknown")}</dd></div>
          <div><dt>Snapshot</dt><dd>{String(manifest.snapshotId ?? "unknown")}</dd></div>
          <div>
            <dt>Live note</dt>
            <dd>
              {String(noteDisclosure?.mode ?? "unknown")} · {String(noteDisclosure?.includedUtf8Bytes ?? 0)} bytes included
            </dd>
          </div>
        </dl>
        <div className="context-block-list">
          {blocks.map((block, index) => (
            <details className="context-block" key={String(block.blockId ?? index)}>
              <summary>
                <span>{String(block.title ?? block.kind ?? `Block ${index + 1}`)}</span>
                <small>{String(block.kind ?? "context")} · {String(block.utf8Bytes ?? 0)} bytes</small>
              </summary>
              <pre>{String(block.content ?? "")}</pre>
            </details>
          ))}
        </div>
        <details className="context-boundary">
          <summary>Readable and protected paths</summary>
          <div>
            <strong>Readable</strong>
            <ul>{readableFiles.map((path) => <li key={path}>{path}</li>)}</ul>
            <strong>Protected</strong>
            <ul>{protectedClasses.map((pathClass) => <li key={pathClass}>{pathClass}</li>)}</ul>
          </div>
        </details>
        <details className="context-boundary">
          <summary>Raw disclosure manifest</summary>
          <pre>{JSON.stringify(manifest, null, 2)}</pre>
        </details>
        <details className="context-boundary">
          <summary>Context for next send</summary>
          <pre>{JSON.stringify(pending, null, 2)}</pre>
        </details>
      </div>
    </details>
  );
}

type ContinuitySaveState = "idle" | "saving" | "saved" | "error";

function continuitySummaryLabel(summary: TutorContinuitySummaryView): string {
  const day = `Day ${summary.source_day_id.slice(3)}`;
  if (summary.source_scope_key.startsWith("study:section:")) {
    return `${day} · ${summary.source_scope_key.slice("study:section:".length)}`;
  }
  if (summary.source_scope_key.startsWith("event:")) return `${day} · calendar session`;
  return `${day} · daily reflection`;
}

export function TutorContinuityControls({
  reflection,
  noteStatus,
  completedTurnId,
  summaries,
  selectedSummaryIds,
  loading,
  loadError,
  saveState,
  saveError,
  sending,
  reflectionSaveBlockedReason = null,
  onSave,
  onToggle,
}: {
  readonly reflection: string;
  readonly noteStatus: NoteSaveStatus;
  readonly completedTurnId: string | null;
  readonly summaries: readonly TutorContinuitySummaryView[];
  readonly selectedSummaryIds: readonly string[];
  readonly loading: boolean;
  readonly loadError: string | null;
  readonly saveState: ContinuitySaveState;
  readonly saveError: string | null;
  readonly sending: boolean;
  readonly reflectionSaveBlockedReason?: string | null;
  readonly onSave: () => void;
  readonly onToggle: (summaryId: string, selected: boolean) => void;
}) {
  const selected = new Set(selectedSummaryIds);
  const reflectionReady = reflection.length > 0;
  const autosaved = isReflectionAutosaved(noteStatus);
  const canSave = reflectionSaveBlockedReason === null
    && completedTurnId !== null
    && reflectionReady
    && autosaved
    && saveState !== "saving";
  const saveGuidance = reflectionSaveBlockedReason !== null
    ? reflectionSaveBlockedReason
    : completedTurnId === null
    ? "Complete a tutor exchange before approving a reflection."
    : !reflectionReady
      ? "Add a short reflection beneath the note’s ## Reflection heading."
      : !autosaved
        ? "Waiting for the current note to finish its local autosave."
        : saveState === "saving"
          ? "Saving the exact reflection to local continuity storage…"
        : saveState === "saved"
          ? "Saved locally. It will be available as continuity on a later day."
          : saveError ?? "Saving creates a local learner-approved summary; it is not sent to a model.";

  return (
    <details className="continuity-controls">
      <summary>
        <span>Continuity</span>
        <small>
          {selectedSummaryIds.length > 0
            ? `${selectedSummaryIds.length} selected for next send`
            : "Local summaries · none selected"}
        </small>
      </summary>
      <div className="continuity-body">
        <section aria-labelledby="continuity-save-heading">
          <div className="continuity-section-heading">
            <h3 id="continuity-save-heading">Save this reflection</h3>
            <button
              className="text-button"
              type="button"
              disabled={!canSave}
              onClick={onSave}
            >
              {saveState === "saving" ? "Saving…" : "Save ## Reflection locally"}
            </button>
          </div>
          <p
            className={`continuity-guidance ${saveState === "error" ? "failed" : ""}`.trim()}
            role="status"
            aria-live="polite"
          >
            {saveGuidance}
          </p>
        </section>

        <section aria-labelledby="continuity-select-heading">
          <h3 id="continuity-select-heading">Use earlier reflections</h3>
          <p className="continuity-disclosure" id="continuity-send-disclosure">
            Nothing is selected automatically. Checking a summary sends its exact text with your next tutor message to Codex/OpenAI.
          </p>
          {loading ? <p className="continuity-guidance" role="status">Loading local summaries…</p> : null}
          {loadError ? <p className="continuity-guidance failed" role="alert">{loadError}</p> : null}
          {!loading && !loadError && summaries.length === 0 ? (
            <p className="continuity-guidance">No approved reflections from an earlier day yet.</p>
          ) : null}
          {summaries.length > 0 ? (
            <ul className="continuity-summary-list">
              {summaries.map((summary) => {
                const isSelected = selected.has(summary.summary_id);
                const atLimit = !isSelected && selectedSummaryIds.length >= 3;
                return (
                  <li key={summary.summary_id}>
                    <label className="continuity-summary-choice">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        disabled={sending || atLimit}
                        aria-describedby="continuity-send-disclosure"
                        onChange={(event) => onToggle(summary.summary_id, event.currentTarget.checked)}
                      />
                      <span>
                        <strong>{continuitySummaryLabel(summary)}</strong>
                        <small>
                          Approved {new Intl.DateTimeFormat("en-GB", {
                            day: "numeric",
                            month: "short",
                            hour: "2-digit",
                            minute: "2-digit",
                            timeZone: "Europe/London",
                          }).format(new Date(summary.approved_at))}
                        </small>
                      </span>
                    </label>
                    <details className="continuity-summary-text">
                      <summary>Read exact summary</summary>
                      <pre>{summary.text}</pre>
                    </details>
                  </li>
                );
              })}
            </ul>
          ) : null}
          {selectedSummaryIds.length >= 3 ? (
            <p className="continuity-guidance">Three summaries is the per-message limit.</p>
          ) : null}
        </section>
      </div>
    </details>
  );
}

function useBootstrap(): { data: BootstrapResponse | null; error: string | null } {
  const [data, setData] = useState<BootstrapResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/bootstrap", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Bootstrap failed (${response.status})`);
        return (await response.json()) as BootstrapResponse;
      })
      .then(setData)
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Bootstrap failed");
      });
    return () => controller.abort();
  }, []);
  return { data, error };
}

function AppRoutes({ data }: { data: BootstrapResponse }) {
  const [eventCurriculumBindings, setEventCurriculumBindings] = useState(
    () => data.eventCurriculumBindings,
  );
  const workspaceProps = {
    data,
    eventCurriculumBindings,
    onEventCurriculumBindingsChanged: setEventCurriculumBindings,
  };
  return (
    <Routes>
      <Route path="/" element={<WorkspacePage {...workspaceProps} autoOrient />} />
      <Route path="/day/:dayId" element={<WorkspacePage {...workspaceProps} />} />
      <Route path="/day/:dayId/event/:eventId" element={<WorkspacePage {...workspaceProps} />} />
      <Route path="/day/:dayId/review" element={<DeferredRoute><DayReviewPage /></DeferredRoute>} />
      <Route path="/notes/:noteId" element={<WorkspacePage {...workspaceProps} />} />
      <Route path="/study/:dayId" element={<WorkspacePage {...workspaceProps} viewMode="study" />} />
      <Route path="/study/:dayId/section/:sectionId" element={<WorkspacePage {...workspaceProps} viewMode="study" />} />
      <Route path="/study/:dayId/section/:sectionId/document/:documentId" element={<WorkspacePage {...workspaceProps} viewMode="study" />} />
      <Route path="/prepare" element={<DeferredRoute><PreparePage /></DeferredRoute>} />
      <Route path="/manager" element={<DeferredRoute><ManagerPage /></DeferredRoute>} />
      <Route
        path="/visuals"
        element={(
          <DeferredRoute>
            <VisualAidPage available={data.diagnostics.imageGeneration.available} />
          </DeferredRoute>
        )}
      />
      <Route path="/backup" element={<DeferredRoute><BackupPage /></DeferredRoute>} />
      <Route path="/diagnostics" element={<DiagnosticsPage data={data} />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function DiagnosticsPage({ data }: { data: BootstrapResponse }) {
  const items = [
    ["Node runtime", data.diagnostics.nodeVersion],
    ["Companion repository", data.diagnostics.companionRoot],
    ["AISB repository", data.diagnostics.aisbRoot],
    ["AISB HEAD", data.diagnostics.aisbHead ?? "Unavailable"],
    ["Local state", data.diagnostics.stateRoot],
    ["Codex App Server", data.diagnostics.codex.version ?? data.diagnostics.codex.detail],
    ["Image generation", data.diagnostics.imageGeneration.detail],
  ] as const;
  return (
    <main className="diagnostics-page">
      <div className="diagnostics-content">
        <div className="diagnostics-topline">
          <p className="page-kicker">Local diagnostics</p>
          <UtilityBackLink />
        </div>
        <h1 className="page-title">The boundaries are visible.</h1>
        <p className="page-subtitle">
          Runtime state and learner notes stay in owner-only companion storage. AISB supplies the curriculum;
          protected answer sources remain outside tutor context.
        </p>
        <div className="rule" />
        <dl className="diagnostic-list">
          {items.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        <CodexSelfTestPanel />
      </div>
    </main>
  );
}

export function App() {
  const { data, error } = useBootstrap();
  if (error) {
    return (
      <main className="app-error">
        <div>
          <p className="page-kicker">Local service unavailable</p>
          <h1>The notebook could not open.</h1>
          <p>{error}</p>
        </div>
      </main>
    );
  }
  if (!data) return <main className="app-loading">Opening the field notebook…</main>;
  return <AppRoutes data={data} />;
}

function isLearningDayId(value: string | undefined): value is LearningDayId {
  return Boolean(value && /^day[0-7]$/.test(value));
}

const DAY_ZERO = Object.freeze({
  dayId: "day0" as const,
  date: null,
  curriculumKind: "preparation" as const,
  title: "Day 0 · Preparation",
});

interface NotesWorkspaceProps {
  readonly dayId: LearningDayId;
  readonly scopeMode: "today" | "study";
  readonly noteId: string;
  readonly note: {
    readonly value: string;
    readonly status: NoteSaveStatus;
    readonly error: string | null;
    readonly baseRevision: number;
    readonly baseContentHash: string;
    readonly logicalPath: string;
    readonly diskRecoveryAvailable: boolean;
    readonly canEdit: boolean;
    readonly coordinationStatus: NoteCoordinationStatus;
    readonly coordinationError: string | null;
    readonly updateValue: (value: string) => void;
    readonly retryDiskSave: () => void;
    readonly resolveConflict: (choice: "keep-local" | "use-disk") => void;
    readonly recoverDiskFile: () => void;
    readonly retryCoordination: () => void;
  };
  readonly sections: readonly CurriculumSectionView[];
  readonly availableNoteSectionIds: readonly string[];
  readonly onOpenNote: (noteId: string, routePath: string) => void;
  readonly tutorContextStatus: string;
  readonly className?: string;
}

function NotesWorkspace({
  dayId,
  scopeMode,
  noteId,
  note,
  sections,
  availableNoteSectionIds,
  onOpenNote,
  tutorContextStatus,
  className = "",
}: NotesWorkspaceProps) {
  return (
    <section className={`notes-section ${className}`.trim()} aria-labelledby="notes-heading">
      <div className="section-heading-row note-heading-row">
        <h2 id="notes-heading">Notes</h2>
        <NoteSaveControls
          status={note.status}
          onRetry={note.retryDiskSave}
          onResolveConflict={note.resolveConflict}
          diskRecoveryAvailable={note.diskRecoveryAvailable}
          onRecoverDiskFile={note.recoverDiskFile}
        />
      </div>
      <NoteControls
        dayId={dayId}
        scopeMode={scopeMode}
        sectionIds={availableNoteSectionIds}
        currentNoteId={noteId}
        currentRevision={note.baseRevision}
        currentContentHash={note.baseContentHash}
        saveStatus={note.status}
        onOpenNote={onOpenNote}
      />
      {note.coordinationStatus === "editing" ? null : (
        <div
          className={`note-coordination-notice ${note.coordinationStatus}`}
          id="note-coordination-status"
          role={note.coordinationStatus === "coordination-error" ? "alert" : "status"}
          aria-live="polite"
        >
          <span>
            {note.coordinationStatus === "viewing-other-tab"
              ? "Open in another tab · view only. This tab will become editable when that editor closes."
              : note.coordinationStatus === "reconciling"
                ? "Recovering the latest local draft before editing…"
                : note.coordinationStatus === "coordination-error"
                  ? note.coordinationError ?? "Safe multi-tab editing is unavailable. This copy is view-only."
                  : "Checking whether this note is already open for editing…"}
          </span>
          {note.coordinationStatus === "coordination-error" ? (
            <button className="text-button" type="button" onClick={note.retryCoordination}>
              Retry
            </button>
          ) : null}
        </div>
      )}
      <div className={`note-editor-frame ${note.canEdit ? "" : "view-only"}`.trim()}>
        <NoteMarkdownEditor
          key={noteId}
          value={note.value}
          readOnly={!note.canEdit}
          describedBy={note.canEdit ? undefined : "note-coordination-status"}
          onChange={note.updateValue}
        />
      </div>
      <div className="note-footer">
        <span className={note.error ? "note-error" : ""} role={note.error ? "alert" : undefined}>
          {note.error ?? (note.logicalPath || "Preparing Markdown path…")}
        </span>
        <span>{tutorContextStatus}</span>
      </div>
      {sections.length > 0 ? <WorkspaceLauncher key={sections.map((section) => section.sectionId).join(":")} sections={sections} /> : null}
    </section>
  );
}

function WorkspacePage({
  data,
  eventCurriculumBindings,
  onEventCurriculumBindingsChanged,
  autoOrient = false,
  viewMode = "today",
}: {
  data: BootstrapResponse;
  eventCurriculumBindings: EventCurriculumBindingSnapshotResponse;
  onEventCurriculumBindingsChanged: (snapshot: EventCurriculumBindingSnapshotResponse) => void;
  autoOrient?: boolean;
  viewMode?: "today" | "study";
}) {
  const params = useParams<{
    dayId?: string;
    eventId?: string;
    noteId?: string;
    sectionId?: string;
    documentId?: string;
  }>();
  const location = useLocation();
  const navigate = useNavigate();
  const { layout, dispatch } = useWorkspaceLayout();
  const layoutIdentity = [
    layout.panels.navigation,
    layout.panels.schedule,
    layout.panels.tutor,
    layout.focusNotes,
  ].join(":");
  const workspaceScroll = useWorkspaceScrollRestoration(location, layoutIdentity);
  const compactViewport = useCompactViewport();
  const navigationPanelRef = useRef<HTMLDivElement>(null);
  const tutorPanelRef = useRef<HTMLDivElement>(null);
  const navigationPanelButtonRef = useRef<HTMLButtonElement>(null);
  const tutorPanelButtonRef = useRef<HTMLButtonElement>(null);
  const navigationEdgeButtonRef = useRef<HTMLButtonElement>(null);
  const tutorEdgeButtonRef = useRef<HTMLButtonElement>(null);
  const pageHeadingRef = useRef<HTMLHeadingElement>(null);
  const mobilePanelReturnFocusRef = useRef<HTMLElement | null>(null);
  const previousPathRef = useRef(location.pathname);
  const messageListRef = useRef<HTMLDivElement>(null);
  const messageTailRef = useRef<HTMLDivElement>(null);
  const keepMessageTailVisibleRef = useRef(true);
  const [schedule, setSchedule] = useState<ScheduleSnapshotResponse>(() => ({
    runtimeSchedule: data.runtimeSchedule,
    scheduleRevision: data.scheduleRevision,
    programmeTimeZone: data.programmeTimeZone,
    programmeDays: data.programmeDays,
    events: data.events,
  }));
  const [mobilePanel, setMobilePanel] = useState<"navigation" | "tutor" | null>(null);
  const restoredAnchorCandidate = window.history.state?.aisbNowAnchor as NowAnchor | undefined;
  // A full reload creates a new bootstrap identity and is an explicit request to
  // sample the clock again. SPA back/forward entries keep their frozen anchor.
  const restoredAnchor = restoredAnchorCandidate?.bootstrapId === bootstrapId
    ? restoredAnchorCandidate
    : undefined;
  const [anchor, setAnchor] = useState<NowAnchor | null>(restoredAnchor ?? null);
  const [showMealBreaks, setShowMealBreaks] = useState(false);
  const hasAutoOriented = useRef(false);
  const isStudy = viewMode === "study";

  useEffect(() => {
    if (anchor) return;
    if (
      !isSampleCurrent(loadClockSample, {
        historyEntryId: window.history.state?.aisbHistoryEntryId as string,
        bootstrapId: window.history.state?.aisbBootstrapId as string,
      })
    ) {
      return;
    }
    const resolved = resolveNowAnchor(loadClockSample, schedule.runtimeSchedule, "Europe/London");
    setAnchor(resolved);
    writeAnchorToHistory(resolved);
  }, [anchor, schedule.runtimeSchedule]);

  useEffect(() => {
    if (anchor) writeAnchorToHistory(anchor);
  }, [anchor, location.key]);

  useEffect(() => {
    if (isStudy || !autoOrient || !anchor || hasAutoOriented.current) return;
    hasAutoOriented.current = true;
    if (anchor.programmeDayId) {
      const target = anchor.primaryEventBindingId
        ? `/day/${anchor.programmeDayId}/event/${anchor.primaryEventBindingId}`
        : `/day/${anchor.programmeDayId}`;
      navigate(target, { replace: true });
    }
  }, [anchor, autoOrient, isStudy, navigate]);

  useEffect(() => {
    const historyEntryId = ensureHistoryEntryId();
    const restored = window.history.state?.aisbNowAnchor as NowAnchor | undefined;
    if (restored?.historyEntryId === historyEntryId) {
      setAnchor(restored);
      return;
    }
    if (anchor) {
      const rebound = { ...anchor, historyEntryId };
      setAnchor(rebound);
      writeAnchorToHistory(rebound);
    }
  }, [location.key]);

  useEffect(() => {
    if (previousPathRef.current === location.pathname) return;
    previousPathRef.current = location.pathname;
    if (mobilePanel === null) return;
    setMobilePanel(null);
    window.requestAnimationFrame(() => pageHeadingRef.current?.focus({ preventScroll: true }));
  }, [location.pathname, mobilePanel]);

  useEffect(() => {
    if (compactViewport) return;
    setMobilePanel(null);
  }, [compactViewport]);

  useEffect(() => {
    if (!compactViewport || mobilePanel === null) return;
    const panel = mobilePanel === "navigation" ? navigationPanelRef.current : tutorPanelRef.current;
    const firstControl = mobilePanel === "navigation"
      ? navigationPanelButtonRef.current
      : tutorPanelButtonRef.current;
    const frame = window.requestAnimationFrame(() => firstControl?.focus());

    const focusableSelector = [
      "a[href]",
      "button:not([disabled])",
      "input:not([disabled])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      "summary",
      "[tabindex]:not([tabindex='-1'])",
    ].join(",");
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        const returnTarget = mobilePanelReturnFocusRef.current;
        setMobilePanel(null);
        window.requestAnimationFrame(() => returnTarget?.focus());
        return;
      }
      if (event.key !== "Tab" || !panel) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(focusableSelector))
        .filter((element) => !element.hasAttribute("disabled") && element.getClientRects().length > 0);
      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (!panel.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [compactViewport, mobilePanel]);

  const routeDayId = isLearningDayId(params.dayId) ? params.dayId : null;
  const noteDayCandidate = params.noteId?.match(/^(day[0-7])_quicknote_/)?.[1];
  const noteDayId = isLearningDayId(noteDayCandidate) ? noteDayCandidate : null;
  const firstRepositoryDayId = (Object.entries(data.repositorySectionsByDay)
    .find(([, daySections]) => (daySections?.length ?? 0) > 0)?.[0] ?? "day0") as LearningDayId;
  const selectedDayId: LearningDayId = routeDayId
    ?? noteDayId
    ?? (isStudy ? firstRepositoryDayId : anchor?.programmeDayId)
    ?? schedule.programmeDays[0]?.dayId
    ?? "day1";
  const selectedScheduleDay = selectedDayId === "day0"
    ? null
    : schedule.programmeDays.find((day) => day.dayId === selectedDayId) ?? schedule.programmeDays[0]!;
  const selectedDay = selectedDayId === "day0" ? DAY_ZERO : selectedScheduleDay!;
  const events = selectedDayId === "day0"
    ? []
    : schedule.events.filter((event) => event.programmeDayId === selectedDayId);
  const selectedEventId = params.eventId ?? null;
  const selectedEvent = events.find((event) => event.eventBindingId === selectedEventId) ?? null;
  const mealEvents = events.filter(isMealScheduleEvent);
  const learningEvents = events.filter((event) => !isMealScheduleEvent(event));
  const visibleEvents = showMealBreaks
    ? events
    : events.filter(
        (event) =>
          !isMealScheduleEvent(event) || event.eventBindingId === selectedEvent?.eventBindingId,
      );
  const scheduleActiveEventId = selectedEventId ?? anchor?.primaryEventBindingId ?? null;
  const daySections = (isStudy
    ? data.repositorySectionsByDay[selectedDayId]
    : data.sectionsByDay[selectedDayId]) ?? [];
  const selectedEventBinding = selectedEvent === null
    ? null
    : eventCurriculumBindings.bindings.find(
        (binding) => binding.eventBindingId === selectedEvent.eventBindingId,
      ) ?? null;
  const showEventMaterialLink = selectedEvent !== null && (
    (selectedEvent.status === "scheduled" && !isMealScheduleEvent(selectedEvent)) ||
    selectedEventBinding !== null
  );
  const selectedEventLinkedSections = curriculumSectionsForTodaySelection(
    daySections,
    selectedEvent?.eventBindingId ?? null,
    eventCurriculumBindings,
  );
  const selectedSection = isStudy
    ? daySections.find((section) => section.sectionId === params.sectionId) ?? null
    : null;
  const sections = isStudy
    ? selectedSection === null ? [] : [selectedSection]
    : selectedEventLinkedSections;
  const outcomes = sections.flatMap((section) => section.outcomes.map((outcome) => ({ section, outcome })));
  const defaultNoteId = isStudy && selectedSection
    ? `lesson-${selectedSection.sectionId}`
    : selectedEvent
      ? `event-${selectedEvent.eventBindingId}`
      : `day-${selectedDayId}`;
  const studyNoteOverride = isStudy
    ? readStudyNoteOverride(
        location.search,
        selectedDayId,
        daySections.map((section) => section.sectionId),
        defaultNoteId,
      )
    : { noteId: null, shouldCanonicalize: false };
  const noteId = params.noteId ?? studyNoteOverride.noteId ?? defaultNoteId;
  const noteTitle = params.noteId
    ? "Standalone note"
    : studyNoteOverride.noteId
      ? "Selected Study note"
    : isStudy && selectedSection
      ? `${selectedSection.sectionId} · ${selectedSection.title}`
    : selectedEvent
      ? `${selectedEvent.title} · ${selectedDay.title}`
      : selectedDay.date === null
        ? selectedDay.title
        : `${selectedDay.title} · ${formatProgrammeDate(selectedDay.date)}`;
  const note = useNoteDraft(noteId, noteTitle, {
    openExistingOnly: isStudy && studyNoteOverride.noteId !== null,
  });

  useEffect(() => {
    if (!isStudy || !studyNoteOverride.shouldCanonicalize) return;
    navigate(studyNoteSelectionHref(location, defaultNoteId, defaultNoteId), { replace: true });
  }, [defaultNoteId, isStudy, location, navigate, studyNoteOverride.shouldCanonicalize]);
  const [showAllOutcomes, setShowAllOutcomes] = useState(false);
  const outcomesDisclosure = useLearningOutcomesDisclosure();
  const outcomesExpanded = outcomesDisclosure.expanded;
  const [assistantMode, setAssistantMode] = useState<"tutor" | "review">("tutor");
  const learningProgress = useLearningProgress();
  const [studyMaterialContext, setStudyMaterialContext] = useState<{
    readonly sectionId: string;
    readonly documentId: string;
    readonly manifestRevision: string;
    readonly title: string;
    readonly accessClassification: "tutor_readable" | "human_reader_only";
    readonly contentHash: string;
  } | null>(null);
  const studyContextReady = !isStudy || (
    selectedSection !== null &&
    params.documentId !== undefined &&
    studyMaterialContext?.sectionId === selectedSection.sectionId &&
    studyMaterialContext.documentId === params.documentId
  );
  const tutorAvailable = params.noteId === undefined && studyContextReady;
  const tutorNoteReady = note.loadedNoteId === noteId;
  const tutorCanSend = tutorAvailable && tutorNoteReady;
  const tutorScope = useMemo<TutorSessionScopeRequest | null>(() => {
    if (!tutorAvailable) return null;
    if (isStudy) {
      if (selectedSection === null) return null;
      return {
        context_mode: "study",
        day_id: selectedDayId,
        event_binding_id: null,
        section_id: selectedSection.sectionId,
      };
    }
    return {
      context_mode: "today",
      day_id: selectedDayId,
      event_binding_id: selectedEvent?.eventBindingId ?? null,
      section_id: null,
    };
  }, [isStudy, selectedDayId, selectedEvent?.eventBindingId, selectedSection, tutorAvailable]);
  const tutorSession = useTutorSession({
    enabled: tutorAvailable,
    scope: tutorScope,
  });
  const messages = tutorSession.messages;
  const sending = tutorSession.sending;
  const tutorIsWorking = sending || tutorSession.activeTurn !== null;
  const tutorEntryLocked = tutorSession.loading
    || tutorIsWorking
    || tutorSession.unresolvedMessage !== null
    || tutorSession.settledSubmission !== null;
  const tutorScopeIdentity = useMemo(() => {
    if (tutorScope === null) return null;
    if (tutorScope.context_mode === "study") return `study:section:${tutorScope.section_id}`;
    return tutorScope.event_binding_id === null
      ? `day:${tutorScope.day_id}`
      : `event:${tutorScope.event_binding_id}`;
  }, [tutorScope]);
  const {
    value: composer,
    setValue: setComposer,
    storageError: composerStorageError,
  } = useScopedComposerDraft(tutorScopeIdentity);
  const [continuitySummaries, setContinuitySummaries] = useState<readonly TutorContinuitySummaryView[]>([]);
  const [selectedContinuityIds, setSelectedContinuityIds] = useState<readonly string[]>([]);
  const [continuityLoading, setContinuityLoading] = useState(false);
  const [continuityLoadError, setContinuityLoadError] = useState<string | null>(null);
  const [continuitySaveState, setContinuitySaveState] = useState<ContinuitySaveState>("idle");
  const [continuitySaveError, setContinuitySaveError] = useState<string | null>(null);
  const continuityLoadGeneration = useRef(0);
  const continuitySaveGeneration = useRef(0);
  const reflection = useMemo(() => extractReflectionBody(note.value), [note.value]);
  const latestCompletedAssistant = useMemo(
    () => messages.findLast(
      (message) => message.role === "assistant" && message.status === "completed" && message.turn_id !== null,
    ) ?? null,
    [messages],
  );
  const replyCount = messages.filter(
    (message) => message.role === "assistant" && message.status === "completed",
  ).length;
  const completedOutcomeCount = outcomes.reduce(
    (count, { outcome }) => count + Number(learningProgress.isCompleted(outcome.outcomeId, outcome.versionId)),
    0,
  );

  useEffect(() => {
    keepMessageTailVisibleRef.current = true;
  }, [tutorScopeIdentity]);

  useEffect(() => {
    if (!keepMessageTailVisibleRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      messageTailRef.current?.scrollIntoView?.({ block: "end" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [assistantMode, messages.length, sending, tutorSession.error, tutorSession.loading, tutorScopeIdentity]);

  useEffect(() => {
    const settled = tutorSession.settledSubmission;
    if (settled === null) return;
    if (settled.clearDraft && composer === settled.learnerText) setComposer("");
    tutorSession.acknowledgeSettledSubmission(settled.clientMessageId);
  }, [composer, setComposer, tutorSession.acknowledgeSettledSubmission, tutorSession.settledSubmission]);

  useEffect(() => {
    continuitySaveGeneration.current += 1;
    setContinuitySaveState("idle");
    setContinuitySaveError(null);
  }, [reflection, tutorScopeIdentity]);

  useEffect(() => {
    const generation = ++continuityLoadGeneration.current;
    const controller = new AbortController();
    setSelectedContinuityIds([]);
    setContinuityLoadError(null);

    if (!tutorAvailable || tutorScopeIdentity === null) {
      setContinuityLoading(false);
      setContinuitySummaries([]);
      return () => controller.abort();
    }

    setContinuityLoading(true);
    void fetch(`/api/tutor/continuity?target_day_id=${encodeURIComponent(selectedDayId)}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw await apiError(response, "Could not read local continuity summaries");
        return parseContinuitySelection(await response.json(), selectedDayId);
      })
      .then((selection) => {
        if (generation !== continuityLoadGeneration.current) return;
        setContinuitySummaries(selection.summaries);
        setContinuityLoading(false);
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted || generation !== continuityLoadGeneration.current) return;
        setContinuitySummaries([]);
        setContinuityLoading(false);
        setContinuityLoadError(
          reason instanceof Error ? reason.message : "Could not read local continuity summaries",
        );
      });

    return () => controller.abort();
  }, [selectedDayId, tutorAvailable, tutorScopeIdentity]);

  const syncToNow = () => {
    const entryId = (window.history.state?.aisbHistoryEntryId as string | undefined) ?? crypto.randomUUID();
    const sample = captureClockSample({ now: () => new Date() }, "button", entryId, bootstrapId);
    const resolved = resolveNowAnchor(sample, schedule.runtimeSchedule, "Europe/London");
    setAnchor(resolved);
    writeAnchorToHistory(resolved);
    if (resolved.programmeDayId) {
      const target = resolved.primaryEventBindingId
        ? `/day/${resolved.programmeDayId}/event/${resolved.primaryEventBindingId}`
        : `/day/${resolved.programmeDayId}`;
      navigate(target, { replace: true });
    }
  };

  const applyScheduleSnapshot = (snapshot: ScheduleSnapshotResponse, focusedEventId?: string) => {
    setSchedule(snapshot);
    const targetEventId = focusedEventId ?? selectedEventId;
    if (!targetEventId) return;
    const targetEvent = snapshot.events.find((event) => event.eventBindingId === targetEventId);
    if (!targetEvent?.programmeDayId) {
      navigate(`/day/${selectedDayId}`, { replace: true });
      return;
    }
    const target = `/day/${targetEvent.programmeDayId}/event/${targetEvent.eventBindingId}`;
    if (target !== location.pathname) navigate(target, { replace: Boolean(selectedEventId) });
  };

  const toggleNavigation = () => {
    if (compactViewport) {
      if (mobilePanel === "navigation") {
        const returnTarget = mobilePanelReturnFocusRef.current;
        setMobilePanel(null);
        window.requestAnimationFrame(() => returnTarget?.focus());
      } else {
        mobilePanelReturnFocusRef.current = document.activeElement instanceof HTMLElement
          ? document.activeElement
          : navigationEdgeButtonRef.current;
        setMobilePanel("navigation");
      }
      return;
    }
    const expanding = !layout.panels.navigation || layout.focusNotes;
    dispatch({ type: "toggle-panel", panel: "navigation" });
    window.requestAnimationFrame(() => {
      (expanding ? navigationPanelButtonRef.current : navigationEdgeButtonRef.current)?.focus();
    });
  };

  const toggleTutor = () => {
    if (compactViewport) {
      if (mobilePanel === "tutor") {
        const returnTarget = mobilePanelReturnFocusRef.current;
        setMobilePanel(null);
        window.requestAnimationFrame(() => returnTarget?.focus());
      } else {
        mobilePanelReturnFocusRef.current = document.activeElement instanceof HTMLElement
          ? document.activeElement
          : tutorEdgeButtonRef.current;
        setMobilePanel("tutor");
      }
      return;
    }
    const expanding = !layout.panels.tutor || layout.focusNotes;
    dispatch({ type: "toggle-panel", panel: "tutor" });
    window.requestAnimationFrame(() => {
      (expanding ? tutorPanelButtonRef.current : tutorEdgeButtonRef.current)?.focus();
    });
  };

  const toggleContinuitySummary = (summaryId: string, selected: boolean) => {
    if (sending) return;
    setSelectedContinuityIds((current) => {
      if (!selected) return current.filter((candidate) => candidate !== summaryId);
      if (
        current.includes(summaryId)
        || current.length >= 3
        || !continuitySummaries.some((summary) => summary.summary_id === summaryId)
      ) {
        return current;
      }
      return [...current, summaryId];
    });
  };

  const saveContinuityReflection = () => {
    const sourceTurnId = latestCompletedAssistant?.turn_id;
    const sourceScope = tutorScope;
    if (
      sourceScope === null
      || sourceTurnId === null
      || sourceTurnId === undefined
      || reflection.length === 0
      || !isReflectionAutosaved(note.status)
      || (isStudy && studyNoteOverride.noteId !== null)
      || continuitySaveState === "saving"
    ) {
      return;
    }

    const generation = ++continuitySaveGeneration.current;
    const request: SaveTutorContinuityRequestBody = {
      source_scope: sourceScope,
      source_turn_id: sourceTurnId,
      text: reflection,
    };
    setContinuitySaveState("saving");
    setContinuitySaveError(null);
    void fetch("/api/tutor/continuity", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    })
      .then(async (response) => {
        if (!response.ok) throw await apiError(response, "Could not save the reflection locally");
        const saved = record(await response.json());
        if (typeof saved?.summary_id !== "string" || saved.source_turn_id !== sourceTurnId) {
          throw new Error("The continuity service returned malformed save data");
        }
      })
      .then(() => {
        if (generation !== continuitySaveGeneration.current) return;
        setContinuitySaveState("saved");
      })
      .catch((reason: unknown) => {
        if (generation !== continuitySaveGeneration.current) return;
        setContinuitySaveState("error");
        setContinuitySaveError(
          reason instanceof Error ? reason.message : "Could not save the reflection locally",
        );
      });
  };

  const sendTutorMessage = () => {
    const learnerText = composer;
    if (!learnerText.trim() || tutorEntryLocked || !tutorCanSend) return;
    if (isStudy && (selectedSection === null || studyMaterialContext === null)) return;
    keepMessageTailVisibleRef.current = true;
    const requestIds = isStudy
      ? {
          context_mode: "study" as const,
          route_path: location.pathname,
          day_id: selectedDayId,
          event_binding_id: null,
          section_id: selectedSection!.sectionId,
          document_id: studyMaterialContext!.documentId,
          material_manifest_revision: studyMaterialContext!.manifestRevision,
          history_entry_id: ensureHistoryEntryId(),
          active_tab: "notes" as const,
        }
      : {
          context_mode: "today" as const,
          route_path: location.pathname,
          day_id: selectedDayId,
          event_binding_id: selectedEvent?.eventBindingId ?? null,
          section_id: null,
          document_id: null,
          material_manifest_revision: null,
          history_entry_id: ensureHistoryEntryId(),
          active_tab: "notes" as const,
        };
    const continuityById = new Map(
      continuitySummaries.map((summary) => [summary.summary_id, summary]),
    );
    const continuityForTurn = selectedContinuityIds.map((summaryId) =>
      continuityById.get(summaryId),
    );
    if (continuityForTurn.some((summary) => summary === undefined)) {
      setContinuityLoadError(
        "A selected continuity summary is no longer available. Reload this page and review it again.",
      );
      return;
    }
    const continuitySelectionsForTurn = continuityForTurn.map((summary) => ({
      summary_id: summary!.summary_id,
      content_hash: summary!.content_hash,
    }));
    const continuityIdsForTurn = continuitySelectionsForTurn.map(({ summary_id }) => summary_id);
    void tutorSession.send({
      message: learnerText,
      continuity_summaries: continuitySelectionsForTurn,
      request_ids: requestIds,
      note_draft: {
        note_id: noteId,
        content: note.value,
        base_revision: note.baseRevision,
        save_status: note.status,
      },
    })
      .then((recorded) => {
        if (!recorded) return;
        setSelectedContinuityIds((current) => current.filter(
          (summaryId) => !continuityIdsForTurn.includes(summaryId),
        ));
      });
  };

  const abandonUncertainTutorMessage = () => {
    const unresolvedText = tutorSession.unresolvedMessage?.text;
    if (unresolvedText === undefined) return;
    const routeAtDecision = location.pathname;
    void tutorSession.abandonUnresolved().then((result) => {
      const action = uncertainTutorComposerAction(
        result,
        window.location.pathname === routeAtDecision,
      );
      if (action === "restore") setComposer(unresolvedText);
      else if (action === "clear") setComposer("");
    });
  };

  const repositoryDayLabel = `Repository Day ${selectedDayId.slice(3)}`;
  const selectedDayLabel = isStudy ? repositoryDayLabel : selectedDay.title;
  const pageHeading = isStudy
    ? selectedSection?.title ?? repositoryDayLabel
    : selectedEvent
      ? selectedEvent.title
      : selectedDay.title;
  const studyMaterialTitle = studyMaterialContext?.title;
  const distinctStudyMaterialTitle = studyMaterialTitle !== undefined
    && studyMaterialTitle !== selectedSection?.title
    ? studyMaterialTitle
    : null;
  const workspaceCrumb = isStudy
    ? `${selectedSection?.sectionId ?? repositoryDayLabel} · ${studyMaterialTitle ?? selectedSection?.title ?? "Choose a section"}`
    : `${selectedDay.title}${selectedEvent ? ` · ${selectedEvent.title}` : ""}`;
  const tutorScopeLabel = isStudy
    ? `${selectedSection?.sectionId ?? repositoryDayLabel} · ${selectedSection?.title ?? "Choose a section"}${distinctStudyMaterialTitle ? ` · ${distinctStudyMaterialTitle}` : ""}`
    : `${selectedDay.title}${selectedEvent ? ` · ${selectedEvent.title}` : ""}${selectedEventBinding ? ` · ${selectedEventBinding.sectionIds.join(", ")}` : ""}`;
  const noteTutorContextStatus = params.noteId !== undefined
    ? "Standalone note · open a day or Study section to chat with curriculum context"
    : isStudy && selectedSection === null
      ? "Choose a repository section to prepare tutor context"
      : isStudy && !studyContextReady
        ? "Preparing repository context for the tutor…"
        : !tutorNoteReady
          ? "Preparing the selected note for the tutor…"
        : isStudy && studyNoteOverride.noteId !== null
          ? "Tutor context ready · selected note draft will be sent with the next tutor turn"
        : "Tutor context ready · live draft will be sent with the next tutor turn";
  const openNote = useCallback((selectedNoteId: string, routePath: string) => {
    if (!isStudy) {
      navigate(routePath);
      return;
    }
    const target = studyNoteSelectionHref(location, selectedNoteId, defaultNoteId);
    const current = `${location.pathname}${location.search}${location.hash}`;
    if (target === current) return;
    const destinationUrl = new URL(target, window.location.origin);
    const destination = {
      pathname: destinationUrl.pathname,
      search: destinationUrl.search,
      hash: destinationUrl.hash,
    };
    const scroller = workspaceScroll.scrollRef.current;
    navigate(target, {
      state: createWorkspaceScrollCarryState(location.state, destination, {
        top: scroller?.scrollTop ?? 0,
        left: scroller?.scrollLeft ?? 0,
      }),
    });
  }, [
    defaultNoteId,
    isStudy,
    location,
    navigate,
    workspaceScroll.scrollRef,
  ]);
  const navigateStudyMaterial = useCallback((path: string, options?: { replace?: boolean }) => {
    navigate(
      materialHrefWithStudyNote(path, selectedDayId, studyNoteOverride.noteId),
      options,
    );
  }, [navigate, selectedDayId, studyNoteOverride.noteId]);
  const activeReviewScopeKey = reviewPanelScopeKey({
    contextMode: viewMode,
    dayId: selectedDayId,
    eventBindingId: selectedEvent?.eventBindingId ?? null,
    linkedSectionIds: selectedEventBinding?.sectionIds ?? [],
    studySectionId: selectedSection?.sectionId ?? null,
  });
  const studyDayTarget: LearningDayId = isStudy
    ? selectedDayId
    : selectedDayId === "day0"
      ? "day0"
      : data.programmeToRepositoryDay[selectedDayId] ?? firstRepositoryDayId;
  const todayDayTarget: LearningDayId = !isStudy
    ? selectedDayId
    : (Object.entries(data.programmeToRepositoryDay).find(([, repoDay]) => repoDay === selectedDayId)?.[0] as LearningDayId | undefined)
      ?? selectedDayId;
  const shellClasses = [
    "app-shell",
    isStudy ? "study-mode" : "",
    !layout.panels.navigation ? "nav-collapsed" : "",
    !layout.panels.tutor ? "tutor-collapsed" : "",
    layout.focusNotes ? "focus-notes" : "",
    compactViewport && mobilePanel === "navigation" ? "mobile-nav-open" : "",
    compactViewport && mobilePanel === "tutor" ? "mobile-tutor-open" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={shellClasses}>
      {compactViewport && mobilePanel !== null ? (
        <button
          className="mobile-panel-backdrop"
          type="button"
          tabIndex={-1}
          aria-hidden="true"
          onClick={mobilePanel === "navigation" ? toggleNavigation : toggleTutor}
        />
      ) : null}
      <aside
        className="side-panel"
        aria-label={isStudy ? "Repository navigation" : "Programme navigation"}
        inert={compactViewport && mobilePanel === "tutor" ? true : undefined}
      >
        <div
          className="panel-inner"
          id="navigation-panel-content"
          ref={navigationPanelRef}
          role={compactViewport && mobilePanel === "navigation" ? "dialog" : undefined}
          aria-modal={compactViewport && mobilePanel === "navigation" ? true : undefined}
          aria-label={compactViewport && mobilePanel === "navigation"
            ? isStudy ? "Repository navigation drawer" : "Programme navigation drawer"
            : undefined}
          aria-hidden={compactViewport && mobilePanel !== "navigation"}
          inert={compactViewport && mobilePanel !== "navigation" ? true : undefined}
          tabIndex={compactViewport && mobilePanel === "navigation" ? -1 : undefined}
        >
          <div className="brand-row">
            <p className="brand">AISB Companion</p>
            <button
              ref={navigationPanelButtonRef}
              className="icon-button"
              type="button"
              aria-label={compactViewport ? "Close navigation" : "Collapse navigation"}
              aria-controls="navigation-panel-content"
              aria-expanded="true"
              onClick={toggleNavigation}
            >
              ←
            </button>
          </div>
          {isStudy ? (
            <>
              <p className="week-label">AISB repository</p>
              <nav className="day-list repository-day-list">
                {(Object.entries(data.repositorySectionsByDay) as [LearningDayId, CurriculumSectionView[]][])
                  .filter(([, repositorySections]) => repositorySections.length > 0)
                  .map(([dayId, repositorySections]) => (
                    <Link
                      key={dayId}
                      className={`day-link ${dayId === selectedDayId ? "active" : ""}`}
                      to={`/study/${dayId}`}
                      aria-current={dayId === selectedDayId ? "page" : undefined}
                    >
                      <span className="day-dot" aria-hidden="true" />
                      <span className="day-label">
                        <strong>Day {dayId.slice(3)}</strong>
                        <span>{repositorySections.length} section{repositorySections.length === 1 ? "" : "s"}</span>
                      </span>
                    </Link>
                  ))}
              </nav>
            </>
          ) : (
            <>
              <p className="week-label">Preparation</p>
              <nav className="day-list preparation-list">
                <Link
                  className={`day-link ${selectedDayId === "day0" ? "active" : ""}`}
                  to="/day/day0"
                  aria-current={selectedDayId === "day0" ? "page" : undefined}
                >
                  <span className="day-dot" aria-hidden="true" />
                  <span className="day-label">
                    <strong>Day 0</strong>
                    <span>Setup and prerequisites</span>
                  </span>
                </Link>
              </nav>
              <p className="week-label programme-week-label">Programme week</p>
              <nav className="day-list">
                {schedule.programmeDays.map((day) => (
                  <Link
                    key={day.dayId}
                    className={`day-link ${day.dayId === selectedDayId ? "active" : ""} ${day.curriculumKind === "break" ? "break-day" : ""}`}
                    to={`/day/${day.dayId}`}
                    aria-current={day.dayId === selectedDayId ? "page" : undefined}
                  >
                    <span className="day-dot" aria-hidden="true" />
                    <span className="day-label">
                      <strong>{day.title}</strong>
                      <span>{formatProgrammeDate(day.date)}</span>
                    </span>
                  </Link>
                ))}
              </nav>
            </>
          )}
          <div className="nav-footer">
            <Link to="/manager">Learning manager</Link>
            <Link to="/prepare">Prepare references</Link>
            <Link to="/visuals">Useful visuals</Link>
            <Link to="/backup">Back up learning record</Link>
            <Link to="/diagnostics">Local diagnostics · {data.diagnostics.status}</Link>
          </div>
        </div>
        <button
          ref={navigationEdgeButtonRef}
          className="edge-button"
          type="button"
          aria-label="Expand navigation"
          aria-controls="navigation-panel-content"
          aria-expanded="false"
          onClick={toggleNavigation}
        >
          <span>{selectedDayLabel} · Navigation</span>
        </button>
      </aside>

      <main className="workspace" inert={compactViewport && mobilePanel !== null ? true : undefined}>
        <header className="workspace-toolbar">
          <span className="route-crumb">{workspaceCrumb} · {data.diagnostics.aisbHead?.slice(0, 8) ?? "AISB"}</span>
          <div className="toolbar-actions">
            <nav className="workspace-mode-switch" aria-label="Workspace mode">
              <Link className={!isStudy ? "active" : ""} to={`/day/${todayDayTarget}`} aria-current={!isStudy ? "page" : undefined}>Today</Link>
              <Link className={isStudy ? "active" : ""} to={`/study/${studyDayTarget}`} aria-current={isStudy ? "page" : undefined}>Study</Link>
            </nav>
            <button
              className="text-button focus-action"
              type="button"
              onClick={() => {
                setMobilePanel(null);
                dispatch({ type: layout.focusNotes ? "exit-focus" : "focus-notes" });
              }}
            >
              {layout.focusNotes ? "Exit focus" : "Focus notes"}
            </button>
          </div>
        </header>

        <div className="workspace-scroll" ref={workspaceScroll.scrollRef}>
          <div className="workspace-content">
            <p className="page-kicker">
              {isStudy
                ? `AISB repository · Day ${selectedDayId.slice(3)}`
                : selectedDay.date === null
                  ? "Before the programme"
                  : formatProgrammeDate(selectedDay.date)}
            </p>
            <h1 className="page-title" ref={pageHeadingRef} tabIndex={-1}>{pageHeading}</h1>
            <p className="page-subtitle">
              {isStudy
                ? selectedSection
                  ? `${selectedSection.sectionId} · ${outcomes.length} learning outcome${outcomes.length === 1 ? "" : "s"} · repository source`
                  : `${daySections.length} authored section${daySections.length === 1 ? "" : "s"} · choose a section to begin`
                : selectedDayId === "day0"
                ? `${sections.length} setup section${sections.length === 1 ? "" : "s"} · repository-backed preparation`
                : selectedEvent
                ? `${formatEventTime(selectedEvent.start)}–${formatEventTime(selectedEvent.end)} · ${selectedDay.title}${selectedEventBinding ? ` · ${selectedEventBinding.sectionIds.join(", ")}` : " · material not linked"}`
                : `${learningEvents.length} learning sessions${mealEvents.length > 0 ? ` · ${mealEvents.length} meal breaks hidden` : ""} · Europe/London`}
            </p>
            {!isStudy && selectedEvent === null ? (
              <div className="day-review-entry">
                <div>
                  <strong>Review the whole day</strong>
                  <span>Use the schedule, outcomes, notes, material, prepared references, and prior learning history.</span>
                </div>
                <Link className="primary-button" to={`/day/${selectedDayId}/review`}>Review day →</Link>
              </div>
            ) : null}
            <div className="rule" />

            {!isStudy ? <section className="schedule-section" aria-labelledby="schedule-heading">
              <div className="section-heading-row">
                <h2 id="schedule-heading">Schedule</h2>
                <div className="schedule-tools">
                  <span className="sync-status">
                    {selectedDayId === "day0"
                      ? "No dated Day 0 calendar items"
                      : anchor
                        ? `Anchored ${formatEventTime(anchor.capturedAt)}`
                        : "Resolving local time"}
                  </span>
                  <button className="text-button" type="button" onClick={syncToNow} title="Uses the system clock; never changes the schedule">
                    Sync to now
                  </button>
                  {mealEvents.length > 0 ? (
                    <button
                      className="text-button meal-visibility-button"
                      type="button"
                      aria-pressed={showMealBreaks}
                      onClick={() => setShowMealBreaks((current) => !current)}
                    >
                      {showMealBreaks ? "Hide meals" : `Show ${mealEvents.length} meals`}
                    </button>
                  ) : null}
                  <button
                    className="icon-button"
                    type="button"
                    aria-label={layout.panels.schedule ? "Collapse schedule" : "Expand schedule"}
                    onClick={() => dispatch({ type: "toggle-panel", panel: "schedule" })}
                  >
                    {layout.panels.schedule ? "↑" : "↓"}
                  </button>
                </div>
              </div>
              {!isStudy && layout.panels.schedule && !layout.focusNotes ? (
                <OrphanedEventLinks
                  snapshot={eventCurriculumBindings}
                  currentScheduleEventIds={schedule.events.map((event) => event.eventBindingId)}
                  scheduleRevision={schedule.scheduleRevision}
                  onChanged={onEventCurriculumBindingsChanged}
                />
              ) : null}
              {layout.panels.schedule && !layout.focusNotes && selectedEvent && showEventMaterialLink ? (
                <EventMaterialLink
                  event={selectedEvent}
                  sections={daySections}
                  scheduleRevision={schedule.scheduleRevision}
                  snapshot={eventCurriculumBindings}
                  onChanged={onEventCurriculumBindingsChanged}
                />
              ) : null}
              {layout.panels.schedule && !layout.focusNotes ? (
                selectedDayId === "day0" ? (
                  <div className="schedule-empty">
                    Day 0 is sourced from the AISB setup material. The imported calendar begins with Day 1, so no date or events are being inferred here.
                  </div>
                ) : <div className="schedule-list">
                  {visibleEvents.map((event) => (
                    <button
                      className={`schedule-row ${event.eventBindingId === scheduleActiveEventId ? "active" : ""} ${event.status === "cancelled" ? "cancelled" : ""} ${isMealScheduleEvent(event) ? "meal" : ""}`}
                      key={event.eventBindingId}
                      type="button"
                      aria-pressed={event.eventBindingId === scheduleActiveEventId}
                      onClick={() => navigate(`/day/${selectedDayId}/event/${event.eventBindingId}`)}
                    >
                      <span className="schedule-time">{formatEventTime(event.start)}</span>
                      <span className="schedule-dot" aria-hidden="true" />
                      <span className="schedule-title">
                        {event.title}
                        {event.status === "cancelled" ? <span className="schedule-status">Cancelled</span> : null}
                        {event.location ? <span className="schedule-location">{event.location}</span> : null}
                      </span>
                    </button>
                  ))}
                  {selectedScheduleDay ? (
                    <ScheduleEditor
                      selectedDay={selectedScheduleDay}
                      selectedEvent={selectedEvent}
                      scheduleRevision={schedule.scheduleRevision}
                      onChanged={applyScheduleSnapshot}
                    />
                  ) : null}
                </div>
              ) : (
                <div className="schedule-collapsed-summary">
                  {selectedDayId === "day0"
                    ? "Repository setup · no calendar date"
                    : selectedEvent
                    ? `${formatEventTime(selectedEvent.start)} · ${selectedEvent.title}`
                    : `${learningEvents.length} learning sessions · ${selectedDay.title}`}
                </div>
              )}
            </section> : null}

            {isStudy || outcomes.length > 0 ? (
            <section className="outcomes-section" aria-labelledby="outcomes-heading">
              <div className="section-heading-row">
                <div className="outcomes-heading-group">
                  <h2 id="outcomes-heading">Learning outcomes</h2>
                  {outcomes.length > 0 ? (
                    <div className="outcome-progress">
                      <progress
                        max={outcomes.length}
                        value={completedOutcomeCount}
                        aria-label={`${completedOutcomeCount} of ${outcomes.length} outcomes checked`}
                      />
                      <span>{completedOutcomeCount} / {outcomes.length} checked</span>
                    </div>
                  ) : null}
                </div>
                <div className="outcomes-tools">
                  {outcomesExpanded && outcomes.length > 6 ? (
                    <button
                      className="text-button"
                      type="button"
                      aria-expanded={showAllOutcomes}
                      aria-controls="learning-outcomes-list"
                      onClick={() => setShowAllOutcomes((current) => !current)}
                    >
                      {showAllOutcomes ? "Show summary" : `Show all ${outcomes.length}`}
                    </button>
                  ) : outcomesExpanded && outcomes.length > 0 ? (
                    <span className="outcomes-scope-label">
                      {sections.length} curriculum section{sections.length === 1 ? "" : "s"}
                    </span>
                  ) : null}
                  <button
                    className="icon-button"
                    type="button"
                    aria-label={outcomesExpanded ? "Collapse learning outcomes" : "Expand learning outcomes"}
                    aria-expanded={outcomesExpanded}
                    aria-controls="learning-outcomes-list"
                    onClick={outcomesDisclosure.toggle}
                  >
                    {outcomesExpanded ? "↑" : "↓"}
                  </button>
                </div>
              </div>
              {outcomesExpanded ? (
                <div className="outcome-groups" id="learning-outcomes-list">
                  {outcomes.slice(0, showAllOutcomes ? outcomes.length : 6).map(({ section, outcome }, index) => (
                    <label
                      className={`outcome-item ${learningProgress.isCompleted(outcome.outcomeId, outcome.versionId) ? "complete" : ""}`.trim()}
                      key={outcome.versionId}
                    >
                      <input
                        type="checkbox"
                        checked={learningProgress.isCompleted(outcome.outcomeId, outcome.versionId)}
                        disabled={learningProgress.loading || learningProgress.isPending(outcome.outcomeId, outcome.versionId)}
                        onChange={(event) => learningProgress.setCompletion(
                          outcome.outcomeId,
                          outcome.versionId,
                          event.currentTarget.checked,
                        )}
                      />
                      <span className="outcome-number" aria-hidden="true">{index + 1}.</span>
                      <span className="outcome-copy">
                        {outcome.text}
                        <span className="outcome-source">{section.sectionId} · {outcome.category}</span>
                      </span>
                    </label>
                  ))}
                  {outcomes.length === 0 ? (
                    <p>
                      {!isStudy && selectedEvent
                        ? "This schedule item has no linked curriculum outcomes yet. Use Study material above to choose its section."
                        : "No formal learning outcomes are declared for this page yet."}
                    </p>
                  ) : null}
                  {learningProgress.error ? (
                    <p className="outcome-progress-error" role="alert">
                      {learningProgress.error}{" "}
                      <button className="text-button" type="button" onClick={() => void learningProgress.reload()}>Retry</button>
                    </p>
                  ) : null}
                </div>
              ) : (
                <div className="outcomes-collapsed-summary" id="learning-outcomes-list">
                  {completedOutcomeCount} of {outcomes.length} checked · {sections.length} section{sections.length === 1 ? "" : "s"}
                </div>
              )}
            </section>
            ) : null}

            {isStudy ? (
              <div className={`study-split ${layout.panels.schedule && !layout.focusNotes ? "" : "material-collapsed"}`.trim()}>
                {layout.panels.schedule && !layout.focusNotes ? (
                  <div className="study-material-pane">
                    <div className="study-material-toolbar">
                      <span>Material</span>
                      <button
                        className="text-button"
                        type="button"
                        onClick={() => dispatch({ type: "toggle-panel", panel: "schedule" })}
                      >
                        Hide material
                      </button>
                    </div>
                    <MaterialReader
                      dayId={selectedDayId}
                      sections={daySections}
                      selectedSectionId={selectedSection?.sectionId ?? null}
                      selectedDocumentId={params.documentId ?? null}
                      selectedFragment={location.hash.startsWith("#") ? location.hash.slice(1) : null}
                      allowFragmentScroll={!workspaceScroll.arrivedWithSavedPosition}
                      onNavigate={navigateStudyMaterial}
                      onContextChanged={setStudyMaterialContext}
                    />
                  </div>
                ) : (
                  <button
                    className="study-material-collapsed"
                    type="button"
                    onClick={() => dispatch({ type: "toggle-panel", panel: "schedule" })}
                  >
                    Show study material
                  </button>
                )}
                <NotesWorkspace
                  className="study-notes"
                  dayId={selectedDayId}
                  scopeMode="study"
                  noteId={noteId}
                  note={note}
                  sections={sections}
                  availableNoteSectionIds={daySections.map((section) => section.sectionId)}
                  onOpenNote={openNote}
                  tutorContextStatus={noteTutorContextStatus}
                />
              </div>
            ) : (
              <NotesWorkspace
                dayId={selectedDayId}
                scopeMode="today"
                noteId={noteId}
                note={note}
                sections={sections}
                availableNoteSectionIds={sections.map((section) => section.sectionId)}
                onOpenNote={openNote}
                tutorContextStatus={noteTutorContextStatus}
              />
            )}
          </div>
        </div>
      </main>

      <aside
        className="tutor-panel"
        aria-label="Tutor conversation"
        inert={compactViewport && mobilePanel === "navigation" ? true : undefined}
      >
        <div
          className="panel-inner"
          id="tutor-panel-content"
          ref={tutorPanelRef}
          role={compactViewport && mobilePanel === "tutor" ? "dialog" : undefined}
          aria-modal={compactViewport && mobilePanel === "tutor" ? true : undefined}
          aria-label={compactViewport && mobilePanel === "tutor" ? "Learning assistant drawer" : undefined}
          aria-hidden={compactViewport && mobilePanel !== "tutor"}
          inert={compactViewport && mobilePanel !== "tutor" ? true : undefined}
          tabIndex={compactViewport && mobilePanel === "tutor" ? -1 : undefined}
        >
          <div className="tutor-heading">
            <div className="assistant-tabs" role="group" aria-label="Learning assistant mode">
              <button className={assistantMode === "tutor" ? "active" : ""} type="button" aria-pressed={assistantMode === "tutor"} onClick={() => setAssistantMode("tutor")}>Tutor</button>
              <button className={assistantMode === "review" ? "active" : ""} type="button" aria-pressed={assistantMode === "review"} onClick={() => setAssistantMode("review")}>Review</button>
            </div>
            <button
              ref={tutorPanelButtonRef}
              className="icon-button"
              type="button"
              aria-label={compactViewport ? "Close tutor" : "Collapse tutor"}
              aria-controls="tutor-panel-content"
              aria-expanded="true"
              onClick={toggleTutor}
            >
              →
            </button>
          </div>
          <div className="assistant-mode-content tutor-mode-content" hidden={assistantMode !== "tutor"}>
              <div className="tutor-context-label">
                {tutorScopeLabel}
                <br />
                — {tutorAvailable
                  ? tutorNoteReady
                    ? `${outcomes.length} outcomes · live note draft ready`
                    : `${outcomes.length} outcomes · preparing selected note`
                  : isStudy
                    ? "Open a repository document to bind the tutor"
                    : "Standalone note · open a day or Study section to chat with curriculum context"}
              </div>
              <div
                className="message-list"
                ref={messageListRef}
                role="log"
                aria-label="Tutor conversation messages"
                aria-live="polite"
                aria-relevant="additions text"
                onScroll={(event) => {
                  const list = event.currentTarget;
                  keepMessageTailVisibleRef.current =
                    list.scrollHeight - list.scrollTop - list.clientHeight <= 48;
                }}
              >
                {messages.length === 0 && !tutorSession.loading ? (
                  <div className="message assistant" role="article" aria-label="Tutor">
                    I’ll use this page’s outcomes, selected session or repository material, permitted AISB paths, and your live note draft. What are you working through?
                  </div>
                ) : null}
                {messages.map((message) => (
                  <div
                    className={`message ${message.role} ${message.status}${message.role === "assistant" ? " markdown-reader tutor-message-markdown" : ""}`}
                    key={message.message_id}
                    role="article"
                    aria-label={message.role === "assistant" ? "Tutor" : message.role === "user" ? "You" : "Tutor status"}
                  >
                    <TutorMessageContent message={message} />
                  </div>
                ))}
                <TutorActiveTurnControls
                  activeTurn={tutorSession.activeTurn}
                  sending={sending}
                  stopping={tutorSession.stopping}
                  onStop={() => { void tutorSession.stopActive(); }}
                />
                {tutorSession.loading ? <div className="message status" role="status">Restoring this session…</div> : null}
                {tutorSession.error ? <div className="message status failed" role="alert">{tutorSession.error}</div> : null}
                <div className="message-tail" ref={messageTailRef} aria-hidden="true" />
              </div>
              {tutorSession.unresolvedMessage ? (
                <section className="uncertain-turn" aria-label="Uncertain tutor message">
                  <div>
                    <strong>Delivery not confirmed</strong>
                    <p>
                      The exact message is saved locally, but there is no confirmed Codex result.
                      New tutor messages are paused to avoid accidental duplicates.
                    </p>
                    <p className="uncertain-turn-risk">
                      Abandoning closes only the local pending state. Codex may still have accepted
                      the request, so sending the restored text again could produce a duplicate.
                    </p>
                  </div>
                  <div className="uncertain-turn-actions">
                    <button
                      type="button"
                      disabled={tutorSession.loading || tutorSession.resolvingUncertain}
                      onClick={() => { void tutorSession.reload(); }}
                    >
                      {tutorSession.loading ? "Checking…" : "Check again"}
                    </button>
                    <button
                      type="button"
                      className="danger-quiet"
                      disabled={tutorSession.loading || tutorSession.resolvingUncertain}
                      onClick={abandonUncertainTutorMessage}
                    >
                      {tutorSession.resolvingUncertain
                        ? "Resolving…"
                        : "Abandon pending & restore text"}
                    </button>
                  </div>
                  {tutorSession.error ? (
                    <p className="uncertain-turn-error" role="alert">{tutorSession.error}</p>
                  ) : null}
                </section>
              ) : null}
              <TutorContinuityControls
                reflection={reflection}
                noteStatus={note.status}
                completedTurnId={latestCompletedAssistant?.turn_id ?? null}
                summaries={continuitySummaries}
                selectedSummaryIds={selectedContinuityIds}
                loading={continuityLoading}
                loadError={continuityLoadError}
                saveState={continuitySaveState}
                saveError={continuitySaveError}
                sending={sending || tutorSession.activeTurn !== null}
                reflectionSaveBlockedReason={isStudy && studyNoteOverride.noteId !== null
                  ? "Switch back to this section’s note before saving a reflection for this tutor thread."
                  : null}
                onSave={saveContinuityReflection}
                onToggle={toggleContinuitySummary}
              />
              <DisclosureInspector disclosure={tutorSession.lastTurnResponse?.disclosure ?? null} pending={{
                  state: "pending next send",
                  context_mode: viewMode,
                  route: location.pathname,
                  day_id: selectedDayId,
                  event_binding_id: selectedEvent?.eventBindingId ?? null,
                  section_id: selectedSection?.sectionId ?? null,
                  material: studyMaterialContext,
                  schedule_revision: isStudy ? null : schedule.scheduleRevision,
                  event_curriculum_binding_revision: isStudy ? null : eventCurriculumBindings.revision,
                  linked_section_ids: isStudy ? [] : selectedEventBinding?.sectionIds ?? [],
                  outcome_ids: outcomes.map(({ outcome }) => outcome.outcomeId),
                  note: { note_id: noteId, revision: note.baseRevision, status: note.status, characters: note.value.length },
                  aisb_root: "<aisb-root>",
                  section_paths: sections.map((section: CurriculumSectionView) => section.sourcePath),
                  note_context: "exact live draft will be frozen at Send",
                  continuity_summaries: selectedContinuityIds.map((summaryId) => {
                    const summary = continuitySummaries.find(
                      (candidate) => candidate.summary_id === summaryId,
                    );
                    return {
                      summary_id: summaryId,
                      content_hash: summary?.content_hash ?? "summary changed or unavailable",
                    };
                  }),
                }} />
              <div className="composer">
                {composerStorageError ? (
                  <p className="composer-storage-error" role="alert">{composerStorageError}</p>
                ) : null}
                <div className="composer-box">
                  <label className="sr-only" htmlFor="tutor-composer">Message the tutor</label>
                  <textarea
                    id="tutor-composer"
                    placeholder={tutorIsWorking
                      ? "Tutor is thinking…"
                      : tutorSession.unresolvedMessage !== null
                        ? "Resolve the pending message before continuing."
                        : tutorAvailable && !tutorNoteReady
                          ? "Preparing the selected note for Tutor…"
                        : tutorCanSend
                          ? "Ask for a nudge, explain your attempt, or review an answer under ## Questions…"
                          : "Open a day or Study section to chat with its curriculum context."}
                    value={tutorEntryLocked ? "" : composer}
                    disabled={!tutorCanSend || tutorEntryLocked}
                    onChange={(event) => setComposer(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                        event.preventDefault();
                        sendTutorMessage();
                      }
                    }}
                  />
                  <button className="send-button" type="button" disabled={!composer.trim() || tutorEntryLocked || !tutorCanSend} onClick={sendTutorMessage}>
                    <span aria-hidden="true">→</span><span className="sr-only">Send</span>
                  </button>
                </div>
              </div>
          </div>
          <div className="assistant-mode-content review-mode-content" hidden={assistantMode !== "review"}>
            <ReviewPanel
              key={activeReviewScopeKey}
              scopeKey={activeReviewScopeKey}
              dayId={selectedDayId}
              contextMode={viewMode}
              eventBindingId={selectedEvent?.eventBindingId ?? null}
              studySectionId={selectedSection?.sectionId ?? null}
              outcomes={outcomes.map(({ section, outcome }) => ({
                sectionId: section.sectionId,
                sectionTitle: section.title,
                outcome,
              }))}
            />
          </div>
        </div>
        <button
          ref={tutorEdgeButtonRef}
          className="edge-button"
          type="button"
          aria-label="Expand tutor"
          aria-controls="tutor-panel-content"
          aria-expanded="false"
          onClick={toggleTutor}
        >
          <span>{assistantMode === "review" ? "Review" : sending ? "Tutor working" : "Tutor"} · {replyCount} replies</span>
        </button>
      </aside>
    </div>
  );
}
