// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import {
  defaultWorkspacePaneSizes,
  paneSizePreferenceKey,
  useWorkspacePaneSizes,
} from "./use-workspace-pane-sizes.js";

beforeEach(() => window.localStorage.clear());

describe("useWorkspacePaneSizes", () => {
  it("persists both resizable boundaries and restores them after remount", async () => {
    const first = renderHook(() => useWorkspacePaneSizes());

    act(() => {
      first.result.current.setTutorWidth(612);
      first.result.current.setStudyMaterialFraction(0.43);
    });
    await waitFor(() => expect(JSON.parse(
      window.localStorage.getItem(paneSizePreferenceKey) ?? "null",
    )).toEqual({
      version: 1,
      tutorWidth: 612,
      studyMaterialFraction: 0.43,
    }));
    first.unmount();

    const restored = renderHook(() => useWorkspacePaneSizes());
    expect(restored.result.current.sizes).toEqual({
      version: 1,
      tutorWidth: 612,
      studyMaterialFraction: 0.43,
    });
  });

  it("falls back safely when stored pane preferences are malformed", () => {
    window.localStorage.setItem(paneSizePreferenceKey, JSON.stringify({
      version: 1,
      tutorWidth: "wide",
      studyMaterialFraction: 4,
    }));

    const { result } = renderHook(() => useWorkspacePaneSizes());
    expect(result.current.sizes).toEqual(defaultWorkspacePaneSizes);
  });

  it("bounds values that cannot fit the supported desktop layout", () => {
    const { result } = renderHook(() => useWorkspacePaneSizes());
    act(() => {
      result.current.setTutorWidth(4_000);
      result.current.setStudyMaterialFraction(0.01);
    });
    expect(result.current.sizes.tutorWidth).toBe(800);
    expect(result.current.sizes.studyMaterialFraction).toBe(0.28);
  });
});
