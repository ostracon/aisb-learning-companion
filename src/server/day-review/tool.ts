import { z } from "zod";

import type { LearningDayId } from "../../shared/api.js";
import type { DayReviewResourceKind } from "../../shared/day-review.js";
import type { DynamicToolCallResponse } from "../codex/generated/v2/DynamicToolCallResponse.js";
import type { DynamicToolSpec } from "../codex/generated/v2/DynamicToolSpec.js";
import type { DayReviewRetrievalService } from "./retrieval-service.js";

export const DAY_REVIEW_TOOLSET_VERSION = "day-review-retrieval-v1";
export const SEARCH_DAY_REVIEW_SOURCES_TOOL = "search_day_review_sources";
export const READ_DAY_REVIEW_SOURCE_TOOL = "read_day_review_source";
export const INSPECT_DAY_REVIEW_HISTORY_TOOL = "inspect_day_review_history";

const RESOURCE_KINDS: readonly DayReviewResourceKind[] = [
  "note",
  "curriculum",
  "prepared_reference",
  "tutor_history",
  "review_history",
  "continuity",
];

export const dayReviewToolSpecs: readonly DynamicToolSpec[] = Object.freeze([
  Object.freeze({
    type: "function" as const,
    name: SEARCH_DAY_REVIEW_SOURCES_TOOL,
    description: "Search learner-visible notes, curriculum projections, prepared references, and bounded learning history for the day bound to this thread. Use returned opaque resource IDs with read_day_review_source. Never guess an ID, path, or URL.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", minLength: 2, maxLength: 500 },
        kinds: { type: "array", maxItems: 6, uniqueItems: true, items: { type: "string", enum: [...RESOURCE_KINDS] } },
        limit: { type: "integer", minimum: 1, maximum: 12 },
      },
      required: ["query"],
    },
  }),
  Object.freeze({
    type: "function" as const,
    name: READ_DAY_REVIEW_SOURCE_TOOL,
    description: "Read one bounded chunk from an opaque resource ID returned in this day review's context or search results. The server re-authorizes the resource against the thread's fixed day. It does not accept paths or URLs.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        resource_id: { type: "string", pattern: "^dayres_[a-f0-9]{48}$" },
        cursor: { type: "integer", minimum: 0 },
        max_bytes: { type: "integer", minimum: 512, maximum: 16384 },
      },
      required: ["resource_id"],
    },
  }),
  Object.freeze({
    type: "function" as const,
    name: INSPECT_DAY_REVIEW_HISTORY_TOOL,
    description: "Inspect bounded prior tutor excerpts, advisory review summaries, or learner-approved continuity relevant to this thread's fixed day. Raw recall responses are never returned.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: { type: "string", enum: ["tutor", "review", "continuity", "all"] },
      },
    },
  }),
]);

const callBase = z.object({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  callId: z.string().min(1),
  namespace: z.null(),
});
const callSchema = z.discriminatedUnion("tool", [
  callBase.extend({
    tool: z.literal(SEARCH_DAY_REVIEW_SOURCES_TOOL),
    arguments: z.object({
      query: z.string().min(2).max(500),
      kinds: z.array(z.enum(RESOURCE_KINDS)).max(6).optional(),
      limit: z.number().int().min(1).max(12).optional(),
    }).strict(),
  }).strict(),
  callBase.extend({
    tool: z.literal(READ_DAY_REVIEW_SOURCE_TOOL),
    arguments: z.object({
      resource_id: z.string().regex(/^dayres_[a-f0-9]{48}$/u),
      cursor: z.number().int().nonnegative().optional(),
      max_bytes: z.number().int().min(512).max(16_384).optional(),
    }).strict(),
  }).strict(),
  callBase.extend({
    tool: z.literal(INSPECT_DAY_REVIEW_HISTORY_TOOL),
    arguments: z.object({
      kind: z.enum(["tutor", "review", "continuity", "all"]).optional(),
    }).strict(),
  }).strict(),
]);

export function isDayReviewToolCall(params: unknown): boolean {
  if (typeof params !== "object" || params === null || !("tool" in params)) return false;
  return [
    SEARCH_DAY_REVIEW_SOURCES_TOOL,
    READ_DAY_REVIEW_SOURCE_TOOL,
    INSPECT_DAY_REVIEW_HISTORY_TOOL,
  ].includes(String((params as { readonly tool?: unknown }).tool));
}

export function createDayReviewToolHandler(
  service: DayReviewRetrievalService,
  dayId: LearningDayId,
): (params: unknown) => Promise<DynamicToolCallResponse> {
  return async (params) => {
    const call = callSchema.parse(params);
    let result: unknown;
    if (call.tool === SEARCH_DAY_REVIEW_SOURCES_TOOL) {
      result = {
        dayId,
        results: await service.search({
          dayId,
          query: call.arguments.query,
          ...(call.arguments.kinds === undefined ? {} : { kinds: call.arguments.kinds }),
          ...(call.arguments.limit === undefined ? {} : { limit: call.arguments.limit }),
        }),
      };
    } else if (call.tool === READ_DAY_REVIEW_SOURCE_TOOL) {
      result = {
        dayId,
        resource: await service.read({
          dayId,
          resourceId: call.arguments.resource_id,
          ...(call.arguments.cursor === undefined ? {} : { cursor: call.arguments.cursor }),
          ...(call.arguments.max_bytes === undefined ? {} : { maxBytes: call.arguments.max_bytes }),
        }),
      };
    } else {
      result = {
        dayId,
        history: await service.inspectHistory({
          dayId,
          ...(call.arguments.kind === undefined ? {} : { kind: call.arguments.kind }),
        }),
      };
    }
    return Object.freeze({
      success: true,
      contentItems: Object.freeze([{ type: "inputText" as const, text: JSON.stringify(result) }]),
    }) as DynamicToolCallResponse;
  };
}
