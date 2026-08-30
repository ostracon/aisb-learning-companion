import { describe, expect, it, vi } from "vitest";

import type {
  CurriculumSectionView,
  LearningDayId,
  LearningProgressSnapshotResponse,
  SetLearningOutcomeCompletionResponse,
} from "../../shared/api.js";
import {
  LearningProgressService,
  type LearningProgressCurriculumSource,
} from "./service.js";

const emptySnapshot: LearningProgressSnapshotResponse = {
  revision: 0,
  version: `r0:${"a".repeat(64)}`,
  completions: [],
  recovered: false,
};

function section(
  sectionId: string,
  outcomeId: string,
  versionId: string,
): CurriculumSectionView {
  return {
    sectionId,
    title: `Section ${sectionId}`,
    sourcePath: `${sectionId}-section/README.md`,
    outcomes: [{
      outcomeId,
      versionId,
      category: "security",
      text: "Explain the security property.",
      sourcePath: `${sectionId}-section/README.md`,
    }],
  };
}

function curriculumSource(
  programme: Partial<Record<LearningDayId, CurriculumSectionView[]>>,
  repository: Partial<Record<LearningDayId, CurriculumSectionView[]>>,
): LearningProgressCurriculumSource {
  return {
    readAllDays: vi.fn(async () => programme),
    readAllRepositoryDays: vi.fn(async () => repository),
  };
}

function persistence(result: SetLearningOutcomeCompletionResponse = {
  status: "unchanged",
  completion: {
    outcomeId: "4.1:security:1",
    outcomeVersionId: "version-1",
    completed: true,
    completedAt: "2026-08-29T12:00:00.000Z",
  },
  snapshot: emptySnapshot,
}) {
  return {
    read: vi.fn(async () => emptySnapshot),
    setCompletion: vi.fn(async () => result),
  };
}

describe("LearningProgressService canonical outcome boundary", () => {
  it("reads the durable snapshot without requiring curriculum projection", async () => {
    const store = persistence();
    const source = curriculumSource({}, {});
    const service = new LearningProgressService(store, source);

    await expect(service.read()).resolves.toEqual(emptySnapshot);
    expect(source.readAllDays).not.toHaveBeenCalled();
    expect(source.readAllRepositoryDays).not.toHaveBeenCalled();
  });

  it("accepts an exact current outcome present only under repository identity", async () => {
    const store = persistence();
    const service = new LearningProgressService(
      store,
      curriculumSource({}, { day4: [section("4.1", "4.1:security:1", "version-1")] }),
    );
    const input = {
      expectedVersion: emptySnapshot.version,
      outcomeId: "4.1:security:1",
      outcomeVersionId: "version-1",
      completed: true,
    };

    await expect(service.setCompletion(input)).resolves.toMatchObject({ status: "unchanged" });
    expect(store.setCompletion).toHaveBeenCalledWith(input);
  });

  it("deduplicates the same canonical pair across programme and repository identities", async () => {
    const store = persistence();
    const canonical = section("4.1", "4.1:security:1", "version-1");
    const service = new LearningProgressService(
      store,
      curriculumSource({ day5: [canonical] }, { day4: [canonical] }),
    );

    await expect(service.setCompletion({
      expectedVersion: emptySnapshot.version,
      outcomeId: "4.1:security:1",
      outcomeVersionId: "version-1",
      completed: true,
    })).resolves.toMatchObject({ status: "unchanged" });
    expect(store.setCompletion).toHaveBeenCalledOnce();
  });

  it.each([
    ["unknown outcome", "missing:security:1", "version-1"],
    ["stale version", "4.1:security:1", "old-version"],
  ])("rejects a %s before persistence", async (_label, outcomeId, outcomeVersionId) => {
    const store = persistence();
    const service = new LearningProgressService(
      store,
      curriculumSource(
        { day5: [section("4.1", "4.1:security:1", "version-1")] },
        { day4: [section("4.1", "4.1:security:1", "version-1")] },
      ),
    );

    await expect(service.setCompletion({
      expectedVersion: emptySnapshot.version,
      outcomeId,
      outcomeVersionId,
      completed: true,
    })).rejects.toMatchObject({
      code: "canonical_outcome_mismatch",
      statusCode: 409,
    });
    expect(store.setCompletion).not.toHaveBeenCalled();
  });

  it("fails closed when current identities disagree about an outcome version", async () => {
    const store = persistence();
    const service = new LearningProgressService(
      store,
      curriculumSource(
        { day5: [section("4.1", "4.1:security:1", "version-1")] },
        { day4: [section("4.1", "4.1:security:1", "version-2")] },
      ),
    );

    await expect(service.setCompletion({
      expectedVersion: emptySnapshot.version,
      outcomeId: "4.1:security:1",
      outcomeVersionId: "version-1",
      completed: true,
    })).rejects.toMatchObject({
      code: "ambiguous_canonical_outcome",
      statusCode: 409,
    });
    expect(store.setCompletion).not.toHaveBeenCalled();
  });
});
