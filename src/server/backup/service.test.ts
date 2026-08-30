import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { BackupEnvelope, BrowserRecoverySnapshot } from "../../shared/backup.js";
import {
  BackupExportError,
  BackupExportService,
  verifyBackupEnvelope,
} from "./service.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(prefix = "aisb-backup-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function put(root: string, path: string, bytes: string | Uint8Array): Promise<void> {
  const target = join(root, ...path.split("/"));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
}

const browserRecovery: BrowserRecoverySnapshot = {
  schemaVersion: 1,
  localStorage: [
    { key: "aisb-companion:manager-composer:v1", value: "Review my week" },
    { key: "aisb-companion:tutor-composer:study:day1:1.1", value: "A saved question" },
  ],
  noteDrafts: [{
    noteId: "day1-notes",
    content: "# Unsaved browser recovery\n",
    baseRevision: 2,
    baseContentHash: "a".repeat(64),
    updatedAt: "2026-08-30T08:00:00.000Z",
    writerEpoch: 3,
    editSequence: 8,
  }],
  noteWriterStates: [{ noteId: "day1-notes", writerEpoch: 3 }],
};

async function populateState(root: string): Promise<void> {
  await Promise.all([
    put(root, "notes/days/day1.md", "# Day 1\n\nSaved notes.\n"),
    put(root, "notes/revisions/day1.jsonl", "{\"revision\":1}\n"),
    put(root, "schedule/schedule.json", "{\"schedule_revision\":3}\n"),
    put(root, "progress/learning-outcomes.json", "{\"revision\":4}\n"),
    put(root, "curriculum/event-bindings.json", "{\"revision\":2}\n"),
    put(root, "continuity/day1/wrap.md", "# Approved continuity summary\n"),
    put(root, "tutor/sessions/sessions.jsonl", "{\"event\":\"completion\"}\n"),
    put(root, "tutor/thread-bindings/bindings.json", "{\"bindings\":[]}\n"),
    put(root, "review/sessions/review-one.json", "{\"complete\":true}\n"),
    put(root, "preparation/runs/run-one.json", "{\"status\":\"complete\"}\n"),
    put(root, "preparation/cache/sha256/ab/source.html", "<h1>Public source</h1>"),
    put(root, "media/visuals/visual_one/metadata.json", "{\"assetId\":\"visual_one\"}\n"),
    put(root, "media/visuals/visual_one/image.png", new Uint8Array([137, 80, 78, 71])),
    put(root, "codex/tutor-home/auth.json", "{\"token\":\"never export\"}\n"),
    put(root, "notes/days/.save-in-progress.tmp", "partial"),
  ]);
}

function payloadBytes(envelope: BackupEnvelope, path: string): Buffer {
  const payload = envelope.files.find((file) => file.path === path);
  if (payload === undefined) throw new Error(`Missing payload ${path}`);
  return Buffer.from(payload.content, "base64");
}

describe("BackupExportService", () => {
  it("creates a deterministic, verified allowlisted envelope with browser recovery and exact bytes", async () => {
    const root = await temporaryRoot();
    await populateState(root);
    const now = () => new Date("2026-08-30T09:15:00.000Z");
    const service = new BackupExportService(root, {}, now);

    const first = await service.export({ browserRecovery });
    const second = await service.export({ browserRecovery });

    expect(second).toEqual(first);
    expect(() => verifyBackupEnvelope(first)).not.toThrow();
    expect(first.manifest.entryCount).toBe(16);
    expect(first.manifest.entries.map(({ path }) => path).slice().sort()).toEqual(
      first.manifest.entries.map(({ path }) => path),
    );
    expect(first.manifest.entries.map(({ path }) => path)).toContain("browser/note-drafts.json");
    expect(first.manifest.entries.map(({ path }) => path)).toContain("state/media/visuals/visual_one/image.png");
    expect(first.manifest.entries.some(({ path }) => path.includes("codex"))).toBe(false);
    expect(first.manifest.entries.some(({ path }) => path.includes("auth.json"))).toBe(false);
    expect(first.manifest.entries.some(({ path }) => path.includes(".tmp"))).toBe(false);
    expect(payloadBytes(first, "state/notes/days/day1.md").toString("utf8")).toBe(
      "# Day 1\n\nSaved notes.\n",
    );
    expect(JSON.parse(payloadBytes(first, "browser/local-storage.json").toString("utf8"))).toEqual({
      entries: browserRecovery.localStorage,
      schemaVersion: 1,
    });

    const noteEntry = first.manifest.entries.find(({ path }) => path === "state/notes/days/day1.md");
    expect(noteEntry?.sha256).toBe(
      `sha256:${createHash("sha256").update("# Day 1\n\nSaved notes.\n").digest("hex")}`,
    );
    expect(first.manifest.restore).toMatchObject({
      mode: "manual-fresh-state-only",
      automaticRestoreAvailable: false,
    });
    expect(first.manifest.exclusions).toContain("AISB repository and Git objects");
  });

  it("fails closed on links, unexpected state file types, credentials, and size limits", async () => {
    const linkedRoot = await temporaryRoot("aisb-backup-link-");
    const outside = await temporaryRoot("aisb-backup-outside-");
    await put(outside, "outside.md", "outside");
    await mkdir(join(linkedRoot, "notes"), { recursive: true });
    await symlink(join(outside, "outside.md"), join(linkedRoot, "notes", "linked.md"));
    await expect(new BackupExportService(linkedRoot).export({ browserRecovery })).rejects.toMatchObject({
      code: "unsafe_path",
    });

    const unsupportedRoot = await temporaryRoot("aisb-backup-type-");
    await put(unsupportedRoot, "notes/day1.txt", "not an application state format");
    await expect(new BackupExportService(unsupportedRoot).export({ browserRecovery })).rejects.toMatchObject({
      code: "unsupported_file",
    });

    const credentialRoot = await temporaryRoot("aisb-backup-secret-");
    await put(credentialRoot, "notes/day1.md", `Do not save sk-proj-${"A".repeat(30)} here`);
    await expect(new BackupExportService(credentialRoot).export({ browserRecovery })).rejects.toMatchObject({
      code: "credential_detected",
    });

    const largeRoot = await temporaryRoot("aisb-backup-large-");
    await put(largeRoot, "notes/day1.md", "12345");
    await expect(new BackupExportService(largeRoot, {
      maxFileBytes: 4,
      maxTotalBytes: 4_096,
    }).export({ browserRecovery })).rejects.toMatchObject({ code: "size_limit" });
  });

  it("rejects unrecognised browser state, credential-like drafts, and tampered payloads", async () => {
    const root = await temporaryRoot();
    await put(root, "notes/day1.md", "safe");
    const service = new BackupExportService(root, {}, () => new Date("2026-08-30T09:15:00.000Z"));

    await expect(service.export({
      browserRecovery: {
        ...browserRecovery,
        localStorage: [{ key: "unrelated:key", value: "value" }],
      },
    })).rejects.toMatchObject({ code: "invalid_request" });

    await expect(service.export({
      browserRecovery: {
        ...browserRecovery,
        noteDrafts: [{
          ...browserRecovery.noteDrafts[0]!,
          content: `sk-proj-${"B".repeat(32)}`,
        }],
      },
    })).rejects.toMatchObject({ code: "credential_detected" });

    const envelope = await service.export({ browserRecovery });
    const first = envelope.files[0]!;
    const tampered: BackupEnvelope = {
      ...envelope,
      files: [{ ...first, content: Buffer.from("tampered").toString("base64") }, ...envelope.files.slice(1)],
    };
    expect(() => verifyBackupEnvelope(tampered)).toThrowError(BackupExportError);
  });
});

