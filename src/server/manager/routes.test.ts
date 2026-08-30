import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import { registerManagerRoutes } from "./routes.js";

describe("registerManagerRoutes", () => {
  it("loads durable history and validates a manager turn", async () => {
    const app = Fastify();
    const service = {
      readSession: vi.fn(async () => ({
        chatId: null,
        threadId: null,
        messages: [],
        unresolvedTurn: null,
      })),
      runTurn: vi.fn(async (input: { clientUserMessageId: string; message: string }) => ({
        message: "Review one outcome.",
        chatId: "manager-chat:1",
        threadId: "thread:1",
        turnId: "turn:1",
        clientUserMessageId: input.clientUserMessageId,
        contextHash: `sha256:${"a".repeat(64)}`,
      })),
    };
    registerManagerRoutes(app, service);

    expect((await app.inject({ method: "GET", url: "/api/manager/session" })).statusCode).toBe(200);
    const response = await app.inject({
      method: "POST",
      url: "/api/manager/turns",
      payload: { clientUserMessageId: "message:1", message: "What next?" },
    });
    expect(response.statusCode).toBe(200);
    expect(service.runTurn).toHaveBeenCalledWith({ clientUserMessageId: "message:1", message: "What next?" });

    const invalid = await app.inject({
      method: "POST",
      url: "/api/manager/turns",
      payload: { clientUserMessageId: "message:2", message: "   " },
    });
    expect(invalid.statusCode).toBe(400);
    await app.close();
  });
});
