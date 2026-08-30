import { useEffect, useReducer } from "react";
import { useLocation } from "react-router-dom";
import {
  defaultWorkspaceLayout,
  historyLayoutKey,
  layoutPreferenceKey,
  normalizeWorkspaceLayout,
  workspaceLayoutReducer,
} from "../state/layout.js";

function readInitialLayout() {
  const historyValue = window.history.state?.[historyLayoutKey] as unknown;
  if (historyValue) return normalizeWorkspaceLayout(historyValue);
  try {
    return normalizeWorkspaceLayout(JSON.parse(localStorage.getItem(layoutPreferenceKey) ?? "null"));
  } catch {
    return defaultWorkspaceLayout;
  }
}

export function useWorkspaceLayout() {
  const [layout, dispatch] = useReducer(workspaceLayoutReducer, undefined, readInitialLayout);
  const location = useLocation();

  useEffect(() => {
    try {
      localStorage.setItem(layoutPreferenceKey, JSON.stringify(layout));
    } catch {
      // History remains the authoritative per-entry snapshot when storage is unavailable.
    }
    const existing = (window.history.state ?? {}) as Record<string, unknown>;
    window.history.replaceState({ ...existing, [historyLayoutKey]: layout }, "");
  }, [layout, location.key]);

  useEffect(() => {
    const restore = () => {
      const historyValue = window.history.state?.[historyLayoutKey] as unknown;
      if (historyValue) dispatch({ type: "restore", layout: normalizeWorkspaceLayout(historyValue) });
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);

  return { layout, dispatch };
}
