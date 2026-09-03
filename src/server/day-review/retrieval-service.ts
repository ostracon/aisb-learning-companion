import { createHash } from "node:crypto";

import type {
  CurriculumSectionView,
  LearningDayId,
  ScheduleSnapshotResponse,
} from "../../shared/api.js";
import type {
  DayReviewResourceDescriptor,
  DayReviewResourceKind,
} from "../../shared/day-review.js";
import type { NoteLocator, NoteRecord, NoteSummary } from "../../shared/notes.js";
import type {
  CurriculumMaterialManifest,
  ReadCurriculumMaterialInput,
  ReadModelSafeCurriculumMaterialResult,
} from "../materials/service.js";
import type {
  DayPreparedReferenceSource,
  PreparedReferenceProjection,
} from "../manager/prepared-context-source.js";
import type {
  ReviewSessionSummaryListing,
  ReviewSessionSummaryOptions,
} from "../review/session-store.js";
import type {
  ApprovedContinuitySummary,
  ContinuitySummarySelection,
} from "../tutor/continuity-store.js";
import type {
  TutorSessionScopeExcerptListing,
  TutorSessionScopeExcerptOptions,
} from "../tutor/session-log-store.js";

const MAX_RESOURCES = 192;
const MAX_SEARCH_BYTES_PER_RESOURCE = 32 * 1024;
const MAX_SEARCH_TOTAL_BYTES = 512 * 1024;
const MAX_READ_BYTES = 16 * 1024;
const MAX_SEARCH_RESULTS = 12;
const TUTOR_HISTORY_OPTIONS: TutorSessionScopeExcerptOptions = Object.freeze({
  maxScopes: 20,
  maxMessagesPerScope: 8,
  maxMessageBytes: 4 * 1024,
  maxTotalBytes: 96 * 1024,
  excludeScopeKeys: ["manager:overall"],
});
const REVIEW_HISTORY_OPTIONS: ReviewSessionSummaryOptions = Object.freeze({
  maxSessions: 20,
  maxOutcomesPerSession: 16,
  maxOutcomeBytes: 2 * 1024,
  maxFeedbackBytes: 4 * 1024,
  maxTotalBytes: 96 * 1024,
});

export interface DayReviewScheduleSource {
  read(): Promise<ScheduleSnapshotResponse>;
}

export interface DayReviewCurriculumSource {
  readDay(dayId: LearningDayId): Promise<readonly CurriculumSectionView[]>;
}

export interface DayReviewNoteSource {
  list(): Promise<readonly NoteSummary[]>;
  read(locator: NoteLocator): Promise<NoteRecord>;
}

export interface DayReviewMaterialSource {
  manifest(sectionId: string): Promise<CurriculumMaterialManifest>;
  readForModelContext(input: ReadCurriculumMaterialInput): Promise<ReadModelSafeCurriculumMaterialResult>;
}

export interface DayReviewTutorHistorySource {
  listScopeExcerpts(options: TutorSessionScopeExcerptOptions): Promise<TutorSessionScopeExcerptListing>;
}

export interface DayReviewReviewHistorySource {
  listRecentSummaries(options: ReviewSessionSummaryOptions): Promise<ReviewSessionSummaryListing>;
}

export interface DayReviewContinuitySource {
  selectForDay(dayId: string): Promise<ContinuitySummarySelection>;
}

export interface DayReviewRetrievalSources {
  readonly schedule: DayReviewScheduleSource;
  readonly curriculum: DayReviewCurriculumSource;
  readonly notes: DayReviewNoteSource;
  readonly materials: DayReviewMaterialSource;
  readonly preparedReferences: DayPreparedReferenceSource;
  readonly tutorHistory: DayReviewTutorHistorySource;
  readonly reviewHistory: DayReviewReviewHistorySource;
  readonly continuity: DayReviewContinuitySource;
}

interface ResourceRecord {
  readonly descriptor: DayReviewResourceDescriptor;
  readonly identity: string;
  readonly load: () => Promise<{
    readonly text: string;
    readonly provenance: Readonly<Record<string, unknown>>;
  }>;
}

export interface DayReviewResourceInventory {
  readonly resources: readonly DayReviewResourceDescriptor[];
  readonly omissions: readonly string[];
}

export interface DayReviewSearchResult {
  readonly resourceId: string;
  readonly kind: DayReviewResourceKind;
  readonly title: string;
  readonly citation: string;
  readonly excerpt: string;
  readonly truncated: boolean;
}

export interface DayReviewReadResult {
  readonly resourceId: string;
  readonly kind: DayReviewResourceKind;
  readonly title: string;
  readonly citation: string;
  readonly text: string;
  readonly cursor: number;
  readonly nextCursor: number | null;
  readonly provenance: Readonly<Record<string, unknown>>;
}

/**
 * Rebuilds a day-bound, learner-visible resource registry for every tool call.
 * Callers can select only opaque IDs from that registry; paths and URLs are
 * never accepted as input.
 */
export class DayReviewRetrievalService {
  public constructor(private readonly sources: DayReviewRetrievalSources) {}

  public async inventory(dayId: LearningDayId): Promise<DayReviewResourceInventory> {
    const { records, omissions } = await this.#records(dayId);
    return Object.freeze({
      resources: Object.freeze(records.map(({ descriptor }) => descriptor)),
      omissions: Object.freeze(omissions),
    });
  }

  public async search(input: {
    readonly dayId: LearningDayId;
    readonly query: string;
    readonly kinds?: readonly DayReviewResourceKind[];
    readonly limit?: number;
  }): Promise<readonly DayReviewSearchResult[]> {
    const query = input.query.replace(/\s+/gu, " ").trim();
    if (query.length < 2 || query.length > 500) throw new Error("Day review search query is invalid");
    const limit = Math.max(1, Math.min(input.limit ?? 8, MAX_SEARCH_RESULTS));
    const allowedKinds = input.kinds === undefined ? null : new Set(input.kinds);
    const { records } = await this.#records(input.dayId);
    const terms = [...new Set(query.toLocaleLowerCase("en-GB").match(/[\p{L}\p{N}_-]{2,}/gu) ?? [])];
    const results: (DayReviewSearchResult & { readonly score: number })[] = [];
    let searchedBytes = 0;

    for (const record of records) {
      if (record.descriptor.status !== "ready" || (allowedKinds && !allowedKinds.has(record.descriptor.kind))) continue;
      if (searchedBytes >= MAX_SEARCH_TOTAL_BYTES) break;
      const loaded = await record.load();
      const available = Math.min(MAX_SEARCH_BYTES_PER_RESOURCE, MAX_SEARCH_TOTAL_BYTES - searchedBytes);
      const searchable = truncateUtf8(loaded.text, available);
      searchedBytes += Buffer.byteLength(searchable, "utf8");
      const haystack = `${record.descriptor.title}\n${searchable}`.toLocaleLowerCase("en-GB");
      const title = record.descriptor.title.toLocaleLowerCase("en-GB");
      let score = 0;
      for (const term of terms) {
        if (title.includes(term)) score += 8;
        const occurrences = haystack.split(term).length - 1;
        score += Math.min(occurrences, 8);
      }
      if (score === 0 && !haystack.includes(query.toLocaleLowerCase("en-GB"))) continue;
      const firstTerm = terms.find((term) => haystack.includes(term));
      const matchIndex = firstTerm === undefined ? 0 : searchable.toLocaleLowerCase("en-GB").indexOf(firstTerm);
      const excerpt = excerptAround(searchable, Math.max(0, matchIndex), 1_600);
      results.push(Object.freeze({
        resourceId: record.descriptor.resourceId,
        kind: record.descriptor.kind,
        title: record.descriptor.title,
        citation: record.descriptor.citation,
        excerpt,
        truncated: Buffer.byteLength(searchable, "utf8") < Buffer.byteLength(loaded.text, "utf8")
          || excerpt.length < searchable.length,
        score,
      }));
    }
    return Object.freeze(results
      .sort((left, right) => right.score - left.score || left.citation.localeCompare(right.citation))
      .slice(0, limit)
      .map(({ score: _score, ...result }) => Object.freeze(result)));
  }

  public async read(input: {
    readonly dayId: LearningDayId;
    readonly resourceId: string;
    readonly cursor?: number;
    readonly maxBytes?: number;
  }): Promise<DayReviewReadResult | null> {
    if (!/^dayres_[a-f0-9]{48}$/u.test(input.resourceId)) {
      throw new Error("Day review resource ID is invalid");
    }
    const cursor = Math.max(0, Math.min(input.cursor ?? 0, Number.MAX_SAFE_INTEGER));
    const maxBytes = Math.max(512, Math.min(input.maxBytes ?? 8 * 1024, MAX_READ_BYTES));
    const { records } = await this.#records(input.dayId);
    const record = records.find(({ descriptor }) => descriptor.resourceId === input.resourceId);
    if (record === undefined || record.descriptor.status !== "ready") return null;
    const loaded = await record.load();
    if (cursor > loaded.text.length) return null;
    const text = truncateUtf8(loaded.text.slice(cursor), maxBytes);
    const nextCursor = cursor + text.length < loaded.text.length ? cursor + text.length : null;
    return Object.freeze({
      resourceId: record.descriptor.resourceId,
      kind: record.descriptor.kind,
      title: record.descriptor.title,
      citation: record.descriptor.citation,
      text,
      cursor,
      nextCursor,
      provenance: loaded.provenance,
    });
  }

  public async inspectHistory(input: {
    readonly dayId: LearningDayId;
    readonly kind?: "tutor" | "review" | "continuity" | "all";
  }): Promise<readonly DayReviewSearchResult[]> {
    const kinds = input.kind === "tutor" ? new Set<DayReviewResourceKind>(["tutor_history"])
      : input.kind === "review" ? new Set<DayReviewResourceKind>(["review_history"])
        : input.kind === "continuity" ? new Set<DayReviewResourceKind>(["continuity"])
          : new Set<DayReviewResourceKind>(["tutor_history", "review_history", "continuity"]);
    const { records } = await this.#records(input.dayId);
    const results: DayReviewSearchResult[] = [];
    for (const record of records) {
      if (!kinds.has(record.descriptor.kind) || record.descriptor.status !== "ready") continue;
      const loaded = await record.load();
      const excerpt = truncateUtf8(loaded.text, 2_400);
      results.push(Object.freeze({
        resourceId: record.descriptor.resourceId,
        kind: record.descriptor.kind,
        title: record.descriptor.title,
        citation: record.descriptor.citation,
        excerpt,
        truncated: Buffer.byteLength(excerpt, "utf8") < Buffer.byteLength(loaded.text, "utf8"),
      }));
    }
    return Object.freeze(results.slice(0, 12));
  }

  async #records(dayId: LearningDayId): Promise<{
    readonly records: readonly ResourceRecord[];
    readonly omissions: string[];
  }> {
    const [schedule, sections, noteSummaries, tutorHistory, reviewHistory, continuity] = await Promise.all([
      this.sources.schedule.read(),
      this.sources.curriculum.readDay(dayId),
      this.sources.notes.list(),
      this.sources.tutorHistory.listScopeExcerpts(TUTOR_HISTORY_OPTIONS),
      this.sources.reviewHistory.listRecentSummaries(REVIEW_HISTORY_OPTIONS),
      this.sources.continuity.selectForDay(dayId),
    ]);
    const sectionIds = new Set(sections.map(({ sectionId }) => sectionId));
    const events = schedule.events.filter(({ programmeDayId }) => programmeDayId === dayId);
    const eventIds = new Set(events.map(({ eventBindingId }) => eventBindingId));
    const dayDate = schedule.programmeDays.find(({ dayId: candidate }) => candidate === dayId)?.date ?? null;
    const records: ResourceRecord[] = [];
    const omissions: string[] = [];

    const activeNotes = noteSummaries.filter(({ status }) => status === "active");
    for (const summary of activeNotes) {
      const record = await this.sources.notes.read(summary.locator);
      if (!noteBelongsToDay(record, dayId, sectionIds, eventIds, dayDate)) continue;
      records.push(resourceRecord(dayId, "note", summary.note_id, {
        title: summary.title,
        citation: `${summary.logical_path} · revision ${summary.revision} · sha256:${summary.content_hash}`,
        status: "ready",
        detail: "Learner-authored local Markdown note.",
      }, async () => ({
        text: record.markdown,
        provenance: Object.freeze({
          logicalPath: record.logical_path,
          revision: record.frontmatter.revision,
          contentHash: `sha256:${record.content_hash}`,
        }),
      })));
    }

    for (const section of sections) {
      const manifest = await this.sources.materials.manifest(section.sectionId);
      for (const document of manifest.documents) {
        records.push(resourceRecord(dayId, "curriculum", `${section.sectionId}:${document.documentId}`, {
          title: `${section.sectionId} · ${document.title}`,
          citation: `AISB ${section.sectionId} · ${document.filename} · revision ${manifest.revision}`,
          status: "ready",
          detail: document.kind === "participant_instructions"
            ? "Learner-visible instruction projection; protected folds are omitted."
            : document.kind === "learner_pdf"
              ? "Page-aware text extracted from a repository-local curriculum PDF."
              : "Learner-visible curriculum Markdown projection.",
        }, async () => {
          const projection = await this.sources.materials.readForModelContext({
            sectionId: section.sectionId,
            documentId: document.documentId,
            expectedManifestRevision: manifest.revision,
          });
          return {
            text: projection.modelSafeMarkdown,
            provenance: Object.freeze({
              sectionId: section.sectionId,
              documentId: document.documentId,
              manifestRevision: manifest.revision,
              contentHash: document.contentHash,
              projection: projection.modelProjection,
              omittedProtectedBlocks: projection.omittedProtectedBlocks,
            }),
          };
        }));
      }
      if (manifest.truncated) omissions.push(`${section.sectionId} material manifest was bounded`);
    }

    const prepared = await this.sources.preparedReferences.listForSections([...sectionIds]);
    for (const source of prepared) {
      const ready = source.projectionStatus === "complete";
      records.push(resourceRecord(dayId, "prepared_reference", source.sourceId, {
        title: source.title,
        citation: `${source.finalUrl ?? source.requestedUrl} · ${source.sourceContentHash ?? "not cached"}${source.pageCount === null ? "" : ` · ${source.pageCount} pages`}`,
        status: ready ? "ready" : "unavailable",
        detail: source.detail,
      }, async () => {
        const projection = await this.sources.preparedReferences.readProjectionForSections(
          source.sourceId,
          [...sectionIds],
        );
        if (projection === null) throw new Error("Prepared reference projection is unavailable");
        return preparedProjectionContent(projection);
      }));
    }

    const acceptedTutorScopes = new Set([
      `day:${dayId}`,
      ...[...eventIds].map((eventId) => `event:${eventId}`),
      ...[...sectionIds].map((sectionId) => `study:section:${sectionId}`),
    ]);
    for (const scope of tutorHistory.scopes.filter(({ scopeKey }) => acceptedTutorScopes.has(scopeKey))) {
      records.push(resourceRecord(dayId, "tutor_history", scope.scopeKey, {
        title: `Tutor conversation · ${scope.scopeKey}`,
        citation: `Local tutor transcript · ${scope.scopeKey} · ${scope.latestActivityAt}`,
        status: "ready",
        detail: "Bounded learner/tutor transcript excerpt.",
      }, async () => ({
        text: scope.messages.map((message) => `${message.role}: ${message.text}`).join("\n\n"),
        provenance: Object.freeze({ scopeKey: scope.scopeKey, latestActivityAt: scope.latestActivityAt }),
      })));
    }
    if (tutorHistory.truncated) omissions.push("prior tutor history inventory was bounded");

    for (const session of reviewHistory.sessions.filter((candidate) =>
      candidate.outcomes.some(({ sectionId }) => sectionIds.has(sectionId)))) {
      records.push(resourceRecord(dayId, "review_history", session.sessionId, {
        title: `Active-recall review · ${session.responsesRecorded}/${session.questionLimit} responses`,
        citation: `Local review ${session.sessionId} · ${session.updatedAt ?? "time unavailable"}`,
        status: "ready",
        detail: "Advisory review summary; raw recall responses are excluded.",
      }, async () => ({
        text: [
          ...session.outcomes.map((outcome) => `${outcome.category}: ${outcome.text}`),
          session.recentFeedback?.text ?? "No saved feedback.",
        ].join("\n"),
        provenance: Object.freeze({
          sessionId: session.sessionId,
          updatedAt: session.updatedAt,
          questionsAsked: session.questionsAsked,
          responsesRecorded: session.responsesRecorded,
          complete: session.complete,
          assessmentAuthority: "advisory",
        }),
      })));
    }
    if (reviewHistory.truncated) omissions.push("active-recall review inventory was bounded");

    for (const summary of continuity.summaries) {
      records.push(continuityRecord(dayId, summary));
    }

    const sorted = records.sort((left, right) =>
      `${left.descriptor.kind}\0${left.descriptor.citation}`.localeCompare(
        `${right.descriptor.kind}\0${right.descriptor.citation}`,
      ));
    if (sorted.length > MAX_RESOURCES) omissions.push(`resource inventory limited to ${MAX_RESOURCES}`);
    return { records: Object.freeze(sorted.slice(0, MAX_RESOURCES)), omissions };
  }
}

function resourceRecord(
  dayId: LearningDayId,
  kind: DayReviewResourceKind,
  identity: string,
  descriptor: Omit<DayReviewResourceDescriptor, "resourceId" | "kind">,
  load: ResourceRecord["load"],
): ResourceRecord {
  const resourceId = `dayres_${createHash("sha256")
    .update(`aisb-day-review-resource-v1\0${dayId}\0${kind}\0${identity}`)
    .digest("hex")
    .slice(0, 48)}`;
  return Object.freeze({
    identity,
    descriptor: Object.freeze({ resourceId, kind, ...descriptor }),
    load,
  });
}

function noteBelongsToDay(
  note: NoteRecord,
  dayId: LearningDayId,
  sectionIds: ReadonlySet<string>,
  eventIds: ReadonlySet<string>,
  dayDate: string | null,
): boolean {
  const links = note.frontmatter.links;
  return links.programme_day_id === dayId
    || (links.event_binding_id !== undefined && eventIds.has(links.event_binding_id))
    || links.section_ids.some((sectionId) => sectionIds.has(sectionId))
    || (dayDate !== null && links.creation_date === dayDate)
    || note.frontmatter.note_id.startsWith(`${dayId}_`);
}

function continuityRecord(dayId: LearningDayId, summary: ApprovedContinuitySummary): ResourceRecord {
  return resourceRecord(dayId, "continuity", summary.summaryId, {
    title: `Approved continuity from ${summary.sourceDayId}`,
    citation: `Approved continuity ${summary.summaryId} · ${summary.approvedAt} · sha256:${summary.contentHash}`,
    status: "ready",
    detail: "Learner-approved continuity summary from an earlier day.",
  }, async () => ({
    text: summary.text,
    provenance: Object.freeze({
      summaryId: summary.summaryId,
      sourceDayId: summary.sourceDayId,
      approvedAt: summary.approvedAt,
      contentHash: `sha256:${summary.contentHash}`,
    }),
  }));
}

function preparedProjectionContent(projection: PreparedReferenceProjection): {
  readonly text: string;
  readonly provenance: Readonly<Record<string, unknown>>;
} {
  return {
    text: projection.markdown,
    provenance: Object.freeze({
      sourceId: projection.sourceId,
      requestedUrl: projection.requestedUrl,
      finalUrl: projection.finalUrl,
      mediaType: projection.mediaType,
      sourceContentHash: projection.sourceContentHash,
      projectionContentHash: projection.projectionContentHash,
      pageCount: projection.pageCount,
      sectionIds: projection.sectionIds,
    }),
  };
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let lower = 0;
  let upper = value.length;
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= maxBytes) lower = middle;
    else upper = middle - 1;
  }
  return value.slice(0, lower).trimEnd();
}

function excerptAround(value: string, index: number, maxCharacters: number): string {
  if (value.length <= maxCharacters) return value;
  const start = Math.max(0, index - Math.floor(maxCharacters * 0.35));
  const end = Math.min(value.length, start + maxCharacters);
  return `${start > 0 ? "…" : ""}${value.slice(start, end).trim()}${end < value.length ? "…" : ""}`;
}
