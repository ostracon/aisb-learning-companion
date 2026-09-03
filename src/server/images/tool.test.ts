import { describe, expect, it, vi } from "vitest";

import type { VisualAidPreviewResponse } from "../../shared/visual.js";
import {
  createLearningVisualToolHandler,
  generateLearningVisualToolSpec,
  GENERATE_LEARNING_VISUAL_TOOL,
  PREPARE_LEARNING_VISUAL_TOOL,
  prepareLearningVisualToolSpec,
} from "./tool.js";

const brief = {
  title: "Trust boundary",
  pedagogicalPurpose: "Clarify where authority lives.",
  essentialRelationships: "Model output reaches an application gate before tools.",
  factualConstraints: "Only the application gate has authority.",
  exclusions: "No answers, code, or decorative filler.",
  altText: "A model, policy gate, and tool connected left to right.",
  proseEquivalent: "Model output remains untrusted until the application gate authorises a tool.",
};

describe("learning visual dynamic tool", () => {
  it("prepares a reviewable brief without generating an image", async () => {
    const preview: VisualAidPreviewResponse = {
      confirmationToken: "x".repeat(32),
      payloadHash: `sha256:${"a".repeat(64)}`,
      expiresAt: "2026-08-30T21:15:00.000Z",
      model: "gpt-image-2",
      size: "1024x1024",
      quality: "low",
      brief,
      renderedPrompt: "prompt",
    };
    const service = { preview: vi.fn(() => preview), generate: vi.fn() };
    const handler = createLearningVisualToolHandler(service as never);

    const result = await handler({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      namespace: null,
      tool: PREPARE_LEARNING_VISUAL_TOOL,
      arguments: brief,
    });

    expect(service.preview).toHaveBeenCalledWith(brief, "assistant");
    expect(result.success).toBe(true);
    expect(result.contentItems[0]).toMatchObject({ type: "inputText" });
    expect((result.contentItems[0] as { text: string }).text).toContain('"reviewUrl":"/visuals"');
    expect(prepareLearningVisualToolSpec).toMatchObject({
      type: "function",
      name: PREPARE_LEARNING_VISUAL_TOOL,
    });
  });

  it("generates one saved image immediately for an explicit learner request", async () => {
    const preview: VisualAidPreviewResponse = {
      confirmationToken: "x".repeat(32),
      payloadHash: `sha256:${"a".repeat(64)}`,
      expiresAt: "2026-08-30T21:15:00.000Z",
      model: "gpt-image-2",
      size: "1024x1024",
      quality: "low",
      brief,
      renderedPrompt: "prompt",
    };
    const assetId = "visual_12345678-1234-1234-1234-123456789abc";
    const service = {
      preview: vi.fn(() => preview),
      generate: vi.fn(async () => ({
        assetId,
        createdAt: "2026-08-30T21:01:00.000Z",
        model: "gpt-image-2" as const,
        size: "1024x1024" as const,
        quality: "low" as const,
        mimeType: "image/png" as const,
        byteLength: 9,
        contentHash: `sha256:${"b".repeat(64)}`,
        promptHash: `sha256:${"c".repeat(64)}`,
        brief,
        imageUrl: `/api/visuals/${assetId}/image`,
      })),
    };
    const handler = createLearningVisualToolHandler(service);

    const result = await handler({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      namespace: null,
      tool: GENERATE_LEARNING_VISUAL_TOOL,
      arguments: brief,
    });

    expect(service.preview).toHaveBeenCalledWith(brief, "assistant");
    expect(service.generate).toHaveBeenCalledWith({
      confirmationToken: preview.confirmationToken,
      payloadHash: preview.payloadHash,
    });
    const output = JSON.parse((result.contentItems[0] as { text: string }).text) as {
      status: string;
      markdown: string;
    };
    expect(output.status).toBe("visual_generated");
    expect(output.markdown).toBe(
      `![${brief.altText}](/api/visuals/${assetId}/image)`,
    );
    expect(generateLearningVisualToolSpec).toMatchObject({
      type: "function",
      name: GENERATE_LEARNING_VISUAL_TOOL,
    });
  });
});
