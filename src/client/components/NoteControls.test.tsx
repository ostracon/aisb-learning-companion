// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NoteControls, slugifyQuickNoteName } from "./NoteControls.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const currentNoteId = "lesson:day1:1.0";
const staleHash = "a".repeat(64);
const diskHash = "b".repeat(64);

function renderControls(saveStatus: "saved-disk" | "conflict") {
  return render(
    <NoteControls
      dayId="day1"
      scopeMode="study"
      sectionIds={["1.0"]}
      currentNoteId={currentNoteId}
      currentRevision={1}
      currentContentHash={staleHash}
      saveStatus={saveStatus}
      onNavigate={() => undefined}
    />,
  );
}

describe("quick-note naming", () => {
  it("builds readable path-safe suffixes without traversal or filename spam", () => {
    expect(slugifyQuickNoteName("  Model editing questions  ")).toBe("model_editing_questions");
    expect(slugifyQuickNoteName("Café / ../ answers?!")).toBe("cafe_answers");
    expect(slugifyQuickNoteName("What's next?")).toBe("whats_next");
  });
});

describe("opening Markdown notes in VS Code", () => {
  it("opens the fresh on-disk version during a preserved browser conflict", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/notes") return jsonResponse({ notes: [], unreadable: [] });
      if (url === `/api/notes/${encodeURIComponent(currentNoteId)}`) {
        return jsonResponse({
          note_id: currentNoteId,
          content: "disk text",
          revision: 7,
          content_hash: diskHash,
          updated_at: "2026-08-30T18:00:00.000Z",
          logical_path: "notes/lessons/1.0/notes.md",
        });
      }
      if (url === "/api/notes/vscode/prepare") {
        expect(JSON.parse(String(init?.body))).toEqual({
          note_id: currentNoteId,
          expected_revision: 7,
          expected_content_hash: diskHash,
        });
        return jsonResponse({
          kind: "saved-note-vscode-launch-v1",
          token_id: "saved-note-token",
          note_id: currentNoteId,
          logical_path: "notes/lessons/1.0/notes.md",
          revision: 7,
          content_hash: diskHash,
        });
      }
      if (url === "/api/notes/vscode/launch") {
        return jsonResponse({
          status: "opened",
          note_id: currentNoteId,
          logical_path: "notes/lessons/1.0/notes.md",
          command: ["code"],
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderControls("conflict");

    const button = screen.getByRole("button", { name: "Open notes in VS Code" });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(button.getAttribute("title")).toMatch(/on-disk Markdown version/);
    await user.click(button);

    await screen.findByText("Opened notes/lessons/1.0/notes.md");
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      "/api/notes",
      `/api/notes/${encodeURIComponent(currentNoteId)}`,
      "/api/notes/vscode/prepare",
      "/api/notes/vscode/launch",
    ]);
  });

  it("fails closed if the Markdown changes after its fresh checkpoint is read", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/notes") return jsonResponse({ notes: [], unreadable: [] });
      if (url === `/api/notes/${encodeURIComponent(currentNoteId)}`) {
        return jsonResponse({
          note_id: currentNoteId,
          content: "disk text",
          revision: 7,
          content_hash: diskHash,
          updated_at: "2026-08-30T18:00:00.000Z",
          logical_path: "notes/lessons/1.0/notes.md",
        });
      }
      if (url === "/api/notes/vscode/prepare") {
        return jsonResponse({ error: "The note changed before VS Code could open it" }, 409);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderControls("conflict");

    await user.click(screen.getByRole("button", { name: "Open notes in VS Code" }));
    await screen.findByRole("alert");
    expect(screen.getByText("The note changed before VS Code could open it")).toBeTruthy();
    expect(fetchMock.mock.calls.some(([input]) => String(input) === "/api/notes/vscode/launch")).toBe(false);
    await waitFor(() => {
      expect((screen.getByRole("button", { name: "Open notes in VS Code" }) as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it("uses the acknowledged checkpoint directly after a complete disk save", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/notes") return jsonResponse({ notes: [], unreadable: [] });
      if (url === "/api/notes/vscode/prepare") {
        expect(JSON.parse(String(init?.body))).toEqual({
          note_id: currentNoteId,
          expected_revision: 1,
          expected_content_hash: staleHash,
        });
        return jsonResponse({
          kind: "saved-note-vscode-launch-v1",
          token_id: "saved-note-token",
          note_id: currentNoteId,
          logical_path: "notes/lessons/1.0/notes.md",
          revision: 1,
          content_hash: staleHash,
        });
      }
      if (url === "/api/notes/vscode/launch") {
        return jsonResponse({
          status: "opened",
          note_id: currentNoteId,
          logical_path: "notes/lessons/1.0/notes.md",
          command: ["code"],
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderControls("saved-disk");

    await user.click(screen.getByRole("button", { name: "Open notes in VS Code" }));
    await screen.findByText("Opened notes/lessons/1.0/notes.md");
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes(encodeURIComponent(currentNoteId)))).toBe(false);
  });
});
