import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import type {
  ManagerSessionView,
  ManagerTurnRequest,
  ManagerTurnResponse,
} from "../../shared/manager.js";
import { ManagerServiceError } from "./service.js";

const managerTurnSchema = z.object({
  clientUserMessageId: z.string().min(1).max(300).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  message: z.string().trim().min(1).max(32_000),
}).strict();

export interface ManagerRouteService {
  readSession(): Promise<ManagerSessionView>;
  runTurn(input: Readonly<ManagerTurnRequest>): Promise<ManagerTurnResponse>;
}

export function registerManagerRoutes(app: FastifyInstance, service: ManagerRouteService): void {
  app.get("/api/manager/session", async (_request, reply) => {
    try {
      return reply.send(await service.readSession());
    } catch (error) {
      return sendManagerError(reply, error);
    }
  });

  app.post("/api/manager/turns", async (request, reply) => {
    try {
      const input = managerTurnSchema.parse(request.body);
      return reply.send(await service.runTurn(input));
    } catch (error) {
      return sendManagerError(reply, error);
    }
  });
}

function sendManagerError(reply: FastifyReply, error: unknown) {
  if (error instanceof z.ZodError) {
    return reply.code(400).send({ error: "The manager request is invalid." });
  }
  if (error instanceof ManagerServiceError) {
    return reply.code(error.statusCode).send({ error: error.message });
  }
  return reply.code(503).send({ error: "The learning manager is temporarily unavailable." });
}
