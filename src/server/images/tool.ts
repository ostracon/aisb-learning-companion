import { z } from "zod";

import type { DynamicToolSpec } from "../codex/generated/v2/DynamicToolSpec.js";
import type { DynamicToolCallResponse } from "../codex/generated/v2/DynamicToolCallResponse.js";
import { visualAidBriefSchema, type VisualAidService } from "./service.js";

export const VISUAL_TOOLSET_VERSION = "learning-visual-v2";
export const PREPARE_LEARNING_VISUAL_TOOL = "prepare_learning_visual";
export const GENERATE_LEARNING_VISUAL_TOOL = "generate_learning_visual";

const visualInputSchema = {
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
};

export const prepareLearningVisualToolSpec: DynamicToolSpec = Object.freeze({
  type: "function" as const,
  name: PREPARE_LEARNING_VISUAL_TOOL,
  description: [
    "Prepare a structured educational-visual brief only when a spatial, mechanistic, or comparative image would materially improve learning.",
    "This does not generate an image or incur image-generation usage. The learner must review and confirm the brief on the Visuals page.",
    "Never use it to reveal an exercise answer, solution code, protected material, or facts absent from the learner-visible context.",
  ].join(" "),
  inputSchema: visualInputSchema,
});

export const generateLearningVisualToolSpec: DynamicToolSpec = Object.freeze({
  type: "function" as const,
  name: GENERATE_LEARNING_VISUAL_TOOL,
  description: [
    "Generate and save one educational image immediately when the learner explicitly asks to create, make, draw, or generate an image or visual.",
    "The learner's explicit request authorises one image-generation call; do not ask them to repeat confirmation on another page.",
    "Use only learner-visible context and never reveal an exercise answer, solution code, protected material, or unsupported facts.",
    "After success, include the returned markdown image verbatim in the assistant reply so the saved image appears in chat.",
  ].join(" "),
  inputSchema: visualInputSchema,
});

export const learningVisualToolSpecs = Object.freeze([
  prepareLearningVisualToolSpec,
  generateLearningVisualToolSpec,
]);

const callSchema = z.object({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  callId: z.string().min(1),
  namespace: z.null(),
  tool: z.enum([PREPARE_LEARNING_VISUAL_TOOL, GENERATE_LEARNING_VISUAL_TOOL]),
  arguments: visualAidBriefSchema,
}).strict();

export function isLearningVisualToolCall(params: unknown): boolean {
  const tool = typeof params === "object" && params !== null && "tool" in params
    ? String((params as { readonly tool?: unknown }).tool)
    : null;
  return typeof params === "object"
    && params !== null
    && (tool === PREPARE_LEARNING_VISUAL_TOOL || tool === GENERATE_LEARNING_VISUAL_TOOL);
}

export function createLearningVisualToolHandler(
  service: Pick<VisualAidService, "preview" | "generate">,
): (params: unknown) => Promise<DynamicToolCallResponse> {
  return async (params) => {
    const call = callSchema.parse(params);
    const preview = service.preview(call.arguments, "assistant");
    if (call.tool === GENERATE_LEARNING_VISUAL_TOOL) {
      const asset = await service.generate({
        confirmationToken: preview.confirmationToken,
        payloadHash: preview.payloadHash,
      });
      const markdown = `![${markdownAlt(asset.brief.altText)}](${asset.imageUrl})`;
      return Object.freeze({
        success: true,
        contentItems: Object.freeze([{
          type: "inputText" as const,
          text: JSON.stringify({
            status: "visual_generated",
            title: asset.brief.title,
            imageUrl: asset.imageUrl,
            altText: asset.brief.altText,
            proseEquivalent: asset.brief.proseEquivalent,
            markdown,
            message: "Include the markdown field verbatim in the learner-facing reply so the generated visual is shown inline.",
          }),
        }]),
      }) as DynamicToolCallResponse;
    }
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

function markdownAlt(value: string): string {
  return value.replace(/[\\\[\]]/gu, " ").replace(/\s+/gu, " ").trim();
}
