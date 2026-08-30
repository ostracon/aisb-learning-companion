import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CONTINUITY_SELECTION_MAX_SUMMARIES,
  CONTINUITY_SELECTION_MAX_TEXT_BYTES,
  ContinuitySummaryStore,
  type ContinuityStoreAtomicStep,
  type ContinuityStoreDependencies,
  type SaveContinuitySummaryRequest,
} from "./continuity-store";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryStateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "aisb-continuity-test-"));
  temporaryRoots.push(root);
  return root;
}

function idSequence(): () => string {
  let sequence = 0;
  return () => `continuity-temp-${String(++sequence).padStart(4, "0")}`;
}

function makeStore(
  stateRoot: string,
  options: {
    readonly times?: readonly string[];
    readonly onAtomicStep?: ContinuityStoreDependencies["on_atomic_step"];
  } = {},
): ContinuitySummaryStore {
  let timeIndex = 0;
  const times = options.times ?? ["2026-08-29T10:00:00.000Z"];
  return new ContinuitySummaryStore(stateRoot, {
    now() {
      const time = times[Math.min(timeIndex, times.length - 1)] ?? "2026-08-29T10:00:00.000Z";
      timeIndex += 1;
      return new Date(time);
    },
    create_id: idSequence(),
    ...(options.onAtomicStep === undefined ? {} : { on_atomic_step: options.onAtomicStep }),
  });
}

function request(
  summaryId: string,
  sourceDayId = "day1",
  text = "I can explain the difference between a model and its representation.",
): SaveContinuitySummaryRequest {
  return {
    summaryId,
    sourceDayId,
    sourceScopeKey: `study:section:${sourceDayId.slice(3)}.1`,
    sourceChatId: `chat:${sourceDayId}:learner`,
    sourceTurnId: `turn:${summaryId}`,
    sectionIds: [`${sourceDayId.slice(3)}.1`],
    outcomeVersionIds: [`outcome-version:${sourceDayId}:1`],
    text,
  };
}

function summaryPath(stateRoot: string, dayId: string, summaryId: string): string {
  return join(stateRoot, "continuity", dayId, `${summaryId}.md`);
}

function metadataFromMarkdown(raw: string): Record<string, unknown> {
  const prefix = "<!-- aisb-continuity-summary:v1\n";
  const separator = "\n-->\n\n# Approved continuity summary\n\n";
  const end = raw.indexOf(separator);
  if (!raw.startsWith(prefix) || end < 0) throw new Error("Expected continuity Markdown metadata");
  return JSON.parse(raw.slice(prefix.length, end)) as Record<string, unknown>;
}

describe("ContinuitySummaryStore Markdown contract", () => {
  it("round-trips and reopens a readable, integrity-tagged learner-approved Markdown artifact", async () => {
    const stateRoot = await temporaryStateRoot();
    const text = "## What stuck\n\n- Threat models need explicit trust boundaries.\n";
    const store = makeStore(stateRoot);
    const saved = await store.save(request("day1-wrap", "day1", text));

    expect(saved).toEqual({
      schemaVersion: 1,
      status: "approved",
      authoredBy: "learner",
      summaryId: "day1-wrap",
      sourceDayId: "day1",
      sourceScopeKey: "study:section:1.1",
      sourceChatId: "chat:day1:learner",
      sourceTurnId: "turn:day1-wrap",
      sectionIds: ["1.1"],
      outcomeVersionIds: ["outcome-version:day1:1"],
      approvedAt: "2026-08-29T10:00:00.000Z",
      contentHash: createHash("sha256").update(text).digest("hex"),
      text,
    });

    const raw = await readFile(summaryPath(stateRoot, "day1", "day1-wrap"), "utf8");
    expect(raw).toContain("# Approved continuity summary\n\n## What stuck");
    expect(raw.endsWith(text)).toBe(true);
    const metadata = metadataFromMarkdown(raw);
    expect(Object.keys(metadata).sort()).toEqual(
      [
        "approved_at",
        "authored_by",
        "content_sha256",
        "outcome_version_ids",
        "schema_version",
        "section_ids",
        "source_chat_id",
        "source_day_id",
        "source_scope_key",
        "source_turn_id",
        "status",
        "summary_id",
      ].sort(),
    );

    const reopened = makeStore(stateRoot);
    expect(await reopened.read("day1", "day1-wrap")).toEqual(saved);
    expect(await reopened.list("day1")).toEqual([saved]);
    expect(await reopened.list()).toEqual([saved]);
  });

  it("atomically creates and replaces a complete Markdown file and leaves the old file after pre-publish failure", async () => {
    const stateRoot = await temporaryStateRoot();
    const steps: Array<{ step: ContinuityStoreAtomicStep; mode: "create" | "replace" }> = [];
    let failReplacement = false;
    const store = makeStore(stateRoot, {
      times: ["2026-08-29T10:00:00.000Z", "2026-08-29T10:05:00.000Z"],
      onAtomicStep(step, details) {
        steps.push({ step, mode: details.mode });
        if (failReplacement && details.mode === "replace" && step === "before_publish") {
          throw new Error("simulated interruption before publish");
        }
      },
    });

    await store.save(request("atomic", "day2", "Accepted version"));
    const acceptedBytes = await readFile(summaryPath(stateRoot, "day2", "atomic"));
    expect(steps.map(({ step, mode }) => `${mode}:${step}`)).toEqual([
      "create:temporary_file_synced",
      "create:before_publish",
      "create:published",
      "create:directory_synced",
    ]);

    failReplacement = true;
    await expect(store.save(request("atomic", "day2", "Never published"))).rejects.toThrow(
      /simulated interruption/,
    );
    expect(await readFile(summaryPath(stateRoot, "day2", "atomic"))).toEqual(acceptedBytes);
    expect((await readdir(join(stateRoot, "continuity", "day2"))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect((await makeStore(stateRoot).read("day2", "atomic"))?.text).toBe("Accepted version");
  });

  it("allows a deliberate replacement while keeping one stable human-readable path", async () => {
    const stateRoot = await temporaryStateRoot();
    const store = makeStore(stateRoot, {
      times: ["2026-08-29T10:00:00.000Z", "2026-08-29T10:05:00.000Z"],
    });
    const first = await store.save(request("replace-me", "day3", "First learner summary"));
    const second = await store.save(request("replace-me", "day3", "Revised learner summary"));

    expect(second.approvedAt).not.toBe(first.approvedAt);
    expect((await store.read("day3", "replace-me"))?.text).toBe("Revised learner summary");
    expect(await readdir(join(stateRoot, "continuity", "day3"))).toEqual(["replace-me.md"]);
  });
});

describe("ContinuitySummaryStore safety and integrity", () => {
  it("rejects traversal-like locators and strict extra transcript, note, raw-envelope, or protected fields", async () => {
    const stateRoot = await temporaryStateRoot();
    const store = makeStore(stateRoot);
    await expect(store.save({ ...request("valid"), summaryId: "../escape" })).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(store.read("day1", "../escape")).rejects.toMatchObject({ code: "invalid_request" });
    await expect(store.read("day8", "valid")).rejects.toMatchObject({ code: "invalid_request" });

    for (const forbidden of [
      { transcript: [{ role: "user", content: "raw turn" }] },
      { noteContent: "whole live note" },
      { rawEnvelope: { schema: "aisb-learning-companion.frozen-context.v1" } },
      { protectedSources: ["answer_solution.py"] },
    ]) {
      await expect(store.save({ ...request("valid"), ...forbidden })).rejects.toMatchObject({
        code: "invalid_request",
      });
    }
    await expect(readFile(summaryPath(stateRoot, "day1", "valid"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a symlinked day directory and a symlinked Markdown record", async () => {
    const stateRoot = await temporaryStateRoot();
    const outside = await temporaryStateRoot();
    const store = makeStore(stateRoot);
    await store.list();

    await symlink(outside, join(stateRoot, "continuity", "day1"));
    await expect(store.list("day1")).rejects.toMatchObject({ code: "unsafe_path" });
    await rm(join(stateRoot, "continuity", "day1"));

    await mkdir(join(stateRoot, "continuity", "day2"));
    const externalFile = join(outside, "external.md");
    await writeFile(externalFile, "not a continuity record", "utf8");
    await symlink(externalFile, summaryPath(stateRoot, "day2", "linked"));
    await expect(store.read("day2", "linked")).rejects.toMatchObject({ code: "unsafe_path" });
    await expect(store.list("day2")).rejects.toMatchObject({ code: "unsafe_path" });
  });

  it("detects body corruption and a SHA-256 mismatch instead of returning modified continuity", async () => {
    const stateRoot = await temporaryStateRoot();
    const store = makeStore(stateRoot);
    await store.save(request("corrupt-me", "day4", "Original approved wording"));
    const path = summaryPath(stateRoot, "day4", "corrupt-me");
    const raw = await readFile(path, "utf8");
    await writeFile(path, raw.replace("Original approved wording", "Modified approved wording"), "utf8");

    await expect(store.read("day4", "corrupt-me")).rejects.toMatchObject({ code: "corrupt_store" });
    await expect(store.list("day4")).rejects.toMatchObject({ code: "corrupt_store" });
  });

  it("enforces the UTF-8 learner-summary bound", async () => {
    const stateRoot = await temporaryStateRoot();
    const store = makeStore(stateRoot);
    await expect(store.save(request("too-large", "day1", "🧠".repeat(2_049)))).rejects.toMatchObject({
      code: "invalid_request",
    });
  });
});

describe("ContinuitySummaryStore bounded prior-day selection", () => {
  it("excludes current and future days, ranks newest prior days, caps count and 16 KiB, then returns chronology", async () => {
    const stateRoot = await temporaryStateRoot();
    const store = makeStore(stateRoot, {
      times: [
        "2026-08-29T03:00:00.000Z",
        "2026-08-29T04:00:00.000Z",
        "2026-08-29T05:00:00.000Z",
        "2026-08-29T06:00:00.000Z",
        "2026-08-29T07:00:00.000Z",
        "2026-08-29T08:00:00.000Z",
      ],
    });
    await store.save(request("day3-small", "day3", "c".repeat(300)));
    await store.save(request("day4-overflow", "day4", "d".repeat(1_000)));
    await store.save(request("day5-heavy", "day5", "e".repeat(8_000)));
    await store.save(request("day6-heavy", "day6", "f".repeat(8_000)));
    await store.save(request("day7-current", "day7", "current"));

    const selected = await store.selectForDay("day7");
    expect(selected.summaries.map((summary) => summary.summaryId)).toEqual([
      "day3-small",
      "day5-heavy",
      "day6-heavy",
    ]);
    expect(selected.summaries).toHaveLength(CONTINUITY_SELECTION_MAX_SUMMARIES);
    expect(selected.totalTextBytes).toBe(16_300);
    expect(selected.totalTextBytes).toBeLessThanOrEqual(CONTINUITY_SELECTION_MAX_TEXT_BYTES);
    expect(selected.summaries.some((summary) => summary.summaryId === "day4-overflow")).toBe(false);
    expect(selected.summaries.some((summary) => summary.summaryId === "day7-current")).toBe(false);
    expect(await makeStore(stateRoot).selectForDay("day7")).toEqual(selected);
  });

  it("returns no continuity for day0 and excludes a future record from an earlier target", async () => {
    const stateRoot = await temporaryStateRoot();
    const store = makeStore(stateRoot);
    await store.save(request("future", "day6", "Not available to day2"));
    expect((await store.selectForDay("day0")).summaries).toEqual([]);
    expect((await store.selectForDay("day2")).summaries).toEqual([]);
  });
});
