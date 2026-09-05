import { readFile } from "node:fs/promises";
import { join } from "node:path";
import fastifyMiddie from "@fastify/middie";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { z } from "zod";
import type {
  AbandonUncertainTutorTurnResponseBody,
  BootstrapResponse,
  EventCurriculumBindingSnapshotResponse,
  LearningDayId,
  LearningProgressSnapshotResponse,
  ScheduleSnapshotResponse,
  SetLearningOutcomeCompletionResponse,
  TutorSessionHistoryResponse,
} from "../shared/api.js";
import { ContextAssemblyError, type CanonicalOutcomeRecord } from "../shared/page-context.js";
import {
  NoteValidationError,
  createNoteTemplate,
  upgradeUntouchedNoteTemplate,
  type NoteLocator,
  type NoteRecord,
  type NoteSummary,
} from "../shared/notes.js";
import { REVIEW_QUESTION_MODES } from "../shared/review.js";
import { resolveRuntimeConfig } from "./config.js";
import {
  CURRICULUM_SOURCE_DAY_BY_PROGRAMME_DAY,
  CurriculumService,
} from "./curriculum/service.js";
import {
  EventCurriculumBindingStore,
  EventCurriculumBindingStoreError,
} from "./curriculum/event-binding-store.js";
import {
  EventCurriculumBindingService,
  EventCurriculumBindingServiceError,
} from "./curriculum/event-binding-service.js";
import { DiagnosticsService } from "./diagnostics/service.js";
import { CodexSelfTestService } from "./diagnostics/codex-self-test.js";
import {
  CurriculumMaterialError,
  CurriculumMaterialService,
} from "./materials/service.js";
import { MarkdownNoteStore, NoteStoreError } from "./notes/store.js";
import {
  SavedNoteVSCodeService,
  SavedNoteVSCodeServiceError,
} from "./notes/open-in-vscode-service.js";
import { ScheduleStore, ScheduleStoreError } from "./schedule/store.js";
import { installSignalShutdown } from "./signal-shutdown.js";
import {
  LearningProgressService,
  LearningProgressServiceError,
} from "./progress/service.js";
import { LearningProgressStore, LearningProgressStoreError } from "./progress/store.js";
import { TutorService, TutorServiceError, tutorScopeKey } from "./tutor/service.js";
import { TutorSessionLogStore, TutorSessionLogStoreError } from "./tutor/session-log-store.js";
import { ContinuitySummaryStore, ContinuityStoreError } from "./tutor/continuity-store.js";
import { TutorThreadBindingStore } from "./tutor/thread-binding-store.js";
import { createLiveCodexReviewCoachGenerator } from "./review/codex-generator.js";
import { ReviewCoachService, ReviewCoachServiceError } from "./review/service.js";
import { FileReviewSessionStore } from "./review/session-store.js";
import {
  scopeStudyReviewSections,
  scopeTodayReviewSections,
} from "./review/context-scope.js";
import {
  NodeVSCodeExecutableDiscovery,
  NodeWorkspaceProcessLauncher,
  WorkspaceLaunchError,
  WorkspaceLaunchService,
} from "./workspace/service.js";
import {
  CurriculumParticipantFileDiscovery,
  GitWorkspaceRepositoryStateReader,
} from "./workspace/runtime.js";
import { CurriculumPreparationManifestSource } from "./preparation/manifest-source.js";
import { PinnedPublicWebFetcher } from "./preparation/public-web-fetcher.js";
import { registerPreparationRoutes } from "./preparation/routes.js";
import { FilePreparationRunStore, PreparationService } from "./preparation/service.js";
import { PopplerPdfTextExtractor } from "./preparation/pdf-text-extractor.js";
import { ManagerContextService } from "./manager/context-service.js";
import { FilePreparedReferenceContextSource } from "./manager/prepared-context-source.js";
import { registerManagerRoutes } from "./manager/routes.js";
import { ManagerService } from "./manager/service.js";
import { DayReviewRetrievalService } from "./day-review/retrieval-service.js";
import { DayReviewContextService } from "./day-review/context-service.js";
import { registerDayReviewRoutes } from "./day-review/routes.js";
import { registerVisualAidRoutes } from "./images/routes.js";
import {
  OpenAIVisualImageProvider,
  VisualAidService,
} from "./images/service.js";
import { LondonMaterialRetrievalService } from "./london-materials/service.js";
import { registerBackupRoutes } from "./backup/routes.js";
import { BackupExportService } from "./backup/service.js";

function repositoryDayIdFor(programmeDayId: LearningDayId): LearningDayId | null {
  const sourceDay = CURRICULUM_SOURCE_DAY_BY_PROGRAMME_DAY[programmeDayId];
  return sourceDay === null ? null : `day${sourceDay}` as LearningDayId;
}

const config = resolveRuntimeConfig();
const app = Fastify({ logger: false, bodyLimit: 9 * 1024 * 1024 });
const scheduleStore = new ScheduleStore(
  join(config.companionRoot, "config", "schedule", "aisb-example-week.snapshot.json"),
  config.stateRoot,
);
const curriculumService = new CurriculumService(config.aisbRoot);
const eventCurriculumBindingStore = new EventCurriculumBindingStore(config.stateRoot);
const eventCurriculumBindingService = new EventCurriculumBindingService(
  eventCurriculumBindingStore,
  scheduleStore,
  curriculumService,
);
const curriculumMaterialService = new CurriculumMaterialService(config.aisbRoot);
const preparationService = new PreparationService({
  manifests: new CurriculumPreparationManifestSource(curriculumService, curriculumMaterialService),
  fetcher: new PinnedPublicWebFetcher(),
  store: new FilePreparationRunStore(config.stateRoot),
  pdfTextExtractor: new PopplerPdfTextExtractor(),
});
const diagnosticsService = new DiagnosticsService(config);
const codexSelfTestService = new CodexSelfTestService(config);
const noteStore = new MarkdownNoteStore(config.stateRoot);
const learningProgressService = new LearningProgressService(
  new LearningProgressStore(config.stateRoot),
  curriculumService,
);
const savedNoteVSCodeService = new SavedNoteVSCodeService(
  {
    state_root: config.stateRoot,
    companion_root: config.companionRoot,
    note_store: noteStore,
  },
  {
    executable_discovery: new NodeVSCodeExecutableDiscovery(),
    launcher: new NodeWorkspaceProcessLauncher(),
  },
);
const tutorThreadBindingStore = new TutorThreadBindingStore(config.stateRoot);
const tutorSessionLogStore = new TutorSessionLogStore(config.stateRoot);
const continuitySummaryStore = new ContinuitySummaryStore(config.stateRoot);
const reviewSessionStore = new FileReviewSessionStore(config.stateRoot);
const preparedReferenceContextSource = new FilePreparedReferenceContextSource(
  config.stateRoot,
  preparationService,
);
const visualAidService = new VisualAidService(
  config.stateRoot,
  config.imageGenerationAvailable
    ? new OpenAIVisualImageProvider(process.env.CODEX_OPENAI_API_KEY ?? "")
    : null,
);
const londonMaterialService = new LondonMaterialRetrievalService(config.aisbRoot);
const tutorService = new TutorService(
  config,
  scheduleStore,
  curriculumService,
  curriculumMaterialService,
  noteStore,
  eventCurriculumBindingStore,
  tutorThreadBindingStore,
  tutorSessionLogStore,
  continuitySummaryStore,
  preparedReferenceContextSource,
  {
    ...(config.imageGenerationAvailable ? { visualAidService } : {}),
    londonMaterialService,
  },
);
const managerService = new ManagerService(
  config,
  new ManagerContextService({
    schedule: scheduleStore,
    curriculum: curriculumService,
    progress: learningProgressService,
    notes: noteStore,
    continuity: continuitySummaryStore,
    tutorHistory: tutorSessionLogStore,
    reviewHistory: reviewSessionStore,
    preparation: preparedReferenceContextSource,
  }),
  tutorSessionLogStore,
  tutorThreadBindingStore,
  undefined,
  config.imageGenerationAvailable ? visualAidService : null,
  { londonMaterials: londonMaterialService },
);
const dayReviewRetrievalService = new DayReviewRetrievalService({
  schedule: scheduleStore,
  curriculum: curriculumService,
  notes: noteStore,
  materials: curriculumMaterialService,
  preparedReferences: preparedReferenceContextSource,
  tutorHistory: tutorSessionLogStore,
  reviewHistory: reviewSessionStore,
  continuity: continuitySummaryStore,
});
const learningDayIds = ["day0", "day1", "day2", "day3", "day4", "day5", "day6", "day7"] as const;
const dayReviewServices = new Map(learningDayIds.map((dayId) => [
  dayId,
  new ManagerService(
    config,
    new DayReviewContextService(
      dayId,
      scheduleStore,
      curriculumService,
      learningProgressService,
      dayReviewRetrievalService,
    ),
    tutorSessionLogStore,
    tutorThreadBindingStore,
    undefined,
    config.imageGenerationAvailable ? visualAidService : null,
    {
      dayId,
      dayReviewRetrieval: dayReviewRetrievalService,
      londonMaterials: londonMaterialService,
    },
  ),
] as const));
const backupExportService = new BackupExportService(config.stateRoot);
const repositoryStateReader = new GitWorkspaceRepositoryStateReader();
const workspaceLaunchService = new WorkspaceLaunchService(config.aisbRoot, {
  section_discovery: new CurriculumParticipantFileDiscovery(curriculumService),
  repository_state: repositoryStateReader,
  executable_discovery: new NodeVSCodeExecutableDiscovery(),
  launcher: new NodeWorkspaceProcessLauncher(),
});
const reviewCoachService = new ReviewCoachService({
  generator: createLiveCodexReviewCoachGenerator(config),
  sessionStore: reviewSessionStore,
  // The user has explicitly consented to these review disclosures. The
  // service still issues a payload-hash-bound, single-use grant for each turn
  // so no later or changed envelope can reuse that decision.
  async authorizeDisclosure(preview) {
    return {
      decision: "allow_once",
      disclosureId: preview.disclosureId,
      payloadHash: preview.payloadHash,
    };
  },
});

const noteKeySchema = z.string().min(1).max(180).regex(/^[A-Za-z0-9._-]+$/);
const learningDayIdSchema = z.enum(["day0", "day1", "day2", "day3", "day4", "day5", "day6", "day7"]);
const programmeDayIdSchema = z.enum(["day1", "day2", "day3", "day4", "day5", "day6", "day7"]);
const createNoteSchema = z
  .object({
    note_id: noteKeySchema,
    title: z.string().trim().min(1).max(240),
  })
  .strict();
const saveNoteSchema = z
  .object({
    content: z.string().max(8 * 1024 * 1024),
    base_revision: z.number().int().positive(),
    base_content_hash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const tutorTurnSchema = z
  .object({
    client_user_message_id: z.uuid(),
    message: z
      .string()
      .max(32_000)
      .refine((value) => value.trim().length > 0, "message must not be blank"),
    continuity_summaries: z
      .array(
        z
          .object({
            summary_id: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,78}[A-Za-z0-9])?$/),
            content_hash: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .max(3),
    request_ids: z.discriminatedUnion("context_mode", [
      z
        .object({
          context_mode: z.literal("today"),
          route_path: z.string().min(1).max(1_000),
          day_id: learningDayIdSchema,
          event_binding_id: z.string().max(180).nullable(),
          section_id: z.null(),
          document_id: z.null(),
          material_manifest_revision: z.null(),
          history_entry_id: z.string().min(1).max(180).regex(/^[A-Za-z0-9._:-]+$/),
          active_tab: z.literal("notes"),
        })
        .strict(),
      z
        .object({
          context_mode: z.literal("study"),
          route_path: z.string().min(1).max(1_000),
          day_id: learningDayIdSchema,
          event_binding_id: z.null(),
          section_id: z.string().regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/),
          document_id: z.string().regex(/^doc_[a-f0-9]{64}$/),
          material_manifest_revision: z.string().regex(/^sha256:[a-f0-9]{64}$/),
          history_entry_id: z.string().min(1).max(180).regex(/^[A-Za-z0-9._:-]+$/),
          active_tab: z.literal("notes"),
        })
        .strict(),
    ]),
    note_draft: z
      .object({
        note_id: noteKeySchema,
        content: z.string().max(8 * 1024 * 1024),
        base_revision: z.number().int().nonnegative(),
        save_status: z.string().max(40),
      })
      .strict(),
  })
  .strict();
const tutorSessionQuerySchema = z.discriminatedUnion("context_mode", [
  z
    .object({
      context_mode: z.literal("today"),
      day_id: learningDayIdSchema,
      event_binding_id: z.string().max(180).optional(),
    })
    .strict(),
  z
    .object({
      context_mode: z.literal("study"),
      day_id: learningDayIdSchema,
      section_id: z.string().regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/),
    })
    .strict(),
]);
const tutorSessionScopeBodySchema = z.discriminatedUnion("context_mode", [
  z
    .object({
      context_mode: z.literal("today"),
      day_id: learningDayIdSchema,
      event_binding_id: z.string().max(180).nullable(),
      section_id: z.null(),
    })
    .strict(),
  z
    .object({
      context_mode: z.literal("study"),
      day_id: learningDayIdSchema,
      event_binding_id: z.null(),
      section_id: z.string().regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/),
    })
    .strict(),
]);
const saveTutorContinuitySchema = z
  .object({
    source_scope: tutorSessionScopeBodySchema,
    source_turn_id: z.string().min(1).max(300).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    text: z
      .string()
      .max(8 * 1024)
      .refine((value) => value.trim().length > 0, "summary must not be blank")
      .refine((value) => Buffer.byteLength(value, "utf8") <= 8 * 1024, "summary is too large"),
  })
  .strict();
const tutorContinuityQuerySchema = z
  .object({ target_day_id: learningDayIdSchema })
  .strict();
const abandonUncertainTutorTurnSchema = z
  .object({
    scope: tutorSessionScopeBodySchema,
    turn_nonce: z.string().min(1).max(300).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    acknowledge_duplicate_risk: z.literal(true),
  })
  .strict();
const stopTutorTurnSchema = z
  .object({
    scope: tutorSessionScopeBodySchema,
    turn_nonce: z.string().min(1).max(300).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  })
  .strict();
const editableScheduleEventSchema = z
  .object({
    programme_day_id: programmeDayIdSchema.nullable(),
    title: z.string().trim().min(1).max(240),
    start: z.iso.datetime({ offset: true }),
    end: z.iso.datetime({ offset: true }),
    all_day: z.boolean(),
    status: z.enum(["scheduled", "cancelled"]).optional(),
    location: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
const editableScheduleChangesSchema = editableScheduleEventSchema
  .partial()
  .extend({ location: z.string().trim().min(1).max(500).nullable().optional() })
  .strict();
const scheduleMutationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("add"), event: editableScheduleEventSchema }).strict(),
  z
    .object({
      kind: z.literal("update"),
      event_binding_id: z.string().regex(/^aisb-\d{4}-\d{3}$/),
      changes: editableScheduleChangesSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("cancel"),
      event_binding_id: z.string().regex(/^aisb-\d{4}-\d{3}$/),
    })
    .strict(),
]);
const scheduleMutationRequestSchema = z
  .object({ expected_revision: z.string().min(1).max(240), mutation: scheduleMutationSchema })
  .strict();
const scheduleReimportRequestSchema = z
  .object({ expected_revision: z.string().min(1).max(240) })
  .strict();
const eventCurriculumBindingIdSchema = z.string().regex(/^aisb-\d{4}-\d{3}$/);
const eventCurriculumSectionIdSchema = z.string().regex(/^(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})$/);
const setEventCurriculumBindingSchema = z
  .object({
    expected_revision: z
      .string()
      .regex(/^event-curriculum-bindings:r[1-9]\d*:[a-f0-9]{16}$/),
    expected_schedule_revision: z.string().min(1).max(240),
    section_ids: z.array(eventCurriculumSectionIdSchema).max(64),
  })
  .strict()
  .superRefine((input, context) => {
    if (new Set(input.section_ids).size !== input.section_ids.length) {
      context.addIssue({
        code: "custom",
        path: ["section_ids"],
        message: "section_ids must be unique while preserving their explicit order",
      });
    }
  });
const workspacePreviewRequestSchema = z
  .object({
    section_id: z.string().regex(/^\d+\.\d+$/),
    expected_section_source_hash: z.string().regex(/^[a-f0-9]{64}$/),
    expected_declaration_hash: z.string().regex(/^[a-f0-9]{64}$/),
    expected_starter_hash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const workspaceTokenRequestSchema = z.object({ token: z.unknown() }).strict();
const reviewSessionFields = {
  day_id: learningDayIdSchema,
  outcome_refs: z
    .array(
      z
        .object({
          outcome_id: z.string().min(1).max(256),
          outcome_version_id: z.string().min(1).max(256),
        })
        .strict(),
    )
    .min(1)
    .max(32),
  question_limit: z.number().int().min(1).max(10),
  modes: z.array(z.enum(REVIEW_QUESTION_MODES)).min(1).max(REVIEW_QUESTION_MODES.length),
} as const;
const createReviewSessionSchema = z.discriminatedUnion("context_mode", [
  z
    .object({
      context_mode: z.literal("today"),
      event_binding_id: eventCurriculumBindingIdSchema.nullable(),
      section_id: z.null(),
      ...reviewSessionFields,
    })
    .strict(),
  z
    .object({
      context_mode: z.literal("study"),
      event_binding_id: z.null(),
      section_id: eventCurriculumSectionIdSchema.nullable(),
      ...reviewSessionFields,
    })
    .strict(),
]);
const submitReviewResponseSchema = z
  .object({
    question_id: z.string().min(1).max(256),
    learner_response: z.string().min(1).max(64 * 1024),
    learner_confidence: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).nullable(),
  })
  .strict();
const reviewSessionIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const materialSectionIdSchema = z.string().regex(/^\d+\.\d+$/);
const materialDocumentIdSchema = z.string().regex(/^doc_[a-f0-9]{64}$/);
const materialManifestRevisionSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const materialImageSourceSchema = z.string().min(1).max(2_048);
const canonicalOutcomeIdentifierSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,254}[A-Za-z0-9])?$/)
  .refine((value) => !value.includes(".."));
const setLearningOutcomeCompletionSchema = z
  .object({
    expected_version: z.string().max(80).regex(/^r(?:0|[1-9]\d*):[a-f0-9]{64}$/),
    outcome_id: canonicalOutcomeIdentifierSchema,
    outcome_version_id: canonicalOutcomeIdentifierSchema,
    completed: z.boolean(),
  })
  .strict();

function noteResponse(note: NoteRecord) {
  return {
    note_id: note.frontmatter.note_id,
    content: note.markdown,
    revision: note.frontmatter.revision,
    content_hash: note.content_hash,
    updated_at: note.frontmatter.last_modified_at,
    logical_path: note.logical_path,
  };
}

function previousCalendarDate(date: string): string {
  const instant = new Date(`${date}T00:00:00.000Z`);
  instant.setUTCDate(instant.getUTCDate() - 1);
  return instant.toISOString().slice(0, 10);
}

async function quickNoteCreationDate(noteKey: string): Promise<string | undefined> {
  const dayId = noteKey.match(/^(day[0-7])_quicknote_[A-Za-z0-9._-]+$/)?.[1];
  if (!dayId) return undefined;
  const schedule = await scheduleStore.read();
  if (dayId === "day0") {
    const firstDate = schedule.programmeDays[0]?.date;
    return firstDate ? previousCalendarDate(firstDate) : new Date().toISOString().slice(0, 10);
  }
  return schedule.programmeDays.find((day) => day.dayId === dayId)?.date;
}

function routeForNote(summary: NoteSummary, events: readonly { eventBindingId: string; programmeDayId: string | null }[]): string {
  if (summary.locator.kind === "day" && /^day[0-7]$/.test(summary.locator.programme_day_id)) {
    return `/day/${summary.locator.programme_day_id}`;
  }
  if (summary.locator.kind === "event") {
    const eventBindingId = summary.locator.event_binding_id;
    const event = events.find((candidate) => candidate.eventBindingId === eventBindingId);
    if (event?.programmeDayId && /^day[1-7]$/.test(event.programmeDayId)) {
      return `/day/${event.programmeDayId}/event/${eventBindingId}`;
    }
  }
  if (summary.locator.kind === "lesson") {
    const sectionId = summary.locator.section_id;
    const day = Number(sectionId.split(".")[0]);
    if (Number.isInteger(day) && day >= 0 && day <= 7) {
      return `/study/day${day}/section/${encodeURIComponent(sectionId)}`;
    }
  }
  return `/notes/${encodeURIComponent(summary.note_id)}`;
}

function scheduleResponse(snapshot: Awaited<ReturnType<ScheduleStore["read"]>>): ScheduleSnapshotResponse {
  return snapshot;
}

async function resolveReviewOutcomes(
  contextMode: "today" | "study",
  dayId: z.infer<typeof learningDayIdSchema>,
  eventBindingId: string | null,
  sectionId: string | null,
  refs: readonly { outcome_id: string; outcome_version_id: string }[],
): Promise<CanonicalOutcomeRecord[]> {
  const [allSections, repository, schedule, eventCurriculumBindings] = await Promise.all([
    contextMode === "today"
      ? curriculumService.readDay(dayId)
      : curriculumService.readRepositoryDay(dayId),
    repositoryStateReader.read(config.aisbRoot),
    contextMode === "today" && eventBindingId !== null
      ? scheduleStore.read()
      : Promise.resolve(null),
    contextMode === "today" && eventBindingId !== null
      ? eventCurriculumBindingService.read()
      : Promise.resolve(null),
  ]);
  const sections = contextMode === "study"
    ? scopeStudyReviewSections({ dayId, sectionId, sections: allSections })
    : eventBindingId !== null
      ? scopeTodayReviewSections({
          dayId,
          eventBindingId,
          sections: allSections,
          events: schedule!.events,
          eventCurriculumBindings: eventCurriculumBindings!,
        })
      : allSections;
  const repositoryResult = z
    .object({ repository_identity: z.string(), revision: z.string().min(1).max(256) })
    .strict()
    .parse(repository);
  const available = new Map<string, CanonicalOutcomeRecord>();
  for (const section of sections) {
    for (const outcome of section.outcomes) {
      const ordinalSuffix = Number.parseInt(outcome.outcomeId.split(":").at(-1) ?? "1", 10);
      available.set(outcome.outcomeId, {
        outcomeId: outcome.outcomeId,
        outcomeVersionId: outcome.versionId,
        sectionId: section.sectionId,
        category: outcome.category,
        ordinal: Number.isSafeInteger(ordinalSuffix) ? Math.max(0, ordinalSuffix - 1) : 0,
        text: outcome.text,
        sourcePath: outcome.sourcePath,
        sourceCommit: repositoryResult.revision,
      });
    }
  }
  return refs.map((ref) => {
    const outcome = available.get(ref.outcome_id);
    if (!outcome || outcome.outcomeVersionId !== ref.outcome_version_id) {
      throw new ReviewCoachServiceError(
        "conflict",
        "A selected learning outcome changed after this page loaded. Refresh before starting review.",
        409,
      );
    }
    return outcome;
  });
}

async function locatorForNoteKey(noteKey: string): Promise<NoteLocator | null> {
  const day = noteKey.match(/^day-(day[0-7])$/)?.[1];
  if (day) return { kind: "day", programme_day_id: day };
  const sectionId = noteKey.match(/^lesson-(\d+\.\d+)$/)?.[1];
  if (sectionId) return { kind: "lesson", section_id: sectionId };
  const eventId = noteKey.match(/^event-(aisb-\d{4}-\d{3})$/)?.[1];
  if (eventId) return { kind: "event", event_binding_id: eventId };
  const quickNoteDate = await quickNoteCreationDate(noteKey);
  if (quickNoteDate) {
    return {
      kind: "ad_hoc",
      creation_date: quickNoteDate,
      note_id: noteKey,
    };
  }
  const summary = (await noteStore.list()).find((candidate) => candidate.note_id === noteKey);
  return summary?.locator ?? null;
}

async function createForNoteKey(noteKey: string, title: string) {
  const existing = (await noteStore.list()).find((candidate) => candidate.note_id === noteKey);
  if (existing) {
    const note = await noteStore.read(existing.locator);
    const upgradedMarkdown = upgradeUntouchedNoteTemplate(note.markdown, note.frontmatter.title);
    if (upgradedMarkdown === null) return { status: "existing" as const, note };
    const upgraded = await noteStore.save(existing.locator, {
      note_id: note.frontmatter.note_id,
      expected_revision: note.frontmatter.revision,
      expected_content_hash: note.content_hash,
      markdown: upgradedMarkdown,
    });
    return {
      status: "existing" as const,
      note: upgraded.status === "conflict" ? upgraded.current : upgraded.note,
    };
  }
  const day = noteKey.match(/^day-(day[0-7])$/)?.[1];
  if (day) {
    return noteStore.create({
      kind: "day",
      programme_day_id: day,
      note_id: noteKey,
      title,
      markdown: createNoteTemplate(title),
    });
  }
  const lessonSectionId = noteKey.match(/^lesson-(\d+\.\d+)$/)?.[1];
  if (lessonSectionId) {
    return noteStore.create({
      kind: "lesson",
      section_id: lessonSectionId,
      note_id: noteKey,
      title,
      markdown: createNoteTemplate(title),
    });
  }
  const eventId = noteKey.match(/^event-(aisb-\d{4}-\d{3})$/)?.[1];
  if (eventId) {
    return noteStore.create({
      kind: "event",
      event_binding_id: eventId,
      note_id: noteKey,
      title,
      markdown: createNoteTemplate(title),
    });
  }
  const quickNoteDate = await quickNoteCreationDate(noteKey);
  if (quickNoteDate) {
    return noteStore.create({
      kind: "ad_hoc",
      creation_date: quickNoteDate,
      filename_style: "named",
      note_id: noteKey,
      title,
      markdown: createNoteTemplate(title),
    });
  }
  return noteStore.create({
    kind: "ad_hoc",
    note_id: noteKey,
    title,
    markdown: createNoteTemplate(title),
  });
}

app.get("/api/health", async () => ({ status: "ok" as const }));

// Deliberately user-triggered: bootstrap never starts App Server or inspects
// account/model state as a side effect of opening the notebook.
app.post("/api/diagnostics/codex-self-test", async (_request, reply) => {
  return reply.send(await codexSelfTestService.run());
});

app.get("/api/progress", async (): Promise<LearningProgressSnapshotResponse> => {
  return learningProgressService.read();
});

app.put("/api/progress/outcomes", async (request, reply) => {
  const input = setLearningOutcomeCompletionSchema.parse(request.body);
  const result: SetLearningOutcomeCompletionResponse = await learningProgressService.setCompletion({
    expectedVersion: input.expected_version,
    outcomeId: input.outcome_id,
    outcomeVersionId: input.outcome_version_id,
    completed: input.completed,
  });
  return reply.code(result.status === "conflict" ? 409 : 200).send(result);
});

app.get("/api/bootstrap", async (): Promise<BootstrapResponse> => {
  const [schedule, eventCurriculumBindings, sectionsByDay, repositorySectionsByDay, diagnostics] = await Promise.all([
    scheduleStore.read(),
    eventCurriculumBindingService.read(),
    curriculumService.readAllDays(),
    curriculumService.readAllRepositoryDays(),
    diagnosticsService.read(),
  ]);
  return {
    runtimeSchedule: schedule.runtimeSchedule,
    scheduleRevision: schedule.scheduleRevision,
    eventCurriculumBindings,
    programmeTimeZone: schedule.programmeTimeZone,
    programmeDays: schedule.programmeDays,
    events: schedule.events,
    sectionsByDay,
    repositorySectionsByDay,
    programmeToRepositoryDay: {
      day1: repositoryDayIdFor("day1"),
      day2: repositoryDayIdFor("day2"),
      day3: repositoryDayIdFor("day3"),
      day4: repositoryDayIdFor("day4"),
      day5: repositoryDayIdFor("day5"),
      day6: repositoryDayIdFor("day6"),
      day7: repositoryDayIdFor("day7"),
    },
    diagnostics,
  };
});

app.get(
  "/api/event-curriculum-bindings",
  async (): Promise<EventCurriculumBindingSnapshotResponse> =>
    eventCurriculumBindingService.read(),
);

app.put<{ Params: { eventBindingId: string } }>(
  "/api/event-curriculum-bindings/:eventBindingId",
  async (request, reply) => {
    const eventBindingId = eventCurriculumBindingIdSchema.parse(
      request.params.eventBindingId,
    );
    const input = setEventCurriculumBindingSchema.parse(request.body);
    return reply.send(
      await eventCurriculumBindingService.replace({
        expectedRevision: input.expected_revision,
        expectedScheduleRevision: input.expected_schedule_revision,
        eventBindingId,
        sectionIds: input.section_ids,
      }),
    );
  },
);

app.get<{ Params: { sectionId: string } }>(
  "/api/materials/sections/:sectionId",
  async (request, reply) => {
    const sectionId = materialSectionIdSchema.parse(request.params.sectionId);
    return reply.send(await curriculumMaterialService.manifest(sectionId));
  },
);

app.get<{
  Params: { sectionId: string; documentId: string };
  Querystring: { manifest_revision?: string };
}>(
  "/api/materials/sections/:sectionId/documents/:documentId",
  async (request, reply) => {
    const sectionId = materialSectionIdSchema.parse(request.params.sectionId);
    const documentId = materialDocumentIdSchema.parse(request.params.documentId);
    const expectedManifestRevision = materialManifestRevisionSchema.parse(
      request.query.manifest_revision,
    );
    return reply.send(await curriculumMaterialService.readForDisplay({
      sectionId,
      documentId,
      expectedManifestRevision,
    }));
  },
);

app.get<{
  Params: { sectionId: string; documentId: string };
  Querystring: { manifest_revision?: string; source?: string };
}>(
  "/api/materials/sections/:sectionId/documents/:documentId/image",
  async (request, reply) => {
    const sectionId = materialSectionIdSchema.parse(request.params.sectionId);
    const documentId = materialDocumentIdSchema.parse(request.params.documentId);
    const expectedManifestRevision = materialManifestRevisionSchema.parse(
      request.query.manifest_revision,
    );
    const source = materialImageSourceSchema.parse(request.query.source);
    const image = await curriculumMaterialService.readImageForDisplay({
      sectionId,
      documentId,
      expectedManifestRevision,
      source,
    });
    return reply
      .header("Cache-Control", "no-store")
      .header("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'")
      .header("Cross-Origin-Resource-Policy", "same-origin")
      .header("X-Content-Type-Options", "nosniff")
      .type(image.contentType)
      .send(image.bytes);
  },
);

app.patch("/api/schedule", async (request, reply) => {
  const input = scheduleMutationRequestSchema.parse(request.body);
  const mutation = input.mutation;
  if (mutation.kind === "add") {
    return reply.send(scheduleResponse(await scheduleStore.mutate(input.expected_revision, {
      kind: "add",
      event: {
        programmeDayId: mutation.event.programme_day_id,
        title: mutation.event.title,
        start: mutation.event.start,
        end: mutation.event.end,
        allDay: mutation.event.all_day,
        ...(mutation.event.status ? { status: mutation.event.status } : {}),
        ...(mutation.event.location ? { location: mutation.event.location } : {}),
      },
    })));
  }
  if (mutation.kind === "cancel") {
    return reply.send(scheduleResponse(await scheduleStore.mutate(input.expected_revision, {
      kind: "cancel",
      eventBindingId: mutation.event_binding_id,
    })));
  }
  return reply.send(scheduleResponse(await scheduleStore.mutate(input.expected_revision, {
    kind: "update",
    eventBindingId: mutation.event_binding_id,
    changes: {
      ...(mutation.changes.programme_day_id !== undefined
        ? { programmeDayId: mutation.changes.programme_day_id }
        : {}),
      ...(mutation.changes.title !== undefined ? { title: mutation.changes.title } : {}),
      ...(mutation.changes.start !== undefined ? { start: mutation.changes.start } : {}),
      ...(mutation.changes.end !== undefined ? { end: mutation.changes.end } : {}),
      ...(mutation.changes.all_day !== undefined ? { allDay: mutation.changes.all_day } : {}),
      ...(mutation.changes.status !== undefined ? { status: mutation.changes.status } : {}),
      ...(Object.hasOwn(mutation.changes, "location") && mutation.changes.location !== undefined
        ? { location: mutation.changes.location }
        : {}),
    },
  })));
});

app.post("/api/schedule/reimport", async (request, reply) => {
  const input = scheduleReimportRequestSchema.parse(request.body);
  return reply.send(scheduleResponse(await scheduleStore.reimportFromSeed(input.expected_revision)));
});

app.post("/api/workspace/preview", async (request, reply) => {
  const input = workspacePreviewRequestSchema.parse(request.body);
  const resolution = await workspaceLaunchService.resolveParticipantFile(input);
  return reply.send(await workspaceLaunchService.previewOpen(resolution));
});

app.post("/api/workspace/create", async (request, reply) => {
  const input = workspaceTokenRequestSchema.parse(request.body);
  return reply.send(await workspaceLaunchService.createIfAbsent(input.token));
});

app.post("/api/workspace/launch", async (request, reply) => {
  const input = workspaceTokenRequestSchema.parse(request.body);
  return reply.send(await workspaceLaunchService.launchVSCode(input.token));
});

app.post("/api/review/sessions", async (request, reply) => {
  const input = createReviewSessionSchema.parse(request.body);
  const session = await reviewCoachService.createSession({
    canonicalOutcomes: await resolveReviewOutcomes(
      input.context_mode,
      input.day_id,
      input.event_binding_id,
      input.section_id,
      input.outcome_refs,
    ),
    questionLimit: input.question_limit,
    modes: input.modes,
  });
  return reply.code(201).send({ mode: "live-codex", session });
});

app.get<{ Params: { sessionId: string } }>("/api/review/sessions/:sessionId", async (request, reply) => {
  const sessionId = reviewSessionIdSchema.parse(request.params.sessionId);
  return reply.send({ mode: "live-codex", session: await reviewCoachService.readSession(sessionId) });
});

app.post<{ Params: { sessionId: string } }>("/api/review/sessions/:sessionId/start", async (request, reply) => {
  const sessionId = reviewSessionIdSchema.parse(request.params.sessionId);
  return reply.send({
    mode: "live-codex",
    session: await reviewCoachService.startQuestion({ sessionId }),
  });
});

app.post<{ Params: { sessionId: string } }>("/api/review/sessions/:sessionId/responses", async (request, reply) => {
  const sessionId = reviewSessionIdSchema.parse(request.params.sessionId);
  const input = submitReviewResponseSchema.parse(request.body);
  return reply.send({
    mode: "live-codex",
    result: await reviewCoachService.submitResponse({
      sessionId,
      questionId: input.question_id,
      learnerResponse: input.learner_response,
      learnerConfidence: input.learner_confidence,
    }),
  });
});

app.get("/api/notes", async () => {
  const [inventory, schedule] = await Promise.all([noteStore.inventory(), scheduleStore.read()]);
  return {
    notes: inventory.notes
      .slice()
      .sort((left, right) => right.last_modified_at.localeCompare(left.last_modified_at))
      .map((summary) => ({
        noteId: summary.note_id,
        noteKind: summary.note_kind,
        title: summary.title,
        revision: summary.revision,
        status: summary.status,
        lastModifiedAt: summary.last_modified_at,
        logicalPath: summary.logical_path,
        routePath: routeForNote(summary, schedule.events),
        hasLearnerContent: summary.has_learner_content,
      })),
    unreadable: inventory.unreadable.map((issue) => ({
      logicalPath: issue.logical_path,
      reason: issue.reason,
    })),
  };
});

app.post("/api/notes/vscode/prepare", async (request, reply) => {
  return reply.send(await savedNoteVSCodeService.prepareOpen(request.body));
});

app.post("/api/notes/vscode/launch", async (request, reply) => {
  const body = z.object({ token: z.unknown() }).strict().parse(request.body);
  return reply.send(await savedNoteVSCodeService.launchVSCode(body.token));
});

app.get<{ Params: { noteKey: string } }>("/api/notes/:noteKey", async (request, reply) => {
  const noteKey = noteKeySchema.parse(request.params.noteKey);
  const locator = await locatorForNoteKey(noteKey);
  if (!locator) return reply.code(404).send({ error: "Note not found" });
  try {
    return noteResponse(await noteStore.read(locator));
  } catch (error) {
    if (error instanceof NoteStoreError && error.code === "not_found") {
      return reply.code(404).send({ error: "Note not found" });
    }
    throw error;
  }
});

app.post("/api/notes", async (request, reply) => {
  const input = createNoteSchema.parse(request.body);
  const result = await createForNoteKey(input.note_id, input.title);
  return reply.code(result.status === "created" ? 201 : 200).send(noteResponse(result.note));
});

app.put<{ Params: { noteKey: string } }>("/api/notes/:noteKey", async (request, reply) => {
  const noteKey = noteKeySchema.parse(request.params.noteKey);
  const input = saveNoteSchema.parse(request.body);
  const locator = await locatorForNoteKey(noteKey);
  if (!locator) return reply.code(404).send({ error: "Note not found" });
  const current = await noteStore.read(locator);
  const result = await noteStore.save(locator, {
    note_id: current.frontmatter.note_id,
    expected_revision: input.base_revision,
    expected_content_hash: input.base_content_hash,
    markdown: input.content,
  });
  if (result.status === "conflict") {
    return reply.code(409).send({
      status: "conflict",
      current: noteResponse(result.current),
      conflict_path: result.conflict_copy_path,
    });
  }
  return noteResponse(result.note);
});

app.post<{ Params: { noteKey: string } }>("/api/notes/:noteKey/recover", async (request, reply) => {
  const noteKey = noteKeySchema.parse(request.params.noteKey);
  const locator = await locatorForNoteKey(noteKey);
  if (!locator) return reply.code(404).send({ error: "Note not found", code: "not_found" });
  const result = await noteStore.recover(locator, noteKey);
  return reply.send({
    ...noteResponse(result.note),
    recovery_status: result.status,
    recovery_snapshot_path: result.recovery_snapshot_path,
    ...(result.status === "recovered" && result.displaced_copy_path
      ? { displaced_copy_path: result.displaced_copy_path }
      : {}),
  });
});

app.get("/api/tutor/continuity", async (request, reply) => {
  const query = tutorContinuityQuerySchema.parse(request.query);
  const selection = await tutorService.readContinuitySummaries(query.target_day_id);
  return reply.send({
    target_day_id: query.target_day_id,
    total_text_bytes: selection.totalTextBytes,
    summaries: selection.summaries.map((summary) => ({
      summary_id: summary.summaryId,
      source_day_id: summary.sourceDayId,
      source_scope_key: summary.sourceScopeKey,
      source_turn_id: summary.sourceTurnId,
      approved_at: summary.approvedAt,
      content_hash: summary.contentHash,
      text: summary.text,
    })),
  });
});

app.post("/api/tutor/continuity", async (request, reply) => {
  const input = saveTutorContinuitySchema.parse(request.body);
  const scope = input.source_scope.context_mode === "today"
    ? {
        contextMode: "today" as const,
        dayId: input.source_scope.day_id,
        eventBindingId: input.source_scope.event_binding_id,
      }
    : {
        contextMode: "study" as const,
        dayId: input.source_scope.day_id,
        sectionId: input.source_scope.section_id,
      };
  const summary = await tutorService.saveContinuitySummary({
    scope,
    sourceTurnId: input.source_turn_id,
    text: input.text,
  });
  return reply.send({
    summary_id: summary.summaryId,
    source_day_id: summary.sourceDayId,
    source_scope_key: summary.sourceScopeKey,
    source_turn_id: summary.sourceTurnId,
    approved_at: summary.approvedAt,
    content_hash: summary.contentHash,
    text: summary.text,
  });
});

app.get("/api/tutor/session", async (request, reply) => {
  const query = tutorSessionQuerySchema.parse(request.query);
  const scope = query.context_mode === "today"
    ? {
        contextMode: "today" as const,
        dayId: query.day_id,
        eventBindingId: query.event_binding_id ? query.event_binding_id : null,
      }
    : {
        contextMode: "study" as const,
        dayId: query.day_id,
        sectionId: query.section_id,
      };
  const scopeKey = tutorScopeKey(scope);
  const session = await tutorService.readSession(scope);
  const activeTurn = tutorService.readActiveTurn(scope);
  const activeTurnResponse = activeTurn === null ? null : {
    turn_nonce: activeTurn.turnNonce,
    state: activeTurn.state,
    started_at: activeTurn.startedAt,
  };
  if (session === null) {
    return reply.send({
      scope_key: scopeKey,
      chat_id: null,
      current_thread_id: null,
      thread_segments: [],
      messages: [],
      active_turn: activeTurnResponse,
    } satisfies TutorSessionHistoryResponse);
  }

  return reply.send({
    scope_key: session.scopeKey,
    chat_id: session.chatId,
    current_thread_id: session.currentThreadId,
    thread_segments: session.threadSegments.map((segment, index, segments) => ({
      thread_id: segment.threadId,
      status: index === segments.length - 1 ? "current" as const : "replaced" as const,
      started_at: segment.boundAt,
      ended_at: segments[index + 1]?.boundAt ?? null,
    })),
    messages: session.messages.map((message) => {
      if (message.kind === "submission") {
        return {
          message_id: `user:${message.sequence}`,
          role: "user" as const,
          status: "accepted" as const,
          text: message.text,
          occurred_at: message.occurredAt,
          turn_nonce: message.turnNonce,
          turn_id: null,
          citations: [],
        };
      }
      if (message.kind === "completion") {
        return {
          message_id: `assistant:${message.sequence}`,
          role: "assistant" as const,
          status: "completed" as const,
          text: message.text,
          occurred_at: message.occurredAt,
          turn_nonce: message.turnNonce,
          turn_id: message.turnId,
          citations: message.citations,
        };
      }
      return {
        message_id: `status:${message.sequence}`,
        role: "status" as const,
        status: "failed" as const,
        text: message.text,
        occurred_at: message.occurredAt,
        turn_nonce: message.turnNonce,
        turn_id: null,
        citations: [],
      };
    }),
    active_turn: activeTurnResponse,
  } satisfies TutorSessionHistoryResponse);
});

app.post("/api/tutor/turns/stop", async (request, reply) => {
  const input = stopTutorTurnSchema.parse(request.body);
  const scope = input.scope.context_mode === "today"
    ? {
        contextMode: "today" as const,
        dayId: input.scope.day_id,
        eventBindingId: input.scope.event_binding_id,
      }
    : {
        contextMode: "study" as const,
        dayId: input.scope.day_id,
        sectionId: input.scope.section_id,
      };
  return reply.send(tutorService.stopTurn(scope, input.turn_nonce));
});

app.post("/api/tutor/session/abandon-uncertain", async (request, reply) => {
  const input = abandonUncertainTutorTurnSchema.parse(request.body);
  const scope = input.scope.context_mode === "today"
    ? {
        contextMode: "today" as const,
        dayId: input.scope.day_id,
        eventBindingId: input.scope.event_binding_id,
      }
    : {
        contextMode: "study" as const,
        dayId: input.scope.day_id,
        sectionId: input.scope.section_id,
      };
  const result = await tutorService.abandonUncertainTurn({
    scope,
    turnNonce: input.turn_nonce,
  });
  return reply.send({
    status: result.status,
    restore_text: result.restoreText,
  } satisfies AbandonUncertainTutorTurnResponseBody);
});

app.post("/api/tutor/turns", async (request, reply) => {
  const input = tutorTurnSchema.parse(request.body);
  const commonTurnInput = {
    clientUserMessageId: input.client_user_message_id,
    message: input.message,
    continuitySummaries: input.continuity_summaries.map((summary) => ({
      summaryId: summary.summary_id,
      contentHash: summary.content_hash,
    })),
    routePath: input.request_ids.route_path,
    dayId: input.request_ids.day_id,
    historyEntryId: input.request_ids.history_entry_id,
    noteDraft: {
      noteId: input.note_draft.note_id,
      content: input.note_draft.content,
      baseRevision: input.note_draft.base_revision,
      saveStatus: input.note_draft.save_status,
    },
  };
  const result = await tutorService.runTurn(
    input.request_ids.context_mode === "today"
      ? {
          ...commonTurnInput,
          contextMode: "today",
          eventBindingId: input.request_ids.event_binding_id,
        }
      : {
          ...commonTurnInput,
          contextMode: "study",
          sectionId: input.request_ids.section_id,
          documentId: input.request_ids.document_id,
          materialManifestRevision: input.request_ids.material_manifest_revision,
        },
  );
  return reply.send({
    mode: result.mode,
    message: result.message,
    context_hash: result.contextHash,
    chat_id: result.chatId,
    thread_id: result.threadId,
    turn_id: result.turnId,
    client_user_message_id: result.clientUserMessageId,
    disclosure: result.disclosure,
  });
});

registerPreparationRoutes(app, preparationService);
registerManagerRoutes(app, managerService);
registerDayReviewRoutes(app, dayReviewServices);
registerVisualAidRoutes(app, visualAidService);
registerBackupRoutes(app, backupExportService);

app.setErrorHandler(async (error, _request, reply) => {
  if (error instanceof z.ZodError) {
    void reply.code(400).send({ error: "The request did not match the local application contract." });
    return;
  }
  if (error instanceof NoteStoreError) {
    const statusCode = error.code === "not_found" ? 404 : 409;
    void reply.code(statusCode).send({ error: error.message, code: error.code });
    return;
  }
  if (error instanceof NoteValidationError) {
    void reply.code(409).send({
      error: "The Markdown note is unreadable. Its bytes were left untouched; recover the latest saved snapshot or repair the file in VS Code.",
      code: "invalid_note",
    });
    return;
  }
  if (error instanceof LearningProgressServiceError) {
    void reply.code(error.statusCode).send({ error: error.message, code: error.code });
    return;
  }
  if (error instanceof LearningProgressStoreError) {
    const statusCode = error.code === "invalid_request" ? 400 :
      error.code === "unsafe_path" ? 409 : 503;
    void reply.code(statusCode).send({ error: error.message, code: error.code });
    return;
  }
  if (error instanceof EventCurriculumBindingServiceError) {
    await reply.code(error.statusCode).send({ error: error.message, code: error.code });
    return;
  }
  if (error instanceof EventCurriculumBindingStoreError) {
    const statusCode =
      error.code === "invalid_request"
        ? 400
        : error.code === "conflict" || error.code === "unsafe_path"
          ? 409
          : 503;
    let current: EventCurriculumBindingSnapshotResponse | undefined;
    if (error.code === "conflict") {
      try {
        current = await eventCurriculumBindingService.read();
      } catch {
        // The compare-and-swap revision remains useful if a second read fails.
      }
    }
    await reply.code(statusCode).send({
      error: error.message,
      code: error.code,
      ...(current ? { current } : {}),
      ...(!current && error.currentRevision
        ? { current_revision: error.currentRevision }
        : {}),
    });
    return;
  }
  if (error instanceof CurriculumMaterialError) {
    void reply.code(error.statusCode).send({
      error: error.message,
      code: error.code,
      ...(error.currentManifestRevision
        ? { current_manifest_revision: error.currentManifestRevision }
        : {}),
    });
    return;
  }
  if (error instanceof SavedNoteVSCodeServiceError) {
    const statusCode = error.code === "note_not_found" ? 404 :
      error.code === "invalid_request" || error.code === "invalid_token" ? 400 : 409;
    void reply.code(statusCode).send({ error: error.message, code: error.code });
    return;
  }
  if (error instanceof ScheduleStoreError) {
    const statusCode = error.code === "not_found" ? 404 : error.code === "conflict" ? 409 : 400;
    void reply.code(statusCode).send({
      error: error.message,
      ...(error.currentRevision ? { current_revision: error.currentRevision } : {}),
    });
    return;
  }
  if (error instanceof WorkspaceLaunchError) {
    const statusCode = error.code === "section_not_linked" ? 404 :
      error.code === "stale_preview" || error.code === "invalid_target" ? 409 : 400;
    void reply.code(statusCode).send({ error: error.message, code: error.code });
    return;
  }
  if (error instanceof ReviewCoachServiceError) {
    void reply.code(error.statusCode).send({ error: error.message, code: error.code });
    return;
  }
  if (error instanceof ContextAssemblyError) {
    const statusCode = error.code === "FILE_POLICY_DENIED" ? 403 : error.code === "INVALID_REQUEST" ? 400 : 409;
    void reply.code(statusCode).send({ error: error.message });
    return;
  }
  if (error instanceof TutorServiceError) {
    void reply.code(error.statusCode).send({
      error: error.message,
      ...(error.code === null ? {} : { code: error.code }),
    });
    return;
  }
  if (error instanceof TutorSessionLogStoreError) {
    const statusCode = error.code === "invalid_request"
      ? 400
      : error.code === "conflicting_duplicate" || error.code === "scope_chat_conflict"
        ? 409
        : 503;
    void reply.code(statusCode).send({ error: error.message, code: error.code });
    return;
  }
  if (error instanceof ContinuityStoreError) {
    const statusCode = error.code === "invalid_request"
      ? 400
      : error.code === "unsafe_path"
        ? 409
        : 503;
    void reply.code(statusCode).send({ error: error.message, code: error.code });
    return;
  }
  void reply.code(500).send({ error: "The local application service failed safely." });
});

app.addHook("onClose", async () => {
  await Promise.all([...dayReviewServices.values()].map(async (service) => await service.close()));
  await managerService.close();
  await tutorService.close();
  await reviewCoachService.close();
});

if (config.mode === "production") {
  await app.register(fastifyStatic, {
    root: join(config.companionRoot, "dist", "client"),
    wildcard: false,
  });
  app.setNotFoundHandler(async (request, reply) => {
    if (request.method === "GET" && !request.url.startsWith("/api/")) {
      return reply.type("text/html").send(await readFile(join(config.companionRoot, "dist", "client", "index.html"), "utf8"));
    }
    return reply.code(404).send({ error: "Not found" });
  });
} else {
  await app.register(fastifyMiddie);
  const { createServer: createViteServer } = await import("vite");
  const vite = await createViteServer({
    root: config.companionRoot,
    server: { middlewareMode: true, hmr: { server: app.server } },
    appType: "spa",
  });
  app.use((request, response, next) => {
    if (request.url?.startsWith("/api/")) {
      next();
      return;
    }
    vite.middlewares(request, response, next);
  });
  app.addHook("onClose", async () => vite.close());
}

await app.listen({ host: config.host, port: config.port });
installSignalShutdown(async () => {
  preparationService.beginShutdown();
  visualAidService.beginShutdown();
  const interrupted = await Promise.allSettled([
    ...[...dayReviewServices.values()].map(async (service) => await service.close()),
    managerService.close(),
    tutorService.close(),
    reviewCoachService.close(),
  ]);
  await app.close();
  const failed = interrupted.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failed !== undefined) throw failed.reason;
});
process.stdout.write(`AISB Companion: http://${config.host}:${config.port}/\n`);
process.stdout.write(`State: ${config.stateRoot}\n`);
