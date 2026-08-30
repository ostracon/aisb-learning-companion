import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import type { PreparationRunView, PreparationStateResponse } from "../../shared/preparation.js";
import { registerPreparationRoutes } from "./routes.js";
import { PreparationRunInProgressError } from "./service.js";

const state: PreparationStateResponse = {
  latestRun: null,
  externalNetworkIsUserStartedOnly: true,
  enrichment: "disabled",
  transcription: "public-captions-only-not-enabled",
};

const run: PreparationRunView = {
  schemaVersion: 1,
  runId: "prep_route",
  startedAt: "2026-08-30T10:00:00.000Z",
  completedAt: "2026-08-30T10:00:00.000Z",
  status: "complete",
  inventoryTruncated: false,
  discoveredCount: 0,
  cachedCount: 0,
  failedCount: 0,
  totalCachedBytes: 0,
  limits: {
    maxInventorySources: 256,
    maxSources: 24,
    maxSourceBytes: 2_097_152,
    maxTotalBytes: 12_582_912,
    maxRedirects: 3,
    requestTimeoutMs: 15_000,
  },
  sources: [],
};

describe("preparation routes", () => {
  it("keeps GET local and starts fetching only through the explicit POST", async () => {
    const app = Fastify({ logger: false });
    const service = {
      state: vi.fn(async () => state),
      start: vi.fn(async () => run),
    };
    registerPreparationRoutes(app, service);

    const read = await app.inject({ method: "GET", url: "/api/preparation" });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual(state);
    expect(service.start).not.toHaveBeenCalled();

    const started = await app.inject({
      method: "POST",
      url: "/api/preparation/runs",
      payload: { fetch: true },
    });
    expect(started.statusCode).toBe(201);
    expect(started.json()).toEqual(run);
    expect(service.start).toHaveBeenCalledExactlyOnceWith(true);

    await app.close();
  });

  it("reports concurrent run admission as a conflict", async () => {
    const app = Fastify({ logger: false });
    registerPreparationRoutes(app, {
      async state() { return state; },
      async start() { throw new PreparationRunInProgressError(); },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/preparation/runs",
      payload: { fetch: false },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: "A preparation run is already in progress.",
      code: "preparation_in_progress",
    });
    await app.close();
  });
});
