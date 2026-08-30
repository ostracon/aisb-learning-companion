import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import type { LearningDayId } from "../../shared/api.js";
import type { ManagerSessionView, ManagerTurnRequest, ManagerTurnResponse } from "../../shared/manager.js";
import { ManagerServiceError } from "../manager/service.js";

const dayIdSchema = z.enum(["day0", "day1", "day2", "day3", "day4", "day5", "day6", "day7"]);
const turnSchema = z.object({
  clientUserMessageId: z.string().min(1).max(300).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  message: z.string().trim().min(1).max(32_000),
}).strict();

export interface DayReviewRouteService {
  readSession(): Promise<ManagerSessionView>;
  runTurn(input: Readonly<ManagerTurnRequest>): Promise<ManagerTurnResponse>;
}

export function registerDayReviewRoutes(
  app: FastifyInstance,
  services: ReadonlyMap<LearningDayId, DayReviewRouteService>,
): void {
  app.get("/api/day-review/:dayId/session", async (request, reply) => {
    try {
      const dayId = parseDayId(request.params);
      return reply.send({ ...(await services.get(dayId)!.readSession()), dayId });
    } catch (error) {
      return sendDayReviewError(reply, error);
    }
  });

  app.post("/api/day-review/:dayId/turns", async (request, reply) => {
    try {
      const dayId = parseDayId(request.params);
      const input = turnSchema.parse(request.body);
      return reply.send(await services.get(dayId)!.runTurn(input));
    } catch (error) {
      return sendDayReviewError(reply, error);
    }
  });
}

function parseDayId(params: unknown): LearningDayId {
  const parsed = z.object({ dayId: dayIdSchema }).strict().parse(params);
  return parsed.dayId;
}

function sendDayReviewError(reply: FastifyReply, error: unknown) {
  if (error instanceof z.ZodError) {
    return reply.code(400).send({ error: "The day review request is invalid." });
  }
  if (error instanceof ManagerServiceError) {
    return reply.code(error.statusCode).send({ error: error.message });
  }
  return reply.code(503).send({ error: "The day review is temporarily unavailable." });
}

