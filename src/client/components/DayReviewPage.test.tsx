// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DayReviewPage } from "./DayReviewPage.js";

const emptySession = {
  dayId: "day1",
  chatId: null,
  threadId: null,
  messages: [],
  unresolvedTurn: null,
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("DayReviewPage", () => {
  it("shows explicit day-level starting modes and a stable exit", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response(emptySession));
    render(
      <MemoryRouter initialEntries={["/day/day1/review"]}>
        <Routes><Route path="/day/:dayId/review" element={<DayReviewPage />} /></Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: "Day 1", level: 1 })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Build a recap/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Active recall/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Find a gap/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Leave review/ }).getAttribute("href")).toBe("/day/day1");
  });

  it("renders the learner message immediately and shows retrieval progress", async () => {
    let finishTurn!: (response: Response) => void;
    const pendingTurn = new Promise<Response>((resolve) => { finishTurn = resolve; });
    const fetch = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(response(emptySession))
      .mockImplementationOnce(async () => await pendingTurn)
      .mockResolvedValueOnce(response({
        ...emptySession,
        chatId: "day-review-chat:1",
        threadId: "thread:1",
        messages: [
          { messageId: "submission:1", role: "user", text: "Review this day", occurredAt: "2026-08-30T20:00:00.000Z", turnNonce: "turn:1", turnId: null },
          { messageId: "completion:2", role: "assistant", text: "Start with one concept.", occurredAt: "2026-08-30T20:00:01.000Z", turnNonce: "turn:1", turnId: "native:1" },
        ],
      }));
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/day/day1/review"]}>
        <Routes><Route path="/day/:dayId/review" element={<DayReviewPage />} /></Routes>
      </MemoryRouter>,
    );
    await screen.findByText("Ready when you are");
    const composer = screen.getByLabelText("Continue this day review") as HTMLTextAreaElement;
    await user.type(composer, "Review this day");
    await user.keyboard("{Control>}{Enter}{/Control}");

    expect(screen.getByText("Review this day")).toBeTruthy();
    expect(screen.getByText(/retrieving relevant sources/)).toBeTruthy();
    expect(composer.disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Thinking…" })).toBeTruthy();
    expect(fetch.mock.calls[1]?.[0]).toBe("/api/day-review/day1/turns");

    await act(async () => {
      finishTurn(response({ message: "Start with one concept." }));
      await pendingTurn;
    });
    expect(await screen.findByText("Start with one concept.")).toBeTruthy();
  });
});
