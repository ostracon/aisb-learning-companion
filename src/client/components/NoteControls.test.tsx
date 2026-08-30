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

const currentNoteId = "lesson-1.0";
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
      onOpenNote={() => undefined}
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

describe("note picker markers", () => {
  it("groups and orders the current day's Study notes while excluding unrelated notes", async () => {
    const onOpenNote = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) !== "/api/notes") throw new Error(`Unexpected fetch: ${String(input)}`);
      return jsonResponse({
        notes: [
          {
            noteId: "lesson-1.1",
            noteKind: "lesson",
            title: "Chat serialization",
            revision: 1,
            status: "active",
            lastModifiedAt: "2026-08-30T20:05:00.000Z",
            logicalPath: "notes/lessons/1.1/notes.md",
            routePath: "/study/day1/section/1.1",
            hasLearnerContent: false,
          },
          {
            noteId: currentNoteId,
            noteKind: "lesson",
            title: "LLM training",
            revision: 2,
            status: "active",
            lastModifiedAt: "2026-08-30T20:00:00.000Z",
            logicalPath: "notes/lessons/1.0/notes.md",
            routePath: "/study/day1/section/1.0",
            hasLearnerContent: true,
          },
          {
            noteId: "day1_quicknote_recent",
            noteKind: "ad_hoc",
            title: "Recent quick note",
            revision: 1,
            status: "active",
            lastModifiedAt: "2026-08-30T19:30:00.000Z",
            logicalPath: "notes/ad-hoc/2026-08-30/day1_quicknote_recent.md",
            routePath: "/notes/day1_quicknote_recent",
            hasLearnerContent: true,
          },
          {
            noteId: "day1_quicknote_blank",
            noteKind: "ad_hoc",
            title: "Blank quick note",
            revision: 1,
            status: "active",
            lastModifiedAt: "2026-08-30T19:00:00.000Z",
            logicalPath: "notes/ad-hoc/2026-08-30/day1_quicknote_blank.md",
            routePath: "/notes/day1_quicknote_blank",
            hasLearnerContent: false,
          },
          {
            noteId: "lesson-2.0",
            noteKind: "lesson",
            title: "Another day",
            revision: 1,
            status: "active",
            lastModifiedAt: "2026-08-30T18:00:00.000Z",
            logicalPath: "notes/lessons/2.0/notes.md",
            routePath: "/study/day2/section/2.0",
            hasLearnerContent: true,
          },
          {
            noteId: "day2_quicknote_other",
            noteKind: "ad_hoc",
            title: "Other-day quick note",
            revision: 1,
            status: "active",
            lastModifiedAt: "2026-08-30T17:00:00.000Z",
            logicalPath: "notes/ad-hoc/2026-08-30/day2_quicknote_other.md",
            routePath: "/notes/day2_quicknote_other",
            hasLearnerContent: true,
          },
          {
            noteId: "lesson-1.2",
            noteKind: "lesson",
            title: "Archived topic",
            revision: 1,
            status: "archived",
            lastModifiedAt: "2026-08-30T16:00:00.000Z",
            logicalPath: "notes/lessons/1.2/notes.md",
            routePath: "/study/day1/section/1.2",
            hasLearnerContent: true,
          },
          {
            noteId: "event-1",
            noteKind: "event",
            title: "Calendar event",
            revision: 1,
            status: "active",
            lastModifiedAt: "2026-08-30T15:00:00.000Z",
            logicalPath: "notes/events/event-1/notes.md",
            routePath: "/day/day1/event/event-1",
            hasLearnerContent: true,
          },
        ],
        unreadable: [],
      });
    }));

    const { container } = render(
      <NoteControls
        dayId="day1"
        scopeMode="study"
        sectionIds={["1.0", "1.1"]}
        currentNoteId={currentNoteId}
        currentRevision={2}
        currentContentHash={staleHash}
        saveStatus="saved-disk"
        onOpenNote={onOpenNote}
      />,
    );

    const editedOption = await screen.findByRole("option", {
      name: "* LLM training (changed) · notes/lessons/1.0/notes.md",
    });
    const blankOption = screen.getByRole("option", {
      name: "Blank quick note · notes/ad-hoc/2026-08-30/day1_quicknote_blank.md",
    });
    expect(editedOption.textContent?.startsWith("* ")).toBe(true);
    expect(blankOption.textContent?.startsWith("* ")).toBe(false);
    expect(screen.getByText(/prefixed with an asterisk/i)).toBeTruthy();

    const topicGroup = container.querySelector('optgroup[label="Topic notes"]');
    const quickGroup = container.querySelector('optgroup[label="Quick notes"]');
    expect(topicGroup).not.toBeNull();
    expect(quickGroup).not.toBeNull();
    expect(Array.from(topicGroup?.querySelectorAll("option") ?? [], (option) => option.value)).toEqual([
      "lesson-1.0",
      "lesson-1.1",
    ]);
    expect(Array.from(quickGroup?.querySelectorAll("option") ?? [], (option) => option.value)).toEqual([
      "day1_quicknote_recent",
      "day1_quicknote_blank",
    ]);
    expect(screen.queryByRole("option", { name: /Another day/ })).toBeNull();
    expect(screen.queryByRole("option", { name: /Other-day quick note/ })).toBeNull();
    expect(screen.queryByRole("option", { name: /Archived topic/ })).toBeNull();
    expect(screen.queryByRole("option", { name: /Calendar event/ })).toBeNull();

    await userEvent.setup().selectOptions(
      screen.getByRole("combobox", { name: "Choose a Markdown note" }),
      "lesson-1.1",
    );
    expect(onOpenNote).toHaveBeenCalledWith("lesson-1.1", "/study/day1/section/1.1");
  });

  it("opens a newly created Study quick note through the same note-selection callback", async () => {
    const onOpenNote = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/notes" && init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({
          note_id: "day1_quicknote_model_editing_questions",
          title: "Model editing questions",
        });
        return jsonResponse({ note_id: "day1_quicknote_model_editing_questions" });
      }
      if (String(input) === "/api/notes") {
        return jsonResponse({ notes: [], unreadable: [] });
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    }));

    render(
      <NoteControls
        dayId="day1"
        scopeMode="study"
        sectionIds={["1.0", "1.1"]}
        currentNoteId={currentNoteId}
        currentRevision={2}
        currentContentHash={staleHash}
        saveStatus="saved-disk"
        onOpenNote={onOpenNote}
      />,
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "New quick note" }));
    await user.type(screen.getByLabelText("Quick-note filename"), "Model editing questions");
    await user.click(screen.getByRole("button", { name: "Create and open" }));

    await waitFor(() => {
      expect(onOpenNote).toHaveBeenCalledWith(
        "day1_quicknote_model_editing_questions",
        "/notes/day1_quicknote_model_editing_questions",
      );
    });
  });

  it("keeps the current non-archived Today note selectable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      notes: [{
        noteId: "event-cancelled",
        noteKind: "event",
        title: "Rescheduled session",
        revision: 2,
        status: "cancelled",
        lastModifiedAt: "2026-08-30T20:00:00.000Z",
        logicalPath: "notes/events/event-cancelled/notes.md",
        routePath: "/day/day1/event/event-cancelled",
        hasLearnerContent: true,
      }],
      unreadable: [],
    })));

    render(
      <NoteControls
        dayId="day1"
        scopeMode="today"
        sectionIds={[]}
        currentNoteId="event-cancelled"
        currentRevision={2}
        currentContentHash={staleHash}
        saveStatus="saved-disk"
        onOpenNote={() => undefined}
      />,
    );

    expect(await screen.findByRole("option", { name: /Rescheduled session/ })).toBeTruthy();
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("event-cancelled");
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
