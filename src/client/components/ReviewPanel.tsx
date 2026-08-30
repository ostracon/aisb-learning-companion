import { useEffect, useMemo, useRef, useState } from "react";
import type {
  CreateReviewSessionRequest,
  LearningDayId,
  OutcomeView,
  ReviewAdvanceResponse,
  ReviewSessionResponse,
  SubmitReviewResponseRequest,
} from "../../shared/api.js";
import {
  REVIEW_QUESTION_MODES,
  type ReviewCoachFeedback,
  type ReviewCoachSessionView,
  type ReviewQuestionMode,
} from "../../shared/review.js";
import { SafeMarkdown } from "./SafeMarkdown.js";

export interface ReviewOutcomeChoice {
  sectionId: string;
  sectionTitle: string;
  outcome: OutcomeView;
}

export interface ReviewPanelProps {
  scopeKey: string;
  dayId: LearningDayId;
  contextMode: "today" | "study";
  eventBindingId: string | null;
  studySectionId: string | null;
  outcomes: readonly ReviewOutcomeChoice[];
}

export function reviewPanelScopeKey(input: {
  readonly contextMode: "today" | "study";
  readonly dayId: LearningDayId;
  readonly eventBindingId: string | null;
  readonly linkedSectionIds: readonly string[];
  readonly studySectionId: string | null;
}): string {
  return input.contextMode === "study"
    ? `study:${input.dayId}:${input.studySectionId ?? "none"}`
    : `today:${input.dayId}:${input.eventBindingId ?? "day"}:${input.linkedSectionIds.join(",")}`;
}

const modeLabels: Record<ReviewQuestionMode, string> = {
  free_recall: "Free recall",
  short_answer: "Short answer",
  explain_back: "Explain back",
  compare_contrast: "Compare / contrast",
  scenario_application: "Scenario / application",
};

const modeDescriptions: Record<ReviewQuestionMode, string> = {
  free_recall: "Write everything you can remember without cues; coverage matters more than polish.",
  short_answer: "Answer one focused question in a few precise sentences.",
  explain_back: "Teach the idea in your own words and connect the important steps.",
  compare_contrast: "Separate related concepts by similarities, differences, and when each applies.",
  scenario_application: "Apply the outcome to a concrete AI-security situation or decision.",
};

const modeAnswerScopes: Record<ReviewQuestionMode, string> = {
  free_recall: "One focused memory dump · about 2 minutes",
  short_answer: "Two or three precise sentences",
  explain_back: "One concise explanation",
  compare_contrast: "One clear distinction and why it matters",
  scenario_application: "One decision and its rationale",
};

const reviewSessionStoragePrefix = "aisb-companion:review-session:";
type ReviewConfidence = 1 | 2 | 3 | 4 | 5 | null;

export function reviewSessionStorageKey(scopeKey: string): string {
  return `${reviewSessionStoragePrefix}${scopeKey}`;
}

export function reviewResponseDraftStorageKey(scopeKey: string, sessionId: string): string {
  return `aisb-companion:review-response:${scopeKey}:${sessionId}`;
}

function readStoredReviewSessionId(scopeKey: string): string | null {
  try {
    return window.localStorage.getItem(reviewSessionStorageKey(scopeKey));
  } catch {
    return null;
  }
}

function storeReviewSessionId(scopeKey: string, sessionId: string): void {
  try {
    window.localStorage.setItem(reviewSessionStorageKey(scopeKey), sessionId);
  } catch {
    // The durable session remains in owner-only companion storage even when a
    // browser privacy setting prevents saving this local resume pointer.
  }
}

function clearStoredReviewSessionId(scopeKey: string, expectedSessionId?: string): void {
  try {
    const key = reviewSessionStorageKey(scopeKey);
    if (expectedSessionId !== undefined && window.localStorage.getItem(key) !== expectedSessionId) return;
    window.localStorage.removeItem(key);
  } catch {
    // A blocked localStorage API must not prevent using the active review.
  }
}

function readStoredReviewResponse(
  scopeKey: string,
  sessionId: string,
  questionId: string | null,
): { readonly response: string; readonly confidence: ReviewConfidence } {
  if (questionId === null) return { response: "", confidence: null };
  try {
    const raw = window.localStorage.getItem(reviewResponseDraftStorageKey(scopeKey, sessionId));
    if (raw === null) return { response: "", confidence: null };
    const value = JSON.parse(raw) as {
      question_id?: unknown;
      response?: unknown;
      confidence?: unknown;
    };
    if (value.question_id !== questionId || typeof value.response !== "string") {
      return { response: "", confidence: null };
    }
    const confidence = value.confidence === null
      || ([1, 2, 3, 4, 5] as const).some((candidate) => candidate === value.confidence)
      ? value.confidence as ReviewConfidence
      : null;
    return { response: value.response, confidence };
  } catch {
    return { response: "", confidence: null };
  }
}

function storeReviewResponse(
  scopeKey: string,
  sessionId: string,
  questionId: string,
  response: string,
  confidence: ReviewConfidence,
): void {
  try {
    const key = reviewResponseDraftStorageKey(scopeKey, sessionId);
    if (response === "" && confidence === null) {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, JSON.stringify({ question_id: questionId, response, confidence }));
  } catch {
    // The active text remains visible even if browser recovery storage is unavailable.
  }
}

function clearStoredReviewResponse(scopeKey: string, sessionId: string): void {
  try {
    window.localStorage.removeItem(reviewResponseDraftStorageKey(scopeKey, sessionId));
  } catch {
    // A blocked localStorage API must not block review progression.
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? "The local review request failed safely");
  return payload;
}

export function ReviewPanel({
  scopeKey,
  dayId,
  contextMode,
  eventBindingId,
  studySectionId,
  outcomes,
}: ReviewPanelProps) {
  const suggestedIds = useMemo(
    () => new Set(outcomes.slice(0, Math.min(3, outcomes.length)).map(({ outcome }) => outcome.outcomeId)),
    [outcomes],
  );
  const [selectedIds, setSelectedIds] = useState<Set<string>>(suggestedIds);
  const [mode, setMode] = useState<ReviewQuestionMode>("free_recall");
  const [questionLimit, setQuestionLimit] = useState(3);
  const [session, setSession] = useState<ReviewCoachSessionView | null>(null);
  const [feedbackHistory, setFeedbackHistory] = useState<ReviewCoachFeedback[]>([]);
  const [response, setResponse] = useState("");
  const [confidence, setConfidence] = useState<ReviewConfidence>(null);
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState(() => readStoredReviewSessionId(scopeKey) !== null);
  const [error, setError] = useState<string | null>(null);
  const [responseMode, setResponseMode] = useState<ReviewSessionResponse["mode"] | null>(null);
  const responseRef = useRef<HTMLTextAreaElement>(null);
  const resumedSessionIdRef = useRef(readStoredReviewSessionId(scopeKey));

  useEffect(() => {
    const storedSessionId = readStoredReviewSessionId(scopeKey);
    resumedSessionIdRef.current = storedSessionId;
    if (storedSessionId === null) {
      setRestoring(false);
      return;
    }

    const controller = new AbortController();
    setRestoring(true);
    setError(null);
    void fetch(`/api/review/sessions/${encodeURIComponent(storedSessionId)}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (response.status === 404) {
          clearStoredReviewSessionId(scopeKey, storedSessionId);
          return null;
        }
        const payload = (await response.json()) as ReviewSessionResponse & { error?: string };
        if (!response.ok) {
          throw new Error(payload.error ?? "The saved review session could not be restored");
        }
        return payload;
      })
      .then((result) => {
        if (controller.signal.aborted || result === null) return;
        const storedDraft = readStoredReviewResponse(
          scopeKey,
          result.session.sessionId,
          result.session.currentQuestion?.questionId ?? null,
        );
        setSession(result.session);
        setResponseMode(result.mode);
        setFeedbackHistory(result.session.lastFeedback ? [result.session.lastFeedback] : []);
        setResponse(result.session.pendingResponse?.learnerResponse ?? storedDraft.response);
        setConfidence(result.session.pendingResponse?.learnerConfidence ?? storedDraft.confidence);
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setError(reason instanceof Error ? reason.message : "The saved review session could not be restored");
      })
      .finally(() => {
        if (!controller.signal.aborted) setRestoring(false);
      });
    return () => controller.abort();
  }, [scopeKey]);

  useEffect(() => {
    if (!session?.currentQuestion) return;
    responseRef.current?.focus();
  }, [session?.currentQuestion?.questionId]);

  useEffect(() => {
    const question = session?.currentQuestion;
    if (!session || !question) return;
    storeReviewResponse(scopeKey, session.sessionId, question.questionId, response, confidence);
  }, [confidence, response, scopeKey, session?.currentQuestion?.questionId, session?.sessionId]);

  const start = async () => {
    const selectedOutcomes = outcomes.filter(({ outcome }) => selectedIds.has(outcome.outcomeId));
    if (selectedOutcomes.length === 0) return;
    setBusy(true);
    setError(null);
    let created: ReviewSessionResponse;
    try {
      const commonRequest = {
        day_id: dayId,
        outcome_refs: selectedOutcomes.map(({ outcome }) => ({
          outcome_id: outcome.outcomeId,
          outcome_version_id: outcome.versionId,
        })),
        question_limit: questionLimit,
        modes: [mode],
      };
      const request: CreateReviewSessionRequest = contextMode === "today"
        ? {
            ...commonRequest,
            context_mode: "today",
            event_binding_id: eventBindingId,
            section_id: null,
          }
        : {
            ...commonRequest,
            context_mode: "study",
            event_binding_id: null,
            section_id: studySectionId,
          };
      created = await post<ReviewSessionResponse>("/api/review/sessions", request);
      const previousSessionId = resumedSessionIdRef.current;
      if (previousSessionId !== null && previousSessionId !== created.session.sessionId) {
        clearStoredReviewResponse(scopeKey, previousSessionId);
      }
      clearStoredReviewResponse(scopeKey, created.session.sessionId);
      resumedSessionIdRef.current = created.session.sessionId;
      storeReviewSessionId(scopeKey, created.session.sessionId);
      setSession(created.session);
      setResponseMode(created.mode);
      setFeedbackHistory([]);
      setResponse("");
      setConfidence(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The local review session could not start");
      setBusy(false);
      return;
    }

    try {
      const result = await post<ReviewSessionResponse>(
        `/api/review/sessions/${encodeURIComponent(created.session.sessionId)}/start`,
        {},
      );
      setSession(result.session);
      setResponseMode(result.mode);
      setFeedbackHistory(result.session.lastFeedback ? [result.session.lastFeedback] : []);
      setResponse(result.session.pendingResponse?.learnerResponse ?? "");
      setConfidence(result.session.pendingResponse?.learnerConfidence ?? null);
    } catch (reason) {
      setError(reason instanceof Error
        ? reason.message
        : "The saved review session could not continue");
    } finally {
      setBusy(false);
    }
  };

  const continueSession = async () => {
    if (!session || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await post<ReviewSessionResponse>(
        `/api/review/sessions/${encodeURIComponent(session.sessionId)}/start`,
        {},
      );
      const storedDraft = readStoredReviewResponse(
        scopeKey,
        result.session.sessionId,
        result.session.currentQuestion?.questionId ?? null,
      );
      setSession(result.session);
      setResponseMode(result.mode);
      setFeedbackHistory(result.session.lastFeedback ? [result.session.lastFeedback] : []);
      setResponse(result.session.pendingResponse?.learnerResponse ?? storedDraft.response);
      setConfidence(result.session.pendingResponse?.learnerConfidence ?? storedDraft.confidence);
    } catch (reason) {
      setError(reason instanceof Error
        ? reason.message
        : "The saved review session could not continue");
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    const question = session?.currentQuestion;
    if (!question || !response.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const request: SubmitReviewResponseRequest = {
        question_id: question.questionId,
        learner_response: response,
        learner_confidence: confidence,
      };
      const result = await post<ReviewAdvanceResponse>(
        `/api/review/sessions/${encodeURIComponent(session.sessionId)}/responses`,
        request,
      );
      clearStoredReviewResponse(scopeKey, session.sessionId);
      setSession(result.result.session);
      setResponseMode(result.mode);
      setFeedbackHistory((current) => [...current, result.result.feedback]);
      setResponse("");
      setConfidence(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The review response could not be recorded");
    } finally {
      setBusy(false);
    }
  };

  const startAnotherSession = () => {
    if (session) {
      clearStoredReviewSessionId(scopeKey, session.sessionId);
      clearStoredReviewResponse(scopeKey, session.sessionId);
    }
    setSession(null);
    setFeedbackHistory([]);
    setResponse("");
    setConfidence(null);
    setError(null);
  };

  if (!session) {
    return (
      <div className="review-panel-content">
        <div className="review-local-note">
          <strong>Protected Sol review</strong>
          <span>
            Your selected outcomes and typed recall answer are sent to GPT-5.6 Sol through the restricted review profile.
            Feedback is advisory. Review sessions, including exact responses and confidence, are stored durably in
            your owner-only companion state so the active session can resume after a refresh.
          </span>
        </div>
        <fieldset className="review-outcome-picker">
          <legend>Choose learning outcomes</legend>
          {outcomes.map(({ sectionId, outcome }) => (
            <label key={outcome.versionId}>
              <input
                type="checkbox"
                checked={selectedIds.has(outcome.outcomeId)}
                onChange={(event) => {
                  const next = new Set(selectedIds);
                  if (event.currentTarget.checked) next.add(outcome.outcomeId);
                  else next.delete(outcome.outcomeId);
                  setSelectedIds(next);
                }}
              />
              <span>{outcome.text}<small>{sectionId} · {outcome.category}</small></span>
            </label>
          ))}
          {outcomes.length === 0 ? <p>No review outcomes are defined for this day.</p> : null}
        </fieldset>
        <div className="review-settings">
          <label>
            <span className="review-setting-label">
              Prompt style
              <span
                className="info-tooltip-trigger"
                role="note"
                tabIndex={0}
                aria-label="Prompt style descriptions"
                aria-describedby="prompt-style-help"
              >
                i
                <span className="info-tooltip" id="prompt-style-help" role="tooltip">
                  {REVIEW_QUESTION_MODES.map((value) => (
                    <span key={value}><strong>{modeLabels[value]}</strong>{modeDescriptions[value]}</span>
                  ))}
                </span>
              </span>
            </span>
            <select
              aria-describedby="selected-prompt-style-description"
              value={mode}
              onChange={(event) => setMode(event.currentTarget.value as ReviewQuestionMode)}
            >
              {REVIEW_QUESTION_MODES.map((value) => <option key={value} value={value}>{modeLabels[value]}</option>)}
            </select>
            <small className="review-setting-description" id="selected-prompt-style-description">
              {modeDescriptions[mode]}
            </small>
          </label>
          <label>
            <span>Questions</span>
            <select value={questionLimit} onChange={(event) => setQuestionLimit(Number(event.currentTarget.value))}>
              {[1, 3, 5].map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
        </div>
        {error ? <p className="review-error" role="alert">{error}</p> : null}
        <button className="primary-button review-start" type="button" disabled={busy || restoring || selectedIds.size === 0} onClick={() => void start()}>
          {restoring ? "Restoring review…" : busy ? "Preparing…" : "Start active recall"}
        </button>
      </div>
    );
  }

  if (session.status === "ready_for_question") {
    return (
      <div className="review-panel-content review-session review-ready-session">
        <div className="review-progress" role="status" aria-live="polite">
          <span>Review saved</span>
          <span>Advisory · ready to continue</span>
        </div>
        <div className="review-question review-ready-message">
          <span>Durable session</span>
          <p>
            This review is safely stored, but its first question has not finished starting. Continuing retries the
            same saved session; opening or refreshing this page never starts a model call by itself.
          </p>
        </div>
        {error ? <p className="review-error" role="alert">{error}</p> : null}
        <button className="primary-button review-submit" type="button" disabled={busy} onClick={() => void continueSession()}>
          {busy ? "Continuing…" : error ? "Retry review" : "Continue review"}
        </button>
      </div>
    );
  }

  const question = session.currentQuestion;
  const responseLocked = session.pendingResponse !== null;
  return (
    <div className="review-panel-content review-session">
      <div className="review-progress" role="status" aria-live="polite">
        <span>{session.status === "complete" ? "Session complete" : `Question ${question?.number ?? session.questionsAsked} of ${session.questionLimit}`}</span>
        <span>Advisory · {responseMode === "live-codex" ? "GPT-5.6 Sol" : "local fallback"}</span>
      </div>
      {feedbackHistory.at(-1) ? (
        <div className="review-feedback" role="status" aria-live="polite">
          <strong>Review feedback</strong>
          <div className="markdown-reader review-rich-markdown">
            <SafeMarkdown
              markdown={feedbackHistory.at(-1)!.text}
              headingIdPrefix={`review-feedback-${feedbackHistory.at(-1)!.feedbackId}-`}
              inertLinkTitle="Review links are inactive; use the cited curriculum source."
              omittedImageLabel="Remote image omitted"
              showRawHtmlSource
            />
          </div>
          <small>{feedbackHistory.at(-1)!.citations.map((citation) => citation.sourcePath).join(" · ")}</small>
        </div>
      ) : null}
      {question ? (
        <>
          <div className="review-question" aria-live="polite" aria-atomic="true">
            <div className="review-question-heading">
              <span>{modeLabels[question.mode]}</span>
              <small>{modeAnswerScopes[question.mode]}</small>
            </div>
            <div className="markdown-reader review-rich-markdown">
              <SafeMarkdown
                markdown={question.prompt}
                headingIdPrefix={`review-question-${question.questionId}-`}
                inertLinkTitle="Review links are inactive; use the cited curriculum source."
                omittedImageLabel="Remote image omitted"
                showRawHtmlSource
              />
            </div>
            <small className="review-question-citations">
              {Array.from(new Set(question.citations.map((citation) => citation.sourcePath))).join(" · ")}
            </small>
          </div>
          <label className="review-response-label" htmlFor="review-response">Your recall</label>
          <textarea
            id="review-response"
            ref={responseRef}
            className="review-response"
            value={response}
            readOnly={responseLocked}
            aria-describedby={responseLocked ? "review-pending-response" : "review-draft-storage"}
            placeholder="Answer from memory first; verify against the cited learner-visible source afterwards."
            onChange={(event) => setResponse(event.currentTarget.value)}
          />
          {responseLocked ? (
            <p className="review-pending-response" id="review-pending-response" role="status">
              This exact response is already saved in owner-only companion storage while feedback finishes. It is
              locked to prevent a changed retry; resume the saved response below.
            </p>
          ) : (
            <small className="review-draft-note" id="review-draft-storage">
              Unsubmitted text stays in owner-only browser storage for this review and returns after a refresh.
            </small>
          )}
          <label className="review-confidence">
            <span>Confidence</span>
            <select disabled={responseLocked} value={confidence ?? ""} onChange={(event) => setConfidence(event.currentTarget.value ? Number(event.currentTarget.value) as 1 | 2 | 3 | 4 | 5 : null)}>
              <option value="">Not recorded</option>
              {[1, 2, 3, 4, 5].map((value) => <option value={value} key={value}>{value} / 5</option>)}
            </select>
          </label>
          {error ? <p className="review-error" role="alert">{error}</p> : null}
          <button className="primary-button review-submit" type="button" disabled={busy || !response.trim()} onClick={() => void submit()}>
            {busy ? responseLocked ? "Resuming…" : "Recording…" : responseLocked ? "Resume saved response" : "Record response"}
          </button>
          {!responseLocked ? (
            <button className="text-button review-start-over" type="button" disabled={busy} onClick={startAnotherSession}>
              Start over with new questions
            </button>
          ) : null}
        </>
      ) : (
        <div className="review-complete">
          <p>{session.responsesRecorded} recall response{session.responsesRecorded === 1 ? "" : "s"} completed for this session.</p>
          {session.lastReviewedAt ? <small>Last reviewed {new Date(session.lastReviewedAt).toLocaleString("en-GB")}</small> : null}
          <button className="outline-button" type="button" onClick={startAnotherSession}>Start another session</button>
        </div>
      )}
    </div>
  );
}
