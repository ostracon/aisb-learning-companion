import type {
  CurriculumSectionView,
  LearningDayId,
  LearningProgressSnapshotResponse,
  SetLearningOutcomeCompletionResponse,
} from "../../shared/api.js";
import type {
  LearningProgressStore,
  SetLearningOutcomeCompletionRequest as StoreMutationRequest,
} from "./store.js";

type CurriculumByDay = Partial<Record<LearningDayId, readonly CurriculumSectionView[]>>;

export interface LearningProgressCurriculumSource {
  /** Calendar/programme identity, including explicit schedule-to-repo mappings. */
  readAllDays(): Promise<CurriculumByDay>;
  /** Direct repository identity, independent of calendar scheduling. */
  readAllRepositoryDays(): Promise<CurriculumByDay>;
}

export type LearningProgressServiceErrorCode =
  | "canonical_outcome_mismatch"
  | "ambiguous_canonical_outcome";

export class LearningProgressServiceError extends Error {
  constructor(
    readonly code: LearningProgressServiceErrorCode,
    message: string,
    readonly statusCode = 409,
  ) {
    super(message);
    this.name = "LearningProgressServiceError";
  }
}

interface LearningProgressPersistence {
  read(): Promise<LearningProgressSnapshotResponse>;
  setCompletion(input: StoreMutationRequest): Promise<SetLearningOutcomeCompletionResponse>;
}

function addCanonicalSections(
  versionsByOutcome: Map<string, Set<string>>,
  curriculum: CurriculumByDay,
): void {
  for (const sections of Object.values(curriculum)) {
    for (const section of sections ?? []) {
      for (const outcome of section.outcomes) {
        const versions = versionsByOutcome.get(outcome.outcomeId) ?? new Set<string>();
        versions.add(outcome.versionId);
        versionsByOutcome.set(outcome.outcomeId, versions);
      }
    }
  }
}

/**
 * Applies the current curriculum contract before allowing the persistence
 * layer to record a learner-declared checkbox. Client-supplied outcome text,
 * paths, section identities, and timestamps are intentionally not accepted.
 */
export class LearningProgressService {
  readonly #store: LearningProgressPersistence;
  readonly #curriculum: LearningProgressCurriculumSource;

  constructor(
    store: LearningProgressStore | LearningProgressPersistence,
    curriculum: LearningProgressCurriculumSource,
  ) {
    this.#store = store;
    this.#curriculum = curriculum;
  }

  read(): Promise<LearningProgressSnapshotResponse> {
    return this.#store.read();
  }

  async setCompletion(input: StoreMutationRequest): Promise<SetLearningOutcomeCompletionResponse> {
    const [programmeCurriculum, repositoryCurriculum] = await Promise.all([
      this.#curriculum.readAllDays(),
      this.#curriculum.readAllRepositoryDays(),
    ]);
    const versionsByOutcome = new Map<string, Set<string>>();
    addCanonicalSections(versionsByOutcome, programmeCurriculum);
    addCanonicalSections(versionsByOutcome, repositoryCurriculum);

    const canonicalVersions = versionsByOutcome.get(input.outcomeId);
    if (canonicalVersions === undefined || !canonicalVersions.has(input.outcomeVersionId)) {
      throw new LearningProgressServiceError(
        "canonical_outcome_mismatch",
        "That learning outcome is no longer part of the current curriculum. Refresh before updating progress.",
      );
    }
    if (canonicalVersions.size !== 1) {
      throw new LearningProgressServiceError(
        "ambiguous_canonical_outcome",
        "The current curriculum contains conflicting versions of that learning outcome.",
      );
    }

    return this.#store.setCompletion(input);
  }
}
