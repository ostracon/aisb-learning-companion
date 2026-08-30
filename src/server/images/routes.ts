import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import type {
  VisualAidAssetView,
  VisualAidBrief,
  VisualAidPreviewResponse,
} from "../../shared/visual.js";
import {
  VisualAidServiceError,
  visualAidBriefSchema,
} from "./service.js";

const confirmationSchema = z.object({
  confirmationToken: z.string().min(20).max(200),
  payloadHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
}).strict();
const assetParamsSchema = z.object({
  assetId: z.string().regex(/^visual_[0-9a-f-]{36}$/),
}).strict();

export interface VisualAidRouteService {
  preview(input: Readonly<VisualAidBrief>): VisualAidPreviewResponse;
  generate(input: Readonly<{
    confirmationToken: string;
    payloadHash: string;
  }>): Promise<VisualAidAssetView>;
  list(): Promise<readonly VisualAidAssetView[]>;
  readImage(assetId: string): Promise<Readonly<{
    bytes: Buffer;
    metadata: VisualAidAssetView;
  }>>;
}

export function registerVisualAidRoutes(app: FastifyInstance, service: VisualAidRouteService): void {
  app.get("/api/visuals", async (_request, reply) => {
    try {
      return reply.send(await service.list());
    } catch (error) {
      return sendVisualError(reply, error);
    }
  });

  app.post("/api/visuals/preview", async (request, reply) => {
    try {
      const input = visualAidBriefSchema.parse(request.body);
      return reply.send(service.preview(input));
    } catch (error) {
      return sendVisualError(reply, error);
    }
  });

  app.post("/api/visuals/generate", async (request, reply) => {
    try {
      const input = confirmationSchema.parse(request.body);
      return reply.code(201).send(await service.generate(input));
    } catch (error) {
      return sendVisualError(reply, error);
    }
  });

  app.get("/api/visuals/:assetId/image", async (request, reply) => {
    try {
      const { assetId } = assetParamsSchema.parse(request.params);
      const image = await service.readImage(assetId);
      return reply
        .header("cache-control", "private, max-age=31536000, immutable")
        .header("x-content-type-options", "nosniff")
        .type(image.metadata.mimeType)
        .send(image.bytes);
    } catch (error) {
      return sendVisualError(reply, error);
    }
  });
}

function sendVisualError(
  reply: FastifyReply,
  error: unknown,
) {
  if (error instanceof z.ZodError) {
    return reply.code(400).send({ error: "The visual request is invalid." });
  }
  if (error instanceof VisualAidServiceError) {
    const status = error.code === "invalid_request"
      ? 400
      : error.code === "confirmation_expired" || error.code === "confirmation_mismatch"
        ? 409
        : error.code === "corrupt_store"
          ? 500
          : 503;
    return reply.code(status).send({ error: error.message, code: error.code });
  }
  return reply.code(500).send({ error: "The visual service failed safely." });
}
