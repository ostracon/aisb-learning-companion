// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { learningOutcomesDisclosurePreferenceKey } from "../state/outcome-disclosure.js";
import { useLearningOutcomesDisclosure } from "./use-learning-outcomes-disclosure.js";

beforeEach(() => window.localStorage.clear());

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useLearningOutcomesDisclosure", () => {
  it("restores the collapsed preference after a hard reload", () => {
    const firstPage = renderHook(() => useLearningOutcomesDisclosure());
    expect(firstPage.result.current.expanded).toBe(true);

    act(() => firstPage.result.current.toggle());
    expect(firstPage.result.current.expanded).toBe(false);
    expect(window.localStorage.getItem(learningOutcomesDisclosurePreferenceKey)).toBe(
      JSON.stringify({ version: 1, expanded: false }),
    );
    firstPage.unmount();

    const reloadedPage = renderHook(() => useLearningOutcomesDisclosure());
    expect(reloadedPage.result.current.expanded).toBe(false);
  });

  it("keeps working in memory when browser storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage blocked", "SecurityError");
    });
    const view = renderHook(() => useLearningOutcomesDisclosure());

    act(() => view.result.current.setExpanded(false));

    expect(view.result.current.expanded).toBe(false);
  });

  it("ignores malformed persisted values", () => {
    window.localStorage.setItem(learningOutcomesDisclosurePreferenceKey, "not-json");

    const view = renderHook(() => useLearningOutcomesDisclosure());

    expect(view.result.current.expanded).toBe(true);
  });
});
