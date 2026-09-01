import { useCallback, useEffect, useState } from "react";

export const paneSizePreferenceKey = "aisb-companion:pane-sizes:v1";

export interface WorkspacePaneSizes {
  readonly version: 1;
  readonly tutorWidth: number;
  readonly studyMaterialFraction: number;
}

export const defaultWorkspacePaneSizes: WorkspacePaneSizes = Object.freeze({
  version: 1,
  tutorWidth: 424,
  studyMaterialFraction: 0.58,
});

const MIN_TUTOR_WIDTH = 320;
const MAX_TUTOR_WIDTH = 800;
const MIN_STUDY_MATERIAL_FRACTION = 0.28;
const MAX_STUDY_MATERIAL_FRACTION = 0.72;

function bounded(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function normalizeWorkspacePaneSizes(value: unknown): WorkspacePaneSizes {
  if (typeof value !== "object" || value === null) return defaultWorkspacePaneSizes;
  const candidate = value as Partial<WorkspacePaneSizes>;
  if (
    candidate.version !== 1
    || typeof candidate.tutorWidth !== "number"
    || !Number.isFinite(candidate.tutorWidth)
    || typeof candidate.studyMaterialFraction !== "number"
    || !Number.isFinite(candidate.studyMaterialFraction)
  ) {
    return defaultWorkspacePaneSizes;
  }
  return {
    version: 1,
    tutorWidth: bounded(candidate.tutorWidth, MIN_TUTOR_WIDTH, MAX_TUTOR_WIDTH),
    studyMaterialFraction: bounded(
      candidate.studyMaterialFraction,
      MIN_STUDY_MATERIAL_FRACTION,
      MAX_STUDY_MATERIAL_FRACTION,
    ),
  };
}

function readInitialPaneSizes(): WorkspacePaneSizes {
  try {
    return normalizeWorkspacePaneSizes(JSON.parse(
      window.localStorage.getItem(paneSizePreferenceKey) ?? "null",
    ));
  } catch {
    return defaultWorkspacePaneSizes;
  }
}

export function useWorkspacePaneSizes() {
  const [sizes, setSizes] = useState<WorkspacePaneSizes>(readInitialPaneSizes);

  useEffect(() => {
    try {
      window.localStorage.setItem(paneSizePreferenceKey, JSON.stringify(sizes));
    } catch {
      // Resizing remains available for this page when browser storage is blocked.
    }
  }, [sizes]);

  const setTutorWidth = useCallback((tutorWidth: number) => {
    setSizes((current) => normalizeWorkspacePaneSizes({ ...current, tutorWidth }));
  }, []);

  const setStudyMaterialFraction = useCallback((studyMaterialFraction: number) => {
    setSizes((current) => normalizeWorkspacePaneSizes({
      ...current,
      studyMaterialFraction,
    }));
  }, []);

  const resetTutorWidth = useCallback(() => {
    setTutorWidth(defaultWorkspacePaneSizes.tutorWidth);
  }, [setTutorWidth]);

  const resetStudyMaterialFraction = useCallback(() => {
    setStudyMaterialFraction(defaultWorkspacePaneSizes.studyMaterialFraction);
  }, [setStudyMaterialFraction]);

  return {
    sizes,
    setTutorWidth,
    setStudyMaterialFraction,
    resetTutorWidth,
    resetStudyMaterialFraction,
  };
}
