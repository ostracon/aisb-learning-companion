import type { LearningDayId } from "./api.js";
import type { ManagerSessionView, ManagerTurnRequest, ManagerTurnResponse } from "./manager.js";

export const DAY_REVIEW_MODES = ["recap", "active_recall", "gap_finding"] as const;
export type DayReviewMode = (typeof DAY_REVIEW_MODES)[number];

export type DayReviewResourceKind =
  | "note"
  | "curriculum"
  | "prepared_reference"
  | "tutor_history"
  | "review_history"
  | "continuity";

export interface DayReviewResourceDescriptor {
  readonly resourceId: string;
  readonly kind: DayReviewResourceKind;
  readonly title: string;
  readonly citation: string;
  readonly status: "ready" | "unavailable";
  readonly detail: string;
}

export interface DayReviewContextProjection {
  readonly schema: "aisb-learning-companion.day-review-context.v1";
  readonly generatedAt: string;
  readonly dayId: LearningDayId;
  readonly schedule: {
    readonly revision: string;
    readonly title: string;
    readonly date: string | null;
    readonly events: readonly {
      readonly title: string;
      readonly start: string;
      readonly end: string;
      readonly status: "scheduled" | "cancelled";
    }[];
  };
  readonly sections: readonly {
    readonly sectionId: string;
    readonly title: string;
  }[];
  readonly outcomes: readonly {
    readonly outcomeId: string;
    readonly versionId: string;
    readonly sectionId: string;
    readonly category: "engineering" | "ml" | "security" | "theory";
    readonly text: string;
    readonly checked: boolean;
  }[];
  readonly resources: readonly DayReviewResourceDescriptor[];
  readonly resourceCounts: Readonly<Record<DayReviewResourceKind, number>>;
  readonly omissions: readonly string[];
}

export interface DayReviewSessionView extends ManagerSessionView {
  readonly dayId: LearningDayId;
}

export type DayReviewTurnRequest = ManagerTurnRequest;
export type DayReviewTurnResponse = ManagerTurnResponse;

