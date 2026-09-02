import { describe, expect, it } from "vitest";

import type {
  DayPreparedReferenceSource,
  PreparedReferenceInventoryItem,
  PreparedReferenceProjection,
} from "../manager/prepared-context-source.js";
import { PreparedReferenceRetrievalService } from "./retrieval-service.js";
import {
  createPreparedReferenceToolHandler,
  READ_PREPARED_REFERENCE_TOOL,
  SEARCH_PREPARED_REFERENCES_TOOL,
} from "./tool.js";

const SOURCE_ID = `source_${"a".repeat(64)}`;
const OTHER_SOURCE_ID = `source_${"b".repeat(64)}`;
const LATE_METHOD_TEXT = "The authors use gradient matching over poisoned instruction examples.";
const PROJECTION_TEXT = `${"opening excerpt filler. ".repeat(500)}\n\n## Page 8\n\n${LATE_METHOD_TEXT}\n\n## Page 9\n\nResults.`;

function inventoryItem(sourceId = SOURCE_ID): PreparedReferenceInventoryItem {
  return Object.freeze({
    sourceId,
    title: sourceId === SOURCE_ID
      ? "Poisoning Language Models During Instruction Tuning"
      : "Unrelated paper",
    requestedUrl: "https://arxiv.org/pdf/2305.00944",
    finalUrl: "https://arxiv.org/pdf/2305.00944",
    status: "cached",
    mediaType: "pdf",
    sourceContentHash: `sha256:${"c".repeat(64)}`,
    projectionContentHash: `sha256:${"d".repeat(64)}`,
    projectionStatus: "complete",
    pageCount: 13,
    detail: "Cached immutable PDF bytes and indexed 13 pages of deterministic text.",
    sectionIds: Object.freeze(["2.1"]),
  });
}

function projection(sourceId = SOURCE_ID): PreparedReferenceProjection {
  return Object.freeze({
    sourceId,
    title: inventoryItem(sourceId).title,
    requestedUrl: "https://arxiv.org/pdf/2305.00944",
    finalUrl: "https://arxiv.org/pdf/2305.00944",
    sourceContentHash: `sha256:${"c".repeat(64)}`,
    projectionContentHash: `sha256:${"d".repeat(64)}`,
    mediaType: "pdf",
    pageCount: 13,
    markdown: PROJECTION_TEXT,
    sectionIds: Object.freeze(["2.1"]),
  });
}

function fakeSource(): DayPreparedReferenceSource {
  return {
    async listForSections(sectionIds) {
      return sectionIds.includes("2.1")
        ? Object.freeze([inventoryItem(), inventoryItem(OTHER_SOURCE_ID)])
        : Object.freeze([]);
    },
    async readProjectionForSections(sourceId, sectionIds) {
      return sectionIds.includes("2.1") && [SOURCE_ID, OTHER_SOURCE_ID].includes(sourceId)
        ? projection(sourceId)
        : null;
    },
  };
}

describe("PreparedReferenceRetrievalService", () => {
  it("searches beyond the short frozen-context excerpt and preserves PDF provenance", async () => {
    const service = new PreparedReferenceRetrievalService(fakeSource());
    const results = await service.search({
      sectionIds: ["2.1"],
      query: "gradient matching poisoned instruction",
    });

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      sourceId: SOURCE_ID,
      status: "ready",
      mediaType: "pdf",
      pageCount: 13,
    });
    expect(results[0]?.excerpt).toContain(LATE_METHOD_TEXT);
    expect(results[0]?.cursor).toBeGreaterThan(6 * 1024);
    expect(results[0]?.citation).toContain("https://arxiv.org/pdf/2305.00944");
    expect(results[0]?.citation).toContain("13 pages");
  });

  it("reads bounded chunks and re-authorizes each source against the section", async () => {
    const service = new PreparedReferenceRetrievalService(fakeSource());
    const first = await service.read({
      sectionIds: ["2.1"],
      sourceId: SOURCE_ID,
      cursor: PROJECTION_TEXT.indexOf("## Page 8"),
      maxBytes: 512,
    });
    expect(first?.text).toContain("## Page 8");
    expect(first?.text).toContain(LATE_METHOD_TEXT);
    expect(first?.provenance).toMatchObject({ pageCount: 13, sectionIds: ["2.1"] });

    await expect(service.read({
      sectionIds: ["1.4"],
      sourceId: SOURCE_ID,
    })).resolves.toBeNull();
    await expect(service.read({
      sectionIds: ["2.1"],
      sourceId: "/private/tmp/paper.pdf",
    })).rejects.toThrow("Prepared reference ID is invalid");
  });
});

describe("prepared-reference tutor tools", () => {
  it("binds calls to the active native thread's server-resolved section scope", async () => {
    const service = new PreparedReferenceRetrievalService(fakeSource());
    const handler = createPreparedReferenceToolHandler(
      service,
      (threadId) => threadId === "thread-active" ? ["2.1"] : null,
    );
    const search = await handler({
      threadId: "thread-active",
      turnId: "turn-1",
      callId: "call-1",
      namespace: null,
      tool: SEARCH_PREPARED_REFERENCES_TOOL,
      arguments: { query: "gradient matching" },
    });
    expect(search.success).toBe(true);
    expect(search.contentItems[0]).toMatchObject({ type: "inputText" });
    const searchPayload = JSON.parse(
      (search.contentItems[0] as { readonly text: string }).text,
    ) as { readonly sectionIds: readonly string[]; readonly results: readonly { readonly sourceId: string }[] };
    expect(searchPayload.sectionIds).toEqual(["2.1"]);
    expect(searchPayload.results[0]?.sourceId).toBe(SOURCE_ID);

    const unavailable = await handler({
      threadId: "thread-other",
      turnId: "turn-2",
      callId: "call-2",
      namespace: null,
      tool: READ_PREPARED_REFERENCE_TOOL,
      arguments: { source_id: SOURCE_ID },
    });
    expect(unavailable.success).toBe(false);
    expect(JSON.parse((unavailable.contentItems[0] as { readonly text: string }).text))
      .toMatchObject({ status: "unavailable" });
  });
});
