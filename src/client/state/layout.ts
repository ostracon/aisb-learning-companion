export const layoutPreferenceKey = "aisb-companion:layout:v1";
export const historyLayoutKey = "aisbCompanionLayout";

export type WorkspacePanel = "navigation" | "schedule" | "notes" | "tutor";

export interface PanelVisibility {
  navigation: boolean;
  schedule: boolean;
  notes: boolean;
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
  | { type: "toggle-study-notes" }
  | { type: "focus-notes" }
  | { type: "exit-focus" }
  | { type: "restore"; layout: WorkspaceLayout };

export const defaultWorkspaceLayout: WorkspaceLayout = {
  version: 1,
  panels: { navigation: true, schedule: true, notes: true, tutor: true },
  focusNotes: false,
  preFocus: null,
};

function clonePanels(value: PanelVisibility): PanelVisibility {
  return {
    navigation: value.navigation,
    schedule: value.schedule,
    notes: value.notes,
    tutor: value.tutor,
  };
}

export function workspaceLayoutReducer(state: WorkspaceLayout, action: LayoutAction): WorkspaceLayout {
  switch (action.type) {
    case "focus-notes":
      if (state.focusNotes) return state;
      return {
        version: 1,
        panels: { navigation: false, schedule: false, notes: true, tutor: false },
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
    case "toggle-study-notes":
      if (state.focusNotes) return state;
      return {
        ...state,
        panels: {
          ...state.panels,
          // A material-only view must contain material. Showing Notes again
          // leaves the learner's previous material choice untouched.
          schedule: state.panels.notes ? true : state.panels.schedule,
          notes: !state.panels.notes,
        },
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
    // Layout v1 originally had no Notes visibility preference. Treat those
    // saved layouts as visible so an upgrade never makes a learner's editor
    // appear to vanish.
    notes: typeof panels.notes === "boolean" ? panels.notes : true,
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
    panels: { navigation: false, schedule: false, notes: true, tutor: false },
    focusNotes: true,
    preFocus: {
      navigation: preFocus.navigation,
      schedule: preFocus.schedule,
      notes: typeof preFocus.notes === "boolean" ? preFocus.notes : true,
      tutor: preFocus.tutor,
    },
  };
}
