import { describe, expect, it, vi } from "vitest";

import type { LondonMaterialRetrievalService } from "./service.js";
import {
  createLondonMaterialToolHandler,
  READ_LONDON_MATERIAL_TOOL,
  SEARCH_LONDON_MATERIALS_TOOL,
} from "./tool.js";

const base = {
  threadId: "thread-1",
  turnId: "turn-1",
  callId: "call-1",
  namespace: null,
};

describe("London material tools", () => {
  it("keeps tutor and day-review searches fixed to the server-bound day", async () => {
    const search = vi.fn().mockResolvedValue([]);
    const handler = createLondonMaterialToolHandler(
      { search } as unknown as LondonMaterialRetrievalService,
      () => "day4",
    );
    await handler({
      ...base,
      tool: SEARCH_LONDON_MATERIALS_TOOL,
      arguments: { query: "ROME", day_id: "day1" },
    });
    expect(search).toHaveBeenCalledWith({ query: "ROME", dayId: "day4" });
  });

  it("allows the overall manager to select a day without accepting paths", async () => {
    const search = vi.fn().mockResolvedValue([]);
    const handler = createLondonMaterialToolHandler(
      { search } as unknown as LondonMaterialRetrievalService,
      () => undefined,
    );
    await handler({
      ...base,
      tool: SEARCH_LONDON_MATERIALS_TOOL,
      arguments: { query: "watermark", day_id: "day6", limit: 3 },
    });
    expect(search).toHaveBeenCalledWith({ query: "watermark", dayId: "day6", limit: 3 });
    await expect(handler({
      ...base,
      tool: READ_LONDON_MATERIAL_TOOL,
      arguments: { resource_id: "../../private/key" },
    })).rejects.toThrow();
  });

  it("fails closed when a tutor turn has no active scope", async () => {
    const handler = createLondonMaterialToolHandler(
      {} as LondonMaterialRetrievalService,
      () => null,
    );
    const response = await handler({
      ...base,
      tool: SEARCH_LONDON_MATERIALS_TOOL,
      arguments: { query: "slides" },
    });
    expect(response.success).toBe(false);
  });
});
