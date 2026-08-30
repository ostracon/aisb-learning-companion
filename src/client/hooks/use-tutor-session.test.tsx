// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AbandonUncertainTutorTurnResponseBody,
  LearningDayId,
  StopTutorTurnRequestBody,
  TutorSessionHistoryResponse,
  TutorSessionMessageView,
  TutorSessionScopeRequest,
  TutorTurnResponseBody,
} from "../../shared/api.js";
import {
  tutorPendingSubmissionStorageKey,
  useTutorSession,
  type TutorTurnSubmission,
} from "./use-tutor-session.js";

beforeEach(() => window.localStorage.clear());

const A_SCOPE = {
  context_mode: "today",
  day_id: "day1",
  event_binding_id: "event-a",
  section_id: null,
} as const satisfies TutorSessionScopeRequest;

const B_SCOPE = {
  context_mode: "study",
  day_id: "day2",
  event_binding_id: null,
  section_id: "2.1",
} as const satisfies TutorSessionScopeRequest;

function message(
  messageId: string,
  role: TutorSessionMessageView["role"],
  text: string,
  turnNonce = messageId,
): TutorSessionMessageView {
  return {
    message_id: messageId,
    role,
    status: role === "user" ? "accepted" : "completed",
    text,
    occurred_at: "2026-08-29T20:00:00.000Z",
    turn_nonce: turnNonce,
    turn_id: role === "user" ? null : `turn-${turnNonce}`,
    citations: [],
  };
}

function history(
  scopeKey: string,
  messages: readonly TutorSessionMessageView[],
): TutorSessionHistoryResponse {
  return {
    scope_key: scopeKey,
    chat_id: messages.length === 0 ? null : `chat-${scopeKey}`,
    current_thread_id: messages.length === 0 ? null : `thread-${scopeKey}`,
    thread_segments: messages.length === 0 ? [] : [{
      thread_id: `thread-${scopeKey}`,
      status: "current",
      started_at: "2026-08-29T19:55:00.000Z",
      ended_at: null,
    }],
    messages,
    active_turn: null,
  };
}

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function turnResponse(clientMessageId: string): TutorTurnResponseBody {
  return {
    mode: "live-codex",
    message: "Canonical answer",
    context_hash: "context-hash",
    chat_id: "chat-a",
    thread_id: "thread-a",
    turn_id: "turn-a",
    client_user_message_id: clientMessageId,
    disclosure: null,
  };
}

function submission(
  text: string,
  scope: TutorSessionScopeRequest = A_SCOPE,
): TutorTurnSubmission {
  const common = {
    route_path: scope.context_mode === "today"
      ? `/day/${scope.day_id}/event/${scope.event_binding_id}`
      : `/study/${scope.day_id}/section/${scope.section_id}`,
    day_id: scope.day_id as LearningDayId,
    history_entry_id: "history-1",
    active_tab: "notes" as const,
  };
  return {
    message: text,
    continuity_summaries: [],
    request_ids: scope.context_mode === "today"
      ? {
          ...common,
          context_mode: "today",
          event_binding_id: scope.event_binding_id,
          section_id: null,
          document_id: null,
          material_manifest_revision: null,
        }
      : {
          ...common,
          context_mode: "study",
          event_binding_id: null,
          section_id: scope.section_id,
          document_id: `doc_${"a".repeat(64)}`,
          material_manifest_revision: `sha256:${"b".repeat(64)}`,
        },
    note_draft: {
      note_id: "note-a",
      content: "# Notes\n",
      base_revision: 1,
      save_status: "saved-disk",
    },
  };
}

describe("useTutorSession scope isolation", () => {
  it("keeps A, B, and revisited A histories isolated", async () => {
    const aHistory = history("scope-a", [message("a-user", "user", "Question A")]);
    const bHistory = history("scope-b", [message("b-user", "user", "Question B")]);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("context_mode=today")) return response(aHistory);
      if (url.includes("context_mode=study")) return response(bHistory);
      throw new Error(`Unexpected request: ${url}`);
    });

    const { result, rerender } = renderHook(
      ({ scope }: { scope: TutorSessionScopeRequest }) => useTutorSession({
        enabled: true,
        scope,
        fetch: fetchMock as typeof fetch,
      }),
      { initialProps: { scope: A_SCOPE as TutorSessionScopeRequest } },
    );

    await waitFor(() => expect(result.current.messages.map((item) => item.text)).toEqual(["Question A"]));
    rerender({ scope: B_SCOPE });
    await waitFor(() => expect(result.current.messages.map((item) => item.text)).toEqual(["Question B"]));
    expect(result.current.messages.some((item) => item.text === "Question A")).toBe(false);

    rerender({ scope: A_SCOPE });
    await waitFor(() => expect(result.current.messages.map((item) => item.text)).toEqual(["Question A"]));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("restores persisted history after a hard remount", async () => {
    const persisted = history("scope-a", [
      message("server-user", "user", "Persisted question"),
      message("server-assistant", "assistant", "Persisted answer", "server-user"),
    ]);
    const fetchMock = vi.fn(async () => response(persisted));

    const first = renderHook(() => useTutorSession({
      enabled: true,
      scope: A_SCOPE,
      fetch: fetchMock as typeof fetch,
    }));
    await waitFor(() => expect(first.result.current.messages).toHaveLength(2));
    first.unmount();

    const second = renderHook(() => useTutorSession({
      enabled: true,
      scope: A_SCOPE,
      fetch: fetchMock as typeof fetch,
    }));
    await waitFor(() => expect(second.result.current.messages.map((item) => item.message_id)).toEqual([
      "server-user",
      "server-assistant",
    ]));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("ignores a delayed load from the old scope", async () => {
    const delayedA = deferred<Response>();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("context_mode=today")) return delayedA.promise;
      return Promise.resolve(response(history("scope-b", [message("b", "user", "Only B")] )));
    });
    const { result, rerender } = renderHook(
      ({ scope }: { scope: TutorSessionScopeRequest }) => useTutorSession({
        enabled: true,
        scope,
        fetch: fetchMock as typeof fetch,
      }),
      { initialProps: { scope: A_SCOPE as TutorSessionScopeRequest } },
    );

    rerender({ scope: B_SCOPE });
    await waitFor(() => expect(result.current.messages.map((item) => item.text)).toEqual(["Only B"]));
    await act(async () => {
      delayedA.resolve(response(history("scope-a", [message("a", "user", "Late A")])));
      await delayedA.promise;
    });
    expect(result.current.messages.map((item) => item.text)).toEqual(["Only B"]);
    expect(result.current.history?.scope_key).toBe("scope-b");
  });
});

describe("useTutorSession turn reconciliation", () => {
  it("shows the learner submission immediately while the tutor request is still pending", async () => {
    const post = deferred<Response>();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") return post.promise;
      return Promise.resolve(response(history("scope-a", [])));
    });
    const { result } = renderHook(() => useTutorSession({
      enabled: true,
      scope: A_SCOPE,
      fetch: fetchMock as typeof fetch,
      createId: () => "client-sending",
    }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    let sendPromise!: Promise<boolean>;
    act(() => {
      sendPromise = result.current.send(submission("Still sending"));
    });

    expect(result.current.sending).toBe(true);
    expect(result.current.messages.at(-1)?.turn_nonce).toBe("client-sending");
    expect(result.current.messages.at(-1)?.text).toBe("Still sending");
    expect(result.current.messages.at(-1)?.role).toBe("user");
    expect(result.current.unresolvedMessage).toBeNull();
    expect(JSON.parse(
      window.localStorage.getItem(tutorPendingSubmissionStorageKey("event:event-a")) ?? "null",
    )).toMatchObject({
      clientMessageId: "client-sending",
      learnerText: "Still sending",
    });

    await act(async () => {
      post.resolve(response(turnResponse("client-sending")));
      await sendPromise;
    });
  });

  it("does not expose the server active turn as uncertain", async () => {
    const active = {
      ...history("scope-a", [
        message("saved-user", "user", "Still running", "client-active"),
      ]),
      active_turn: {
        turn_nonce: "client-active",
        state: "running" as const,
        started_at: "2026-08-30T09:00:00.000Z",
      },
    } satisfies TutorSessionHistoryResponse;
    const fetchMock = vi.fn(async () => response(active));
    const firstPage = renderHook(() => useTutorSession({
      enabled: true,
      scope: A_SCOPE,
      fetch: fetchMock as typeof fetch,
    }));

    await waitFor(() => expect(firstPage.result.current.activeTurn?.turn_nonce).toBe("client-active"));
    expect(firstPage.result.current.messages.map((item) => item.text)).toEqual(["Still running"]);
    expect(firstPage.result.current.unresolvedMessage).toBeNull();
    expect(JSON.parse(
      window.localStorage.getItem(tutorPendingSubmissionStorageKey("event:event-a")) ?? "null",
    )).toMatchObject({
      clientMessageId: "client-active",
      learnerText: "Still running",
    });
    firstPage.unmount();

    const terminal = history("scope-a", [
      message("saved-user", "user", "Still running", "client-active"),
      message("saved-assistant", "assistant", "Finished after reload", "client-active"),
    ]);
    const secondPage = renderHook(() => useTutorSession({
      enabled: true,
      scope: A_SCOPE,
      fetch: vi.fn(async () => response(terminal)) as typeof fetch,
    }));
    await waitFor(() => expect(secondPage.result.current.settledSubmission).not.toBeNull());
    expect(secondPage.result.current.settledSubmission).toMatchObject({
      clientMessageId: "client-active",
      learnerText: "Still running",
      clearDraft: true,
    });
  });

  it("reconciles a persisted pending submission after reload and clears its marker only after acknowledgement", async () => {
    const scopeKey = "event:event-a";
    const occurredAt = "2026-08-30T09:00:00.000Z";
    window.localStorage.setItem(tutorPendingSubmissionStorageKey(scopeKey), JSON.stringify({
      version: 1,
      scopeKey,
      clientMessageId: "client-reloaded",
      learnerText: "Exact reloaded submission",
      occurredAt,
    }));
    const learner = {
      ...message("saved-user", "user", "Exact reloaded submission", "client-reloaded"),
      occurred_at: occurredAt,
    };
    const active = {
      ...history(scopeKey, [learner]),
      active_turn: {
        turn_nonce: "client-reloaded",
        state: "running" as const,
        started_at: occurredAt,
      },
    } satisfies TutorSessionHistoryResponse;
    const terminal = history(scopeKey, [
      learner,
      message("saved-assistant", "assistant", "Completed reply", "client-reloaded"),
    ]);
    let completed = false;
    const fetchMock = vi.fn(async () => response(completed ? terminal : active));
    const { result } = renderHook(() => useTutorSession({
      enabled: true,
      scope: A_SCOPE,
      fetch: fetchMock as typeof fetch,
    }));

    await waitFor(() => expect(result.current.activeTurn?.turn_nonce).toBe("client-reloaded"));
    expect(result.current.messages.map((item) => item.text)).toEqual(["Exact reloaded submission"]);
    expect(result.current.settledSubmission).toBeNull();

    completed = true;
    await act(async () => {
      await result.current.reload();
    });

    expect(result.current.activeTurn).toBeNull();
    expect(result.current.settledSubmission).toMatchObject({
      clientMessageId: "client-reloaded",
      learnerText: "Exact reloaded submission",
      clearDraft: true,
    });
    expect(window.localStorage.getItem(tutorPendingSubmissionStorageKey(scopeKey))).not.toBeNull();
    act(() => result.current.acknowledgeSettledSubmission("client-reloaded"));
    expect(result.current.settledSubmission).toBeNull();
    expect(window.localStorage.getItem(tutorPendingSubmissionStorageKey(scopeKey))).toBeNull();
  });

  it("settles a failed submission without clearing the learner draft", async () => {
    const scopeKey = "event:event-a";
    const occurredAt = "2026-08-30T09:00:00.000Z";
    window.localStorage.setItem(tutorPendingSubmissionStorageKey(scopeKey), JSON.stringify({
      version: 1,
      scopeKey,
      clientMessageId: "client-failed",
      learnerText: "Keep this exact failed draft",
      occurredAt,
    }));
    const failed = history(scopeKey, [
      {
        ...message("saved-user", "user", "Keep this exact failed draft", "client-failed"),
        occurred_at: occurredAt,
      },
      {
        ...message("saved-status", "status", "The tutor turn failed.", "client-failed"),
        status: "failed",
        turn_id: null,
      },
    ]);
    const fetchMock = vi.fn(async () => response(failed));
    const { result } = renderHook(() => useTutorSession({
      enabled: true,
      scope: A_SCOPE,
      fetch: fetchMock as typeof fetch,
    }));

    await waitFor(() => expect(result.current.settledSubmission).not.toBeNull());
    expect(result.current.settledSubmission).toMatchObject({
      clientMessageId: "client-failed",
      learnerText: "Keep this exact failed draft",
      clearDraft: false,
    });
    expect(window.localStorage.getItem(tutorPendingSubmissionStorageKey(scopeKey))).not.toBeNull();

    act(() => result.current.acknowledgeSettledSubmission("client-failed"));
    expect(result.current.settledSubmission).toBeNull();
    expect(window.localStorage.getItem(tutorPendingSubmissionStorageKey(scopeKey))).toBeNull();
  });

  it("keeps another scope's completion recoverable across a hard reload", async () => {
    const scopeKey = "event:event-a";
    const occurredAt = "2026-08-30T09:00:00.000Z";
    window.localStorage.setItem(tutorPendingSubmissionStorageKey(scopeKey), JSON.stringify({
      version: 1,
      scopeKey,
      clientMessageId: "client-background",
      learnerText: "Completed while viewing another page",
      occurredAt,
    }));
    const firstPage = renderHook(() => useTutorSession({
      enabled: true,
      scope: B_SCOPE,
      fetch: vi.fn(async () => response(history("study:section:2.1", []))) as typeof fetch,
    }));
    await waitFor(() => expect(firstPage.result.current.loading).toBe(false));
    expect(window.localStorage.getItem(tutorPendingSubmissionStorageKey(scopeKey))).not.toBeNull();
    firstPage.unmount();

    const completed = history(scopeKey, [
      {
        ...message(
          "saved-user",
          "user",
          "Completed while viewing another page",
          "client-background",
        ),
        occurred_at: occurredAt,
      },
      message("saved-assistant", "assistant", "Background reply", "client-background"),
    ]);
    const reloadedPage = renderHook(() => useTutorSession({
      enabled: true,
      scope: A_SCOPE,
      fetch: vi.fn(async () => response(completed)) as typeof fetch,
    }));

    await waitFor(() => expect(reloadedPage.result.current.settledSubmission).not.toBeNull());
    expect(reloadedPage.result.current.settledSubmission).toMatchObject({
      clientMessageId: "client-background",
      learnerText: "Completed while viewing another page",
      clearDraft: true,
    });
    expect(window.localStorage.getItem(tutorPendingSubmissionStorageKey(scopeKey))).not.toBeNull();
  });

  it("polls an active turn without entering the visible loading state", async () => {
    const poll = deferred<Response>();
    const active = {
      ...history("scope-a", [
        message("saved-user", "user", "Still running", "client-active"),
      ]),
      active_turn: {
        turn_nonce: "client-active",
        state: "running" as const,
        started_at: "2026-08-30T09:00:00.000Z",
      },
    } satisfies TutorSessionHistoryResponse;
    let getCount = 0;
    const fetchMock = vi.fn(() => {
      getCount += 1;
      return getCount === 1 ? Promise.resolve(response(active)) : poll.promise;
    });
    const { result } = renderHook(() => useTutorSession({
      enabled: true,
      scope: A_SCOPE,
      fetch: fetchMock as typeof fetch,
    }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2), { timeout: 2_000 });
    expect(result.current.loading).toBe(false);

    await act(async () => {
      poll.resolve(response(active));
      await poll.promise;
    });
  });

  it("keeps polling after a transient silent-poll failure and reaches the terminal history", async () => {
    const terminalPoll = deferred<Response>();
    const active = {
      ...history("scope-a", [
        message("saved-user", "user", "Still running", "client-active"),
      ]),
      active_turn: {
        turn_nonce: "client-active",
        state: "running" as const,
        started_at: "2026-08-30T09:00:00.000Z",
      },
    } satisfies TutorSessionHistoryResponse;
    const terminal = history("scope-a", [
      message("saved-user", "user", "Still running", "client-active"),
      message("saved-assistant", "assistant", "Finished", "client-active"),
    ]);
    let getCount = 0;
    const fetchMock = vi.fn(() => {
      getCount += 1;
      if (getCount === 1) return Promise.resolve(response(active));
      if (getCount === 2) return Promise.reject(new TypeError("temporary disconnect"));
      return terminalPoll.promise;
    });
    const { result } = renderHook(() => useTutorSession({
      enabled: true,
      scope: A_SCOPE,
      fetch: fetchMock as typeof fetch,
    }));

    await waitFor(() => expect(result.current.activeTurn?.turn_nonce).toBe("client-active"));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3), {
      timeout: 4_000,
    });
    expect(result.current.activeTurn?.turn_nonce).toBe("client-active");
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    await act(async () => {
      terminalPoll.resolve(response(terminal));
      await terminalPoll.promise;
    });
    await waitFor(() => expect(result.current.activeTurn).toBeNull());
    expect(result.current.messages.at(-1)?.text).toBe("Finished");
    expect(result.current.unresolvedMessage).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("retains exact optimistic text and reconciles it to canonical server message IDs", async () => {
    const post = deferred<Response>();
    const canonical = history("scope-a", [
      message("server-user-id", "user", "  exact learner text  ", "client-1"),
      message("server-assistant-id", "assistant", "Canonical answer", "client-1"),
    ]);
    let getCount = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") return post.promise;
      getCount += 1;
      return Promise.resolve(response(getCount === 1 ? history("scope-a", []) : canonical));
    });
    const { result } = renderHook(() => useTutorSession({
      enabled: true,
      scope: A_SCOPE,
      fetch: fetchMock as typeof fetch,
      createId: () => "client-1",
    }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    let sendPromise!: Promise<boolean>;
    act(() => {
      sendPromise = result.current.send(submission("  exact learner text  "));
    });
    expect(result.current.messages.at(-1)?.text).toBe("  exact learner text  ");
    expect(result.current.messages.at(-1)?.message_id).toBe("pending:client-1");

    await act(async () => {
      post.resolve(response(turnResponse("client-1")));
      await sendPromise;
    });
    await waitFor(() => expect(result.current.messages.map((item) => item.message_id)).toEqual([
      "server-user-id",
      "server-assistant-id",
    ]));
    expect(result.current.settledSubmission).toMatchObject({
      clientMessageId: "client-1",
      learnerText: "  exact learner text  ",
      clearDraft: true,
    });
    expect(
      window.localStorage.getItem(tutorPendingSubmissionStorageKey("event:event-a")),
    ).not.toBeNull();
    act(() => result.current.acknowledgeSettledSubmission("client-1"));
    expect(result.current.settledSubmission).toBeNull();
    expect(
      window.localStorage.getItem(tutorPendingSubmissionStorageKey("event:event-a")),
    ).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it("recovers a response-lost network error from canonical history", async () => {
    const canonical = history("scope-a", [
      message("recovered-user", "user", "Was this recorded?", "client-lost"),
      message("recovered-assistant", "assistant", "Yes.", "client-lost"),
    ]);
    let getCount = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") throw new TypeError("network response lost");
      getCount += 1;
      return response(getCount === 1 ? history("scope-a", []) : canonical);
    });
    const { result } = renderHook(() => useTutorSession({
      enabled: true,
      scope: A_SCOPE,
      fetch: fetchMock as typeof fetch,
      createId: () => "client-lost",
    }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.send(submission("Was this recorded?"));
    });
    expect(result.current.messages.map((item) => item.message_id)).toEqual([
      "recovered-user",
      "recovered-assistant",
    ]);
    expect(result.current.error).toBeNull();
    expect(result.current.messages.some((item) => item.role === "status")).toBe(false);
  });

  it("never posts again while both POST and canonical history are uncertain", async () => {
    let getCount = 0;
    const postedIds: string[] = [];
    const createId = vi.fn(() => "client-uncertain");
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { client_user_message_id: string };
        postedIds.push(body.client_user_message_id);
        throw new TypeError("network response lost");
      }
      getCount += 1;
      if (getCount === 1) return response(history("scope-a", []));
      throw new TypeError("history unavailable");
    });
    const { result } = renderHook(() => useTutorSession({
      enabled: true,
      scope: A_SCOPE,
      fetch: fetchMock as typeof fetch,
      createId,
    }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.send(submission("Was this delivered?"));
    });
    await act(async () => {
      await result.current.send(submission("Was this delivered?"));
    });

    expect(postedIds).toEqual(["client-uncertain"]);
    expect(createId).toHaveBeenCalledTimes(1);
    expect(result.current.unresolvedMessage?.text).toBe("Was this delivered?");
    expect(result.current.error).toMatch(/explicitly abandon/i);
  });

  it("exposes and explicitly abandons exact text when the POST failed before a WAL record", async () => {
    let turnPosts = 0;
    let abandonBody: Record<string, unknown> | null = null;
    const ids = ["client-pre-wal", "client-after-abandon"];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST" && String(input) === "/api/tutor/turns") {
        turnPosts += 1;
        return response({ error: "The request was rejected before dispatch" }, 503);
      }
      if (
        init?.method === "POST"
        && String(input) === "/api/tutor/session/abandon-uncertain"
      ) {
        abandonBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return response({ status: "abandoned", restore_text: true });
      }
      return response(history("scope-a", []));
    });
    const { result } = renderHook(() => useTutorSession({
      enabled: true,
      scope: A_SCOPE,
      fetch: fetchMock as typeof fetch,
      createId: () => ids.shift() ?? "unexpected-id",
    }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.send(submission("  exact text retained before WAL  "));
    });
    const retainedText = result.current.unresolvedMessage?.text;
    expect(retainedText).toBe("  exact text retained before WAL  ");

    await act(async () => {
      await result.current.send(submission("A blocked replacement"));
    });
    expect(turnPosts).toBe(1);
    expect(result.current.error).toMatch(/previous tutor message/i);

    let resolution: AbandonUncertainTutorTurnResponseBody | false = false;
    await act(async () => {
      resolution = await result.current.abandonUnresolved();
    });

    expect(resolution).toEqual({ status: "abandoned", restore_text: true });
    expect(abandonBody).toMatchObject({
      scope: A_SCOPE,
      turn_nonce: "client-pre-wal",
      acknowledge_duplicate_risk: true,
    });
    expect(result.current.unresolvedMessage).toBeNull();
    expect(result.current.messages).toEqual([]);

    await act(async () => {
      await result.current.send(submission(retainedText ?? ""));
    });
    expect(turnPosts).toBe(2);
    expect(result.current.unresolvedMessage?.text).toBe("  exact text retained before WAL  ");
  });

  it("does not send different text while an earlier delivery is uncertain", async () => {
    let getCount = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") throw new TypeError("network response lost");
      getCount += 1;
      if (getCount === 1) return response(history("scope-a", []));
      throw new TypeError("history unavailable");
    });
    const { result } = renderHook(() => useTutorSession({
      enabled: true,
      scope: A_SCOPE,
      fetch: fetchMock as typeof fetch,
      createId: () => "client-uncertain",
    }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.send(submission("First text"));
    });
    await act(async () => {
      await result.current.send(submission("Different text"));
    });

    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(result.current.error).toMatch(/previous tutor message/i);
  });

  it("requires an explicit acknowledged abandon before clearing an unresolved message", async () => {
    const unresolved = history("scope-a", [
      message("saved-user", "user", "Uncertain text", "client-uncertain"),
    ]);
    const resolved = history("scope-a", [
      ...unresolved.messages,
      {
        message_id: "status-abandoned",
        role: "status",
        status: "failed",
        text: "You chose to stop waiting.",
        occurred_at: "2026-08-29T20:01:00.000Z",
        turn_nonce: "client-uncertain",
        turn_id: null,
        citations: [],
      },
    ]);
    let getCount = 0;
    let abandonBody: Record<string, unknown> | null = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        expect(String(input)).toBe("/api/tutor/session/abandon-uncertain");
        abandonBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return response({ status: "abandoned", restore_text: true });
      }
      getCount += 1;
      return response(getCount === 1 ? unresolved : resolved);
    });
    const { result } = renderHook(() => useTutorSession({
      enabled: true,
      scope: A_SCOPE,
      fetch: fetchMock as typeof fetch,
    }));
    await waitFor(() => expect(result.current.unresolvedMessage?.text).toBe("Uncertain text"));

    let resolution: AbandonUncertainTutorTurnResponseBody | false = false;
    await act(async () => {
      resolution = await result.current.abandonUnresolved();
    });

    expect(resolution).toEqual({ status: "abandoned", restore_text: true });
    expect(abandonBody).toMatchObject({
      turn_nonce: "client-uncertain",
      acknowledge_duplicate_risk: true,
      scope: A_SCOPE,
    });
    expect(result.current.unresolvedMessage).toBeNull();
  });

  it("does not let a delayed abandon from scope A disrupt scope B", async () => {
    const abandon = deferred<Response>();
    const aHistory = history("scope-a", [
      message("saved-user", "user", "Uncertain A", "client-a"),
    ]);
    const bHistory = history("scope-b", [message("b-user", "user", "Only B", "client-b")]);
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") return abandon.promise;
      const url = String(input);
      return Promise.resolve(response(
        url.includes("context_mode=today") ? aHistory : bHistory,
      ));
    });
    const { result, rerender } = renderHook(
      ({ scope }: { scope: TutorSessionScopeRequest }) => useTutorSession({
        enabled: true,
        scope,
        fetch: fetchMock as typeof fetch,
      }),
      { initialProps: { scope: A_SCOPE as TutorSessionScopeRequest } },
    );
    await waitFor(() => expect(result.current.unresolvedMessage?.text).toBe("Uncertain A"));

    let resolution!: Promise<AbandonUncertainTutorTurnResponseBody | false>;
    act(() => {
      resolution = result.current.abandonUnresolved();
    });
    rerender({ scope: B_SCOPE });
    await waitFor(() => expect(result.current.messages.map((item) => item.text)).toEqual(["Only B"]));

    await act(async () => {
      abandon.resolve(response({ status: "abandoned", restore_text: true }));
      await resolution;
    });
    expect(result.current.history?.scope_key).toBe("scope-b");
    expect(result.current.messages.map((item) => item.text)).toEqual(["Only B"]);
    expect(result.current.loading).toBe(false);
  });

  it("does not POST twice when Send is clicked again during an active turn", async () => {
    const post = deferred<Response>();
    let getCount = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") return post.promise;
      getCount += 1;
      return Promise.resolve(response(
        getCount === 1
          ? history("scope-a", [])
          : history("scope-a", [message("saved-user", "user", "One", "client-one")]),
      ));
    });
    const { result } = renderHook(() => useTutorSession({
      enabled: true,
      scope: A_SCOPE,
      fetch: fetchMock as typeof fetch,
      createId: () => "client-one",
    }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      first = result.current.send(submission("One"));
      second = result.current.send(submission("Two"));
    });
    await expect(second).resolves.toBe(false);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);

    await act(async () => {
      post.resolve(response(turnResponse("client-one")));
      await first;
    });
    expect(result.current.sending).toBe(false);
  });

  it("requests an authoritative stop for the exact active nonce", async () => {
    let stopBody: StopTutorTurnRequestBody | null = null;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/tutor/turns/stop") {
        stopBody = JSON.parse(String(init?.body)) as StopTutorTurnRequestBody;
        return Promise.resolve(response({ status: "stopping" }));
      }
      return Promise.resolve(response({
        ...history("scope-a", []),
        active_turn: {
          turn_nonce: "server-active-turn",
          state: "running",
          started_at: "2026-08-30T09:00:00.000Z",
        },
      } satisfies TutorSessionHistoryResponse));
    });
    const { result } = renderHook(() => useTutorSession({
      enabled: true,
      scope: A_SCOPE,
      fetch: fetchMock as typeof fetch,
      createId: () => "client-stop",
    }));
    await waitFor(() => expect(result.current.activeTurn?.state).toBe("running"));
    await act(async () => {
      await result.current.stopActive();
    });

    expect(stopBody).toEqual({
      scope: A_SCOPE,
      turn_nonce: "server-active-turn",
    });
    expect(result.current.stopping).toBe(false);
  });
});
