/**
 * Serializable contracts for one server-authoritative tutor turn.
 *
 * Deliberately keep browser input and resolved domain records as separate types.
 * The browser may name entities and submit the live note/file selections, but it
 * never supplies schedule text, learning outcomes, repository state, file hashes,
 * or access decisions.
 */

export const PAGE_CONTEXT_VERSION = 1 as const;
export const NOTE_CONTEXT_UTF8_LIMIT_BYTES = 64 * 1024;

export type PageKind =
  | "week"
  | "day"
  | "lesson"
  | "event_notes"
  | "event_chat"
  | "event_resources"
  | "note"
  | "review"
  | "manager"
  | "schedule"
  | "repository"
  | "prepare"
  | "settings"
  | "diagnostics";

export type ChatScopeType = "tutor" | "review" | "manager" | "preparation" | "visual";

export type OutcomeCategory = "engineering" | "ml" | "security" | "theory";

export type NoteKind = "day" | "lesson" | "event" | "ad_hoc";

export type NoteSaveState =
  | "saved"
  | "saving"
  | "local_only"
  | "offline"
  | "conflicted"
  | "error";

export type FileAccessMode =
  | "tool_readable"
  | "injected_projection"
  | "content_injected_file_access_denied";

export type ContextTrust =
  | "application"
  | "learner_authored_untrusted"
  | "human_authored_schedule_untrusted"
  | "repository_untrusted"
  | "external_untrusted";

export interface TextRangeInput {
  /** JavaScript string offset, matching editor selection APIs. */
  readonly start: number;
  /** Exclusive JavaScript string offset. */
  readonly end: number;
}

/** The only file metadata accepted from the browser. */
export interface FileSelectionInput {
  /** A path relative to the configured AISB root. Never an absolute path. */
  readonly relativePath: string;
  readonly range?: TextRangeInput;
}

/**
 * Opaque entity and revision identifiers carried by the current route.
 * `contextRevision` and `scopeBindingId` are server-issued comparison tokens;
 * neither is treated as an authoritative domain record.
 */
export interface PageContextRequestIds {
  readonly routeId: string;
  readonly historyEntryId: string;
  readonly contextRevision: string;
  readonly scopeBindingId: string;
  readonly chatId: string;
  readonly activeTabId?: string;
  readonly dayId?: string;
  readonly eventBindingId?: string;
  readonly sessionId?: string;
  readonly sectionId?: string;
  readonly exerciseId?: string;
  readonly noteId?: string;
}

/** Exact editor state sent at the instant the learner presses Send. */
export interface LiveNoteDraftInput {
  readonly noteId: string;
  readonly text: string;
  readonly baseRevision: string | null;
  readonly saveState: NoteSaveState;
  /** Cursor/selection head used to derive the currently edited Markdown section. */
  readonly currentOffset: number;
  /** Additional ranges the learner explicitly chose to disclose. */
  readonly selectedRanges?: readonly TextRangeInput[];
}

export interface ResolvePageContextInput {
  readonly ids: PageContextRequestIds;
  readonly noteDraft: LiveNoteDraftInput | null;
  readonly fileSelections: readonly FileSelectionInput[];
}

export interface CanonicalRouteContext {
  readonly routeId: string;
  readonly path: string;
  readonly pageKind: PageKind;
  readonly historyEntryId: string;
  readonly activeTab: string | null;
  readonly dayId: string | null;
  readonly eventBindingId: string | null;
  readonly sessionId: string | null;
  readonly sectionId: string | null;
  readonly exerciseId: string | null;
}

export interface ScheduleEventContext {
  readonly eventBindingId: string;
  readonly title: string;
  readonly start: string;
  readonly end: string;
  readonly timeZone: string;
  readonly kind: string;
  readonly location: string | null;
  readonly linkedSectionIds: readonly string[];
}

export interface NowAnchorContext {
  readonly capturedAt: string;
  readonly captureSource: "load" | "button";
  readonly historyEntryId: string;
  readonly bootstrapId: string;
  readonly programmeTimeZone: string;
  readonly scheduleRevision: string;
  readonly resolvedDayId: string | null;
  readonly activeEventBindingIds: readonly string[];
  readonly primaryEventBindingId: string | null;
  readonly fallbackReason: string;
}

export interface SchedulePageContext {
  readonly revision: string;
  readonly programmeTimeZone: string;
  readonly dayId: string | null;
  readonly event: ScheduleEventContext | null;
  readonly nowAnchor: NowAnchorContext | null;
}

export interface CanonicalOutcomeRecord {
  readonly outcomeId: string;
  readonly outcomeVersionId: string;
  readonly sectionId: string;
  readonly category: OutcomeCategory;
  readonly ordinal: number;
  /** Byte-preserved text from the section README. */
  readonly text: string;
  readonly sourcePath: string;
  readonly sourceCommit: string;
}

export interface SanitizedLessonContext {
  readonly sectionId: string;
  readonly sectionTitle: string;
  readonly currentExerciseId: string | null;
  readonly currentExerciseTitle: string | null;
  readonly progressState: string;
  /** Learner-visible projection only; never raw instructions/folds/tests. */
  readonly visibleProjection: string;
  readonly projectionHash: string;
}

export interface RepositoryContext {
  readonly repositoryIdentity: string;
  readonly headCommit: string;
  readonly cwdAlias: "<aisb-root>";
  readonly sectionDirectory: string | null;
  readonly instructionSourceHash: string;
}

export interface ChatScope {
  readonly scopeType: ChatScopeType;
  readonly scopeId: string;
  readonly chatId: string;
  readonly threadId: string;
  readonly scopeBindingId: string;
}

/** Descriptor produced only after canonical path and source-policy validation. */
export interface AisbFileDescriptor {
  readonly descriptorId: string;
  readonly rootAlias: "<aisb-root>";
  readonly relativePath: string;
  readonly exists: boolean;
  readonly fileType: "file" | "missing";
  readonly sourceHash: string | null;
  readonly linkedSectionId: string | null;
  readonly linkedExerciseId: string | null;
  readonly selectedRange: TextRangeInput | null;
  readonly accessMode: FileAccessMode;
}

/** Canonical state-root descriptor used to validate a browser draft. */
export interface CanonicalNoteRecord {
  readonly noteId: string;
  readonly kind: NoteKind;
  /** Logical state-relative path only; never a host absolute path. */
  readonly logicalPath: string;
  readonly persistedRevision: string | null;
}

export interface NoteDraftSnapshot {
  readonly state: "current_note";
  readonly noteId: string;
  readonly kind: NoteKind;
  readonly logicalPath: string;
  readonly accessMode: "content_injected_file_access_denied";
  readonly baseRevision: string | null;
  readonly persistedRevision: string | null;
  readonly draftHash: string;
  readonly draftUtf8Bytes: number;
  readonly saveState: NoteSaveState;
  /** Exact send-time editor buffer. */
  readonly text: string;
  readonly currentOffset: number;
  readonly selectedRanges: readonly TextRangeInput[];
}

export interface NoCurrentNoteSnapshot {
  readonly state: "no_current_note";
  readonly accessMode: "content_injected_file_access_denied";
}

export type CurrentNoteSnapshot = NoteDraftSnapshot | NoCurrentNoteSnapshot;

/**
 * Canonical server-side resolution returned by injected domain services.
 * `expectedCurrentNoteId` prevents a draft from another page/scope being attached.
 */
export interface ResolvedCanonicalPage {
  readonly contextRevision: string;
  readonly route: CanonicalRouteContext;
  readonly schedule: SchedulePageContext | null;
  readonly lesson: SanitizedLessonContext | null;
  readonly canonicalOutcomes: readonly CanonicalOutcomeRecord[];
  readonly repository: RepositoryContext;
  readonly scope: ChatScope;
  readonly expectedCurrentNoteId: string | null;
  readonly linkedFiles: readonly AisbFileDescriptor[];
}

export interface PageContextSnapshot {
  readonly version: typeof PAGE_CONTEXT_VERSION;
  readonly snapshotId: string;
  readonly snapshotHash: string;
  readonly capturedAt: string;
  readonly contextRevision: string;
  readonly route: CanonicalRouteContext;
  readonly schedule: SchedulePageContext | null;
  readonly lesson: SanitizedLessonContext | null;
  readonly canonicalOutcomes: readonly CanonicalOutcomeRecord[];
  readonly repository: RepositoryContext;
  readonly scope: ChatScope;
  readonly relevantFiles: readonly AisbFileDescriptor[];
  readonly note: CurrentNoteSnapshot;
}

export type CoreContextBlockKind =
  | "page_session"
  | "canonical_outcomes"
  | "visible_lesson"
  | "file_descriptors"
  | "current_note";

export type ContextBlockKind = CoreContextBlockKind | "supplementary";

export interface ContextCitation {
  readonly citationId: string;
  readonly label: string;
  readonly sourcePath: string | null;
  readonly sourceHash: string | null;
}

export interface TurnContextBlock {
  readonly blockId: string;
  readonly kind: ContextBlockKind;
  readonly title: string;
  readonly required: boolean;
  readonly evictable: boolean;
  readonly trust: ContextTrust;
  readonly content: string;
  readonly utf8Bytes: number;
  readonly blockHash: string;
  readonly citations: readonly ContextCitation[];
}

export interface SupplementaryContextBlock {
  readonly id: string;
  readonly title: string;
  readonly trust: Exclude<ContextTrust, "application">;
  readonly content: string;
  readonly citations?: readonly ContextCitation[];
}

export interface NoteDisclosureSegment {
  readonly start: number;
  readonly end: number;
  readonly labels: readonly ("current_markdown_section" | "user_selected_range")[];
  readonly utf8Bytes: number;
  readonly content: string;
}

export interface NoteDisclosureSummary {
  readonly mode: "none" | "full" | "selected_ranges";
  readonly originalUtf8Bytes: number;
  readonly includedUtf8Bytes: number;
  readonly omittedUtf8Bytes: number;
  readonly segments: readonly NoteDisclosureSegment[];
}

export interface OmissionRecord {
  readonly source: "note" | "supplementary";
  readonly reason: "note_over_64_kib" | "supplementary_budget";
  readonly omittedUtf8Bytes: number;
  readonly detail: string;
}

export interface TurnContextBinding {
  readonly algorithm: "sha256";
  readonly turnNonce: string;
  readonly snapshotHash: string;
  readonly payloadHash: string;
  readonly bindingHash: string;
  readonly scopeId: string;
  readonly threadId: string;
}

export interface FrozenTurnContext {
  readonly version: typeof PAGE_CONTEXT_VERSION;
  /** The full snapshot stays application-private; only its immutable identity is bound here. */
  readonly snapshotId: string;
  readonly snapshotHash: string;
  readonly scope: ChatScope;
  readonly blocks: readonly TurnContextBlock[];
  readonly noteDisclosure: NoteDisclosureSummary;
  readonly omissions: readonly OmissionRecord[];
  readonly binding: TurnContextBinding;
}

export interface ObservedToolReadInput {
  readonly bindingHash: string;
  readonly turnNonce: string;
  readonly threadId: string;
  readonly relativePath: string;
  readonly sourceHash: string;
  readonly citation: string;
}

export interface ObservedToolRead {
  readonly relativePath: string;
  readonly sourceHash: string;
  readonly citation: string;
  readonly observedAt: string;
}

/** Safe client projection: exact disclosed blocks, no host paths or private manifests. */
export interface DisclosureInspectorProjection {
  readonly bindingHash: string;
  readonly turnNonce: string;
  readonly snapshotId: string;
  readonly scope: ChatScope;
  readonly blocks: readonly TurnContextBlock[];
  readonly noteDisclosure: NoteDisclosureSummary;
  readonly omissions: readonly OmissionRecord[];
  readonly toolBoundary: {
    readonly cwdAlias: "<aisb-root>";
    readonly readableFiles: readonly string[];
    readonly protectedClasses: readonly string[];
  };
  readonly observedToolReads: readonly ObservedToolRead[];
}

export type ContextAssemblyErrorCode =
  | "INVALID_REQUEST"
  | "STALE_CONTEXT"
  | "SCOPE_MISMATCH"
  | "NOTE_SCOPE_MISMATCH"
  | "MISSING_NOTE_DRAFT"
  | "FILE_POLICY_DENIED"
  | "TURN_NONCE_REUSED"
  | "UNKNOWN_TURN_BINDING"
  | "TOOL_READ_POLICY_DENIED";

export class ContextAssemblyError extends Error {
  public readonly code: ContextAssemblyErrorCode;

  public constructor(code: ContextAssemblyErrorCode, message: string) {
    super(message);
    this.name = "ContextAssemblyError";
    this.code = code;
  }
}
