// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
});
