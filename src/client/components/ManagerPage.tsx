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
  const [showLatest, setShowLatest] = useState(false);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const transcriptContentRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const submittedRef = useRef(false);
  const stickToLatestRef = useRef(true);

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

  const scrollToLatest = (behavior: ScrollBehavior = "auto") => {
    const transcript = transcriptRef.current;
    if (transcript === null) return;
    stickToLatestRef.current = true;
    setShowLatest(false);
    if (typeof transcript.scrollTo === "function") {
      transcript.scrollTo({ top: transcript.scrollHeight, behavior });
    } else {
      transcript.scrollTop = transcript.scrollHeight;
    }
  };

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => scrollToLatest());
    return () => window.cancelAnimationFrame(frame);
  // New canonical or optimistic messages should be brought into view.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.messages.length, sending]);

  useEffect(() => {
    const content = transcriptContentRef.current;
    if (content === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (stickToLatestRef.current) scrollToLatest();
    });
    observer.observe(content);
    return () => observer.disconnect();
  // The observer is bound once to the stable transcript content element.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (
      !submittedRef.current
      || sending
      || loading
      || session.unresolvedTurn !== null
    ) return;
    composerRef.current?.focus({ preventScroll: true });
  }, [loading, sending, session.unresolvedTurn]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const message = draft.trim();
    if (!message || sending || loading || session.unresolvedTurn !== null) return;
    setSending(true);
    setError(null);
    // Clear the visible composer immediately, but retain its browser recovery
    // bytes until canonical history confirms the turn.
    setDraftState("");
    submittedRef.current = true;
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
      setDraft(message);
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
            Plan, connect, and review using your schedule, outcomes, notes, prepared references,
            and recent learning history.
          </p>
        </div>
        <UtilityBackLink />
      </header>

      <details className="manager-context-note">
        <summary>Context snapshot · refreshed on every send</summary>
        <p>
          Each send receives a fresh, bounded snapshot of learner-visible local state, including
          recent tutor excerpts and advisory review summaries. Raw review answers, protected solution
          files, recovery copies, credentials, provider state, and omitted transcript content are not
          included. Checked outcomes are workflow state, not proof of mastery.
        </p>
        <p className="manager-visual-link">
          For a source-grounded single-day conversation, open that day and select <strong>Review day</strong>.
          If a diagram would materially help, <Link to="/visuals">open the visual aid</Link>; generation
          remains a separate confirmed action.
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
      <section className="manager-chat" aria-label="Learning manager conversation" aria-busy={sending}>
        <div className="manager-transcript-shell">
          <div
            className="manager-transcript"
            ref={transcriptRef}
            role="log"
            aria-label="Learning manager messages"
            aria-live="polite"
            onScroll={(event) => {
              const transcript = event.currentTarget;
              const atLatest = transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop < 48;
              stickToLatestRef.current = atLatest;
              setShowLatest(!atLatest);
            }}
          >
            <div className="manager-transcript-content" ref={transcriptContentRef}>
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
              {sending ? (
                <p className="manager-thinking" role="status">
                  <span className="manager-thinking-mark" aria-hidden="true"><i /><i /><i /></span>
                  Manager is reviewing the latest local context…
                </p>
              ) : null}
            </div>
          </div>
          {showLatest ? (
            <button
              className="manager-latest-button"
              type="button"
              aria-label="Jump to latest message"
              onClick={() => scrollToLatest()}
            >
              <span aria-hidden="true">↓</span> Latest
            </button>
          ) : null}
        </div>
        <form className="manager-composer" onSubmit={submit}>
          <label htmlFor="manager-message">Message the learning manager</label>
          <textarea
            ref={composerRef}
            id="manager-message"
            rows={3}
            maxLength={32_000}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || (!event.metaKey && !event.ctrlKey)) return;
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }}
            disabled={loading || sending || session.unresolvedTurn !== null}
            aria-describedby={session.unresolvedTurn ? "manager-unresolved-status" : undefined}
            placeholder={sending
              ? "Manager is reviewing your context…"
              : "Ask what to revisit, connect, summarise from your notes, or practise next…"}
          />
          <div className="manager-composer-footer">
            <span className="manager-composer-shortcut">⌘ / Ctrl + Enter to send</span>
            <span className="manager-composer-count">{draft.length.toLocaleString()} / 32,000</span>
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
