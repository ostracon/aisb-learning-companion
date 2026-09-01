import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  AbandonUncertainTutorTurnRequestBody,
  AbandonUncertainTutorTurnResponseBody,
  StopTutorTurnRequestBody,
  StopTutorTurnResponseBody,
  TutorSessionHistoryResponse,
  TutorSessionMessageView,
  TutorSessionScopeRequest,
  TutorTurnRequestBody,
  TutorTurnResponseBody,
} from "../../shared/api.js";

export type TutorTurnSubmission = Omit<TutorTurnRequestBody, "client_user_message_id">;

export interface UseTutorSessionOptions {
  readonly enabled: boolean;
  readonly scope: TutorSessionScopeRequest | null;
  readonly fetch?: typeof globalThis.fetch;
  readonly createId?: () => string;
}

interface PendingMessage {
  readonly scopeKey: string;
  readonly message: TutorSessionMessageView;
}

interface PendingSubmission {
  readonly scopeKey: string;
  readonly clientMessageId: string;
  readonly learnerText: string;
  readonly occurredAt: string;
}

interface ScopedNotice {
  readonly scopeKey: string;
  readonly text: string;
}

export interface SettledTutorSubmission extends PendingSubmission {
  readonly clearDraft: boolean;
}

class TutorApiError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
    readonly currentManifestRevision: string | null,
  ) {
    super(message);
    this.name = "TutorApiError";
  }
}

const PENDING_SUBMISSION_STORAGE_VERSION = 1;

export function tutorPendingSubmissionStorageKey(scopeKey: string): string {
  return `aisb-companion:tutor-pending:${scopeKey}`;
}

function readPendingSubmission(scopeKey: string): PendingSubmission | undefined {
  try {
    const raw = window.localStorage.getItem(tutorPendingSubmissionStorageKey(scopeKey));
    if (raw === null) return undefined;
    const value = JSON.parse(raw) as unknown;
    if (
      !isRecord(value)
      || value.version !== PENDING_SUBMISSION_STORAGE_VERSION
      || value.scopeKey !== scopeKey
      || typeof value.clientMessageId !== "string"
      || typeof value.learnerText !== "string"
      || !isIsoDate(value.occurredAt)
    ) {
      window.localStorage.removeItem(tutorPendingSubmissionStorageKey(scopeKey));
      return undefined;
    }
    return {
      scopeKey,
      clientMessageId: value.clientMessageId,
      learnerText: value.learnerText,
      occurredAt: value.occurredAt,
    };
  } catch {
    return undefined;
  }
}

function persistPendingSubmission(pending: PendingSubmission): void {
  try {
    window.localStorage.setItem(tutorPendingSubmissionStorageKey(pending.scopeKey), JSON.stringify({
      version: PENDING_SUBMISSION_STORAGE_VERSION,
      ...pending,
    }));
  } catch {
    // The separate scoped composer draft remains the recovery copy when this
    // additional submission marker cannot be persisted.
  }
}

function clearPersistedPendingSubmission(scopeKey: string, clientMessageId: string): void {
  try {
    const pending = readPendingSubmission(scopeKey);
    if (pending?.clientMessageId === clientMessageId) {
      window.localStorage.removeItem(tutorPendingSubmissionStorageKey(scopeKey));
    }
  } catch {
    // A stale marker is harmless: canonical history is still authoritative.
  }
}

const defaultFetch: typeof globalThis.fetch = (input, init) => globalThis.fetch(input, init);
const defaultCreateId = () => globalThis.crypto.randomUUID();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function asHistory(value: unknown): TutorSessionHistoryResponse {
  if (!isRecord(value)) throw new Error("The tutor history service returned malformed data");
  if (
    typeof value.scope_key !== "string"
    || (value.chat_id !== null && typeof value.chat_id !== "string")
    || (value.current_thread_id !== null && typeof value.current_thread_id !== "string")
    || !Array.isArray(value.thread_segments)
    || !Array.isArray(value.messages)
    || (
      value.active_turn !== null
      && (
        !isRecord(value.active_turn)
        || typeof value.active_turn.turn_nonce !== "string"
        || !["preparing", "running", "stopping"].includes(String(value.active_turn.state))
        || !isIsoDate(value.active_turn.started_at)
      )
    )
  ) {
    throw new Error("The tutor history service returned malformed data");
  }

  for (const segment of value.thread_segments) {
    if (
      !isRecord(segment)
      || typeof segment.thread_id !== "string"
      || (segment.status !== "current" && segment.status !== "replaced")
      || !isIsoDate(segment.started_at)
      || (segment.ended_at !== null && !isIsoDate(segment.ended_at))
    ) {
      throw new Error("The tutor history service returned a malformed thread segment");
    }
  }

  for (const message of value.messages) {
    if (
      !isRecord(message)
      || typeof message.message_id !== "string"
      || !["user", "assistant", "status"].includes(String(message.role))
      || !["accepted", "completed", "failed"].includes(String(message.status))
      || typeof message.text !== "string"
      || !isIsoDate(message.occurred_at)
      || typeof message.turn_nonce !== "string"
      || (message.turn_id !== null && typeof message.turn_id !== "string")
      || !Array.isArray(message.citations)
    ) {
      throw new Error("The tutor history service returned a malformed message");
    }
    for (const citation of message.citations) {
      if (!isRecord(citation) || typeof citation.label !== "string" || typeof citation.url !== "string") {
        throw new Error("The tutor history service returned a malformed citation");
      }
    }
  }

  return value as unknown as TutorSessionHistoryResponse;
}

function asTurnResponse(value: unknown, expectedClientMessageId: string): TutorTurnResponseBody {
  if (!isRecord(value)) throw new Error("The tutor returned malformed turn data");
  if (
    value.mode !== "live-codex"
    || typeof value.message !== "string"
    || typeof value.context_hash !== "string"
    || typeof value.chat_id !== "string"
    || typeof value.thread_id !== "string"
    || typeof value.turn_id !== "string"
    || value.client_user_message_id !== expectedClientMessageId
  ) {
    throw new Error("The tutor returned malformed turn data");
  }
  return value as unknown as TutorTurnResponseBody;
}

function scopeIdentity(scope: TutorSessionScopeRequest): string {
  if (scope.context_mode === "study") return `study:section:${scope.section_id}`;
  return scope.event_binding_id === null
    ? `day:${scope.day_id}`
    : `event:${scope.event_binding_id}`;
}

function historyUrl(scope: TutorSessionScopeRequest): string {
  const query = new URLSearchParams();
  query.set("context_mode", scope.context_mode);
  query.set("day_id", scope.day_id);
  if (scope.context_mode === "today") {
    query.set("event_binding_id", scope.event_binding_id ?? "");
  } else {
    query.set("section_id", scope.section_id);
  }
  return `/api/tutor/session?${query.toString()}`;
}

function submissionMatchesScope(
  submission: TutorTurnSubmission,
  scope: TutorSessionScopeRequest,
): boolean {
  if (
    submission.request_ids.context_mode !== scope.context_mode
    || submission.request_ids.day_id !== scope.day_id
  ) {
    return false;
  }
  return scope.context_mode === "today"
    ? submission.request_ids.context_mode === "today"
      && submission.request_ids.event_binding_id === scope.event_binding_id
    : submission.request_ids.context_mode === "study"
      && submission.request_ids.section_id === scope.section_id;
}

function responseError(response: Response, fallback: string): Promise<TutorApiError> {
  return response.json()
    .then((value: unknown) => {
      if (!isRecord(value)) return new TutorApiError(fallback, null, null);
      return new TutorApiError(
        typeof value.error === "string" ? value.error : fallback,
        typeof value.code === "string" ? value.code : null,
        typeof value.current_manifest_revision === "string"
          ? value.current_manifest_revision
          : null,
      );
    })
    .catch(() => new TutorApiError(fallback, null, null));
}

function errorText(reason: unknown, fallback: string): string {
  return reason instanceof Error ? reason.message : fallback;
}

function isAbort(reason: unknown): boolean {
  return reason instanceof DOMException && reason.name === "AbortError";
}

function isPreDispatchStaleManifest(reason: unknown): reason is TutorApiError {
  return reason instanceof TutorApiError && reason.code === "stale_manifest";
}

function isConfirmedPreDispatchFailure(reason: unknown): reason is TutorApiError {
  return reason instanceof TutorApiError && reason.code === "tutor_not_dispatched";
}

function hasSubmission(history: TutorSessionHistoryResponse, turnNonce: string): boolean {
  return history.messages.some(
    (message) => message.turn_nonce === turnNonce && message.role === "user",
  );
}

function hasTerminal(history: TutorSessionHistoryResponse, turnNonce: string): boolean {
  return history.messages.some(
    (message) => message.turn_nonce === turnNonce && message.role !== "user",
  );
}

function hasCompletion(history: TutorSessionHistoryResponse, turnNonce: string): boolean {
  return history.messages.some(
    (message) => message.turn_nonce === turnNonce && message.role === "assistant",
  );
}

function latestUnresolvedSubmission(
  history: TutorSessionHistoryResponse,
): TutorSessionMessageView | null {
  const terminalNonces = new Set(
    history.messages
      .filter((message) => message.role !== "user")
      .map((message) => message.turn_nonce),
  );
  return [...history.messages]
    .reverse()
    .find((message) => message.role === "user" && !terminalNonces.has(message.turn_nonce))
    ?? null;
}

/**
 * Keeps the visible tutor transcript bound to one calendar/repository scope.
 * The server history is authoritative; optimistic text exists only to bridge a
 * POST and its mandatory canonical history reconciliation.
 */
export function useTutorSession(options: UseTutorSessionOptions) {
  const fetchImpl = options.fetch ?? defaultFetch;
  const createId = options.createId ?? defaultCreateId;
  const activeScope = options.enabled ? options.scope : null;
  const activeScopeKey = activeScope === null ? null : scopeIdentity(activeScope);

  const [history, setHistory] = useState<TutorSessionHistoryResponse | null>(null);
  const [historyScopeKey, setHistoryScopeKey] = useState<string | null>(null);
  const [lastTurnResponse, setLastTurnResponse] = useState<TutorTurnResponseBody | null>(null);
  const [optimistic, setOptimistic] = useState<PendingMessage | null>(null);
  const [ephemeralStatus, setEphemeralStatus] = useState<PendingMessage | null>(null);
  const [loading, setLoading] = useState(activeScope !== null);
  const [sending, setSending] = useState(false);
  const [resolvingUncertain, setResolvingUncertain] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settledSubmission, setSettledSubmission] = useState<SettledTutorSubmission | null>(null);
  const [materialRefreshRequest, setMaterialRefreshRequest] = useState(0);
  const [materialRefreshNotice, setMaterialRefreshNotice] = useState<ScopedNotice | null>(null);

  const inputRef = useRef({ scope: activeScope, scopeKey: activeScopeKey });
  inputRef.current = { scope: activeScope, scopeKey: activeScopeKey };
  const historyCacheRef = useRef(new Map<string, TutorSessionHistoryResponse>());
  const responseByScopeRef = useRef(new Map<string, TutorTurnResponseBody>());
  const optimisticByScopeRef = useRef(new Map<string, PendingMessage>());
  const pendingSubmissionByScopeRef = useRef(new Map<string, PendingSubmission>());
  const settledSubmissionByScopeRef = useRef(new Map<string, SettledTutorSubmission>());
  const ephemeralByScopeRef = useRef(new Map<string, PendingMessage>());
  const routeGenerationRef = useRef(0);
  const loadSequenceRef = useRef(0);
  const visibleLoadControllerRef = useRef<AbortController | null>(null);
  const sendingRef = useRef(false);
  const resolvingUncertainRef = useRef(false);
  const stoppingRef = useRef(false);

  const settlePendingSubmission = useCallback((
    pending: PendingSubmission,
    clearDraft: boolean,
  ): void => {
    pendingSubmissionByScopeRef.current.delete(pending.scopeKey);
    const settled = { ...pending, clearDraft } satisfies SettledTutorSubmission;
    settledSubmissionByScopeRef.current.set(pending.scopeKey, settled);
    if (inputRef.current.scopeKey === pending.scopeKey) {
      setSettledSubmission(settled);
    }
  }, []);

  const readHistory = useCallback(async (
    scope: TutorSessionScopeRequest,
    signal?: AbortSignal,
  ): Promise<TutorSessionHistoryResponse> => {
    const response = await fetchImpl(
      historyUrl(scope),
      signal === undefined ? undefined : { signal },
    );
    if (!response.ok) throw await responseError(response, "Could not read tutor history");
    return asHistory(await response.json());
  }, [fetchImpl]);

  const loadVisibleHistory = useCallback(async (
    scope: TutorSessionScopeRequest,
    scopeKey: string,
    generation: number,
    silent = false,
  ): Promise<boolean> => {
    const sequence = ++loadSequenceRef.current;
    visibleLoadControllerRef.current?.abort();
    const controller = new AbortController();
    visibleLoadControllerRef.current = controller;
    if (!silent) {
      setLoading(true);
      setError(null);
    }
    try {
      const canonical = await readHistory(scope, controller.signal);
      historyCacheRef.current.set(scopeKey, canonical);
      if (
        generation !== routeGenerationRef.current
        || sequence !== loadSequenceRef.current
        || inputRef.current.scopeKey !== scopeKey
      ) {
        return false;
      }
      setHistoryScopeKey(scopeKey);
      setHistory(canonical);
      const pending = optimisticByScopeRef.current.get(scopeKey);
      if (pending && hasSubmission(canonical, pending.message.turn_nonce)) {
        optimisticByScopeRef.current.delete(scopeKey);
        setOptimistic(null);
      }
      const pendingSubmission = pendingSubmissionByScopeRef.current.get(scopeKey);
      if (
        pendingSubmission !== undefined
        && hasTerminal(canonical, pendingSubmission.clientMessageId)
      ) {
        settlePendingSubmission(
          pendingSubmission,
          hasCompletion(canonical, pendingSubmission.clientMessageId),
        );
      } else if (pendingSubmission === undefined) {
        const unresolved = latestUnresolvedSubmission(canonical);
        if (unresolved !== null) {
          const reconstructedPending = {
            scopeKey,
            clientMessageId: unresolved.turn_nonce,
            learnerText: unresolved.text,
            occurredAt: unresolved.occurred_at,
          } satisfies PendingSubmission;
          pendingSubmissionByScopeRef.current.set(scopeKey, reconstructedPending);
          persistPendingSubmission(reconstructedPending);
        }
      }
      ephemeralByScopeRef.current.delete(scopeKey);
      setEphemeralStatus(null);
      if (!silent) setError(null);
      return true;
    } catch (reason) {
      if (isAbort(reason)) return false;
      if (
        !silent
        && generation === routeGenerationRef.current
        && sequence === loadSequenceRef.current
        && inputRef.current.scopeKey === scopeKey
      ) {
        setError(errorText(reason, "Could not read tutor history"));
      }
      return false;
    } finally {
      if (
        !silent
        && generation === routeGenerationRef.current
        && sequence === loadSequenceRef.current
        && inputRef.current.scopeKey === scopeKey
      ) {
        setLoading(false);
      }
      if (visibleLoadControllerRef.current === controller) {
        visibleLoadControllerRef.current = null;
      }
    }
  }, [readHistory, settlePendingSubmission]);

  useEffect(() => {
    const generation = ++routeGenerationRef.current;
    visibleLoadControllerRef.current?.abort();
    ++loadSequenceRef.current;

    if (activeScope === null || activeScopeKey === null) {
      setHistoryScopeKey(null);
      setHistory(null);
      setLastTurnResponse(null);
      setOptimistic(null);
      setEphemeralStatus(null);
      setSettledSubmission(null);
      setLoading(false);
      setError(null);
      return;
    }

    const persistedPending = readPendingSubmission(activeScopeKey);
    if (
      persistedPending !== undefined
      && !pendingSubmissionByScopeRef.current.has(activeScopeKey)
      && !settledSubmissionByScopeRef.current.has(activeScopeKey)
    ) {
      pendingSubmissionByScopeRef.current.set(activeScopeKey, persistedPending);
      optimisticByScopeRef.current.set(activeScopeKey, {
        scopeKey: activeScopeKey,
        message: {
          message_id: `pending:${persistedPending.clientMessageId}`,
          role: "user",
          status: "accepted",
          text: persistedPending.learnerText,
          occurred_at: persistedPending.occurredAt,
          turn_nonce: persistedPending.clientMessageId,
          turn_id: null,
          citations: [],
        },
      });
    }
    setHistoryScopeKey(activeScopeKey);
    setHistory(historyCacheRef.current.get(activeScopeKey) ?? null);
    setLastTurnResponse(responseByScopeRef.current.get(activeScopeKey) ?? null);
    setOptimistic(optimisticByScopeRef.current.get(activeScopeKey) ?? null);
    setEphemeralStatus(ephemeralByScopeRef.current.get(activeScopeKey) ?? null);
    setSettledSubmission(settledSubmissionByScopeRef.current.get(activeScopeKey) ?? null);
    void loadVisibleHistory(activeScope, activeScopeKey, generation);

    return () => {
      if (generation === routeGenerationRef.current) {
        visibleLoadControllerRef.current?.abort();
      }
    };
  // The serialized key deliberately prevents equivalent scope objects from
  // restarting the load on every render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeScopeKey, loadVisibleHistory]);

  useEffect(() => {
    if (
      activeScopeKey !== null
      && materialRefreshNotice !== null
      && materialRefreshNotice.scopeKey !== activeScopeKey
    ) {
      setMaterialRefreshNotice(null);
    }
  }, [activeScopeKey, materialRefreshNotice]);

  const reload = useCallback(async (): Promise<boolean> => {
    const current = inputRef.current;
    if (current.scope === null || current.scopeKey === null) return false;
    return loadVisibleHistory(
      current.scope,
      current.scopeKey,
      routeGenerationRef.current,
    );
  }, [loadVisibleHistory]);

  const visibleHistory = historyScopeKey === activeScopeKey ? history : null;
  const activeTurn = visibleHistory?.active_turn ?? null;

  useEffect(() => {
    if (
      activeScope === null
      || activeScopeKey === null
      || loading
      || (!sending && activeTurn === null)
    ) {
      return;
    }
    const generation = routeGenerationRef.current;
    const timer = window.setInterval(() => {
      if (inputRef.current.scopeKey !== activeScopeKey) return;
      if (visibleLoadControllerRef.current !== null) return;
      void loadVisibleHistory(activeScope, activeScopeKey, generation, true);
    }, 1_500);
    return () => window.clearInterval(timer);
  }, [activeScope, activeScopeKey, activeTurn, loadVisibleHistory, loading, sending]);

  const send = useCallback(async (submission: TutorTurnSubmission): Promise<boolean> => {
    const current = inputRef.current;
    if (current.scope === null || current.scopeKey === null || sendingRef.current) return false;
    if (!submission.message.trim()) return false;
    if (!submissionMatchesScope(submission, current.scope)) {
      setError("The tutor page changed before Send. Re-open the current session and try again.");
      return false;
    }

    const submittedScope = current.scope;
    const submittedScopeKey = current.scopeKey;
    const unresolved = pendingSubmissionByScopeRef.current.get(submittedScopeKey);
    if (unresolved !== undefined) {
      setError(
        "A previous tutor message still has an uncertain delivery state. Check again or explicitly abandon it before sending another message.",
      );
      return false;
    }
    const clientMessageId = createId();
    const occurredAt = new Date().toISOString();
    const submissionForRequest = submission;
    const pendingSubmission: PendingSubmission = {
      scopeKey: submittedScopeKey,
      clientMessageId,
      learnerText: submissionForRequest.message,
      occurredAt,
    };
    pendingSubmissionByScopeRef.current.set(submittedScopeKey, pendingSubmission);
    persistPendingSubmission(pendingSubmission);
    settledSubmissionByScopeRef.current.delete(submittedScopeKey);
    setSettledSubmission(null);
    const pending: PendingMessage = optimisticByScopeRef.current.get(submittedScopeKey) ?? {
      scopeKey: submittedScopeKey,
      message: {
        message_id: `pending:${clientMessageId}`,
        role: "user",
        status: "accepted",
        text: submissionForRequest.message,
        occurred_at: occurredAt,
        turn_nonce: clientMessageId,
        turn_id: null,
        citations: [],
      },
    };
    optimisticByScopeRef.current.set(submittedScopeKey, pending);
    ephemeralByScopeRef.current.delete(submittedScopeKey);
    setOptimistic(pending);
    setEphemeralStatus(null);
    setError(null);
    setMaterialRefreshNotice(null);
    sendingRef.current = true;
    setSending(true);

    let postError: unknown = null;
    let turnResponse: TutorTurnResponseBody | null = null;
    try {
      const response = await fetchImpl("/api/tutor/turns", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...submissionForRequest,
          client_user_message_id: clientMessageId,
        } satisfies TutorTurnRequestBody),
      });
      if (!response.ok) throw await responseError(response, "The tutor turn failed");
      turnResponse = asTurnResponse(await response.json(), clientMessageId);
      responseByScopeRef.current.set(submittedScopeKey, turnResponse);
    } catch (reason) {
      postError = reason;
    }

    let canonical: TutorSessionHistoryResponse | null = null;
    let historyError: unknown = null;
    try {
      canonical = await readHistory(submittedScope);
      historyCacheRef.current.set(submittedScopeKey, canonical);
      if (hasSubmission(canonical, clientMessageId)) {
        optimisticByScopeRef.current.delete(submittedScopeKey);
      }
      if (hasTerminal(canonical, clientMessageId)) {
        settlePendingSubmission(pendingSubmission, hasCompletion(canonical, clientMessageId));
      }
      ephemeralByScopeRef.current.delete(submittedScopeKey);
    } catch (reason) {
      historyError = reason;
      const status: PendingMessage = {
        scopeKey: submittedScopeKey,
        message: {
          message_id: `status:${clientMessageId}`,
          role: "status",
          status: "failed",
          text: "Could not confirm whether this turn was recorded. Your text is retained here; reload history before retrying.",
          occurred_at: new Date().toISOString(),
          turn_nonce: clientMessageId,
          turn_id: null,
          citations: [],
        },
      };
      ephemeralByScopeRef.current.set(submittedScopeKey, status);
    }

    const rejectedBeforeDispatch = canonical !== null
      && postError !== null
      && (
        isPreDispatchStaleManifest(postError)
        || isConfirmedPreDispatchFailure(postError)
      )
      && !hasSubmission(canonical, clientMessageId);
    if (rejectedBeforeDispatch) {
      const staleManifestRejectedBeforeDispatch = isPreDispatchStaleManifest(postError);
      pendingSubmissionByScopeRef.current.delete(submittedScopeKey);
      clearPersistedPendingSubmission(submittedScopeKey, clientMessageId);
      optimisticByScopeRef.current.delete(submittedScopeKey);
      ephemeralByScopeRef.current.delete(submittedScopeKey);
      settledSubmissionByScopeRef.current.delete(submittedScopeKey);
      if (inputRef.current.scopeKey === submittedScopeKey) {
        setHistoryScopeKey(submittedScopeKey);
        setHistory(canonical);
        setOptimistic(null);
        setEphemeralStatus(null);
        setSettledSubmission(null);
        setError(
          staleManifestRejectedBeforeDispatch
            ? null
            : errorText(postError, "The tutor is temporarily unavailable. No message was sent; retry when ready."),
        );
        if (staleManifestRejectedBeforeDispatch) {
          setMaterialRefreshNotice({
            scopeKey: submittedScopeKey,
            text: "Course material changed on disk. The page context is refreshing; your message remains in the composer. Send it again when ready.",
          });
          setMaterialRefreshRequest((request) => request + 1);
        }
      }
      sendingRef.current = false;
      setSending(false);
      return false;
    }

    if (inputRef.current.scopeKey === submittedScopeKey) {
      if (canonical !== null) {
        setHistoryScopeKey(submittedScopeKey);
        setHistory(canonical);
        const remaining = optimisticByScopeRef.current.get(submittedScopeKey) ?? null;
        setOptimistic(remaining);
        setEphemeralStatus(null);
        if (turnResponse !== null) setLastTurnResponse(turnResponse);
        setError(
          !hasTerminal(canonical, clientMessageId) && postError !== null
            ? errorText(postError, "The tutor turn failed")
            : null,
        );
      } else {
        setOptimistic(optimisticByScopeRef.current.get(submittedScopeKey) ?? null);
        setEphemeralStatus(ephemeralByScopeRef.current.get(submittedScopeKey) ?? null);
        setError(errorText(historyError, "Could not confirm tutor history"));
      }
    }

    sendingRef.current = false;
    setSending(false);
    return canonical !== null && hasCompletion(canonical, clientMessageId);
  }, [createId, fetchImpl, readHistory, settlePendingSubmission]);

  const abandonUnresolved = useCallback(async (): Promise<
    AbandonUncertainTutorTurnResponseBody | false
  > => {
    const current = inputRef.current;
    const generation = routeGenerationRef.current;
    if (
      current.scope === null
      || current.scopeKey === null
      || sendingRef.current
      || resolvingUncertainRef.current
    ) {
      return false;
    }
    const pending = pendingSubmissionByScopeRef.current.get(current.scopeKey);
    if (pending === undefined) return false;

    resolvingUncertainRef.current = true;
    setResolvingUncertain(true);
    setError(null);
    try {
      const body = {
        scope: current.scope,
        turn_nonce: pending.clientMessageId,
        acknowledge_duplicate_risk: true,
      } satisfies AbandonUncertainTutorTurnRequestBody;
      const response = await fetchImpl("/api/tutor/session/abandon-uncertain", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        throw await responseError(response, "Could not resolve the uncertain tutor message");
      }
      const value = await response.json() as unknown;
      if (
        !isRecord(value)
        || (value.status !== "abandoned" && value.status !== "recovered")
        || typeof value.restore_text !== "boolean"
      ) {
        throw new Error("The tutor resolution service returned malformed data");
      }
      if (value.status === "abandoned") {
        pendingSubmissionByScopeRef.current.delete(current.scopeKey);
        clearPersistedPendingSubmission(current.scopeKey, pending.clientMessageId);
        settledSubmissionByScopeRef.current.delete(current.scopeKey);
        optimisticByScopeRef.current.delete(current.scopeKey);
        ephemeralByScopeRef.current.delete(current.scopeKey);
        if (
          inputRef.current.scopeKey === current.scopeKey
          && routeGenerationRef.current === generation
        ) {
          setSettledSubmission(null);
          setOptimistic(null);
          setEphemeralStatus(null);
        }
      } else {
        settlePendingSubmission(pending, !value.restore_text);
      }
      if (
        inputRef.current.scopeKey === current.scopeKey
        && routeGenerationRef.current === generation
      ) {
        // The explicit resolution already removed the browser lock. Refresh
        // canonical history in the background so a slow continuity check can
        // never delay restoring the learner's exact text or re-enabling input.
        void loadVisibleHistory(current.scope, current.scopeKey, generation);
      }
      return value as unknown as AbandonUncertainTutorTurnResponseBody;
    } catch (reason) {
      if (inputRef.current.scopeKey === current.scopeKey) {
        setError(errorText(reason, "Could not resolve the uncertain tutor message"));
      }
      return false;
    } finally {
      resolvingUncertainRef.current = false;
      setResolvingUncertain(false);
    }
  }, [fetchImpl, loadVisibleHistory, settlePendingSubmission]);

  const stopActive = useCallback(async (): Promise<StopTutorTurnResponseBody["status"] | false> => {
    const current = inputRef.current;
    if (
      current.scope === null
      || current.scopeKey === null
      || stoppingRef.current
      || resolvingUncertainRef.current
    ) {
      return false;
    }
    const turnNonce = historyCacheRef.current.get(current.scopeKey)?.active_turn?.turn_nonce;
    if (turnNonce === undefined) return false;

    stoppingRef.current = true;
    setStopping(true);
    setError(null);
    try {
      const body = {
        scope: current.scope,
        turn_nonce: turnNonce,
      } satisfies StopTutorTurnRequestBody;
      const response = await fetchImpl("/api/tutor/turns/stop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw await responseError(response, "Could not stop the tutor turn");
      const value = await response.json() as unknown;
      if (!isRecord(value) || (value.status !== "stopping" && value.status !== "not_active")) {
        throw new Error("The tutor stop service returned malformed data");
      }
      if (inputRef.current.scopeKey === current.scopeKey) {
        await loadVisibleHistory(current.scope, current.scopeKey, routeGenerationRef.current);
      }
      return value.status;
    } catch (reason) {
      if (inputRef.current.scopeKey === current.scopeKey) {
        setError(errorText(reason, "Could not stop the tutor turn"));
      }
      return false;
    } finally {
      stoppingRef.current = false;
      setStopping(false);
    }
  }, [fetchImpl, loadVisibleHistory]);

  const messages = useMemo(() => {
    const canonical = historyScopeKey === activeScopeKey ? history?.messages ?? [] : [];
    const currentOptimistic = optimistic?.scopeKey === activeScopeKey ? optimistic.message : null;
    const currentStatus = ephemeralStatus?.scopeKey === activeScopeKey ? ephemeralStatus.message : null;
    const includesOptimistic = currentOptimistic === null
      || canonical.some((message) => message.turn_nonce === currentOptimistic.turn_nonce);
    return [
      ...canonical,
      ...(currentOptimistic !== null && !includesOptimistic ? [currentOptimistic] : []),
      ...(currentStatus === null ? [] : [currentStatus]),
    ] as readonly TutorSessionMessageView[];
  }, [activeScopeKey, ephemeralStatus, history, historyScopeKey, optimistic]);

  const acknowledgeSettledSubmission = useCallback((clientMessageId: string): void => {
    const scopeKey = inputRef.current.scopeKey;
    if (scopeKey === null) return;
    const settled = settledSubmissionByScopeRef.current.get(scopeKey);
    if (settled?.clientMessageId !== clientMessageId) return;
    clearPersistedPendingSubmission(scopeKey, clientMessageId);
    settledSubmissionByScopeRef.current.delete(scopeKey);
    setSettledSubmission(null);
  }, []);

  const canonicalUnresolvedMessage = visibleHistory === null
    ? null
    : latestUnresolvedSubmission(visibleHistory);
  const activePendingSubmission = activeScopeKey === null
    ? undefined
    : pendingSubmissionByScopeRef.current.get(activeScopeKey);
  const activeOptimisticMessage = optimistic?.scopeKey === activeScopeKey
    ? optimistic.message
    : null;
  const unresolvedCandidate = canonicalUnresolvedMessage
    ?? (
      activePendingSubmission !== undefined
      && activeOptimisticMessage?.turn_nonce === activePendingSubmission.clientMessageId
        ? activeOptimisticMessage
        : null
    );
  const unresolvedMessage = unresolvedCandidate !== null
    && unresolvedCandidate.turn_nonce !== activeTurn?.turn_nonce
    && !(
      sending
      && activePendingSubmission?.clientMessageId === unresolvedCandidate.turn_nonce
    )
      ? unresolvedCandidate
      : null;

  return {
    loading,
    sending,
    resolvingUncertain,
    stopping,
    error: error ?? (
      materialRefreshNotice?.scopeKey === activeScopeKey
        ? materialRefreshNotice.text
        : null
    ),
    materialRefreshRequest,
    messages,
    history: visibleHistory,
    activeTurn,
    unresolvedMessage,
    settledSubmission:
      settledSubmission?.scopeKey === activeScopeKey ? settledSubmission : null,
    lastTurnResponse:
      historyScopeKey === activeScopeKey ? lastTurnResponse : null,
    send,
    reload,
    abandonUnresolved,
    acknowledgeSettledSubmission,
    stopActive,
  };
}
