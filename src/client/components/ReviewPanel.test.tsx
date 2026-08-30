// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReviewCoachSessionView } from "../../shared/review.js";
import {
  ReviewPanel,
  reviewPanelScopeKey,
  reviewResponseDraftStorageKey,
  reviewSessionStorageKey,
  type ReviewOutcomeChoice,
} from "./ReviewPanel.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

const choice: ReviewOutcomeChoice = {
  sectionId: "1.1",
  sectionTitle: "LLM internals",
  outcome: {
    outcomeId: "1.1:security:1",
    versionId: "outcome-version-1",
    category: "security",
    text: "Explain the model-facing trust boundary.",
    sourcePath: "1.1-llm-internals/README.md",
  },
};

function session(): ReviewCoachSessionView {
  return {
    sessionId: "session-1",
    threadId: "local-review:session-1",
    status: "awaiting_response",
    questionLimit: 3,
    questionsAsked: 1,
    responsesRecorded: 0,
    lastReviewedAt: null,
    lastLearnerConfidence: null,
    selectedOutcomeIds: [choice.outcome.outcomeId],
    currentQuestion: {
      questionId: "question-1",
      number: 1,
      total: 3,
      mode: "free_recall",
      prompt: "What do you remember about the model-facing trust boundary?",
      outcomeIds: [choice.outcome.outcomeId],
      citations: [{
        outcomeId: choice.outcome.outcomeId,
        outcomeVersionId: choice.outcome.versionId,
        category: "security",
        label: "security outcome 1",
        sourcePath: choice.outcome.sourcePath,
        sourceCommit: "a".repeat(40),
      }],
      provenance: {
        engine: "local-template",
        transport: "in-process",
        model: null,
        permissionProfile: null,
        threadId: "local-review:session-1",
        turnId: "local-turn:1",
        disclosureId: "disclosure-1",
        payloadHash: `sha256:${"a".repeat(64)}`,
        outputSchemaApplied: false,
      },
    },
    lastFeedback: null,
    pendingResponse: null,
    assessmentAuthority: "advisory",
  };
}

function readySession(): ReviewCoachSessionView {
  return {
    ...session(),
    threadId: null,
    status: "ready_for_question",
    questionsAsked: 0,
    currentQuestion: null,
  };
}

describe("ReviewPanel", () => {
  it("starts a local one-question review using only selected canonical IDs", async () => {
    const scopeKey = "today:day1:aisb-2026-016:1.1";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ mode: "live-codex", session: readySession() }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ mode: "local-template", session: session() }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(
      <ReviewPanel
        scopeKey={scopeKey}
        dayId="day1"
        contextMode="today"
        eventBindingId="aisb-2026-016"
        studySectionId={null}
        outcomes={[choice]}
      />,
    );

    expect(screen.getByText(/typed recall answer are sent to GPT-5.6 Sol/)).toBeTruthy();
    expect(screen.getByText(/stored durably in your owner-only companion state/)).toBeTruthy();
    expect(screen.getByRole("note", { name: "Prompt style descriptions" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Start active recall" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      context_mode: "today",
      day_id: "day1",
      event_binding_id: "aisb-2026-016",
      section_id: null,
      outcome_refs: [{ outcome_id: choice.outcome.outcomeId, outcome_version_id: choice.outcome.versionId }],
      question_limit: 3,
      modes: ["free_recall"],
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/review/sessions/session-1/start");
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({});
    expect(screen.getByText(/What do you remember/)).toBeTruthy();
    expect(screen.getByText(choice.outcome.sourcePath)).toBeTruthy();
    expect(screen.getByLabelText("Your recall")).toBe(document.activeElement);
    expect(window.localStorage.getItem(reviewSessionStorageKey(scopeKey))).toBe("session-1");
  });

  it("cannot start without any canonical outcome", () => {
    render(
      <ReviewPanel
        scopeKey="study:day5:none"
        dayId="day5"
        contextMode="study"
        eventBindingId={null}
        studySectionId={null}
        outcomes={[]}
      />,
    );
    expect((screen.getByRole("button", { name: "Start active recall" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/No review outcomes/)).toBeTruthy();
  });

  it("changes its remount identity when the event or linked sections change", () => {
    const base = {
      contextMode: "today" as const,
      dayId: "day1" as const,
      eventBindingId: "aisb-2026-016",
      linkedSectionIds: ["1.1"],
      studySectionId: null,
    };

    expect(reviewPanelScopeKey(base)).not.toBe(
      reviewPanelScopeKey({ ...base, eventBindingId: "aisb-2026-017" }),
    );
    expect(reviewPanelScopeKey(base)).not.toBe(
      reviewPanelScopeKey({ ...base, linkedSectionIds: ["1.2"] }),
    );
    expect(reviewPanelScopeKey({
      ...base,
      contextMode: "study",
      eventBindingId: null,
      linkedSectionIds: [],
      studySectionId: "1.1",
    })).not.toBe(reviewPanelScopeKey({
      ...base,
      contextMode: "study",
      eventBindingId: null,
      linkedSectionIds: [],
      studySectionId: "1.2",
    }));
  });

  it("resets local review selection when React receives a new event scope key", async () => {
    const user = userEvent.setup();
    const base = {
      contextMode: "today" as const,
      dayId: "day1" as const,
      eventBindingId: "aisb-2026-016",
      linkedSectionIds: ["1.1"],
      studySectionId: null,
    };
    const view = render(
      <ReviewPanel
        key={reviewPanelScopeKey(base)}
        scopeKey={reviewPanelScopeKey(base)}
        dayId="day1"
        contextMode="today"
        eventBindingId={base.eventBindingId}
        studySectionId={null}
        outcomes={[choice]}
      />,
    );
    const checkbox = screen.getByRole("checkbox", {
      name: /Explain the model-facing trust boundary/i,
    }) as HTMLInputElement;
    await user.click(checkbox);
    expect(checkbox.checked).toBe(false);

    const relinked = { ...base, linkedSectionIds: ["1.2"] };
    view.rerender(
      <ReviewPanel
        key={reviewPanelScopeKey(relinked)}
        scopeKey={reviewPanelScopeKey(relinked)}
        dayId="day1"
        contextMode="today"
        eventBindingId={relinked.eventBindingId}
        studySectionId={null}
        outcomes={[choice]}
      />,
    );
    expect((screen.getByRole("checkbox", {
      name: /Explain the model-facing trust boundary/i,
    }) as HTMLInputElement).checked).toBe(true);
  });

  it("sends the selected Study section as the server scope", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ mode: "live-codex", session: readySession() }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ mode: "local-template", session: session() }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(
      <ReviewPanel
        scopeKey="study:day1:1.1"
        dayId="day1"
        contextMode="study"
        eventBindingId={null}
        studySectionId="1.1"
        outcomes={[choice]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Start active recall" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      context_mode: "study",
      day_id: "day1",
      event_binding_id: null,
      section_id: "1.1",
    });
  });

  it("retains a durable created session and offers retry when first-question dispatch fails", async () => {
    const scopeKey = "study:day1:1.1";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ mode: "live-codex", session: readySession() }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: async () => ({ error: "Question generation is temporarily unavailable" }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(
      <ReviewPanel
        scopeKey={scopeKey}
        dayId="day1"
        contextMode="study"
        eventBindingId={null}
        studySectionId="1.1"
        outcomes={[choice]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Start active recall" }));
    expect(await screen.findByRole("button", { name: "Retry review" })).toBeTruthy();
    expect(window.localStorage.getItem(reviewSessionStorageKey(scopeKey))).toBe("session-1");
    expect(screen.getByText(/same saved session/)).toBeTruthy();
  });

  it("never starts model work merely by reloading a durable ready session", async () => {
    const scopeKey = "today:day1:aisb-2026-016:1.1";
    window.localStorage.setItem(reviewSessionStorageKey(scopeKey), "session-1");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ mode: "live-codex", session: readySession() }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ReviewPanel
        scopeKey={scopeKey}
        dayId="day1"
        contextMode="today"
        eventBindingId="aisb-2026-016"
        studySectionId={null}
        outcomes={[choice]}
      />,
    );

    expect(await screen.findByRole("button", { name: "Continue review" })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/review/sessions/session-1");
  });

  it("rehydrates the durable active session for its exact page scope", async () => {
    const scopeKey = "study:day1:1.1";
    window.localStorage.setItem(reviewSessionStorageKey(scopeKey), "session-1");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ mode: "live-codex", session: session() }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ReviewPanel
        scopeKey={scopeKey}
        dayId="day1"
        contextMode="study"
        eventBindingId={null}
        studySectionId="1.1"
        outcomes={[choice]}
      />,
    );

    expect(await screen.findByText(/What do you remember/)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/review/sessions/session-1",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(screen.getByLabelText("Your recall")).toBe(document.activeElement);
  });

  it("renders structured review questions and feedback without hiding a leading heading", async () => {
    const scopeKey = "study:day1:1.1";
    const baseSession = session();
    const richSession: ReviewCoachSessionView = {
      ...baseSession,
      currentQuestion: {
        ...baseSession.currentQuestion!,
        prompt: "# Compare controls\n\nWhat changes in \\(p_i\\)?",
      },
      lastFeedback: {
        feedbackId: "feedback-rich",
        questionId: "question-previous",
        responseId: "response-previous",
        text: "## Nudge\n\n- Revisit **ordering**.\n- Check \\(q_i\\).",
        outcomeIds: [choice.outcome.outcomeId],
        citations: baseSession.currentQuestion!.citations,
        assessmentAuthority: "advisory",
        provenance: baseSession.currentQuestion!.provenance,
      },
    };
    window.localStorage.setItem(reviewSessionStorageKey(scopeKey), richSession.sessionId);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ mode: "live-codex", session: richSession }),
    }));

    const { container } = render(
      <ReviewPanel
        scopeKey={scopeKey}
        dayId="day1"
        contextMode="study"
        eventBindingId={null}
        studySectionId="1.1"
        outcomes={[choice]}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Compare controls" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Nudge" })).toBeTruthy();
    expect(screen.getByText("One focused memory dump · about 2 minutes")).toBeTruthy();
    expect(screen.getByText("ordering").tagName).toBe("STRONG");
    expect(container.querySelector(".review-question .katex")).toBeTruthy();
    expect(container.querySelector(".review-feedback .katex")).toBeTruthy();
  });

  it("lets an unanswered saved question be replaced without retaining its local draft", async () => {
    const scopeKey = "study:day1:1.1";
    const activeSession = session();
    const draftKey = reviewResponseDraftStorageKey(scopeKey, activeSession.sessionId);
    window.localStorage.setItem(reviewSessionStorageKey(scopeKey), activeSession.sessionId);
    window.localStorage.setItem(draftKey, JSON.stringify({
      question_id: activeSession.currentQuestion!.questionId,
      response: "Draft for the old question",
      confidence: null,
    }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ mode: "live-codex", session: activeSession }),
    }));

    render(
      <ReviewPanel
        scopeKey={scopeKey}
        dayId="day1"
        contextMode="study"
        eventBindingId={null}
        studySectionId="1.1"
        outcomes={[choice]}
      />,
    );

    await userEvent.click(await screen.findByRole("button", { name: "Start over with new questions" }));

    expect(screen.getByRole("button", { name: "Start active recall" })).toBeTruthy();
    expect(window.localStorage.getItem(reviewSessionStorageKey(scopeKey))).toBeNull();
    expect(window.localStorage.getItem(draftKey)).toBeNull();
  });

  it("restores an unsent response and confidence, then clears them only after accepted submission", async () => {
    const scopeKey = "study:day1:1.1";
    const activeSession = session();
    const draftKey = reviewResponseDraftStorageKey(scopeKey, activeSession.sessionId);
    window.localStorage.setItem(reviewSessionStorageKey(scopeKey), activeSession.sessionId);
    window.localStorage.setItem(draftKey, JSON.stringify({
      question_id: activeSession.currentQuestion!.questionId,
      response: "My exact unfinished recall",
      confidence: 3,
    }));
    const feedback = {
      feedbackId: "feedback-1",
      questionId: activeSession.currentQuestion!.questionId,
      responseId: "response-1",
      text: "Good boundary identification.",
      outcomeIds: [choice.outcome.outcomeId],
      citations: activeSession.currentQuestion!.citations,
      assessmentAuthority: "advisory" as const,
      provenance: activeSession.currentQuestion!.provenance,
    };
    const completedSession: ReviewCoachSessionView = {
      ...activeSession,
      status: "complete",
      responsesRecorded: 1,
      currentQuestion: null,
      lastFeedback: feedback,
      pendingResponse: null,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ mode: "live-codex", session: activeSession }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          mode: "live-codex",
          result: {
            session: completedSession,
            responseId: "response-1",
            feedback,
            nextQuestion: null,
          },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(
      <ReviewPanel
        scopeKey={scopeKey}
        dayId="day1"
        contextMode="study"
        eventBindingId={null}
        studySectionId="1.1"
        outcomes={[choice]}
      />,
    );

    const response = await screen.findByLabelText("Your recall") as HTMLTextAreaElement;
    expect(response.value).toBe("My exact unfinished recall");
    expect((screen.getByLabelText("Confidence") as HTMLSelectElement).value).toBe("3");
    expect(window.localStorage.getItem(draftKey)).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "Record response" }));
    await waitFor(() => expect(screen.getByText(/1 recall response completed/)).toBeTruthy());
    expect(window.localStorage.getItem(draftKey)).toBeNull();
  });

  it("restores and locks the exact server-saved response while feedback is pending", async () => {
    const scopeKey = "today:day1:aisb-2026-016:1.1";
    const pendingSession: ReviewCoachSessionView = {
      ...session(),
      status: "feedback_pending",
      pendingResponse: {
        questionId: "question-1",
        learnerResponse: "Exact durable response",
        learnerConfidence: 4,
      },
    };
    window.localStorage.setItem(reviewSessionStorageKey(scopeKey), pendingSession.sessionId);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ mode: "live-codex", session: pendingSession }),
    }));

    render(
      <ReviewPanel
        scopeKey={scopeKey}
        dayId="day1"
        contextMode="today"
        eventBindingId="aisb-2026-016"
        studySectionId={null}
        outcomes={[choice]}
      />,
    );

    const response = await screen.findByLabelText("Your recall") as HTMLTextAreaElement;
    expect(response.value).toBe("Exact durable response");
    expect(response.readOnly).toBe(true);
    const confidence = screen.getByLabelText("Confidence") as HTMLSelectElement;
    expect(confidence.value).toBe("4");
    expect(confidence.disabled).toBe(true);
    expect(screen.getByText(/locked to prevent a changed retry/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Resume saved response" })).toBeTruthy();
  });

  it("forgets a stale local resume pointer when the durable session is gone", async () => {
    const scopeKey = "today:day1:missing:1.1";
    window.localStorage.setItem(reviewSessionStorageKey(scopeKey), "session-missing");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: "Review session not found" }),
    }));

    render(
      <ReviewPanel
        scopeKey={scopeKey}
        dayId="day1"
        contextMode="today"
        eventBindingId="missing"
        studySectionId={null}
        outcomes={[choice]}
      />,
    );

    await waitFor(() => {
      expect(window.localStorage.getItem(reviewSessionStorageKey(scopeKey))).toBeNull();
    });
    expect(screen.getByRole("button", { name: "Start active recall" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
