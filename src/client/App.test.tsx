// @vitest-environment jsdom

import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TutorContinuitySummaryView } from "../shared/api.js";
import {
  DisclosureInspector,
  extractReflectionBody,
  NoteSaveControls,
  shouldRestoreUncertainTutorText,
  studyDayTargetFor,
  studyNavigationDays,
  TutorComposer,
  tutorComposerStorageKey,
  TutorContinuityControls,
  uncertainTutorComposerAction,
  useScopedComposerDraft,
} from "./App.js";

describe("Study day navigation", () => {
  it("keeps a schedule-only day selected when switching to Study", () => {
    expect(studyDayTargetFor("day4", false, {
      day1: "day1",
      day2: "day2",
      day3: "day3",
      day4: null,
      day5: "day5",
      day6: "day6",
      day7: "day7",
    })).toBe("day4");
  });

  it("uses an explicit programme-to-repository mapping when one exists", () => {
    expect(studyDayTargetFor("day5", false, {
      day1: "day1",
      day2: "day2",
      day3: "day3",
      day4: null,
      day5: "day4",
      day6: "day6",
      day7: "day7",
    })).toBe("day4");
  });

  it("merges repository and schedule-only days into one chronological list", () => {
    const days = [
      { dayId: "day5" as const, date: "2026-09-03", curriculumKind: "content" as const, title: "Day 5" },
      { dayId: "day4" as const, date: "2026-09-02", curriculumKind: "break" as const, title: "Day 4 · Schedule only" },
    ];
    const events = [
      { eventBindingId: "breakfast", programmeDayId: "day4" as const, title: "Breakfast", start: "2026-09-02T07:00:00+01:00", end: "2026-09-02T08:00:00+01:00", allDay: false, status: "scheduled" as const },
      { eventBindingId: "visit", programmeDayId: "day4" as const, title: "Visit UK AISI", start: "2026-09-02T09:00:00+01:00", end: "2026-09-02T10:00:00+01:00", allDay: false, status: "scheduled" as const },
      { eventBindingId: "talk", programmeDayId: "day5" as const, title: "Model editing talk", start: "2026-09-03T09:00:00+01:00", end: "2026-09-03T10:00:00+01:00", allDay: false, status: "scheduled" as const },
    ];
    const setup = { sectionId: "0.1", title: "Setup", sourcePath: "day0-setup/README.md", outcomes: [] };
    const monitoring = { sectionId: "2.2", title: "Monitoring", sourcePath: "2.2-monitoring/README.md", outcomes: [] };
    const security = { sectionId: "6.1", title: "Security", sourcePath: "6.1-security/README.md", outcomes: [] };

    expect(studyNavigationDays(days, events, {
      day6: [security],
      day0: [setup],
      day2: [monitoring],
    })).toEqual([
      { kind: "repository", dayId: "day0", repositorySections: [setup] },
      { kind: "repository", dayId: "day2", repositorySections: [monitoring] },
      { kind: "schedule", dayId: "day4", day: days[1], learningEventCount: 1 },
      { kind: "schedule", dayId: "day5", day: days[0], learningEventCount: 1 },
      { kind: "repository", dayId: "day6", repositorySections: [security] },
    ]);
  });

  it("uses a repository row when the same numbered day has material", () => {
    const day = {
      dayId: "day5" as const,
      date: "2026-09-03",
      curriculumKind: "content" as const,
      title: "Day 5",
    };
    const section = {
      sectionId: "4.1",
      title: "Model editing",
      sourcePath: "4.1-model-editing/README.md",
      outcomes: [],
    };

    expect(studyNavigationDays([day], [], { day5: [section] })).toEqual([{
      kind: "repository",
      dayId: "day5",
      repositorySections: [section],
    }]);
  });
});

describe("uncertain tutor text restoration", () => {
  it("restores only when the resolution explicitly leaves the text retryable", () => {
    expect(shouldRestoreUncertainTutorText(false)).toBe(false);
    expect(shouldRestoreUncertainTutorText({
      status: "recovered",
      restore_text: false,
    })).toBe(false);
    expect(shouldRestoreUncertainTutorText({
      status: "recovered",
      restore_text: true,
    })).toBe(true);
    expect(shouldRestoreUncertainTutorText({
      status: "abandoned",
      restore_text: true,
    })).toBe(true);
  });

  it("leaves a retryable draft in its original scope when navigation wins the resolution race", () => {
    expect(uncertainTutorComposerAction({
      status: "abandoned",
      restore_text: true,
    }, false)).toBe("leave");
    expect(uncertainTutorComposerAction({
      status: "recovered",
      restore_text: false,
    }, false)).toBe("clear");
    expect(uncertainTutorComposerAction({
      status: "recovered",
      restore_text: true,
    }, true)).toBe("restore");
    expect(uncertainTutorComposerAction(false, true)).toBe("leave");
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("NoteSaveControls", () => {
  it("keeps routine autosave phases visually stable while typing", () => {
    const { rerender } = render(<NoteSaveControls status="saving-local" onRetry={vi.fn()} />);
    const status = screen.getByRole("status");

    expect(status.textContent).toContain("Saving note…");
    expect(status.classList.contains("autosaving")).toBe(true);

    for (const saveStatus of ["saved-locally", "saving-disk"] as const) {
      rerender(<NoteSaveControls status={saveStatus} onRetry={vi.fn()} />);
      expect(status.textContent).toContain("Saving note…");
      expect(status.classList.contains("autosaving")).toBe(true);
      expect(status.getAttribute("data-save-state")).toBe(saveStatus);
    }

    rerender(<NoteSaveControls status="saved-disk" onRetry={vi.fn()} />);
    expect(status.textContent).toContain("Saved to disk");
    expect(status.classList.contains("saved")).toBe(true);
  });

  it.each(["offline", "error"] as const)(
    "offers an accessible retry action when the disk state is %s",
    async (status) => {
      const retry = vi.fn();
      const user = userEvent.setup();
      render(<NoteSaveControls status={status} onRetry={retry} />);

      expect(screen.getByRole("status").textContent).toContain(status);
      const button = screen.getByRole("button", {
        name: "Retry saving note to its Markdown file",
      });
      expect(button.textContent).toContain("Retry save");
      await user.click(button);
      expect(retry).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["loading", "saving-local", "saved-locally", "saving-disk", "saved-disk", "conflict"] as const)(
    "does not offer retry while the save state is %s",
    (status) => {
      render(<NoteSaveControls status={status} onRetry={vi.fn()} />);

      expect(
        screen.queryByRole("button", { name: "Retry saving note to its Markdown file" }),
      ).toBeNull();
    },
  );

  it("offers explicit, recoverable choices when browser and Markdown notes diverge", async () => {
    const resolve = vi.fn();
    const user = userEvent.setup();
    render(
      <NoteSaveControls
        status="conflict"
        onRetry={vi.fn()}
        onResolveConflict={resolve}
      />,
    );

    expect(screen.getByRole("alert").textContent).toContain("separate conflict copy");
    await user.click(screen.getByRole("button", { name: "Keep browser draft" }));
    await user.click(screen.getByRole("button", { name: "Use Markdown version" }));
    expect(resolve.mock.calls).toEqual([["keep-local"], ["use-disk"]]);
  });

  it("offers last-good Markdown recovery without competing with a blind retry", async () => {
    const recover = vi.fn();
    const user = userEvent.setup();
    render(
      <NoteSaveControls
        status="error"
        onRetry={vi.fn()}
        diskRecoveryAvailable
        onRecoverDiskFile={recover}
      />,
    );

    expect(screen.getByRole("alert").textContent).toContain("unreadable bytes will be preserved");
    expect(screen.queryByRole("button", { name: "Retry saving note to its Markdown file" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Recover last saved Markdown" }));
    expect(recover).toHaveBeenCalledTimes(1);
  });
});

describe("useScopedComposerDraft", () => {
  it("keeps unsent tutor text isolated to the scope where it was typed", () => {
    const view = renderHook(
      ({ scopeKey }: { scopeKey: string | null }) => useScopedComposerDraft(scopeKey),
      { initialProps: { scopeKey: "event:a" as string | null } },
    );

    act(() => view.result.current.setValue("draft for A"));
    expect(view.result.current.value).toBe("draft for A");

    view.rerender({ scopeKey: "event:b" });
    expect(view.result.current.value).toBe("");
    act(() => view.result.current.setValue("draft for B"));

    view.rerender({ scopeKey: "event:a" });
    expect(view.result.current.value).toBe("draft for A");
    view.rerender({ scopeKey: "event:b" });
    expect(view.result.current.value).toBe("draft for B");
    view.rerender({ scopeKey: null });
    expect(view.result.current.value).toBe("");
  });

  it("restores an exact unresolved tutor draft after a hard reload", () => {
    const scopeKey = "event:aisb-2026-016";
    const firstPage = renderHook(() => useScopedComposerDraft(scopeKey));
    act(() => firstPage.result.current.setValue("exact unconfirmed learner message"));
    expect(window.localStorage.getItem(tutorComposerStorageKey(scopeKey))).toBe(
      "exact unconfirmed learner message",
    );
    firstPage.unmount();

    const reloadedPage = renderHook(() => useScopedComposerDraft(scopeKey));
    expect(reloadedPage.result.current.value).toBe("exact unconfirmed learner message");
    expect(reloadedPage.result.current.storageError).toBeNull();
  });

  it("retains the visible draft in memory and reports browser-storage failure", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    });
    const view = renderHook(() => useScopedComposerDraft("event:storage-failure"));

    act(() => view.result.current.setValue("still visible"));

    expect(view.result.current.value).toBe("still visible");
    expect(view.result.current.storageError).toMatch(/still held in memory/i);
  });
});

describe("TutorComposer", () => {
  it("keeps per-keystroke state inside the composer instead of rerendering its workspace parent", async () => {
    const send = vi.fn();
    let workspaceRenders = 0;

    function WorkspaceHarness() {
      workspaceRenders += 1;
      return (
        <div>
          <div data-testid="expensive-workspace">Course document</div>
          <TutorComposer
            scopeKey="study:section:5.3"
            tutorIsWorking={false}
            unresolvedMessage={false}
            tutorAvailable
            tutorNoteReady
            tutorCanSend
            tutorEntryLocked={false}
            settledSubmission={null}
            onAcknowledgeSettledSubmission={vi.fn()}
            onSend={send}
          />
        </div>
      );
    }

    const user = userEvent.setup();
    render(<WorkspaceHarness />);
    const composer = screen.getByRole("textbox", { name: "Message the tutor" });

    await user.type(composer, "three quick keys");

    expect(workspaceRenders).toBe(1);
    expect((composer as HTMLTextAreaElement).value).toBe("three quick keys");
    expect(window.localStorage.getItem(
      tutorComposerStorageKey("study:section:5.3"),
    )).toBe("three quick keys");

    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(send).toHaveBeenCalledWith("three quick keys");
  });
});

describe("DisclosureInspector", () => {
  it("summarizes frozen blocks and keeps exact detail available on demand", () => {
    render(
      <DisclosureInspector
        pending={{
          state: "pending",
          continuity_summaries: [{
            summary_id: "day0-foundations",
            content_hash: "a".repeat(64),
          }],
        }}
        disclosure={{
          bindingHash: "sha256:binding",
          snapshotId: "page_123",
          noteDisclosure: { mode: "full", includedUtf8Bytes: 91 },
          blocks: [
            {
              blockId: "core:01:page_session",
              kind: "page_session",
              title: "Current page and session",
              utf8Bytes: 512,
              content: "exact frozen payload",
            },
          ],
          toolBoundary: {
            readableFiles: ["1.1-llm-internals/README.md"],
            protectedClasses: ["*_solution.py"],
          },
        }}
      />,
    );

    expect(screen.getByText("Context sent · 1 frozen blocks")).toBeTruthy();
    expect(screen.getByText("Current page and session")).toBeTruthy();
    expect(screen.getByText("page_session · 512 bytes")).toBeTruthy();
    expect(screen.getByText("Readable and protected paths")).toBeTruthy();
    expect(screen.getByText("Raw disclosure manifest")).toBeTruthy();
    expect(screen.getByText("Context for next send")).toBeTruthy();
    expect(screen.getByText(/day0-foundations/)).toBeTruthy();
  });
});

describe("extractReflectionBody", () => {
  it("returns the reflection body only, stopping at the next Markdown heading", () => {
    expect(extractReflectionBody([
      "# Session note",
      "",
      "## Reflection",
      "I can now explain the boundary.",
      "",
      "A second paragraph.",
      "",
      "## Answers",
      "Not part of the reflection.",
    ].join("\n"))).toBe("I can now explain the boundary.\n\nA second paragraph.");
  });

  it("ignores heading-looking lines inside fenced code", () => {
    expect(extractReflectionBody([
      "## Reflection",
      "Keep this.",
      "```markdown",
      "# This is code, not the next heading",
      "```",
      "Keep this too.",
      "### Review",
      "Stop here.",
    ].join("\n"))).toBe([
      "Keep this.",
      "```markdown",
      "# This is code, not the next heading",
      "```",
      "Keep this too.",
    ].join("\n"));
  });

  it("does not treat a similarly named section as Reflection", () => {
    expect(extractReflectionBody("## Reflections\nNothing approved here.")).toBe("");
  });
});

describe("TutorContinuityControls", () => {
  const summary: TutorContinuitySummaryView = {
    summary_id: "day0-foundations",
    source_day_id: "day0",
    source_scope_key: "study:section:0.1-setup",
    source_turn_id: "turn-0",
    approved_at: "2026-08-28T16:30:00.000Z",
    content_hash: "a".repeat(64),
    text: "I can explain why the setup boundary matters.",
  };

  it("starts unchecked and explains the exact external disclosure before selection", async () => {
    const user = userEvent.setup();
    const toggle = vi.fn();
    render(
      <TutorContinuityControls
        reflection="I understand the current lesson."
        noteStatus="saved-disk"
        completedTurnId="turn-current"
        summaries={[summary]}
        selectedSummaryIds={[]}
        loading={false}
        loadError={null}
        saveState="idle"
        saveError={null}
        sending={false}
        onSave={vi.fn()}
        onToggle={toggle}
      />,
    );

    expect(screen.getByText("Local summaries · none selected")).toBeTruthy();
    expect(screen.getByText(/Nothing is selected automatically/).textContent).toContain(
      "sends its exact text with your next tutor message to Codex/OpenAI",
    );
    const checkbox = screen.getByRole("checkbox", { name: /Day 0 · 0.1-setup/ });
    expect((checkbox as HTMLInputElement).checked).toBe(false);
    await user.click(checkbox);
    expect(toggle).toHaveBeenCalledWith("day0-foundations", true);
  });

  it("allows local approval only when a reflection is autosaved after a completed reply", async () => {
    const user = userEvent.setup();
    const save = vi.fn();
    const { rerender } = render(
      <TutorContinuityControls
        reflection="A useful reflection."
        noteStatus="saving-local"
        completedTurnId={null}
        summaries={[]}
        selectedSummaryIds={[]}
        loading={false}
        loadError={null}
        saveState="idle"
        saveError={null}
        sending={false}
        onSave={save}
        onToggle={vi.fn()}
      />,
    );

    expect(
      (screen.getByRole("button", { name: "Save ## Reflection locally" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText("Complete a tutor exchange before approving a reflection.")).toBeTruthy();

    rerender(
      <TutorContinuityControls
        reflection="A useful reflection."
        noteStatus="saved-locally"
        completedTurnId="turn-current"
        summaries={[]}
        selectedSummaryIds={[]}
        loading={false}
        loadError={null}
        saveState="idle"
        saveError={null}
        sending={false}
        onSave={save}
        onToggle={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Save ## Reflection locally" }));
    expect(save).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/it is not sent to a model/i)).toBeTruthy();
  });

  it("does not approve a reference note reflection against the visible section's tutor thread", () => {
    render(
      <TutorContinuityControls
        reflection="A reflection from an earlier topic."
        noteStatus="saved-disk"
        completedTurnId="turn-current"
        summaries={[]}
        selectedSummaryIds={[]}
        loading={false}
        loadError={null}
        saveState="idle"
        saveError={null}
        sending={false}
        reflectionSaveBlockedReason="Switch back to this section’s note before saving a reflection for this tutor thread."
        onSave={vi.fn()}
        onToggle={vi.fn()}
      />,
    );

    expect(
      (screen.getByRole("button", { name: "Save ## Reflection locally" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText(/Switch back to this section’s note/)).toBeTruthy();
  });
});
