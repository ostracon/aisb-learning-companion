import { describe, expect, it, vi } from "vitest";

import type { VisualAidPreviewResponse } from "../../shared/visual.js";
import {
  createLearningVisualToolHandler,
  learningVisualToolSpec,
  PREPARE_LEARNING_VISUAL_TOOL,
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
    const service = { preview: vi.fn(() => preview) };
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
    expect(learningVisualToolSpec).toMatchObject({
      type: "function",
      name: PREPARE_LEARNING_VISUAL_TOOL,
    });
  });
});
