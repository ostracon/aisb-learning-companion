// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
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
    expect(screen.getByText("All inventoried sources")).toBeTruthy();
    expect(screen.getByText("6 deterministic fetch workers")).toBeTruthy();
    expect(screen.queryByText(/24-source/u)).toBeNull();
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

  it("keeps an explicit live status visible until caching publishes its result", async () => {
    const user = userEvent.setup();
    let finishRun: ((response: Response) => void) | undefined;
    const pendingRun = new Promise<Response>((resolve) => {
      finishRun = resolve;
    });
    const run = {
      schemaVersion: 1 as const,
      runId: "prep_feedback",
      startedAt: "2026-08-30T10:00:00.000Z",
      completedAt: "2026-08-30T10:00:02.000Z",
      status: "partial" as const,
      inventoryTruncated: false,
      discoveredCount: 3,
      cachedCount: 2,
      failedCount: 1,
      totalCachedBytes: 24,
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
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/preparation") {
        return new Response(JSON.stringify(emptyState), { status: 200 });
      }
      return pendingRun;
    });
    vi.stubGlobal("fetch", fetch);
    render(<MemoryRouter><PreparePage /></MemoryRouter>);
    await screen.findByText(/No preparation run yet/u);

    await user.click(screen.getByRole("button", { name: "Inventory & cache public sources" }));

    expect(screen.getByRole("status").textContent).toContain("Run in progress");
    expect(screen.getByText("Caching public sources safely")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Fetching safely…" }) as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      finishRun?.(new Response(JSON.stringify(run), { status: 201 }));
      await pendingRun;
    });

    expect(screen.getByRole("status").textContent).toContain("Run finished");
    expect(screen.getByText("2 cached · 1 failed safely")).toBeTruthy();
    expect(screen.getByText(/3 sources found/u)).toBeTruthy();
  });
});
