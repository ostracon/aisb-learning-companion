import { mkdtemp, readFile, readdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { CurriculumMaterialManifest } from "../materials/service.js";
import {
  FilePreparationRunStore,
  PreparationRunInProgressError,
  PreparationShuttingDownError,
  PreparationService,
  htmlToReferenceMarkdown,
  type PreparationFetcher,
  type PreparationRunStore,
} from "./service.js";
import type { PreparationRunView } from "../../shared/preparation.js";

function manifest(
  sectionId: string,
  links: readonly { readonly label: string; readonly url: string }[],
): CurriculumMaterialManifest {
  return {
    sectionId,
    revision: `manifest-${sectionId}`,
    rootDocumentId: `doc-${sectionId}`,
    truncated: false,
    limits: {
      maxDepth: 4,
      maxDocuments: 32,
      maxDocumentBytes: 512_000,
      maxTotalBytes: 2_000_000,
      maxLinksPerDocument: 128,
      maxTotalLinks: 512,
    },
    documents: [{
      documentId: `doc-${sectionId}`,
      title: `Section ${sectionId}`,
      filename: "README.md",
      kind: "readme",
      accessClassification: "tutor_readable",
      contentHash: `content-${sectionId}`,
      byteLength: 100,
      links: links.map((link) => ({ kind: "external" as const, ...link })),
      linksTruncated: false,
    }],
  };
}

class MemoryStore implements PreparationRunStore {
  public run: PreparationRunView | null = null;
  public readonly objects: { readonly hash: string; readonly extension: string; readonly bytes: Uint8Array }[] = [];

  public async latest(): Promise<PreparationRunView | null> {
    return this.run;
  }

  public async putObject(contentHash: string, extension: "html" | "pdf" | "md", bytes: Uint8Array): Promise<string> {
    this.objects.push({ hash: contentHash, extension, bytes });
    const digest = contentHash.slice(7);
    return `preparation/cache/sha256/${digest.slice(0, 2)}/${digest}.${extension}`;
  }

  public async saveRun(run: PreparationRunView): Promise<void> {
    this.run = run;
  }
}

describe("PreparationService", () => {
  it("inventories and deduplicates verified HTTPS manifest links without network access", async () => {
    const store = new MemoryStore();
    const fetchCalls: string[] = [];
    const service = new PreparationService({
      manifests: {
        async readManifests() {
          return [
            manifest("1.1", [{ label: "Primary", url: "https://example.com/read#one" }]),
            manifest("1.2", [{ label: "Again", url: "https://example.com/read#two" }]),
          ];
        },
      },
      fetcher: {
        async fetch(url) {
          fetchCalls.push(url);
          throw new Error("must not fetch");
        },
      },
      store,
      now: () => new Date("2026-08-30T10:00:00.000Z"),
      createId: () => "prep_inventory",
    });

    const run = await service.start(false);

    expect(fetchCalls).toEqual([]);
    expect(run).toMatchObject({
      runId: "prep_inventory",
      status: "complete",
      discoveredCount: 1,
      cachedCount: 0,
      failedCount: 0,
    });
    expect(run.sources).toHaveLength(1);
    expect(run.sources[0]).toMatchObject({
      requestedUrl: "https://example.com/read",
      status: "not_fetched",
    });
    expect(run.sources[0]?.origins.map(({ sectionId }) => sectionId)).toEqual(["1.1", "1.2"]);
  });

  it("caches immutable HTML bytes and an inert Markdown projection", async () => {
    const store = new MemoryStore();
    const bytes = Buffer.from("<title>Safety</title><script>ignore()</script><h1>Boundary</h1><p>Public text &amp; facts.</p>");
    const fetcher: PreparationFetcher = {
      async fetch(url) {
        return {
          ok: true,
          requestedUrl: url,
          finalUrl: url,
          mediaType: "html",
          bytes,
          contentHash: "sha256:5b7cdf684eea20677fbd3ff23aa5db000ce9825288d82156792f558e431ae85a",
          redirects: [],
        };
      },
    };
    const service = new PreparationService({
      manifests: { async readManifests() { return [manifest("2.1", [{ label: "Safety", url: "https://example.com/safety" }])]; } },
      fetcher,
      store,
      now: () => new Date("2026-08-30T10:00:00.000Z"),
      createId: () => "prep_cache",
    });

    const run = await service.start(true);

    expect(run).toMatchObject({ status: "complete", cachedCount: 1, failedCount: 0 });
    expect(run.sources[0]).toMatchObject({ status: "cached", mediaType: "html" });
    expect(store.objects.map(({ extension }) => extension)).toEqual(["html", "md"]);
    const markdown = new TextDecoder().decode(store.objects[1]?.bytes);
    expect(markdown).toContain("# Safety");
    expect(markdown).toContain("# Boundary");
    expect(markdown).toContain("Public text & facts.");
    expect(markdown).not.toContain("ignore()");
    expect(run.generatedMarkdownBytes).toBe(Buffer.byteLength(markdown));
    expect(run.totalCachedBytes).toBe(bytes.byteLength + Buffer.byteLength(markdown));
    await expect(service.state()).resolves.toMatchObject({ latestRun: { runId: "prep_cache" } });
  });

  it("marks a bounded cache run partial when discovered sources are skipped", async () => {
    const store = new MemoryStore();
    const bytes = Buffer.from("%PDF-1.7");
    const service = new PreparationService({
      manifests: {
        async readManifests() {
          return [manifest("2.2", [
            { label: "A", url: "https://a.example/reference" },
            { label: "B", url: "https://b.example/reference" },
          ])];
        },
      },
      fetcher: {
        async fetch(url) {
          return {
            ok: true as const,
            requestedUrl: url,
            finalUrl: url,
            mediaType: "pdf" as const,
            bytes,
            contentHash: "sha256:86edbaa24831badfa0a8b04bb410141e2ee4182b6d0014493fe262a7a331c20b",
            redirects: [],
          };
        },
      },
      store,
      limits: { maxSources: 1 },
      now: () => new Date("2026-08-30T10:00:00.000Z"),
      createId: () => "prep_skipped",
    });

    const run = await service.start(true);

    expect(run).toMatchObject({ status: "partial", cachedCount: 1, failedCount: 0 });
    expect(run.sources.map(({ status }) => status)).toEqual(["cached", "not_fetched"]);
  });

  it("counts generated Markdown against the total byte limit before publishing", async () => {
    const store = new MemoryStore();
    const bytes = Buffer.from("<title>T</title><p>Body</p>");
    const service = new PreparationService({
      manifests: { async readManifests() { return [manifest("2.3", [{ label: "T", url: "https://example.com/t" }])]; } },
      fetcher: {
        async fetch(url) {
          return {
            ok: true as const,
            requestedUrl: url,
            finalUrl: url,
            mediaType: "html" as const,
            bytes,
            contentHash: "sha256:6027ce2221a9faadbb4d02c4bc72aa47dc28bc937a75d228459032d0a29ca3f6",
            redirects: [],
          };
        },
      },
      store,
      limits: { maxSourceBytes: bytes.byteLength, maxTotalBytes: bytes.byteLength },
      now: () => new Date("2026-08-30T10:00:00.000Z"),
      createId: () => "prep_markdown_limit",
    });

    const run = await service.start(true);

    expect(run).toMatchObject({ status: "failed", cachedCount: 0, failedCount: 1, totalCachedBytes: 0 });
    expect(run.sources[0]).toMatchObject({ failureCode: "total_limit" });
    expect(store.objects).toEqual([]);
  });

  it("records source failures without discarding successful cache entries", async () => {
    const store = new MemoryStore();
    const service = new PreparationService({
      manifests: {
        async readManifests() {
          return [manifest("3.1", [
            { label: "Good", url: "https://a.example/source" },
            { label: "Blocked", url: "https://b.example/source" },
          ])];
        },
      },
      fetcher: {
        async fetch(url) {
          if (url.includes("a.example")) {
            const bytes = Buffer.from("%PDF-1.7");
            return {
              ok: true as const,
              requestedUrl: url,
              finalUrl: url,
              mediaType: "pdf" as const,
              bytes,
              contentHash: "sha256:86edbaa24831badfa0a8b04bb410141e2ee4182b6d0014493fe262a7a331c20b",
              redirects: [],
            };
          }
          return {
            ok: false as const,
            requestedUrl: url,
            finalUrl: url,
            failureCode: "private_address" as const,
            detail: "The source resolved to a private address.",
            redirects: [],
          };
        },
      },
      store,
      now: () => new Date("2026-08-30T10:00:00.000Z"),
      createId: () => "prep_partial",
    });

    const run = await service.start(true);

    expect(run).toMatchObject({ status: "partial", cachedCount: 1, failedCount: 1 });
    expect(run.sources.map(({ status }) => status).sort()).toEqual(["cached", "failed"]);
  });

  it("bounds the sorted inventory before fetching", async () => {
    const calls: string[] = [];
    const store = new MemoryStore();
    const service = new PreparationService({
      manifests: {
        async readManifests() {
          return [manifest("4.1", [
            { label: "C", url: "https://c.example/" },
            { label: "A", url: "https://a.example/" },
            { label: "B", url: "https://b.example/" },
          ])];
        },
      },
      fetcher: {
        async fetch(url) {
          calls.push(url);
          return {
            ok: false as const,
            requestedUrl: url,
            finalUrl: url,
            failureCode: "network_error" as const,
            detail: "failed",
            redirects: [],
          };
        },
      },
      store,
      limits: { maxInventorySources: 2, maxSources: 2 },
      now: () => new Date("2026-08-30T10:00:00.000Z"),
      createId: () => "prep_bounded",
    });

    const run = await service.start(true);

    expect(calls).toEqual(["https://a.example/", "https://b.example/"]);
    expect(run).toMatchObject({ discoveredCount: 3, inventoryTruncated: true });
  });

  it("admits only one preparation run at a time", async () => {
    let release!: () => void;
    const waiting = new Promise<readonly CurriculumMaterialManifest[]>((resolve) => {
      release = () => resolve([]);
    });
    const service = new PreparationService({
      manifests: { async readManifests() { return waiting; } },
      fetcher: { async fetch() { throw new Error("no sources"); } },
      store: new MemoryStore(),
      now: () => new Date("2026-08-30T10:00:00.000Z"),
      createId: () => "prep_serialized",
    });

    const first = service.start(false);
    await expect(service.start(true)).rejects.toBeInstanceOf(PreparationRunInProgressError);
    release();
    await expect(first).resolves.toMatchObject({ runId: "prep_serialized" });
  });

  it("aborts an active fetch during pre-drain shutdown and publishes no run", async () => {
    const store = new MemoryStore();
    let fetchStarted!: () => void;
    const started = new Promise<void>((resolve) => { fetchStarted = resolve; });
    const service = new PreparationService({
      manifests: { async readManifests() { return [manifest("4.2", [{ label: "A", url: "https://a.example/" }])]; } },
      fetcher: {
        async fetch(_url, limits) {
          fetchStarted();
          return await new Promise((_, reject) => {
            limits.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        },
      },
      store,
      now: () => new Date("2026-08-30T10:00:00.000Z"),
      createId: () => "prep_cancelled",
    });

    const active = service.start(true);
    await started;
    service.beginShutdown();
    service.beginShutdown();

    await expect(active).rejects.toBeInstanceOf(PreparationShuttingDownError);
    expect(store.run).toBeNull();
    await expect(service.start(false)).rejects.toBeInstanceOf(PreparationShuttingDownError);
  });
});

describe("htmlToReferenceMarkdown", () => {
  it("strips active markup and preserves a useful inert text projection", () => {
    const markdown = htmlToReferenceMarkdown(
      Buffer.from("<title>Guide</title><style>.x{}</style><h2>Topic</h2><ul><li>One</li><li>Two</li></ul>"),
      "https://example.com/guide",
    );
    expect(markdown).toContain("# Guide");
    expect(markdown).toContain("## Topic");
    expect(markdown).toContain("- One");
    expect(markdown).not.toContain(".x{}");
    expect(markdown).not.toContain("<style>");
  });
});

describe("FilePreparationRunStore", () => {
  it("publishes content-addressed objects and immutable valid run records", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "aisb-preparation-store-"));
    const store = new FilePreparationRunStore(stateRoot);
    const bytes = Buffer.from("cached bytes");
    const hash = "sha256:6e10e7392858b23a91ec0fc838bdea89407aa958ff11f6d89dd6f593be5cc008";
    const path = await store.putObject(hash, "pdf", bytes);
    expect(path).toMatch(/^preparation\/cache\/sha256\/6e\//u);
    expect(await readFile(join(stateRoot, path), "utf8")).toBe("cached bytes");

    const service = new PreparationService({
      manifests: {
        async readManifests() {
          return [manifest("5.1", [{ label: "Reference", url: "https://example.com/reference" }])];
        },
      },
      fetcher: { async fetch() { throw new Error("inventory must remain local"); } },
      store,
      now: () => new Date("2026-08-30T12:30:00.000Z"),
      createId: () => "prep_file_store",
    });
    await service.start(false);
    await expect(store.latest()).resolves.toMatchObject({
      runId: "prep_file_store",
      sources: [{ status: "not_fetched" }],
    });

    const stored = await store.latest();
    expect(stored).not.toBeNull();
    await expect(store.saveRun({
      ...stored!,
      sources: stored!.sources.map((source) => ({ ...source, detail: "conflicting rewrite" })),
    })).rejects.toThrow("immutable_target_conflict");
  });

  it("refuses a symlinked preparation directory without writing outside the state root", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "aisb-preparation-state-"));
    const outside = await mkdtemp(join(tmpdir(), "aisb-preparation-outside-"));
    await symlink(outside, join(stateRoot, "preparation"));
    const store = new FilePreparationRunStore(stateRoot);

    await expect(store.putObject(
      "sha256:6e10e7392858b23a91ec0fc838bdea89407aa958ff11f6d89dd6f593be5cc008",
      "pdf",
      Buffer.from("cached bytes"),
    )).rejects.toThrow(/unsafe_directory/u);
    expect(await readdir(outside)).toEqual([]);
  });
});
