import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { StartPreparationRequest } from "../../shared/preparation.js";
import type { PreparationRunView, PreparationStateResponse } from "../../shared/preparation.js";
import { PreparationRunInProgressError } from "./service.js";

const startPreparationSchema = z.object({ fetch: z.boolean() }).strict();

export interface PreparationRouteService {
  state(): Promise<PreparationStateResponse>;
  start(fetchSources: boolean): Promise<PreparationRunView>;
}

/** Register explicit, same-origin preparation controls. GET never fetches externally. */
export function registerPreparationRoutes(
  app: FastifyInstance,
  service: PreparationRouteService,
): void {
  app.get("/api/preparation", async (_request, reply) => {
    return reply.send(await service.state());
  });

  app.post("/api/preparation/runs", async (request, reply) => {
    const input = startPreparationSchema.parse(request.body) satisfies StartPreparationRequest;
    try {
      return reply.code(201).send(await service.start(input.fetch));
    } catch (error) {
      if (error instanceof PreparationRunInProgressError) {
        return reply.code(409).send({ error: error.message, code: error.code });
      }
      throw error;
    }
  });
}
