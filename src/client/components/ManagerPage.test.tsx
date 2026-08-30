// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ManagerPage } from "./ManagerPage.js";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("ManagerPage", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it("keeps a composer draft until canonical history confirms the turn", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({
        chatId: null,
        threadId: null,
        messages: [],
        unresolvedTurn: null,
      }))
      .mockResolvedValueOnce(jsonResponse({
        message: "Revisit section 1.1.",
        chatId: "manager-chat:1",
        threadId: "thread:1",
        turnId: "turn:1",
        clientUserMessageId: "ignored-by-parser",
        contextHash: `sha256:${"a".repeat(64)}`,
      }))
      .mockResolvedValueOnce(jsonResponse({
        chatId: "manager-chat:1",
        threadId: "thread:1",
        messages: [
          {
            messageId: "submission:1",
            role: "user",
            text: "What should I revisit?",
            occurredAt: "2026-08-30T10:00:00.000Z",
            turnNonce: "nonce:1",
            turnId: null,
          },
          {
            messageId: "completion:2",
            role: "assistant",
            text: "Revisit **section 1.1**.",
            occurredAt: "2026-08-30T10:01:00.000Z",
            turnNonce: "nonce:1",
            turnId: "turn:1",
          },
        ],
        unresolvedTurn: null,
      }));
    const user = userEvent.setup();
    render(<MemoryRouter><ManagerPage /></MemoryRouter>);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    expect(screen.getByRole("link", { name: "Back to workspace" }).getAttribute("href")).toBe("/");

    const composer = screen.getByLabelText("Message the learning manager");
    await user.type(composer, "What should I revisit?");
    expect(window.localStorage.getItem("aisb-companion:manager-composer:v1")).toBe("What should I revisit?");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("section 1.1", { selector: "strong" })).not.toBeNull();
    expect(window.localStorage.getItem("aisb-companion:manager-composer:v1")).toBeNull();
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "/api/manager/session",
      "/api/manager/turns",
      "/api/manager/session",
    ]);
    expect(screen.getByRole("link", { name: "open the visual aid" }).getAttribute("href")).toBe("/visuals");
  });

  it("disables sending while a durable manager turn is unresolved and can check again", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({
        chatId: "manager-chat:1",
        threadId: "thread:1",
        messages: [{
          messageId: "submission:1",
          role: "user",
          text: "What should I revisit?",
          occurredAt: "2026-08-30T10:00:00.000Z",
          turnNonce: "nonce:pending",
          turnId: null,
        }],
        unresolvedTurn: { submittedAt: "2026-08-30T10:00:00.000Z" },
      }))
      .mockResolvedValueOnce(jsonResponse({
        chatId: "manager-chat:1",
        threadId: "thread:1",
        messages: [{
          messageId: "submission:1",
          role: "user",
          text: "What should I revisit?",
          occurredAt: "2026-08-30T10:00:00.000Z",
          turnNonce: "nonce:pending",
          turnId: null,
        }, {
          messageId: "completion:2",
          role: "assistant",
          text: "Revisit the boundary outcome.",
          occurredAt: "2026-08-30T10:01:00.000Z",
          turnNonce: "nonce:pending",
          turnId: "turn:1",
        }],
        unresolvedTurn: null,
      }));
    const user = userEvent.setup();
    render(<MemoryRouter><ManagerPage /></MemoryRouter>);

    expect(await screen.findByText(/has not reached a final state/u)).not.toBeNull();
    expect((screen.getByLabelText("Message the learning manager") as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);

    await user.click(screen.getByRole("button", { name: "Check again" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/has not reached a final state/u)).toBeNull();
    expect((screen.getByLabelText("Message the learning manager") as HTMLTextAreaElement).disabled).toBe(false);
  });

  it("moves a submitted draft into the transcript immediately and restores it after failure", async () => {
    let settleTurn!: (response: Response) => void;
    const pendingTurn = new Promise<Response>((resolve) => {
      settleTurn = resolve;
    });
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({
        chatId: null,
        threadId: null,
        messages: [],
        unresolvedTurn: null,
      }))
      .mockReturnValueOnce(pendingTurn)
      .mockResolvedValueOnce(jsonResponse({
        chatId: null,
        threadId: null,
        messages: [],
        unresolvedTurn: null,
      }));
    const user = userEvent.setup();
    render(<MemoryRouter><ManagerPage /></MemoryRouter>);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const composer = screen.getByLabelText("Message the learning manager") as HTMLTextAreaElement;
    await user.type(composer, "Find one weak topic.");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(screen.getByText("Find one weak topic.", { selector: ".manager-message.user > p:not(.manager-message-role)" })).not.toBeNull();
    expect(composer.value).toBe("");
    expect(composer.disabled).toBe(true);
    expect(screen.getByText(/reviewing the latest local context/u)).not.toBeNull();
    expect(window.localStorage.getItem("aisb-companion:manager-composer:v1")).toBe("Find one weak topic.");

    settleTurn(jsonResponse({ error: "Manager unavailable" }, 503));

    await waitFor(() => expect(composer.disabled).toBe(false));
    expect(composer.value).toBe("Find one weak topic.");
    expect(window.localStorage.getItem("aisb-companion:manager-composer:v1")).toBe("Find one weak topic.");
    expect(screen.queryByText("Find one weak topic.", { selector: ".manager-message.user > p:not(.manager-message-role)" })).toBeNull();
  });

  it("submits with Control-Enter", async () => {
    let settleTurn!: (response: Response) => void;
    const pendingTurn = new Promise<Response>((resolve) => {
      settleTurn = resolve;
    });
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({
        chatId: null,
        threadId: null,
        messages: [],
        unresolvedTurn: null,
      }))
      .mockReturnValueOnce(pendingTurn)
      .mockResolvedValueOnce(jsonResponse({
        chatId: null,
        threadId: null,
        messages: [],
        unresolvedTurn: null,
      }));
    const user = userEvent.setup();
    render(<MemoryRouter><ManagerPage /></MemoryRouter>);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const composer = screen.getByLabelText("Message the learning manager");
    await user.type(composer, "Plan my next session.");
    await user.keyboard("{Control>}{Enter}{/Control}");

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Plan my next session.", { selector: ".manager-message.user > p:not(.manager-message-role)" })).not.toBeNull();
    settleTurn(jsonResponse({ error: "Manager unavailable" }, 503));
    await waitFor(() => expect((composer as HTMLTextAreaElement).disabled).toBe(false));
  });

  it("offers a direct return to the latest message after the reader scrolls up", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({
      chatId: "manager-chat:1",
      threadId: "thread:1",
      messages: [{
        messageId: "completion:1",
        role: "assistant",
        text: "A useful earlier response.",
        occurredAt: "2026-08-30T10:01:00.000Z",
        turnNonce: "nonce:1",
        turnId: "turn:1",
      }],
      unresolvedTurn: null,
    }));
    render(<MemoryRouter><ManagerPage /></MemoryRouter>);
    await screen.findByText("A useful earlier response.");

    const transcript = screen.getByRole("log", { name: "Learning manager messages" });
    Object.defineProperties(transcript, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 300 },
      scrollTop: { configurable: true, value: 100, writable: true },
    });
    const scrollTo = vi.fn();
    Object.defineProperty(transcript, "scrollTo", { configurable: true, value: scrollTo });
    fireEvent.scroll(transcript);

    await userEvent.setup().click(screen.getByRole("button", { name: "Jump to latest message" }));
    expect(scrollTo).toHaveBeenCalledWith({ top: 1_000, behavior: "auto" });
  });
});
