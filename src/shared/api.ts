import type { RuntimeSchedule } from "./schedule.js";
import type { ReviewCoachAdvanceResult, ReviewCoachSessionView, ReviewQuestionMode } from "./review.js";

export type ProgrammeDayId = `day${1 | 2 | 3 | 4 | 5 | 6 | 7}`;
export type LearningDayId = "day0" | ProgrammeDayId;

export interface ProgrammeDaySummary {
  dayId: ProgrammeDayId;
  date: string;
  curriculumKind: "content" | "break";
  title: string;
}

export interface ScheduleEventView {
  eventBindingId: string;
  programmeDayId: ProgrammeDayId | null;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  status: "scheduled" | "cancelled";
  location?: string;
}

export interface OutcomeView {
  outcomeId: string;
  versionId: string;
  category: "engineering" | "ml" | "security" | "theory";
  text: string;
  sourcePath: string;
}

export interface CurriculumSectionView {
  sectionId: string;
  title: string;
  sourcePath: string;
  outcomes: OutcomeView[];
  participantTarget?: ParticipantTargetView;
}

export interface ParticipantTargetView {
  relativePath: string;
  declaredByPath: string;
  declarationHash: string;
  sectionSourceHash: string;
  starterHash: string;
  cursorLine: number;
  state: "missing" | "file" | "blocked";
}

export interface DiagnosticsView {
  status: "ready" | "degraded";
  nodeVersion: string;
  companionRoot: string;
  aisbRoot: string;
  stateRoot: string;
  repositoriesSeparated: boolean;
  aisbHead: string | null;
  codex: {
    available: boolean;
    version: string | null;
    detail: string;
  };
  imageGeneration: {
    available: boolean;
    detail: string;
  };
}

export type CodexSelfTestIssueCode =
  | "codex_process_unavailable"
  | "codex_version_mismatch"
  | "account_check_failed"
  | "account_authentication_required"
  | "model_catalog_unavailable"
  | "required_model_unavailable"
  | "required_effort_unavailable"
  | "tutor_profile_unavailable"
  | "review_profile_unavailable";

export interface CodexSelfTestProfileView {
  profile_id: "aisb-tutor" | "aisb-review";
  applied: boolean;
  instruction_source_verified: boolean;
}

export interface CodexSelfTestResponse {
  status: "ready" | "degraded";
  tested_at: string;
  version: {
    expected: string;
    reported: string | null;
    matches: boolean;
  };
  account: {
    status: "authenticated" | "authentication_required" | "not_configured" | "unavailable";
    kind: "chatgpt" | "api_key" | "amazon_bedrock" | null;
    plan: string | null;
  };
  model: {
    model: "gpt-5.6-sol";
    available: boolean;
    medium_effort_available: boolean;
  };
  profiles: readonly CodexSelfTestProfileView[];
  issues: readonly {
    code: CodexSelfTestIssueCode;
    detail: string;
  }[];
}

export interface BootstrapResponse {
  runtimeSchedule: RuntimeSchedule;
  scheduleRevision: string;
  eventCurriculumBindings: EventCurriculumBindingSnapshotResponse;
  programmeTimeZone: "Europe/London";
  programmeDays: ProgrammeDaySummary[];
  events: ScheduleEventView[];
  /** Calendar/programme projection used only by Today. */
  sectionsByDay: Partial<Record<LearningDayId, CurriculumSectionView[]>>;
  /** Stable repository identity used only by Study. */
  repositorySectionsByDay: Partial<Record<LearningDayId, CurriculumSectionView[]>>;
  programmeToRepositoryDay: Record<ProgrammeDayId, LearningDayId | null>;
  diagnostics: DiagnosticsView;
}

export interface EventCurriculumBindingView {
  eventBindingId: string;
  /** Explicit user-authored order. The application never infers or sorts it. */
  sectionIds: readonly string[];
  source: "explicit";
}

export interface EventCurriculumBindingSnapshotResponse {
  schemaVersion: 1;
  revision: string;
  bindings: readonly EventCurriculumBindingView[];
}

export interface SetEventCurriculumBindingRequest {
  expected_revision: string;
  /** The exact local schedule snapshot held stable while this link is published. */
  expected_schedule_revision: string;
  /** An empty list explicitly clears the event's binding. */
  section_ids: readonly string[];
}

export type MaterialAccessClassification = "tutor_readable" | "human_reader_only";
export type MaterialDocumentKind = "readme" | "participant_instructions" | "learner_markdown" | "learner_pdf";

export type MaterialLinkView =
  | { kind: "document"; label: string; documentId: string; fragment?: string }
  | { kind: "section"; label: string; sectionId: string; fragment?: string }
  | { kind: "external"; label: string; url: string }
  | { kind: "unavailable"; label: string; reason: string };

export interface MaterialDocumentView {
  documentId: string;
  title: string;
  filename: string;
  kind: MaterialDocumentKind;
  accessClassification: MaterialAccessClassification;
  contentHash: string;
  byteLength: number;
  links: readonly MaterialLinkView[];
  linksTruncated: boolean;
}

export interface MaterialManifestResponse {
  sectionId: string;
  revision: string;
  rootDocumentId: string;
  documents: readonly MaterialDocumentView[];
  truncated: boolean;
}

export const MATERIAL_FOLD_DIRECTIVE_LANGUAGE = "aisb-material-fold";

export interface MaterialDisplayProjection {
  markdown: string;
  folds: readonly MaterialDisplayFoldView[];
}

export interface MaterialDisplayFoldView {
  foldId: string;
  summary: string;
  summaryMarkdown?: string;
  body: MaterialDisplayProjection;
  contextVisibility: "included" | "browser_only";
  defaultOpen: boolean;
}

export interface MaterialDocumentResponse {
  audience: "browser_display";
  sectionId: string;
  manifestRevision: string;
  document: MaterialDocumentView;
  display: MaterialDisplayProjection;
  displayProjection: "structured_readme" | "structured_instructions" | "pdf_text";
  browserOnlyFoldCount: number;
}

export type TutorContextMode = "today" | "study";

interface TutorRequestIdsBase {
  route_path: string;
  day_id: LearningDayId;
  history_entry_id: string;
  active_tab: "notes";
}

export interface TutorTodayRequestIds extends TutorRequestIdsBase {
  context_mode: "today";
  event_binding_id: string | null;
  section_id: null;
  document_id: null;
  material_manifest_revision: null;
}

export interface TutorStudyRequestIds extends TutorRequestIdsBase {
  context_mode: "study";
  event_binding_id: null;
  section_id: string;
  document_id: string;
  material_manifest_revision: string;
}

export type TutorRequestIds = TutorTodayRequestIds | TutorStudyRequestIds;

export interface TutorContinuitySummaryReference {
  /** Identifier of the locally approved summary shown to the learner. */
  summary_id: string;
  /** Hash of the exact summary text the learner reviewed before Send. */
  content_hash: string;
}

export interface TutorTurnRequestBody {
  /** Browser-generated idempotency key for one visible learner submission. */
  client_user_message_id: string;
  message: string;
  /** Explicit per-send learner selection, bound to the exact reviewed text. */
  continuity_summaries: readonly TutorContinuitySummaryReference[];
  request_ids: TutorRequestIds;
  note_draft: {
    note_id: string;
    content: string;
    base_revision: number;
    save_status: string;
  };
}

export type TutorSessionScopeRequest =
  | {
      context_mode: "today";
      day_id: LearningDayId;
      event_binding_id: string | null;
      section_id: null;
    }
  | {
      context_mode: "study";
      day_id: LearningDayId;
      event_binding_id: null;
      section_id: string;
    };

export interface TutorSessionThreadSegmentView {
  thread_id: string;
  status: "current" | "replaced";
  started_at: string;
  ended_at: string | null;
}

export interface TutorSessionMessageView {
  message_id: string;
  role: "user" | "assistant" | "status";
  status: "accepted" | "completed" | "failed";
  text: string;
  occurred_at: string;
  turn_nonce: string;
  turn_id: string | null;
  citations: readonly {
    label: string;
    url: string;
  }[];
}

export interface TutorSessionHistoryResponse {
  scope_key: string;
  chat_id: string | null;
  current_thread_id: string | null;
  thread_segments: readonly TutorSessionThreadSegmentView[];
  messages: readonly TutorSessionMessageView[];
  active_turn: TutorActiveTurnView | null;
}

export interface TutorActiveTurnView {
  turn_nonce: string;
  state: "preparing" | "running" | "stopping";
  started_at: string;
}

export interface TutorTurnResponseBody {
  mode: "live-codex";
  message: string;
  context_hash: string;
  chat_id: string;
  thread_id: string;
  turn_id: string;
  client_user_message_id: string;
  disclosure: unknown;
}

export interface TutorContinuitySummaryView {
  summary_id: string;
  source_day_id: LearningDayId;
  source_scope_key: string;
  source_turn_id: string;
  approved_at: string;
  content_hash: string;
  text: string;
}

export interface TutorContinuitySelectionResponse {
  target_day_id: LearningDayId;
  total_text_bytes: number;
  summaries: readonly TutorContinuitySummaryView[];
}

export interface SaveTutorContinuityRequestBody {
  source_scope: TutorSessionScopeRequest;
  source_turn_id: string;
  text: string;
}

export interface AbandonUncertainTutorTurnRequestBody {
  scope: TutorSessionScopeRequest;
  turn_nonce: string;
  /** Required acknowledgement: a native turn may still appear after abandonment. */
  acknowledge_duplicate_risk: true;
}

export interface AbandonUncertainTutorTurnResponseBody {
  status: "abandoned" | "recovered";
  /** True when the exact learner text should be restored as an unsent draft. */
  restore_text: boolean;
}

export interface StopTutorTurnRequestBody {
  scope: TutorSessionScopeRequest;
  turn_nonce: string;
}

export interface StopTutorTurnResponseBody {
  status: "stopping" | "not_active";
}

/**
 * A learner-declared checklist state. Completion is not an assessment of
 * knowledge or mastery.
 */
export interface LearningOutcomeCompletionView {
  outcomeId: string;
  outcomeVersionId: string;
  completed: boolean;
  completedAt: string | null;
}

export interface LearningProgressSnapshotResponse {
  revision: number;
  /** Compare-and-swap token covering the complete persisted snapshot. */
  version: string;
  completions: readonly LearningOutcomeCompletionView[];
  recovered: boolean;
}

export interface SetLearningOutcomeCompletionRequest {
  expected_version: string;
  outcome_id: string;
  outcome_version_id: string;
  completed: boolean;
}

export type SetLearningOutcomeCompletionResponse =
  | {
      status: "saved";
      completion: LearningOutcomeCompletionView;
      snapshot: LearningProgressSnapshotResponse;
      previousVersion: string;
    }
  | {
      status: "unchanged";
      completion: LearningOutcomeCompletionView;
      snapshot: LearningProgressSnapshotResponse;
    }
  | {
      status: "conflict";
      current: LearningProgressSnapshotResponse;
    };

export interface ScheduleSnapshotResponse {
  runtimeSchedule: RuntimeSchedule;
  scheduleRevision: string;
  programmeTimeZone: "Europe/London";
  programmeDays: ProgrammeDaySummary[];
  events: ScheduleEventView[];
}

export interface ScheduleEventRequest {
  programme_day_id: ProgrammeDayId | null;
  title: string;
  start: string;
  end: string;
  all_day: boolean;
  status?: "scheduled" | "cancelled";
  location?: string;
}

export interface ScheduleEventChangesRequest {
  programme_day_id?: ProgrammeDayId | null;
  title?: string;
  start?: string;
  end?: string;
  all_day?: boolean;
  status?: "scheduled" | "cancelled";
  location?: string | null;
}

export type ScheduleMutationRequest =
  | { expected_revision: string; mutation: { kind: "add"; event: ScheduleEventRequest } }
  | {
      expected_revision: string;
      mutation: {
        kind: "update";
        event_binding_id: string;
        changes: ScheduleEventChangesRequest;
      };
    }
  | { expected_revision: string; mutation: { kind: "cancel"; event_binding_id: string } };

export interface ScheduleReimportRequest {
  expected_revision: string;
}

export interface NoteListItemView {
  noteId: string;
  noteKind: "day" | "lesson" | "event" | "ad_hoc";
  title: string;
  revision: number;
  status: "active" | "archived" | "cancelled" | "orphaned";
  lastModifiedAt: string;
  logicalPath: string;
  routePath: string;
  hasLearnerContent: boolean;
}

export interface NoteListResponse {
  notes: NoteListItemView[];
  unreadable: Array<{
    logicalPath: string;
    reason: string;
  }>;
}

export interface SavedNoteLaunchToken {
  kind: "saved-note-vscode-launch-v1";
  token_id: string;
  note_id: string;
  logical_path: string;
  revision: number;
  content_hash: string;
}

export type SavedNoteLaunchResponse =
  | {
      status: "opened";
      note_id: string;
      logical_path: string;
      command: readonly string[];
    }
  | {
      status: "launch_failed";
      reason: "editor_not_found" | "editor_not_allowed" | "spawn_failed";
      note_id: string;
      logical_path: string;
      retryable: true;
      command: readonly string[];
    };

export interface WorkspacePreviewRequest {
  section_id: string;
  expected_section_source_hash: string;
  expected_declaration_hash: string;
  expected_starter_hash: string;
}

export interface WorkspaceCreateToken {
  kind: "workspace-create-v1";
  token_id: string;
  section_id: string;
  target_relative_path: string;
  starter_hash: string;
}

export interface WorkspaceLaunchToken {
  kind: "workspace-launch-v1";
  token_id: string;
  section_id: string;
  target_relative_path: string;
  content_hash: string;
  cursor_line: number;
  created_by_service: boolean;
}

export type WorkspacePreviewResponse =
  | {
      status: "existing";
      target_relative_path: string;
      launch_token: WorkspaceLaunchToken;
    }
  | {
      status: "absent";
      target_relative_path: string;
      starter_content: string;
      create_token: WorkspaceCreateToken;
    };

export type WorkspaceCreateResponse =
  | {
      status: "created";
      target_relative_path: string;
      launch_token: WorkspaceLaunchToken;
    }
  | {
      status: "already_existed";
      target_relative_path: string;
      requires_new_preview: true;
    };

export type WorkspaceLaunchResponse =
  | {
      status: "opened";
      target_relative_path: string;
      created_by_service: boolean;
      command: readonly string[];
    }
  | {
      status: "launch_failed";
      reason: "editor_not_found" | "editor_not_allowed" | "spawn_failed";
      target_relative_path: string;
      created_by_service: boolean;
      retryable: true;
      command: readonly string[];
    };

interface CreateReviewSessionRequestBase {
  day_id: LearningDayId;
  outcome_refs: readonly {
    outcome_id: string;
    outcome_version_id: string;
  }[];
  question_limit: number;
  modes: readonly ReviewQuestionMode[];
}

export type CreateReviewSessionRequest =
  | (CreateReviewSessionRequestBase & {
      context_mode: "today";
      /** Identifies the selected event; canonical links are re-resolved server-side. */
      event_binding_id: string | null;
      section_id: null;
    })
  | (CreateReviewSessionRequestBase & {
      context_mode: "study";
      event_binding_id: null;
      /** Null only when reviewing the complete repository-day page. */
      section_id: string | null;
    });

export interface ReviewSessionResponse {
  mode: "live-codex" | "local-template";
  session: ReviewCoachSessionView;
}

export interface SubmitReviewResponseRequest {
  question_id: string;
  learner_response: string;
  learner_confidence: 1 | 2 | 3 | 4 | 5 | null;
}

export interface ReviewAdvanceResponse {
  mode: "live-codex" | "local-template";
  result: ReviewCoachAdvanceResult;
}
