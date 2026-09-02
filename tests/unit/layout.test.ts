import { describe, expect, it } from "vitest";
import {
  defaultWorkspaceLayout,
  normalizeWorkspaceLayout,
  workspaceLayoutReducer,
} from "../../src/client/state/layout.js";

describe("workspace layout", () => {
  it("restores the exact mixed arrangement after focus", () => {
    const mixed = workspaceLayoutReducer(defaultWorkspaceLayout, { type: "toggle-panel", panel: "tutor" });
    const focused = workspaceLayoutReducer(mixed, { type: "focus-notes" });
    expect(focused).toMatchObject({
      focusNotes: true,
      panels: { navigation: false, schedule: false, notes: true, tutor: false },
      preFocus: mixed.panels,
    });
    expect(workspaceLayoutReducer(focused, { type: "exit-focus" })).toEqual(mixed);
  });

  it("expanding an edge exits focus and preserves the other pre-focus choices", () => {
    const mixed = {
      ...defaultWorkspaceLayout,
      panels: { navigation: true, schedule: false, notes: false, tutor: true },
    };
    const focused = workspaceLayoutReducer(mixed, { type: "focus-notes" });
    const expanded = workspaceLayoutReducer(focused, { type: "toggle-panel", panel: "schedule" });
    expect(expanded).toEqual({
      version: 1,
      panels: { navigation: true, schedule: true, notes: false, tutor: true },
      focusNotes: false,
      preFocus: null,
    });
  });

  it("rehydrates focus only with a complete pre-focus snapshot", () => {
    expect(normalizeWorkspaceLayout({ version: 1, panels: {}, focusNotes: true })).toEqual(
      defaultWorkspaceLayout,
    );
  });

  it("migrates layouts saved before Notes visibility existed", () => {
    expect(normalizeWorkspaceLayout({
      version: 1,
      panels: { navigation: false, schedule: true, tutor: false },
      focusNotes: false,
    })).toEqual({
      version: 1,
      panels: { navigation: false, schedule: true, notes: true, tutor: false },
      focusNotes: false,
      preFocus: null,
    });
  });

  it("restores a hidden Notes column after temporarily focusing it", () => {
    const notesHidden = workspaceLayoutReducer(defaultWorkspaceLayout, { type: "toggle-study-notes" });
    const focused = workspaceLayoutReducer(notesHidden, { type: "focus-notes" });

    expect(focused.panels.notes).toBe(true);
    expect(workspaceLayoutReducer(focused, { type: "exit-focus" })).toEqual(notesHidden);
  });

  it("restores material when Notes is hidden from a notes-only Study view", () => {
    const materialHidden = workspaceLayoutReducer(defaultWorkspaceLayout, {
      type: "toggle-panel",
      panel: "schedule",
    });

    expect(workspaceLayoutReducer(materialHidden, { type: "toggle-study-notes" }).panels).toEqual({
      navigation: true,
      schedule: true,
      notes: false,
      tutor: true,
    });
  });
});
