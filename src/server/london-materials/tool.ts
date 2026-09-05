import { z } from "zod";

import type { LearningDayId } from "../../shared/api.js";
import type { DynamicToolCallResponse } from "../codex/generated/v2/DynamicToolCallResponse.js";
import type { DynamicToolSpec } from "../codex/generated/v2/DynamicToolSpec.js";
import type { LondonMaterialRetrievalService } from "./service.js";

export const LONDON_MATERIAL_TOOLSET_VERSION = "london26-material-retrieval-v1";
export const SEARCH_LONDON_MATERIALS_TOOL = "search_london26_materials";
export const READ_LONDON_MATERIAL_TOOL = "read_london26_material";

const dayIds = ["day0", "day1", "day2", "day3", "day4", "day5", "day6", "day7"] as const;

export const londonMaterialToolSpecs: readonly DynamicToolSpec[] = Object.freeze([
  Object.freeze({
    type: "function" as const,
    name: SEARCH_LONDON_MATERIALS_TOOL,
    description: [
      "Search the private, snapshotted London 2026 course files collected from cohort Slack and linked Google Drive documents.",
      "Use this for talks, slides, cohort-shared PDFs, Slack learning images, and papers announced during the programme.",
      "The day filter is fixed by the application in day/tutor review; the overall manager may select a programme day.",
      "Results contain server-authorized opaque resource IDs; never invent an ID, path, or URL.",
    ].join(" "),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", minLength: 2, maxLength: 500 },
        day_id: { type: "string", enum: [...dayIds] },
        limit: { type: "integer", minimum: 1, maximum: 12 },
      },
      required: ["query"],
    },
  }),
  Object.freeze({
    type: "function" as const,
    name: READ_LONDON_MATERIAL_TOOL,
    description: [
      "Read one bounded text or OCR chunk from a result returned by search_london26_materials.",
      "Follow nextCursor when more of the archived paper or slide deck is needed.",
      "The server accepts only an opaque resource ID and never an arbitrary path or URL.",
    ].join(" "),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        resource_id: { type: "string", pattern: "^londonres_[a-f0-9]{48}$" },
        cursor: { type: "integer", minimum: 0 },
        max_bytes: { type: "integer", minimum: 512, maximum: 16384 },
      },
      required: ["resource_id"],
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
    tool: z.literal(SEARCH_LONDON_MATERIALS_TOOL),
    arguments: z.object({
      query: z.string().min(2).max(500),
      day_id: z.enum(dayIds).optional(),
      limit: z.number().int().min(1).max(12).optional(),
    }).strict(),
  }).strict(),
  callBase.extend({
    tool: z.literal(READ_LONDON_MATERIAL_TOOL),
    arguments: z.object({
      resource_id: z.string().regex(/^londonres_[a-f0-9]{48}$/u),
      cursor: z.number().int().nonnegative().optional(),
      max_bytes: z.number().int().min(512).max(16_384).optional(),
    }).strict(),
  }).strict(),
]);

export function isLondonMaterialToolCall(params: unknown): boolean {
  if (typeof params !== "object" || params === null || !("tool" in params)) return false;
  return [SEARCH_LONDON_MATERIALS_TOOL, READ_LONDON_MATERIAL_TOOL]
    .includes(String((params as { readonly tool?: unknown }).tool));
}

export function createLondonMaterialToolHandler(
  service: LondonMaterialRetrievalService,
  dayScopeForThread: (threadId: string) => LearningDayId | null | undefined,
): (params: unknown) => Promise<DynamicToolCallResponse> {
  return async (params) => {
    const call = callSchema.parse(params);
    const fixedDay = dayScopeForThread(call.threadId);
    if (fixedDay === null) {
      return response({ status: "unavailable", detail: "No London-material scope is active for this tutor turn." }, false);
    }
    if (call.tool === SEARCH_LONDON_MATERIALS_TOOL) {
      const dayId = fixedDay ?? call.arguments.day_id;
      return response({
        dayId: dayId ?? null,
        results: await service.search({
          query: call.arguments.query,
          ...(dayId === undefined ? {} : { dayId }),
          ...(call.arguments.limit === undefined ? {} : { limit: call.arguments.limit }),
        }),
      });
    }
    return response({
      dayId: fixedDay ?? null,
      resource: await service.read({
        resourceId: call.arguments.resource_id,
        ...(fixedDay === undefined ? {} : { dayId: fixedDay }),
        ...(call.arguments.cursor === undefined ? {} : { cursor: call.arguments.cursor }),
        ...(call.arguments.max_bytes === undefined ? {} : { maxBytes: call.arguments.max_bytes }),
      }),
    });
  };
}

function response(value: unknown, success = true): DynamicToolCallResponse {
  return Object.freeze({
    success,
    contentItems: Object.freeze([{ type: "inputText" as const, text: JSON.stringify(value) }]),
  }) as DynamicToolCallResponse;
}
