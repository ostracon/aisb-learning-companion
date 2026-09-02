import { z } from "zod";

import type { DynamicToolCallResponse } from "../codex/generated/v2/DynamicToolCallResponse.js";
import type { DynamicToolSpec } from "../codex/generated/v2/DynamicToolSpec.js";
import type { PreparedReferenceRetrievalService } from "./retrieval-service.js";

export const SEARCH_PREPARED_REFERENCES_TOOL = "search_prepared_references";
export const READ_PREPARED_REFERENCE_TOOL = "read_prepared_reference";

export const preparedReferenceToolSpecs: readonly DynamicToolSpec[] = Object.freeze([
  Object.freeze({
    type: "function" as const,
    name: SEARCH_PREPARED_REFERENCES_TOOL,
    description: [
      "Search the complete cached text projections of public HTML and PDF references linked from the current section.",
      "Use this whenever the learner asks about a paper, source, implementation, experiment, or claim that is not fully present in the short page-context excerpt.",
      "Prefer a PDF result with indexed pages when the learner asks for the full paper and both an abstract page and PDF are available.",
      "Results contain server-authorized source IDs and cursors for jumping to matching passages; never invent an ID, path, or URL.",
    ].join(" "),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", minLength: 2, maxLength: 500 },
        limit: { type: "integer", minimum: 1, maximum: 12 },
      },
      required: ["query"],
    },
  }),
  Object.freeze({
    type: "function" as const,
    name: READ_PREPARED_REFERENCE_TOOL,
    description: [
      "Read one bounded chunk of a cached HTML/PDF text projection selected by search_prepared_references.",
      "Follow nextCursor to inspect the relevant methods, results, or later pages instead of treating an opening excerpt as the whole source.",
      "The server re-authorizes every source against the current section and does not accept paths or URLs.",
    ].join(" "),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        source_id: { type: "string", pattern: "^source_[a-f0-9]{64}$" },
        cursor: { type: "integer", minimum: 0 },
        max_bytes: { type: "integer", minimum: 512, maximum: 16384 },
      },
      required: ["source_id"],
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
    tool: z.literal(SEARCH_PREPARED_REFERENCES_TOOL),
    arguments: z.object({
      query: z.string().min(2).max(500),
      limit: z.number().int().min(1).max(12).optional(),
    }).strict(),
  }).strict(),
  callBase.extend({
    tool: z.literal(READ_PREPARED_REFERENCE_TOOL),
    arguments: z.object({
      source_id: z.string().regex(/^source_[a-f0-9]{64}$/u),
      cursor: z.number().int().nonnegative().optional(),
      max_bytes: z.number().int().min(512).max(16_384).optional(),
    }).strict(),
  }).strict(),
]);

export function isPreparedReferenceToolCall(params: unknown): boolean {
  if (typeof params !== "object" || params === null || !("tool" in params)) return false;
  return [SEARCH_PREPARED_REFERENCES_TOOL, READ_PREPARED_REFERENCE_TOOL]
    .includes(String((params as { readonly tool?: unknown }).tool));
}

export function createPreparedReferenceToolHandler(
  service: PreparedReferenceRetrievalService,
  sectionScopeForThread: (threadId: string) => readonly string[] | null,
): (params: unknown) => Promise<DynamicToolCallResponse> {
  return async (params) => {
    const call = callSchema.parse(params);
    const sectionIds = sectionScopeForThread(call.threadId);
    if (sectionIds === null || sectionIds.length === 0) {
      return response({
        status: "unavailable",
        detail: "No prepared-reference scope is active for this tutor turn.",
      }, false);
    }
    if (call.tool === SEARCH_PREPARED_REFERENCES_TOOL) {
      return response({
        sectionIds,
        results: await service.search({
          sectionIds,
          query: call.arguments.query,
          ...(call.arguments.limit === undefined ? {} : { limit: call.arguments.limit }),
        }),
      });
    }
    return response({
      sectionIds,
      resource: await service.read({
        sectionIds,
        sourceId: call.arguments.source_id,
        ...(call.arguments.cursor === undefined ? {} : { cursor: call.arguments.cursor }),
        ...(call.arguments.max_bytes === undefined ? {} : { maxBytes: call.arguments.max_bytes }),
      }),
    });
  };
}

function response(value: unknown, success = true): DynamicToolCallResponse {
  return Object.freeze({
    success,
    contentItems: Object.freeze([{
      type: "inputText" as const,
      text: JSON.stringify(value),
    }]),
  }) as DynamicToolCallResponse;
}
