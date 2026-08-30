import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import type { VisualAidBrief } from "../../shared/visual.js";
import { registerVisualAidRoutes } from "./routes.js";

const brief: VisualAidBrief = {
  title: "Boundary",
  pedagogicalPurpose: "Clarify ownership.",
  essentialRelationships: "Input, model, gate, tool.",
  factualConstraints: "The gate owns authority.",
  exclusions: "No answers.",
  altText: "A four-node flow.",
  proseEquivalent: "The gate owns authority.",
};

describe("registerVisualAidRoutes", () => {
  it("keeps preview and generation as separate explicit requests", async () => {
    const app = Fastify();
    const service = {
      preview: vi.fn(() => ({
        confirmationToken: "x".repeat(32),
        payloadHash: `sha256:${"a".repeat(64)}`,
        expiresAt: "2026-08-30T10:15:00.000Z",
        model: "gpt-image-2" as const,
        size: "1024x1024" as const,
        quality: "low" as const,
        brief,
        renderedPrompt: "prompt",
      })),
      generate: vi.fn(async () => ({
        assetId: "visual_12345678-1234-1234-1234-123456789abc",
        createdAt: "2026-08-30T10:01:00.000Z",
        model: "gpt-image-2" as const,
        size: "1024x1024" as const,
        quality: "low" as const,
        mimeType: "image/png" as const,
        byteLength: 3,
        contentHash: `sha256:${"b".repeat(64)}`,
        promptHash: `sha256:${"c".repeat(64)}`,
        brief,
        imageUrl: "/api/visuals/visual_12345678-1234-1234-1234-123456789abc/image",
      })),
      list: vi.fn(async () => []),
      readImage: vi.fn(async () => { throw new Error("unused"); }),
    };
    registerVisualAidRoutes(app, service);

    const preview = await app.inject({ method: "POST", url: "/api/visuals/preview", payload: brief });
    expect(preview.statusCode).toBe(200);
    expect(service.generate).not.toHaveBeenCalled();
    const confirmation = preview.json();

    const generated = await app.inject({
      method: "POST",
      url: "/api/visuals/generate",
      payload: {
        confirmationToken: confirmation.confirmationToken,
        payloadHash: confirmation.payloadHash,
      },
    });
    expect(generated.statusCode).toBe(201);
    expect(service.generate).toHaveBeenCalledOnce();
    await app.close();
  });

  it("serves immutable image bytes with nosniff", async () => {
    const app = Fastify();
    registerVisualAidRoutes(app, {
      preview: vi.fn() as never,
      generate: vi.fn() as never,
      list: async () => [],
      readImage: async (assetId) => ({
        bytes: Buffer.from("png"),
        metadata: {
          assetId,
          createdAt: "2026-08-30T10:01:00.000Z",
          model: "gpt-image-2",
          size: "1024x1024",
          quality: "low",
          mimeType: "image/png",
          byteLength: 3,
          contentHash: `sha256:${"b".repeat(64)}`,
          promptHash: `sha256:${"c".repeat(64)}`,
          brief,
          imageUrl: `/api/visuals/${assetId}/image`,
        },
      }),
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/visuals/visual_12345678-1234-1234-1234-123456789abc/image",
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("image/png");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["cache-control"]).toContain("immutable");
    await app.close();
  });
});
