export const layoutPreferenceKey = "aisb-companion:layout:v1";
export const historyLayoutKey = "aisbCompanionLayout";

export type WorkspacePanel = "navigation" | "schedule" | "tutor";

export interface PanelVisibility {
  navigation: boolean;
  schedule: boolean;
  tutor: boolean;
}

export interface WorkspaceLayout {
  version: 1;
  panels: PanelVisibility;
  focusNotes: boolean;
  preFocus: PanelVisibility | null;
}

export type LayoutAction =
  | { type: "toggle-panel"; panel: WorkspacePanel }
  | { type: "focus-notes" }
  | { type: "exit-focus" }
  | { type: "restore"; layout: WorkspaceLayout };

export const defaultWorkspaceLayout: WorkspaceLayout = {
  version: 1,
  panels: { navigation: true, schedule: true, tutor: true },
  focusNotes: false,
  preFocus: null,
};

function clonePanels(value: PanelVisibility): PanelVisibility {
  return { navigation: value.navigation, schedule: value.schedule, tutor: value.tutor };
}

export function workspaceLayoutReducer(state: WorkspaceLayout, action: LayoutAction): WorkspaceLayout {
  switch (action.type) {
    case "focus-notes":
      if (state.focusNotes) return state;
      return {
        version: 1,
        panels: { navigation: false, schedule: false, tutor: false },
        focusNotes: true,
        preFocus: clonePanels(state.panels),
      };
    case "exit-focus":
      if (!state.focusNotes) return state;
      return {
        version: 1,
        panels: clonePanels(state.preFocus ?? defaultWorkspaceLayout.panels),
        focusNotes: false,
        preFocus: null,
      };
    case "toggle-panel": {
      if (state.focusNotes) {
        const restored = clonePanels(state.preFocus ?? defaultWorkspaceLayout.panels);
        restored[action.panel] = true;
        return { version: 1, panels: restored, focusNotes: false, preFocus: null };
      }
      return {
        ...state,
        panels: { ...state.panels, [action.panel]: !state.panels[action.panel] },
      };
    }
    case "restore":
      return normalizeWorkspaceLayout(action.layout);
  }
}

export function normalizeWorkspaceLayout(value: unknown): WorkspaceLayout {
  if (!value || typeof value !== "object") return defaultWorkspaceLayout;
  const candidate = value as Partial<WorkspaceLayout>;
  const panels = candidate.panels as Partial<PanelVisibility> | undefined;
  if (
    candidate.version !== 1 ||
    typeof panels?.navigation !== "boolean" ||
    typeof panels.schedule !== "boolean" ||
    typeof panels.tutor !== "boolean" ||
    typeof candidate.focusNotes !== "boolean"
  ) {
    return defaultWorkspaceLayout;
  }
  const normalizedPanels: PanelVisibility = {
    navigation: panels.navigation,
    schedule: panels.schedule,
    tutor: panels.tutor,
  };
  if (!candidate.focusNotes) {
    return { version: 1, panels: normalizedPanels, focusNotes: false, preFocus: null };
  }
  const preFocus = candidate.preFocus as Partial<PanelVisibility> | null | undefined;
  if (
    !preFocus ||
    typeof preFocus.navigation !== "boolean" ||
    typeof preFocus.schedule !== "boolean" ||
    typeof preFocus.tutor !== "boolean"
  ) {
    return defaultWorkspaceLayout;
  }
  return {
    version: 1,
    panels: { navigation: false, schedule: false, tutor: false },
    focusNotes: true,
    preFocus: {
      navigation: preFocus.navigation,
      schedule: preFocus.schedule,
      tutor: preFocus.tutor,
    },
  };
}
