import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, Navigate, useParams } from "react-router-dom";

import type { LearningDayId } from "../../shared/api.js";
import type { DayReviewMode, DayReviewSessionView } from "../../shared/day-review.js";
import type { ManagerSessionMessageView, ManagerTurnResponse } from "../../shared/manager.js";
import { SafeMarkdown } from "./SafeMarkdown.js";
import "../styles/manager.css";
import "../styles/day-review.css";

const MODES: readonly {
  readonly id: DayReviewMode;
  readonly label: string;
  readonly description: string;
  readonly prompt: (dayLabel: string) => string;
}[] = [
  {
    id: "recap",
    label: "Build a recap",
    description: "Connect the day’s main ideas, then let me correct or add to it.",
    prompt: (dayLabel) => `Help me recap ${dayLabel}. Use my notes and the day resources selectively. Give me a concise connected recap, then ask me for one correction or addition.`,
  },
  {
    id: "active_recall",
    label: "Active recall",
    description: "Ask one focused question at a time, sized for a short answer.",
    prompt: (dayLabel) => `Run a ${dayLabel} active-recall review. Ask one focused question at a time, short enough for a two- or three-sentence answer, and adapt based on my reply.`,
  },
  {
    id: "gap_finding",
    label: "Find a gap",
    description: "Compare outcomes, notes, and prior review history; start small.",
    prompt: (dayLabel) => `Find likely gaps across ${dayLabel}'s outcomes, my notes, and prior review history. Start with the single highest-value gap and ask one diagnostic question.`,
  },
];

function isDayId(value: string | undefined): value is LearningDayId {
  return value !== undefined && /^(?:day[0-7])$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMessage(value: unknown): ManagerSessionMessageView {
  if (
    !isRecord(value)
    || typeof value.messageId !== "string"
    || !["user", "assistant", "status"].includes(String(value.role))
    || typeof value.text !== "string"
    || typeof value.occurredAt !== "string"
    || typeof value.turnNonce !== "string"
    || (value.turnId !== null && typeof value.turnId !== "string")
  ) throw new Error("The day review returned malformed history.");
  return value as unknown as ManagerSessionMessageView;
}

function parseSession(value: unknown, dayId: LearningDayId): DayReviewSessionView {
  if (
    !isRecord(value)
    || value.dayId !== dayId
    || (value.chatId !== null && typeof value.chatId !== "string")
    || (value.threadId !== null && typeof value.threadId !== "string")
    || !Array.isArray(value.messages)
    || !(value.unresolvedTurn === null
      || (isRecord(value.unresolvedTurn) && typeof value.unresolvedTurn.submittedAt === "string"))
  ) throw new Error("The day review returned malformed history.");
  return {
    dayId,
    chatId: value.chatId as string | null,
    threadId: value.threadId as string | null,
    messages: value.messages.map(parseMessage),
    unresolvedTurn: value.unresolvedTurn as DayReviewSessionView["unresolvedTurn"],
  };
}

async function responseError(response: Response, fallback: string): Promise<Error> {
  try {
    const payload: unknown = await response.json();
    return new Error(isRecord(payload) && typeof payload.error === "string" ? payload.error : fallback);
  } catch {
    return new Error(fallback);
  }
}

export function DayReviewPage() {
  const params = useParams();
  const dayId = isDayId(params.dayId) ? params.dayId : null;
  const dayLabel = dayId === null ? "Day" : `Day ${dayId.slice(3)}`;
  const composerKey = dayId === null ? "" : `aisb-companion:day-review-composer:v1:${dayId}`;
  const [session, setSession] = useState<DayReviewSessionView | null>(null);
  const [draft, setDraftState] = useState(() => {
    if (!composerKey) return "";
    try { return window.localStorage.getItem(composerKey) ?? ""; } catch { return ""; }
  });
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const loadSequenceRef = useRef(0);

  const setDraft = (value: string) => {
    setDraftState(value);
    if (!composerKey) return;
    try {
      if (value) window.localStorage.setItem(composerKey, value);
      else window.localStorage.removeItem(composerKey);
    } catch {
      // The open page keeps the draft even if browser recovery storage is unavailable.
    }
  };

  useEffect(() => {
    if (!composerKey) {
      setDraftState("");
      return;
    }
    try {
      setDraftState(window.localStorage.getItem(composerKey) ?? "");
    } catch {
      setDraftState("");
    }
  }, [composerKey]);

  const load = async (): Promise<void> => {
    if (dayId === null) return;
    const loadSequence = ++loadSequenceRef.current;
    try {
      const response = await fetch(`/api/day-review/${dayId}/session`);
      if (!response.ok) throw await responseError(response, "Could not load this day review.");
      const loaded = parseSession(await response.json(), dayId);
      if (loadSequence !== loadSequenceRef.current) return;
      setSession(loaded);
      setError(null);
    } catch (reason) {
      if (loadSequence !== loadSequenceRef.current) return;
      setError(reason instanceof Error ? reason.message : "Could not load this day review.");
    }
  };

  useEffect(() => {
    setSession(null);
    setLoading(true);
    setError(null);
    let current = true;
    void load().finally(() => { if (current) setLoading(false); });
    return () => {
      current = false;
      loadSequenceRef.current += 1;
    };
    // The route fixes one durable day scope for the lifetime of this component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dayId]);

  useEffect(() => {
    if ((session?.messages.length ?? 0) === 0 && !sending) return;
    const transcript = transcriptRef.current;
    if (transcript === null) return;
    transcript.scrollTo?.({ top: transcript.scrollHeight, behavior: "smooth" });
  }, [session?.messages.length, sending]);

  const send = async (message: string) => {
    if (dayId === null || !message.trim() || sending || loading || session?.unresolvedTurn) return;
    setSending(true);
    setError(null);
    const clientUserMessageId = crypto.randomUUID();
    const optimistic: ManagerSessionMessageView = {
      messageId: `pending:${clientUserMessageId}`,
      role: "user",
      text: message.trim(),
      occurredAt: new Date().toISOString(),
      turnNonce: clientUserMessageId,
      turnId: null,
    };
    setSession((current) => current === null ? current : ({
      ...current,
      messages: [...current.messages, optimistic],
    }));
    setDraft("");
    try {
      const response = await fetch(`/api/day-review/${dayId}/turns`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientUserMessageId, message: message.trim() }),
      });
      if (!response.ok) throw await responseError(response, "The day review turn failed.");
      const body: unknown = await response.json();
      if (!isRecord(body) || typeof body.message !== "string") {
        throw new Error("The day review returned malformed turn data.");
      }
      void (body as unknown as ManagerTurnResponse);
      await load();
    } catch (reason) {
      setSession((current) => current === null ? current : ({
        ...current,
        messages: current.messages.filter(({ messageId }) => messageId !== optimistic.messageId),
      }));
      setDraft(message);
      await load();
      setError(reason instanceof Error ? reason.message : "The day review turn failed.");
    } finally {
      setSending(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void send(draft);
  };

  if (dayId === null) return <Navigate to="/" replace />;

  return (
    <main className="day-review-page">
      <header className="day-review-header">
        <div>
          <p className="eyebrow">Day review · GPT-5.6 Sol</p>
          <h1>{dayLabel}</h1>
          <p>Review the schedule, outcomes, notes, learner-visible material, and prepared references without loading everything into one prompt.</p>
        </div>
        <Link className="day-review-exit" to={`/day/${dayId}`}>← Leave review</Link>
      </header>

      <section className="day-review-focus" aria-labelledby="day-review-focus-heading">
        <div>
          <p className="eyebrow">Choose a focus</p>
          <h2 id="day-review-focus-heading">One useful move at a time</h2>
        </div>
        <div className="day-review-mode-list">
          {MODES.map((mode) => (
            <button
              key={mode.id}
              type="button"
              disabled={sending || loading || session?.unresolvedTurn !== null}
              onClick={() => void send(mode.prompt(dayLabel))}
            >
              <strong>{mode.label}</strong>
              <span>{mode.description}</span>
            </button>
          ))}
        </div>
      </section>

      {error ? <p className="inline-error" role="alert">{error}</p> : null}
      {session?.unresolvedTurn ? (
        <div className="manager-unresolved" role="status" id="day-review-unresolved">
          <p>A saved message is still unresolved. Check again before sending another message.</p>
          <button className="text-button" type="button" disabled={loading || sending} onClick={() => void load()}>
            Check again
          </button>
        </div>
      ) : null}

      <section className="day-review-chat" aria-label={`${dayLabel} review conversation`}>
        <div className="day-review-transcript" ref={transcriptRef} aria-live="polite">
          {loading ? <p className="quiet-copy">Reading this day’s review history…</p> : null}
          {!loading && session?.messages.length === 0 ? (
            <div className="day-review-empty">
              <p className="eyebrow">Ready when you are</p>
              <h2>Start with a focus above, or ask your own question.</h2>
              <p>The assistant gets a compact map first and retrieves only the relevant learner-visible detail.</p>
            </div>
          ) : null}
          {session?.messages.map((message) => (
            <article key={message.messageId} className={`manager-message ${message.role}`}>
              <p className="manager-message-role">{message.role === "user" ? "You" : message.role === "assistant" ? "Day review" : "Status"}</p>
              {message.role === "assistant" ? (
                <SafeMarkdown
                  markdown={message.text}
                  headingIdPrefix={`day-review-${message.messageId}-`}
                  inertLinkTitle="Use the cited source in the workspace or prepared-reference view."
                  omittedImageLabel="Day review image omitted"
                  showRawHtmlSource
                />
              ) : <p>{message.text}</p>}
              <time dateTime={message.occurredAt}>{new Date(message.occurredAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
            </article>
          ))}
          {sending ? (
            <p className="day-review-thinking" role="status">
              <span aria-hidden="true" /> Reviewing the day map and retrieving relevant sources…
            </p>
          ) : null}
        </div>
        <form className="manager-composer" onSubmit={submit}>
          <label htmlFor="day-review-message">Continue this day review</label>
          <textarea
            id="day-review-message"
            rows={3}
            maxLength={32_000}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            disabled={session?.unresolvedTurn !== null}
            aria-describedby={session?.unresolvedTurn ? "day-review-unresolved" : undefined}
            placeholder="Ask for a recap, one recall question, or help finding a gap…"
          />
          <div>
            <span>{draft.length.toLocaleString()} / 32,000</span>
            <button className="primary-button" type="submit" disabled={sending || loading || session?.unresolvedTurn !== null || !draft.trim()}>
              {sending ? "Reviewing…" : "Send"}
            </button>
          </div>
        </form>
      </section>
    </main>
  );
}
