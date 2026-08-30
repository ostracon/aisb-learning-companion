import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";

import type {
  ManagerSessionMessageView,
  ManagerSessionView,
  ManagerTurnResponse,
} from "../../shared/manager.js";
import { SafeMarkdown } from "./SafeMarkdown.js";
import { UtilityBackLink } from "./UtilityBackLink.js";
import "../styles/manager.css";

const COMPOSER_KEY = "aisb-companion:manager-composer:v1";

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
  ) {
    throw new Error("The manager service returned malformed history.");
  }
  return value as unknown as ManagerSessionMessageView;
}

function parseSession(value: unknown): ManagerSessionView {
  if (
    !isRecord(value)
    || (value.chatId !== null && typeof value.chatId !== "string")
    || (value.threadId !== null && typeof value.threadId !== "string")
    || !Array.isArray(value.messages)
    || !(
      value.unresolvedTurn === null
      || (isRecord(value.unresolvedTurn) && typeof value.unresolvedTurn.submittedAt === "string")
    )
  ) {
    throw new Error("The manager service returned malformed history.");
  }
  return {
    chatId: value.chatId as string | null,
    threadId: value.threadId as string | null,
    messages: value.messages.map(parseMessage),
    unresolvedTurn: value.unresolvedTurn as ManagerSessionView["unresolvedTurn"],
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

export function ManagerPage() {
  const [session, setSession] = useState<ManagerSessionView>({
    chatId: null,
    threadId: null,
    messages: [],
    unresolvedTurn: null,
  });
  const [draft, setDraftState] = useState(() => {
    try {
      return window.localStorage.getItem(COMPOSER_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  const setDraft = (value: string) => {
    setDraftState(value);
    try {
      if (value) window.localStorage.setItem(COMPOSER_KEY, value);
      else window.localStorage.removeItem(COMPOSER_KEY);
    } catch {
      // The in-memory draft remains available for this open page.
    }
  };

  const load = async (): Promise<ManagerSessionView | null> => {
    try {
      const response = await fetch("/api/manager/session");
      if (!response.ok) throw await responseError(response, "Could not load manager history.");
      const next = parseSession(await response.json());
      setSession(next);
      setError(null);
      return next;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load manager history.");
      return null;
    }
  };

  useEffect(() => {
    let current = true;
    void load().finally(() => {
      if (current) setLoading(false);
    });
    return () => {
      current = false;
    };
  // The manager route owns one stable overall scope.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const transcript = transcriptRef.current;
    if (transcript === null) return;
    if (typeof transcript.scrollTo === "function") {
      transcript.scrollTo({ top: transcript.scrollHeight });
    } else {
      transcript.scrollTop = transcript.scrollHeight;
    }
  }, [session.messages.length, sending]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const message = draft.trim();
    if (!message || sending || loading || session.unresolvedTurn !== null) return;
    setSending(true);
    setError(null);
    const clientUserMessageId = crypto.randomUUID();
    const optimistic: ManagerSessionMessageView = {
      messageId: `pending:${clientUserMessageId}`,
      role: "user",
      text: message,
      occurredAt: new Date().toISOString(),
      turnNonce: clientUserMessageId,
      turnId: null,
    };
    setSession((current) => ({ ...current, messages: [...current.messages, optimistic] }));
    try {
      const response = await fetch("/api/manager/turns", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientUserMessageId, message }),
      });
      if (!response.ok) throw await responseError(response, "The manager turn failed.");
      const body: unknown = await response.json();
      if (!isRecord(body) || typeof body.message !== "string") {
        throw new Error("The manager returned malformed turn data.");
      }
      void (body as unknown as ManagerTurnResponse);
      setDraft("");
      await load();
    } catch (reason) {
      setSession((current) => ({
        ...current,
        messages: current.messages.filter((entry) => entry.messageId !== optimistic.messageId),
      }));
      const failure = reason instanceof Error ? reason.message : "The manager turn failed.";
      await load();
      setError(failure);
    } finally {
      setSending(false);
    }
  };

  const checkUnresolved = async () => {
    if (loading || sending) return;
    setLoading(true);
    try {
      await load();
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="manager-page">
      <header className="utility-page-header">
        <div>
          <p className="eyebrow">Across the programme</p>
          <h1>Learning manager</h1>
          <p>
            Plan, connect, and review using the current schedule, learning outcomes, checked workflow
            state, saved Markdown notes, bounded prior tutor excerpts, review summaries, and
            learner-approved continuity summaries.
          </p>
        </div>
        <UtilityBackLink />
      </header>

      <details className="manager-context-note">
        <summary>What this conversation can use</summary>
        <p>
          Each send receives a fresh, bounded snapshot of learner-visible local state, including
          recent tutor excerpts and advisory review summaries. Raw review answers, protected solution
          files, recovery copies, credentials, provider state, and omitted transcript content are not
          included. Checked outcomes are workflow state, not proof of mastery.
        </p>
        <p className="manager-visual-link">
          If a diagram would materially help, <Link to="/visuals">open the visual aid</Link>. It is a
          separate action with its own reviewed confirmation.
        </p>
      </details>

      {error ? <p className="inline-error" role="alert">{error}</p> : null}
      {session.unresolvedTurn ? (
        <div className="manager-unresolved" role="status" id="manager-unresolved-status">
          <p>
            A saved manager message from {new Date(session.unresolvedTurn.submittedAt).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })} has not reached a final state. Check again before sending another message.
          </p>
          <button className="text-button" type="button" disabled={loading || sending} onClick={() => void checkUnresolved()}>
            {loading ? "Checking…" : "Check again"}
          </button>
        </div>
      ) : null}
      <section className="manager-chat" aria-label="Learning manager conversation">
        <div className="manager-transcript" ref={transcriptRef} aria-live="polite">
          {loading ? <p className="quiet-copy">Reading manager history…</p> : null}
          {!loading && session.messages.length === 0 ? (
            <div className="manager-welcome">
              <p className="eyebrow">A useful first question</p>
              <h2>What should I revisit, and why?</h2>
              <p>The manager will point back to your own material and suggest one practical next action.</p>
            </div>
          ) : null}
          {session.messages.map((message) => (
            <article key={message.messageId} className={`manager-message ${message.role}`}>
              <p className="manager-message-role">{message.role === "user" ? "You" : message.role === "assistant" ? "Manager" : "Status"}</p>
              {message.role === "assistant" ? (
                <SafeMarkdown
                  markdown={message.text}
                  headingIdPrefix={`manager-${message.messageId}-`}
                  inertLinkTitle="Manager links are shown as text; open sources from the workspace."
                  omittedImageLabel="Manager image omitted"
                  showRawHtmlSource
                />
              ) : <p>{message.text}</p>}
              <time dateTime={message.occurredAt}>{new Date(message.occurredAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
            </article>
          ))}
          {sending ? <p className="manager-thinking" role="status">Manager is reading the current local context…</p> : null}
        </div>
        <form className="manager-composer" onSubmit={submit}>
          <label htmlFor="manager-message">Message the learning manager</label>
          <textarea
            id="manager-message"
            rows={4}
            maxLength={32_000}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            disabled={session.unresolvedTurn !== null}
            aria-describedby={session.unresolvedTurn ? "manager-unresolved-status" : undefined}
            placeholder="Ask what to revisit, connect, summarise from your notes, or practise next…"
          />
          <div>
            <span>{draft.length.toLocaleString()} / 32,000</span>
            <button
              className="primary-button"
              type="submit"
              disabled={sending || loading || session.unresolvedTurn !== null || !draft.trim()}
            >
              {sending ? "Thinking…" : "Send"}
            </button>
          </div>
        </form>
      </section>
    </main>
  );
}
