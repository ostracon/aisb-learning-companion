// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { LearningProgressSnapshotResponse } from "../../shared/api.js";
import { useLearningProgress } from "./use-learning-progress.js";

const emptyHash = "a".repeat(64);
const conflictHash = "b".repeat(64);
const savedHash = "c".repeat(64);

function snapshot(
  revision: number,
  hash: string,
  completed = false,
): LearningProgressSnapshotResponse {
  return {
    revision,
    version: `r${revision}:${hash}`,
    recovered: false,
    completions: revision === 0 ? [] : [{
      outcomeId: "1.1:security:1",
      outcomeVersionId: "outcome-version-1",
      completed,
      completedAt: completed ? "2026-08-29T20:00:00.000Z" : null,
    }],
  };
}

function response(ok: boolean, body: unknown): Response {
  return { ok, json: async () => body } as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("useLearningProgress", () => {
  it("loads and persists a learner-declared completion", async () => {
    const initial = snapshot(0, emptyHash);
    const saved = snapshot(1, savedHash, true);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(true, initial))
      .mockResolvedValueOnce(response(true, {
        status: "saved",
        completion: saved.completions[0],
        snapshot: saved,
        previousVersion: initial.version,
      }));

    const { result } = renderHook(() => useLearningProgress({ fetch: fetchMock }));
    await waitFor(() => expect(result.current.snapshot?.version).toBe(initial.version));

    act(() => result.current.setCompletion("1.1:security:1", "outcome-version-1", true));
    await waitFor(() => expect(result.current.isCompleted("1.1:security:1", "outcome-version-1")).toBe(true));

    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      expected_version: initial.version,
      outcome_id: "1.1:security:1",
      outcome_version_id: "outcome-version-1",
      completed: true,
    });
  });

  it("rebases one compare-and-swap conflict before retrying the same intent", async () => {
    const initial = snapshot(0, emptyHash);
    const concurrent = snapshot(1, conflictHash, false);
    const saved = snapshot(2, savedHash, true);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(true, initial))
      .mockResolvedValueOnce(response(false, { status: "conflict", current: concurrent }))
      .mockResolvedValueOnce(response(true, {
        status: "saved",
        completion: saved.completions[0],
        snapshot: saved,
        previousVersion: concurrent.version,
      }));

    const { result } = renderHook(() => useLearningProgress({ fetch: fetchMock }));
    await waitFor(() => expect(result.current.snapshot?.version).toBe(initial.version));
    act(() => result.current.setCompletion("1.1:security:1", "outcome-version-1", true));
    await waitFor(() => expect(result.current.snapshot?.version).toBe(saved.version));

    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)).expected_version).toBe(concurrent.version);
    expect(result.current.error).toBeNull();
  });

  it("does not let a delayed load regress a newer accepted mutation snapshot", async () => {
    const initial = snapshot(0, emptyHash);
    const saved = snapshot(1, savedHash, true);
    const firstLoad = deferred<Response>();
    let getCount = 0;
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return Promise.resolve(response(true, {
          status: "saved",
          completion: saved.completions[0],
          snapshot: saved,
          previousVersion: initial.version,
        }));
      }
      getCount += 1;
      return getCount === 1
        ? firstLoad.promise
        : Promise.resolve(response(true, initial));
    });

    const { result } = renderHook(() => useLearningProgress({ fetch: fetchMock as typeof fetch }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    act(() => result.current.setCompletion("1.1:security:1", "outcome-version-1", true));
    await waitFor(() => expect(result.current.snapshot?.version).toBe(saved.version));

    firstLoad.resolve(response(true, initial));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.snapshot?.version).toBe(saved.version);
    expect(result.current.isCompleted("1.1:security:1", "outcome-version-1")).toBe(true);
  });

  it("keeps one outcome pending until every queued toggle settles", async () => {
    const initial = snapshot(0, emptyHash);
    const firstSaved = snapshot(1, savedHash, true);
    const secondSaved = snapshot(2, "d".repeat(64), false);
    const firstPut = deferred<Response>();
    const secondPut = deferred<Response>();
    let putCount = 0;
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== "PUT") return Promise.resolve(response(true, initial));
      putCount += 1;
      return putCount === 1 ? firstPut.promise : secondPut.promise;
    });

    const { result } = renderHook(() => useLearningProgress({ fetch: fetchMock as typeof fetch }));
    await waitFor(() => expect(result.current.snapshot?.version).toBe(initial.version));
    act(() => {
      result.current.setCompletion("1.1:security:1", "outcome-version-1", true);
      result.current.setCompletion("1.1:security:1", "outcome-version-1", false);
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(result.current.isPending("1.1:security:1", "outcome-version-1")).toBe(true);

    firstPut.resolve(response(true, {
      status: "saved",
      completion: firstSaved.completions[0],
      snapshot: firstSaved,
      previousVersion: initial.version,
    }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(result.current.isPending("1.1:security:1", "outcome-version-1")).toBe(true);

    secondPut.resolve(response(true, {
      status: "saved",
      completion: secondSaved.completions[0],
      snapshot: secondSaved,
      previousVersion: firstSaved.version,
    }));
    await waitFor(() => expect(result.current.snapshot?.version).toBe(secondSaved.version));
    expect(result.current.isPending("1.1:security:1", "outcome-version-1")).toBe(false);
  });
});
