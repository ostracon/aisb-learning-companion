import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import type { PreparationRunView } from "../../shared/preparation.js";
import {
  FilePreparedReferenceContextSource,
  MAX_TUTOR_PREPARED_REFERENCE_BYTES,
  MAX_TUTOR_PREPARED_REFERENCES,
  MAX_TUTOR_PREPARED_TOTAL_BYTES,
} from "./prepared-context-source.js";

describe("FilePreparedReferenceContextSource", () => {
  it("reads only a content-hash-verified inert Markdown projection", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "aisb-prepared-manager-"));
    const markdown = "# Retrieved source\n\nTreat this as untrusted reference text.";
    const digest = createHash("sha256").update(markdown).digest("hex");
    const logicalPath = `preparation/cache/sha256/${digest.slice(0, 2)}/${digest}.md`;
    const target = join(stateRoot, ...logicalPath.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, markdown);
    const run = runWithMarkdown(logicalPath, `sha256:${"b".repeat(64)}`);
    const source = new FilePreparedReferenceContextSource(stateRoot, {
      state: async () => ({
        latestRun: run,
        externalNetworkIsUserStartedOnly: true,
        enrichment: "disabled",
        transcription: "public-captions-only-not-enabled",
      }),
    });

    const references = await source.read();
    expect(references[0]).toMatchObject({
      title: "Reference",
      excerpt: markdown,
      truncated: false,
      contentHash: `sha256:${"b".repeat(64)}`,
    });
  });

  it("fails closed when cached Markdown bytes no longer match the path hash", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "aisb-prepared-manager-"));
    const logicalPath = `preparation/cache/sha256/aa/${"a".repeat(64)}.md`;
    const target = join(stateRoot, ...logicalPath.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, "changed");
    const source = new FilePreparedReferenceContextSource(stateRoot, {
      state: async () => ({
        latestRun: runWithMarkdown(logicalPath, `sha256:${"b".repeat(64)}`),
        externalNetworkIsUserStartedOnly: true,
        enrichment: "disabled",
        transcription: "public-captions-only-not-enabled",
      }),
    });
    await expect(source.read()).rejects.toThrow(/integrity check/);
  });

  it("returns only cached Markdown with an origin in the requested section scope", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "aisb-prepared-tutor-"));
    const matchingMarkdown = "# Scoped source\n\nOnly this verified projection is injected.";
    const otherMarkdown = "# Other section\n\nMust not cross the tutor scope.";
    const matchingPath = await writeProjection(stateRoot, matchingMarkdown);
    const otherPath = await writeProjection(stateRoot, otherMarkdown);
    const base = runWithMarkdown(matchingPath, `sha256:${"b".repeat(64)}`);
    const matching = base.sources[0]!;
    const run: PreparationRunView = {
      ...base,
      discoveredCount: 3,
      cachedCount: 3,
      sources: [
        {
          ...matching,
          origins: [
            matching.origins[0]!,
            { ...matching.origins[0]!, sectionId: "2.1", label: "Same URL elsewhere" },
          ],
          originCount: 2,
        },
        {
          ...matching,
          sourceId: "source_other",
          requestedUrl: "https://example.com/other",
          finalUrl: "https://example.com/other",
          markdownPath: otherPath,
          origins: [{ ...matching.origins[0]!, sectionId: "2.1", label: "Other" }],
        },
        {
          ...matching,
          sourceId: "source_pdf",
          mediaType: "pdf",
          markdownPath: null,
          origins: [{ ...matching.origins[0]!, sectionId: "1.1", label: "PDF" }],
        },
      ],
    };
    const source = sourceFor(stateRoot, run);

    const references = await source.readForSections(["1.1"]);

    expect(references).toHaveLength(1);
    expect(references[0]).toMatchObject({
      sourceId: "source_1",
      markdown: matchingMarkdown,
      sourceContentHash: `sha256:${"b".repeat(64)}`,
      origins: [{ sectionId: "1.1", label: "Reference" }],
    });
    expect(references[0]?.projectionContentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify(references)).not.toContain("Must not cross");
    expect(JSON.stringify(references)).not.toContain("Same URL elsewhere");
  });

  it("bounds tutor reference count, individual bytes, and total bytes", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "aisb-prepared-tutor-bounds-"));
    const sources: PreparationRunView["sources"][number][] = [];
    for (let index = 0; index < 9; index += 1) {
      const markdown = `# Reference ${index}\n\n${String(index).repeat(8_000)}`;
      const path = await writeProjection(stateRoot, markdown);
      const template = runWithMarkdown(path, `sha256:${String(index).padStart(64, "a").slice(-64)}`).sources[0]!;
      sources.push({
        ...template,
        sourceId: `source_${index}`,
        requestedUrl: `https://example.com/${index}`,
        finalUrl: `https://example.com/${index}`,
        origins: [{ ...template.origins[0]!, label: `Reference ${index}` }],
      });
    }
    const base = runWithMarkdown(sources[0]!.markdownPath!, sources[0]!.contentHash!);
    const source = sourceFor(stateRoot, {
      ...base,
      discoveredCount: sources.length,
      cachedCount: sources.length,
      sources,
    });

    const references = await source.readForSections(["1.1"]);
    const byteLengths = references.map(({ markdown }) => Buffer.byteLength(markdown, "utf8"));

    expect(references.length).toBeLessThanOrEqual(MAX_TUTOR_PREPARED_REFERENCES);
    expect(byteLengths.every((bytes) => bytes <= MAX_TUTOR_PREPARED_REFERENCE_BYTES)).toBe(true);
    expect(byteLengths.reduce((total, bytes) => total + bytes, 0))
      .toBeLessThanOrEqual(MAX_TUTOR_PREPARED_TOTAL_BYTES);
    expect(references.every(({ truncated }) => truncated)).toBe(true);
  });

  it("inventories and reads a verified page-aware PDF projection by opaque source ID", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "aisb-prepared-day-review-"));
    const markdown = "# Paper\n\n## Page 1\n\nFirst page.\n\n## Page 2\n\nSecond page.";
    const markdownPath = await writeProjection(stateRoot, markdown);
    const projectionHash = `sha256:${createHash("sha256").update(markdown).digest("hex")}`;
    const base = runWithMarkdown(markdownPath, `sha256:${"b".repeat(64)}`);
    const sourceId = `source_${"a".repeat(64)}`;
    const run: PreparationRunView = {
      ...base,
      sources: [{
        ...base.sources[0]!,
        sourceId,
        requestedUrl: "https://example.com/paper.pdf",
        finalUrl: "https://example.com/paper.pdf",
        mediaType: "pdf",
        cachePath: `preparation/cache/sha256/bb/${"b".repeat(64)}.pdf`,
        markdownPath,
        textProjection: {
          status: "complete",
          extractor: "poppler-pdftotext",
          pageCount: 2,
          byteLength: Buffer.byteLength(markdown),
          contentHash: projectionHash,
          detail: "Published deterministic page-aware text for 2 PDF pages.",
        },
      }],
    };
    const source = sourceFor(stateRoot, run);

    const inventory = await source.listForSections(["1.1"]);
    expect(inventory).toEqual([expect.objectContaining({
      sourceId,
      mediaType: "pdf",
      projectionStatus: "complete",
      projectionContentHash: projectionHash,
      pageCount: 2,
      sectionIds: ["1.1"],
    })]);
    await expect(source.readProjectionForSections(sourceId, ["2.1"])).resolves.toBeNull();
    await expect(source.readProjectionForSections("/tmp/paper.pdf", ["1.1"]))
      .rejects.toThrow("ID is invalid");
    await expect(source.readProjectionForSections(sourceId, ["1.1"]))
      .resolves.toMatchObject({ markdown, pageCount: 2, projectionContentHash: projectionHash });
  });
});

function sourceFor(
  stateRoot: string,
  run: PreparationRunView,
): FilePreparedReferenceContextSource {
  return new FilePreparedReferenceContextSource(stateRoot, {
    state: async () => ({
      latestRun: run,
      externalNetworkIsUserStartedOnly: true,
      enrichment: "disabled",
      transcription: "public-captions-only-not-enabled",
    }),
  });
}

async function writeProjection(stateRoot: string, markdown: string): Promise<string> {
  const digest = createHash("sha256").update(markdown).digest("hex");
  const logicalPath = `preparation/cache/sha256/${digest.slice(0, 2)}/${digest}.md`;
  const target = join(stateRoot, ...logicalPath.split("/"));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, markdown);
  return logicalPath;
}

function runWithMarkdown(markdownPath: string, contentHash: string): PreparationRunView {
  return {
    schemaVersion: 1,
    runId: "prep_test",
    startedAt: "2026-08-30T10:00:00.000Z",
    completedAt: "2026-08-30T10:00:01.000Z",
    status: "complete",
    inventoryTruncated: false,
    discoveredCount: 1,
    cachedCount: 1,
    failedCount: 0,
    totalCachedBytes: 20,
    limits: {
      maxInventorySources: 256,
      maxSources: 24,
      maxSourceBytes: 2 * 1024 * 1024,
      maxTotalBytes: 12 * 1024 * 1024,
      maxRedirects: 3,
      requestTimeoutMs: 15_000,
    },
    sources: [{
      sourceId: "source_1",
      requestedUrl: "https://example.com/reference",
      finalUrl: "https://example.com/reference",
      origins: [{
        sectionId: "1.1",
        manifestRevision: `sha256:${"c".repeat(64)}`,
        documentId: `doc_${"d".repeat(64)}`,
        documentContentHash: "e".repeat(64),
        label: "Reference",
      }],
      originCount: 1,
      originsTruncated: false,
      status: "cached",
      mediaType: "html",
      fetchedAt: "2026-08-30T10:00:00.500Z",
      byteLength: 20,
      contentHash,
      cachePath: `preparation/cache/sha256/bb/${"b".repeat(64)}.html`,
      markdownPath,
      redirects: [],
      failureCode: null,
      detail: "Cached immutable source bytes and an inert Markdown text projection.",
    }],
  };
}
