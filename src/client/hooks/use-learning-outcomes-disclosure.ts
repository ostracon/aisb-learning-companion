import { useCallback, useEffect, useState } from "react";

import {
  learningOutcomesDisclosurePreferenceKey,
  normalizeLearningOutcomesDisclosurePreference,
  serializeLearningOutcomesDisclosurePreference,
} from "../state/outcome-disclosure.js";

function readPreference(): boolean {
  try {
    return normalizeLearningOutcomesDisclosurePreference(JSON.parse(
      window.localStorage.getItem(learningOutcomesDisclosurePreferenceKey) ?? "null",
    ));
  } catch {
    return true;
  }
}

export function useLearningOutcomesDisclosure() {
  const [expanded, setExpandedState] = useState(readPreference);

  const setExpanded = useCallback((next: boolean) => {
    setExpandedState(next);
    try {
      window.localStorage.setItem(
        learningOutcomesDisclosurePreferenceKey,
        serializeLearningOutcomesDisclosurePreference(next),
      );
    } catch {
      // The in-memory preference still works when browser storage is unavailable.
    }
  }, []);

  useEffect(() => {
    const synchronize = (event: StorageEvent) => {
      if (event.key !== learningOutcomesDisclosurePreferenceKey) return;
      setExpandedState(readPreference());
    };
    window.addEventListener("storage", synchronize);
    return () => window.removeEventListener("storage", synchronize);
  }, []);

  return {
    expanded,
    toggle: useCallback(() => setExpanded(!expanded), [expanded, setExpanded]),
    setExpanded,
  };
}
