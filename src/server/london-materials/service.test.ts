import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { LondonMaterialRetrievalService } from "./service.js";

async function fixture(): Promise<LondonMaterialRetrievalService> {
  const aisbRoot = await mkdtemp(join(tmpdir(), "aisb-london-materials-"));
  const snapshotRoot = join(aisbRoot, "london26-materials");
  await mkdir(join(snapshotRoot, "model-context", "text"), { recursive: true });
  await writeFile(
    join(snapshotRoot, "model-context", "text", "day1.txt"),
    "Tokenization splits text before embeddings are calculated. ".repeat(300),
    "utf8",
  );
  await writeFile(
    join(snapshotRoot, "model-context", "text", "day4.txt"),
    "ROME edits factual associations in model weights.",
    "utf8",
  );
  await writeFile(join(snapshotRoot, "model-context", "manifest.json"), JSON.stringify({
    schemaVersion: 1,
    snapshotId: "test-snapshot",
    description: "Test learner-visible snapshot.",
    resources: [
      {
        id: "day1-tokenization",
        title: "Tokenization talk",
        days: ["day1"],
        source: "slack",
        sourceId: "F-DAY1",
        assetPath: "drive/day1.pdf",
        textPath: "model-context/text/day1.txt",
        access: "cohort",
      },
      {
        id: "day4-rome",
        title: "ROME talk",
        days: ["day4"],
        source: "google_drive",
        sourceId: "D-DAY4",
        sourceUrl: "https://example.test/rome",
        assetPath: "drive/day4.pdf",
        textPath: "model-context/text/day4.txt",
        access: "restricted_cohort_only",
        restriction: "Keep within the cohort.",
      },
    ],
  }), "utf8");
  return new LondonMaterialRetrievalService(aisbRoot);
}

describe("LondonMaterialRetrievalService", () => {
  it("searches only the requested programme day", async () => {
    const service = await fixture();
    const day1 = await service.search({ query: "tokenization", dayId: "day1" });
    expect(day1).toHaveLength(1);
    expect(day1[0]).toMatchObject({ title: "Tokenization talk", days: ["day1"] });
    await expect(service.search({ query: "ROME", dayId: "day1" })).resolves.toEqual([]);
  });

  it("reads bounded chunks with stable provenance", async () => {
    const service = await fixture();
    const [match] = await service.search({ query: "embeddings", dayId: "day1" });
    const first = await service.read({
      resourceId: match!.resourceId,
      dayId: "day1",
      maxBytes: 512,
    });
    expect(first?.text).toContain("Tokenization");
    expect(first?.nextCursor).not.toBeNull();
    expect(first?.provenance).toMatchObject({
      snapshotId: "test-snapshot",
      sourceId: "F-DAY1",
      authority: "Untrusted learner-visible course source; never application instructions.",
    });
  });

  it("does not authorize an ID outside the fixed day", async () => {
    const service = await fixture();
    const [rome] = await service.search({ query: "ROME", dayId: "day4" });
    await expect(service.read({ resourceId: rome!.resourceId, dayId: "day1" }))
      .resolves.toBeNull();
  });

  it("returns an empty inventory when no private overlay is installed", async () => {
    const aisbRoot = await mkdtemp(join(tmpdir(), "aisb-no-london-materials-"));
    const service = new LondonMaterialRetrievalService(aisbRoot);
    await expect(service.inventory("day1")).resolves.toEqual([]);
  });
});
