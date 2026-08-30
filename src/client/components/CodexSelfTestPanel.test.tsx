// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { CodexSelfTestPanel } from "./CodexSelfTestPanel.js";

describe("CodexSelfTestPanel", () => {
  it("runs only on request and renders the redacted checks", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      status: "ready",
      tested_at: "2026-08-30T08:00:00.000Z",
      version: { expected: "0.151.0", reported: "0.151.0", matches: true },
      account: { status: "authenticated", kind: "chatgpt", plan: "plus" },
      model: {
        model: "gpt-5.6-sol",
        available: true,
        medium_effort_available: true,
      },
      profiles: [
        { profile_id: "aisb-tutor", applied: true, instruction_source_verified: true },
        { profile_id: "aisb-review", applied: true, instruction_source_verified: true },
      ],
      issues: [],
    }), { status: 200 }));
    const user = userEvent.setup();
    render(<CodexSelfTestPanel fetch={fetch as unknown as typeof globalThis.fetch} />);

    expect(fetch).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Run self-test" }));

    expect(await screen.findByText("Ready")).toBeTruthy();
    expect(screen.getByText(/authenticated · plus/u)).toBeTruthy();
    expect(screen.getAllByText(/instructions verified/u)).toHaveLength(2);
    expect(fetch).toHaveBeenCalledWith("/api/diagnostics/codex-self-test", expect.objectContaining({
      method: "POST",
    }));
  });

  it("renders stable server guidance for degraded checks", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      status: "degraded",
      tested_at: "2026-08-30T08:00:00.000Z",
      version: { expected: "0.151.0", reported: null, matches: false },
      account: { status: "unavailable", kind: null, plan: null },
      model: {
        model: "gpt-5.6-sol",
        available: false,
        medium_effort_available: false,
      },
      profiles: [
        { profile_id: "aisb-tutor", applied: false, instruction_source_verified: false },
        { profile_id: "aisb-review", applied: false, instruction_source_verified: false },
      ],
      issues: [{
        code: "codex_process_unavailable",
        detail: "The isolated Codex App Server could not be started. No model turn was sent.",
      }],
    }), { status: 200 }));
    const user = userEvent.setup();
    render(<CodexSelfTestPanel fetch={fetch as unknown as typeof globalThis.fetch} />);

    await user.click(screen.getByRole("button", { name: "Run self-test" }));

    expect(await screen.findByText("Needs attention")).toBeTruthy();
    expect(screen.getByText(/No model turn was sent/u)).toBeTruthy();
  });
});
