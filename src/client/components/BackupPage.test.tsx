// @vitest-environment jsdom

import "fake-indexeddb/auto";

import { createHash, webcrypto } from "node:crypto";

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BACKUP_CATEGORIES,
  BACKUP_FORMAT,
  backupContentDigestInput,
  canonicalJson,
  type BackupEnvelope,
  type BackupManifest,
  type BackupManifestEntry,
  type BrowserRecoverySnapshot,
} from "../../shared/backup.js";
import {
  claimDraftWriterEpoch,
  resetDraftDatabaseForTests,
  writeDraft,
} from "../storage/drafts.js";
import {
  BackupPage,
  collectBrowserRecoverySnapshot,
  verifyBackupEnvelopeForDownload,
} from "./BackupPage.js";

const emptyBrowserRecovery: BrowserRecoverySnapshot = {
  schemaVersion: 1,
  localStorage: [],
  noteDrafts: [],
  noteWriterStates: [],
};

function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

/**
 * Adapt jsdom-owned buffers before passing them to Node's Web Crypto.
 *
 * Node 22 rejects ArrayBuffers created in jsdom's realm even though real
 * browsers accept the same input. Keeping that compatibility shim in the
 * test preserves a browser-accurate production implementation.
 */
function installTestWebCrypto(): void {
  const digest = async (
    algorithm: AlgorithmIdentifier,
    data: BufferSource,
  ): Promise<ArrayBuffer> => {
    const view = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data);
    return webcrypto.subtle.digest(algorithm, Buffer.from(Array.from(view)));
  };
  Object.defineProperty(window, "crypto", {
    configurable: true,
    value: { subtle: { digest } } as unknown as Crypto,
  });
}

function backupFixture(): BackupEnvelope {
  const source = [
    { path: "browser/local-storage.json", content: "{\"entries\":[],\"schemaVersion\":1}\n" },
    { path: "browser/note-drafts.json", content: "{\"drafts\":[],\"schemaVersion\":1}\n" },
    { path: "browser/note-writer-state.json", content: "{\"schemaVersion\":1,\"writers\":[]}\n" },
  ] as const;
  const entries: BackupManifestEntry[] = source.map(({ path, content }) => ({
    path,
    category: "browser-recovery",
    mediaType: "application/json",
    byteLength: Buffer.byteLength(content),
    sha256: sha256(content),
  }));
  const manifest: BackupManifest = {
    schemaVersion: 1,
    format: BACKUP_FORMAT,
    exportedAt: "2026-08-30T09:15:00.000Z",
    contentSha256: sha256(backupContentDigestInput(entries)),
    totalBytes: entries.reduce((total, entry) => total + entry.byteLength, 0),
    entryCount: entries.length,
    entries,
    includedCategories: BACKUP_CATEGORIES,
    exclusions: [
      "AISB repository and Git objects",
      "Codex homes, authentication, and caches",
      "credentials and process environment",
      "temporary and lock files",
    ],
    restore: {
      mode: "manual-fresh-state-only",
      automaticRestoreAvailable: false,
      guidance: "Recover only into fresh empty state.",
    },
  };
  return {
    schemaVersion: 1,
    format: BACKUP_FORMAT,
    manifest,
    manifestSha256: sha256(canonicalJson(manifest)),
    files: source.map(({ path, content }) => ({
      path,
      encoding: "base64",
      content: Buffer.from(content).toString("base64"),
    })),
  };
}

afterEach(async () => {
  cleanup();
  window.localStorage.clear();
  await resetDraftDatabaseForTests();
  vi.restoreAllMocks();
});

describe("BackupPage", () => {
  it("does nothing on mount and downloads only after browser and server hashes verify", async () => {
    installTestWebCrypto();
    const user = userEvent.setup();
    const envelope = backupFixture();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(envelope), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const collectBrowserRecovery = vi.fn(async () => emptyBrowserRecovery);
    const download = vi.fn();

    render(
      <MemoryRouter>
        <BackupPage
          fetchImpl={fetchImpl}
          collectBrowserRecovery={collectBrowserRecovery}
          download={download}
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole("link", { name: "Back to workspace" }).getAttribute("href")).toBe("/");

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Download verified backup" }));

    await waitFor(() => expect(download).toHaveBeenCalledWith(envelope));
    expect(fetchImpl).toHaveBeenCalledWith("/api/backup/export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ browserRecovery: emptyBrowserRecovery }),
    });
    expect(screen.getByRole("heading", { name: "Manifest ready" })).toBeTruthy();
    expect(screen.getByText("SHA-256 verified")).toBeTruthy();
    expect(screen.getByText(/manual, manifest-verified operation/u)).toBeTruthy();
    expect(screen.getByText(/replacement native threads/u)).toBeTruthy();
  });

  it("refuses to download a payload that does not match its manifest", async () => {
    installTestWebCrypto();
    const user = userEvent.setup();
    const envelope = backupFixture();
    const corrupt: BackupEnvelope = {
      ...envelope,
      files: [
        { ...envelope.files[0]!, content: Buffer.from("changed").toString("base64") },
        ...envelope.files.slice(1),
      ],
    };
    const download = vi.fn();
    render(
      <MemoryRouter>
        <BackupPage
          fetchImpl={async () => new Response(JSON.stringify(corrupt), { status: 200 })}
          collectBrowserRecovery={async () => emptyBrowserRecovery}
          download={download}
        />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole("button", { name: "Download verified backup" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/verification failed/u);
    expect(download).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "Manifest ready" })).toBeNull();
  });

  it("coalesces a rapid repeated action into one export", async () => {
    installTestWebCrypto();
    const user = userEvent.setup();
    const envelope = backupFixture();
    let releaseCollection: (() => void) | undefined;
    const collectionGate = new Promise<void>((resolve) => {
      releaseCollection = resolve;
    });
    const collectBrowserRecovery = vi.fn(async () => {
      await collectionGate;
      return emptyBrowserRecovery;
    });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(envelope), { status: 200 }));

    render(
      <MemoryRouter>
        <BackupPage
          fetchImpl={fetchImpl}
          collectBrowserRecovery={collectBrowserRecovery}
          download={() => undefined}
        />
      </MemoryRouter>,
    );
    const button = screen.getByRole("button", { name: "Download verified backup" });
    await user.dblClick(button);
    expect(collectBrowserRecovery).toHaveBeenCalledTimes(1);

    releaseCollection?.();
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
  });

  it("collects the note draft and only recognised companion browser keys", async () => {
    window.localStorage.setItem("unrelated", "ignored");
    window.localStorage.setItem("aisb-companion:manager-composer:v1", "Plan tomorrow");
    window.localStorage.setItem("aisb-companion:tutor-composer:event:event-a", "Exact tutor draft");
    window.localStorage.setItem(
      "aisb-companion:tutor-pending:event:event-a",
      JSON.stringify({
        version: 1,
        scopeKey: "event:event-a",
        clientMessageId: "client-pending",
        learnerText: "Exact tutor draft",
        occurredAt: "2026-08-30T09:00:00.000Z",
      }),
    );
    const writerEpoch = await claimDraftWriterEpoch("day1-notes");
    await writeDraft({
      noteId: "day1-notes",
      content: "# Still unsaved\n",
      baseRevision: 1,
      baseContentHash: "a".repeat(64),
      updatedAt: "2026-08-30T09:00:00.000Z",
      writerEpoch,
      editSequence: 2,
    });

    const snapshot = await collectBrowserRecoverySnapshot();

    expect(snapshot.localStorage).toEqual([
      { key: "aisb-companion:manager-composer:v1", value: "Plan tomorrow" },
      { key: "aisb-companion:tutor-composer:event:event-a", value: "Exact tutor draft" },
      {
        key: "aisb-companion:tutor-pending:event:event-a",
        value: JSON.stringify({
          version: 1,
          scopeKey: "event:event-a",
          clientMessageId: "client-pending",
          learnerText: "Exact tutor draft",
          occurredAt: "2026-08-30T09:00:00.000Z",
        }),
      },
    ]);
    expect(snapshot.noteDrafts).toEqual([expect.objectContaining({
      noteId: "day1-notes",
      content: "# Still unsaved\n",
      writerEpoch,
      editSequence: 2,
    })]);
    expect(snapshot.noteWriterStates).toEqual([{ noteId: "day1-notes", writerEpoch }]);
  });

  it("fails closed when a future companion browser key has no export contract", async () => {
    window.localStorage.setItem("aisb-companion:future-state:v2", "important");
    await expect(collectBrowserRecoverySnapshot()).rejects.toThrow(/Unrecognised companion browser state/u);
  });

  it("verifies a complete fixture independently of the page flow", async () => {
    installTestWebCrypto();
    await expect(verifyBackupEnvelopeForDownload(backupFixture())).resolves.toBeUndefined();
  });
});
