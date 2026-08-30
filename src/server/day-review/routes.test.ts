import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import type { LearningDayId } from "../../shared/api.js";
import { registerDayReviewRoutes } from "./routes.js";

describe("registerDayReviewRoutes", () => {
  it("binds session and turn requests to the selected programme day", async () => {
    const app = Fastify();
    const day1 = {
      readSession: vi.fn(async () => ({
        chatId: "day-review-day1-chat:1",
        threadId: "thread:day1",
        messages: [],
        unresolvedTurn: null,
      })),
      runTurn: vi.fn(async (input: { clientUserMessageId: string; message: string }) => ({
        message: "Start with one boundary.",
        chatId: "day-review-day1-chat:1",
        threadId: "thread:day1",
        turnId: "turn:day1:1",
        clientUserMessageId: input.clientUserMessageId,
        contextHash: `sha256:${"a".repeat(64)}`,
      })),
    };
    const services = new Map<LearningDayId, typeof day1>([["day1", day1]]);
    registerDayReviewRoutes(app, services);

    const session = await app.inject({ method: "GET", url: "/api/day-review/day1/session" });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({ dayId: "day1", threadId: "thread:day1" });

    const turn = await app.inject({
      method: "POST",
      url: "/api/day-review/day1/turns",
      payload: { clientUserMessageId: "day-review:1", message: "Find a gap." },
    });
    expect(turn.statusCode).toBe(200);
    expect(day1.runTurn).toHaveBeenCalledWith({ clientUserMessageId: "day-review:1", message: "Find a gap." });

    expect((await app.inject({ method: "GET", url: "/api/day-review/day9/session" })).statusCode).toBe(400);
    expect((await app.inject({
      method: "POST",
      url: "/api/day-review/day1/turns",
      payload: { clientUserMessageId: "day-review:2", message: " ", unexpected: true },
    })).statusCode).toBe(400);
    await app.close();
  });
});
