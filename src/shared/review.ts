import type { OutcomeCategory } from "./page-context.js";

export const REVIEW_QUESTION_MODES = [
  "free_recall",
  "short_answer",
  "explain_back",
  "compare_contrast",
  "scenario_application",
] as const;

export type ReviewQuestionMode = (typeof REVIEW_QUESTION_MODES)[number];

/** A citation derived by the server from one selected canonical outcome. */
export interface ReviewOutcomeCitation {
  readonly outcomeId: string;
  readonly outcomeVersionId: string;
  readonly category: OutcomeCategory;
  readonly label: string;
  readonly sourcePath: string;
  readonly sourceCommit: string;
}

/** Auditable origin of one generated review item. */
export interface ReviewTurnProvenance {
  readonly engine: "codex-app-server" | "local-template";
  /** Ordinary App Server review generation uses `turn/start`, never `review/start`. */
  readonly transport: "turn/start" | "in-process";
  readonly model: string | null;
  readonly permissionProfile: string | null;
  readonly threadId: string;
  readonly turnId: string;
  readonly disclosureId: string;
  readonly payloadHash: string;
  readonly outputSchemaApplied: boolean;
}

export interface ReviewCoachQuestion {
  readonly questionId: string;
  readonly number: number;
  readonly total: number;
  readonly mode: ReviewQuestionMode;
  readonly prompt: string;
  readonly outcomeIds: readonly string[];
  readonly citations: readonly ReviewOutcomeCitation[];
  readonly provenance: ReviewTurnProvenance;
}

export interface ReviewCoachFeedback {
  readonly feedbackId: string;
  readonly questionId: string;
  readonly responseId: string;
  readonly text: string;
  readonly outcomeIds: readonly string[];
  readonly citations: readonly ReviewOutcomeCitation[];
  /** Model feedback is evidence for reflection, never an authoritative mastery decision. */
  readonly assessmentAuthority: "advisory";
  readonly provenance: ReviewTurnProvenance;
}

/** Exact durable retry material exposed only by the owner-local companion API. */
export interface ReviewCoachPendingResponse {
  readonly questionId: string;
  readonly learnerResponse: string;
  readonly learnerConfidence: 1 | 2 | 3 | 4 | 5 | null;
}

export type ReviewCoachSessionStatus =
  | "ready_for_question"
  | "awaiting_response"
  | "feedback_pending"
  | "complete";

export interface ReviewCoachSessionView {
  readonly sessionId: string;
  /** Null until an explicitly authorized generator creates the protected thread. */
  readonly threadId: string | null;
  readonly status: ReviewCoachSessionStatus;
  readonly questionLimit: number;
  readonly questionsAsked: number;
  readonly responsesRecorded: number;
  readonly lastReviewedAt: string | null;
  readonly lastLearnerConfidence: 1 | 2 | 3 | 4 | 5 | null;
  readonly selectedOutcomeIds: readonly string[];
  readonly currentQuestion: ReviewCoachQuestion | null;
  readonly lastFeedback: ReviewCoachFeedback | null;
  /** Present only while the saved response is awaiting reconciled feedback. */
  readonly pendingResponse: ReviewCoachPendingResponse | null;
  readonly assessmentAuthority: "advisory";
}

export interface ReviewCoachAdvanceResult {
  readonly session: ReviewCoachSessionView;
  readonly responseId: string;
  readonly feedback: ReviewCoachFeedback;
  readonly nextQuestion: ReviewCoachQuestion | null;
}
