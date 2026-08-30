import { useCallback, useEffect, useRef, useState } from "react";

import type {
  LearningProgressSnapshotResponse,
  SetLearningOutcomeCompletionResponse,
} from "../../shared/api.js";

export interface UseLearningProgressOptions {
  readonly fetch?: typeof globalThis.fetch;
}

const defaultFetch: typeof globalThis.fetch = (input, init) => globalThis.fetch(input, init);

function completionKey(outcomeId: string, outcomeVersionId: string): string {
  return `${outcomeId}\u0000${outcomeVersionId}`;
}

function asSnapshot(value: unknown): LearningProgressSnapshotResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("The progress service returned a malformed snapshot");
  }
  const candidate = value as Partial<LearningProgressSnapshotResponse>;
  if (
    typeof candidate.revision !== "number"
    || !Number.isSafeInteger(candidate.revision)
    || candidate.revision < 0
    || typeof candidate.version !== "string"
    || !/^r(?:0|[1-9]\d*):[a-f0-9]{64}$/.test(candidate.version)
    || !Array.isArray(candidate.completions)
    || typeof candidate.recovered !== "boolean"
  ) {
    throw new Error("The progress service returned a malformed snapshot");
  }
  for (const completion of candidate.completions) {
    if (
      typeof completion !== "object"
      || completion === null
      || typeof completion.outcomeId !== "string"
      || typeof completion.outcomeVersionId !== "string"
      || typeof completion.completed !== "boolean"
      || (completion.completedAt !== null && typeof completion.completedAt !== "string")
    ) {
      throw new Error("The progress service returned malformed outcome state");
    }
  }
  return candidate as LearningProgressSnapshotResponse;
}

function responseSnapshot(
  value: unknown,
): { readonly status: "saved" | "unchanged"; readonly snapshot: LearningProgressSnapshotResponse }
  | { readonly status: "conflict"; readonly current: LearningProgressSnapshotResponse } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("The progress service returned a malformed response");
  }
  const candidate = value as Partial<SetLearningOutcomeCompletionResponse>;
  if (candidate.status === "conflict" && "current" in candidate) {
    return { status: "conflict", current: asSnapshot(candidate.current) };
  }
  if ((candidate.status === "saved" || candidate.status === "unchanged") && "snapshot" in candidate) {
    return { status: candidate.status, snapshot: asSnapshot(candidate.snapshot) };
  }
  throw new Error("The progress service returned a malformed response");
}

/**
 * Owns the client side of the progress compare-and-swap protocol. Mutations are
 * serialized, and one conflict is rebased onto the server snapshot before the
 * learner's exact checkbox intent is retried.
 */
export function useLearningProgress(options: UseLearningProgressOptions = {}) {
  const fetchImpl = options.fetch ?? defaultFetch;
  const [snapshot, setSnapshot] = useState<LearningProgressSnapshotResponse | null>(null);
  const [pendingCounts, setPendingCounts] = useState<ReadonlyMap<string, number>>(() => new Map());
  const [error, setError] = useState<string | null>(null);
  const snapshotRef = useRef<LearningProgressSnapshotResponse | null>(null);
  const mutationTailRef = useRef<Promise<void>>(Promise.resolve());
  const loadGenerationRef = useRef(0);

  const acceptSnapshot = useCallback((next: LearningProgressSnapshotResponse) => {
    const current = snapshotRef.current;
    if (
      current !== null
      && (
        next.revision < current.revision
        || (next.revision === current.revision && next.version !== current.version)
      )
    ) {
      return false;
    }
    snapshotRef.current = next;
    setSnapshot(next);
    return true;
  }, []);

  const load = useCallback(async () => {
    const generation = ++loadGenerationRef.current;
    setError(null);
    try {
      const response = await fetchImpl("/api/progress");
      if (!response.ok) throw new Error("Could not read learning-outcome progress");
      const next = asSnapshot(await response.json());
      if (generation === loadGenerationRef.current) acceptSnapshot(next);
    } catch (reason) {
      if (generation !== loadGenerationRef.current) return;
      setError(reason instanceof Error ? reason.message : "Could not read learning-outcome progress");
    }
  }, [acceptSnapshot, fetchImpl]);

  useEffect(() => {
    void load();
  }, [load]);

  const setCompletion = useCallback((outcomeId: string, outcomeVersionId: string, completed: boolean) => {
    const key = completionKey(outcomeId, outcomeVersionId);
    setPendingCounts((current) => {
      const next = new Map(current);
      next.set(key, (next.get(key) ?? 0) + 1);
      return next;
    });

    const mutation = mutationTailRef.current.then(async () => {
      setError(null);
      let base = snapshotRef.current;
      if (base === null) {
        await load();
        base = snapshotRef.current;
      }
      if (base === null) throw new Error("Learning-outcome progress is not available yet");

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await fetchImpl("/api/progress/outcomes", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            expected_version: base.version,
            outcome_id: outcomeId,
            outcome_version_id: outcomeVersionId,
            completed,
          }),
        });
        const result = responseSnapshot(await response.json());
        if (result.status === "conflict") {
          acceptSnapshot(result.current);
          base = snapshotRef.current ?? result.current;
          if (attempt === 0) continue;
          throw new Error("Progress changed in another window; try the checkbox again");
        }
        if (!response.ok) throw new Error("Could not save learning-outcome progress");
        acceptSnapshot(result.snapshot);
        return;
      }
    });

    mutationTailRef.current = mutation
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : "Could not save learning-outcome progress");
      })
      .finally(() => {
        setPendingCounts((current) => {
          const next = new Map(current);
          const remaining = (next.get(key) ?? 1) - 1;
          if (remaining === 0) next.delete(key);
          else next.set(key, remaining);
          return next;
        });
      });
  }, [acceptSnapshot, fetchImpl, load]);

  const completionMap = new Map(
    snapshot?.completions.map((completion) => [
      completionKey(completion.outcomeId, completion.outcomeVersionId),
      completion.completed,
    ]) ?? [],
  );

  return {
    snapshot,
    loading: snapshot === null && error === null,
    error,
    reload: load,
    isCompleted(outcomeId: string, outcomeVersionId: string): boolean {
      return completionMap.get(completionKey(outcomeId, outcomeVersionId)) === true;
    },
    isPending(outcomeId: string, outcomeVersionId: string): boolean {
      return pendingCounts.has(completionKey(outcomeId, outcomeVersionId));
    },
    setCompletion,
  };
}
