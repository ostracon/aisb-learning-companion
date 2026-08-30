import { z } from "zod";

import type { DynamicToolSpec } from "../codex/generated/v2/DynamicToolSpec.js";
import type { DynamicToolCallResponse } from "../codex/generated/v2/DynamicToolCallResponse.js";
import { visualAidBriefSchema, type VisualAidService } from "./service.js";

export const VISUAL_TOOLSET_VERSION = "learning-visual-v1";
export const PREPARE_LEARNING_VISUAL_TOOL = "prepare_learning_visual";

export const learningVisualToolSpec: DynamicToolSpec = Object.freeze({
  type: "function" as const,
  name: PREPARE_LEARNING_VISUAL_TOOL,
  description: [
    "Prepare a structured educational-visual brief only when a spatial, mechanistic, or comparative image would materially improve learning.",
    "This does not generate an image or incur image-generation usage. The learner must review and confirm the brief on the Visuals page.",
    "Never use it to reveal an exercise answer, solution code, protected material, or facts absent from the learner-visible context.",
  ].join(" "),
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      title: { type: "string", minLength: 1, maxLength: 160 },
      pedagogicalPurpose: { type: "string", minLength: 1, maxLength: 1200 },
      essentialRelationships: { type: "string", minLength: 1, maxLength: 2400 },
      factualConstraints: { type: "string", minLength: 1, maxLength: 2400 },
      exclusions: { type: "string", minLength: 1, maxLength: 1600 },
      altText: { type: "string", minLength: 1, maxLength: 800 },
      proseEquivalent: { type: "string", minLength: 1, maxLength: 2400 },
    },
    required: [
      "title",
      "pedagogicalPurpose",
      "essentialRelationships",
      "factualConstraints",
      "exclusions",
      "altText",
      "proseEquivalent",
    ],
  },
});

const callSchema = z.object({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  callId: z.string().min(1),
  namespace: z.null(),
  tool: z.literal(PREPARE_LEARNING_VISUAL_TOOL),
  arguments: visualAidBriefSchema,
}).strict();

export function createLearningVisualToolHandler(
  service: Pick<VisualAidService, "preview">,
): (params: unknown) => Promise<DynamicToolCallResponse> {
  return async (params) => {
    const call = callSchema.parse(params);
    const preview = service.preview(call.arguments, "assistant");
    return Object.freeze({
      success: true,
      contentItems: Object.freeze([{
        type: "inputText" as const,
        text: JSON.stringify({
          status: "brief_prepared",
          title: preview.brief.title,
          reviewUrl: "/visuals",
          expiresAt: preview.expiresAt,
          message: "The learner must review the exact prompt and explicitly confirm generation on the Visuals page.",
        }),
      }]),
    }) as DynamicToolCallResponse;
  };
}
