// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PreparationStateResponse } from "../../shared/preparation.js";
import { PreparePage } from "./PreparePage.js";

const emptyState: PreparationStateResponse = {
  latestRun: null,
  externalNetworkIsUserStartedOnly: true,
  enrichment: "disabled",
  transcription: "public-captions-only-not-enabled",
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PreparePage", () => {
  it("reads local history without starting an external preparation run", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(emptyState), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetch);

    render(<MemoryRouter><PreparePage /></MemoryRouter>);

    expect(screen.getByRole("link", { name: "Back to workspace" }).getAttribute("href")).toBe("/");
    expect(await screen.findByText(/No preparation run yet/u)).toBeTruthy();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("/api/preparation", expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("starts network caching only after the explicit cache action", async () => {
    const user = userEvent.setup();
    const run = {
      schemaVersion: 1 as const,
      runId: "prep_ui",
      startedAt: "2026-08-30T10:00:00.000Z",
      completedAt: "2026-08-30T10:00:01.000Z",
      status: "complete" as const,
      inventoryTruncated: false,
      discoveredCount: 1,
      cachedCount: 1,
      failedCount: 0,
      totalCachedBytes: 12,
      limits: {
        maxInventorySources: 256,
        maxSources: 24,
        maxSourceBytes: 2_097_152,
        maxTotalBytes: 12_582_912,
        maxRedirects: 3,
        requestTimeoutMs: 15_000,
      },
      sources: [{
        sourceId: "source_example",
        requestedUrl: "https://example.com/guide",
        finalUrl: "https://example.com/guide",
        originCount: 1,
        originsTruncated: false,
        origins: [{
          sectionId: "1.1",
          manifestRevision: "manifest-1.1",
          documentId: "doc-1.1",
          documentContentHash: "content-1.1",
          label: "Guide",
        }],
        status: "cached" as const,
        mediaType: "html" as const,
        fetchedAt: "2026-08-30T10:00:01.000Z",
        byteLength: 12,
        contentHash: `sha256:${"a".repeat(64)}`,
        cachePath: "preparation/cache/source.html",
        markdownPath: "preparation/cache/source.md",
        redirects: [],
        failureCode: null,
        detail: "Cached immutable source bytes and an inert Markdown text projection.",
      }],
    };
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/preparation") {
        return new Response(JSON.stringify(emptyState), { status: 200 });
      }
      expect(init?.method).toBe("POST");
      expect(init?.body).toBe(JSON.stringify({ fetch: true }));
      return new Response(JSON.stringify(run), { status: 201 });
    });
    vi.stubGlobal("fetch", fetch);
    render(<MemoryRouter><PreparePage /></MemoryRouter>);
    await screen.findByText(/No preparation run yet/u);

    await user.click(screen.getByRole("button", { name: "Inventory & cache public sources" }));

    expect(await screen.findByText("HTML + Markdown · 12 bytes")).toBeTruthy();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
