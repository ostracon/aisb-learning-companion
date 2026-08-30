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
      panels: { navigation: false, schedule: false, tutor: false },
      preFocus: mixed.panels,
    });
    expect(workspaceLayoutReducer(focused, { type: "exit-focus" })).toEqual(mixed);
  });

  it("expanding an edge exits focus and preserves the other pre-focus choices", () => {
    const mixed = {
      ...defaultWorkspaceLayout,
      panels: { navigation: true, schedule: false, tutor: true },
    };
    const focused = workspaceLayoutReducer(mixed, { type: "focus-notes" });
    const expanded = workspaceLayoutReducer(focused, { type: "toggle-panel", panel: "schedule" });
    expect(expanded).toEqual({
      version: 1,
      panels: { navigation: true, schedule: true, tutor: true },
      focusNotes: false,
      preFocus: null,
    });
  });

  it("rehydrates focus only with a complete pre-focus snapshot", () => {
    expect(normalizeWorkspaceLayout({ version: 1, panels: {}, focusNotes: true })).toEqual(
      defaultWorkspaceLayout,
    );
  });
});
