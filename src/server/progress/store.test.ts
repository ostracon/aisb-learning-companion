import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  LearningProgressStore,
  type LearningProgressAtomicStep,
  type LearningProgressStoreDependencies,
} from "./store";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryStateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "aisb-learning-progress-test-"));
  temporaryRoots.push(root);
  return root;
}

function idSequence(prefix = "progress-temp"): () => string {
  let sequence = 0;
  return () => `${prefix}-${String(++sequence).padStart(4, "0")}`;
}

function makeStore(
  stateRoot: string,
  options: {
    readonly times?: readonly string[];
    readonly onAtomicStep?: LearningProgressStoreDependencies["on_atomic_step"];
  } = {},
): LearningProgressStore {
  let timeIndex = 0;
  const times = options.times ?? ["2026-08-29T20:00:00.000Z"];
  return new LearningProgressStore(stateRoot, {
    now() {
      const value = times[Math.min(timeIndex, times.length - 1)] ?? "2026-08-29T20:00:00.000Z";
      timeIndex += 1;
      return new Date(value);
    },
    create_id: idSequence(),
    ...(options.onAtomicStep === undefined ? {} : { on_atomic_step: options.onAtomicStep }),
  });
}

function primaryPath(stateRoot: string): string {
  return join(stateRoot, "progress/learning-outcomes.json");
}

function recoveryPath(stateRoot: string): string {
  return join(stateRoot, "progress/recovery");
}

async function allFileText(root: string): Promise<string> {
  const chunks: string[] = [];
  async function visit(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) chunks.push(await readFile(child, "utf8"));
    }
  }
  await visit(root);
  return chunks.join("\n");
}

describe("LearningProgressStore persistence contract", () => {
  it("persists only versioned user-declared completion metadata", async () => {
    const stateRoot = await temporaryStateRoot();
    const store = makeStore(stateRoot);
    const empty = await store.read();
    expect(empty).toMatchObject({ revision: 0, completions: [], recovered: false });

    const saved = await store.setCompletion({
      expectedVersion: empty.version,
      outcomeId: "1.1:security:1",
      outcomeVersionId: "f72d6a10d154ab09",
      completed: true,
    });
    expect(saved.status).toBe("saved");
    if (saved.status !== "saved") throw new Error("Expected saved completion");
    expect(saved.completion).toEqual({
      outcomeId: "1.1:security:1",
      outcomeVersionId: "f72d6a10d154ab09",
      completed: true,
      completedAt: "2026-08-29T20:00:00.000Z",
    });
    expect(saved.snapshot).toMatchObject({ revision: 1, recovered: false });

    const raw = await readFile(primaryPath(stateRoot), "utf8");
    const document = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(document).sort()).toEqual([
      "completions",
      "payload_hash",
      "revision",
      "schema_version",
    ]);
    expect(raw).not.toMatch(/outcome.?text|note|prompt|mastery|model|auth|credential/i);

    const reopened = await makeStore(stateRoot).read();
    expect(reopened).toEqual({ ...saved.snapshot, recovered: false });
  });

  it("treats the same declaration as unchanged and keys versions independently", async () => {
    const stateRoot = await temporaryStateRoot();
    const store = makeStore(stateRoot, {
      times: ["2026-08-29T20:00:00.000Z", "2026-08-29T20:01:00.000Z"],
    });
    const initial = await store.read();
    const first = await store.setCompletion({
      expectedVersion: initial.version,
      outcomeId: "1.2:ml:1",
      outcomeVersionId: "version-a",
      completed: true,
    });
    if (first.status !== "saved") throw new Error("Expected first save");

    const unchanged = await store.setCompletion({
      expectedVersion: first.snapshot.version,
      outcomeId: "1.2:ml:1",
      outcomeVersionId: "version-a",
      completed: true,
    });
    expect(unchanged.status).toBe("unchanged");
    if (unchanged.status !== "unchanged") throw new Error("Expected unchanged declaration");
    expect(unchanged.snapshot.version).toBe(first.snapshot.version);
    expect(unchanged.completion.completedAt).toBe("2026-08-29T20:00:00.000Z");

    const newVersion = await store.setCompletion({
      expectedVersion: unchanged.snapshot.version,
      outcomeId: "1.2:ml:1",
      outcomeVersionId: "version-b",
      completed: false,
    });
    expect(newVersion.status).toBe("saved");
    if (newVersion.status !== "saved") throw new Error("Expected versioned save");
    expect(newVersion.completion.completedAt).toBeNull();
    expect(newVersion.snapshot.completions).toHaveLength(2);

    const unchecked = await store.setCompletion({
      expectedVersion: newVersion.snapshot.version,
      outcomeId: "1.2:ml:1",
      outcomeVersionId: "version-a",
      completed: false,
    });
    expect(unchecked.status).toBe("saved");
    if (unchecked.status !== "saved") throw new Error("Expected unchecked save");
    expect(unchecked.completion).toMatchObject({ completed: false, completedAt: null });
  });

  it("keeps recovery snapshots append-only across later revisions", async () => {
    const stateRoot = await temporaryStateRoot();
    const store = makeStore(stateRoot);
    const initial = await store.read();
    const first = await store.setCompletion({
      expectedVersion: initial.version,
      outcomeId: "2.1:theory:1",
      outcomeVersionId: "version-1",
      completed: true,
    });
    if (first.status !== "saved") throw new Error("Expected first save");

    const revisionOneName = (await readdir(recoveryPath(stateRoot))).find((name) => name.startsWith("000000000001-"));
    expect(revisionOneName).toBeDefined();
    const revisionOnePath = join(recoveryPath(stateRoot), revisionOneName ?? "missing");
    const revisionOneBytes = await readFile(revisionOnePath);

    const second = await store.setCompletion({
      expectedVersion: first.snapshot.version,
      outcomeId: "2.1:theory:2",
      outcomeVersionId: "version-2",
      completed: true,
    });
    expect(second.status).toBe("saved");
    expect(await readFile(revisionOnePath)).toEqual(revisionOneBytes);
    expect((await readdir(recoveryPath(stateRoot))).filter((name) => name.endsWith(".json"))).toHaveLength(3);
  });

  it("rejects extra content and path-like identifiers without leaking submitted bytes", async () => {
    const stateRoot = await temporaryStateRoot();
    const store = makeStore(stateRoot);
    const initial = await store.read();
    const secret = "PRIVATE LEARNER NOTE THAT MUST NEVER BE PERSISTED";

    await expect(
      store.setCompletion({
        expectedVersion: initial.version,
        outcomeId: "1.1:security:1",
        outcomeVersionId: "version-1",
        completed: true,
        noteText: secret,
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      store.setCompletion({
        expectedVersion: initial.version,
        outcomeId: "../../notes/private",
        outcomeVersionId: "version-1",
        completed: true,
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });

    expect(await allFileText(stateRoot)).not.toContain(secret);
    await expect(readFile(primaryPath(stateRoot))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("LearningProgressStore serialization and CAS", () => {
  it("serializes concurrent mutations so exactly one stale writer conflicts", async () => {
    const stateRoot = await temporaryStateRoot();
    const store = makeStore(stateRoot, {
      times: ["2026-08-29T20:00:00.000Z", "2026-08-29T20:00:01.000Z"],
    });
    const initial = await store.read();

    const results = await Promise.all([
      store.setCompletion({
        expectedVersion: initial.version,
        outcomeId: "1.1:engineering:1",
        outcomeVersionId: "version-1",
        completed: true,
      }),
      store.setCompletion({
        expectedVersion: initial.version,
        outcomeId: "1.1:security:1",
        outcomeVersionId: "version-2",
        completed: true,
      }),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(["conflict", "saved"]);
    const current = await store.read();
    expect(current).toMatchObject({ revision: 1 });
    expect(current.completions).toHaveLength(1);
  });

  it("returns the current snapshot for a stale token without changing accepted bytes", async () => {
    const stateRoot = await temporaryStateRoot();
    const store = makeStore(stateRoot);
    const initial = await store.read();
    const saved = await store.setCompletion({
      expectedVersion: initial.version,
      outcomeId: "3.1:security:1",
      outcomeVersionId: "version-1",
      completed: true,
    });
    if (saved.status !== "saved") throw new Error("Expected saved completion");
    const acceptedBytes = await readFile(primaryPath(stateRoot));

    const conflict = await store.setCompletion({
      expectedVersion: initial.version,
      outcomeId: "3.1:security:2",
      outcomeVersionId: "version-2",
      completed: true,
    });
    expect(conflict).toMatchObject({
      status: "conflict",
      current: { version: saved.snapshot.version },
    });
    expect(await readFile(primaryPath(stateRoot))).toEqual(acceptedBytes);
  });
});

describe("LearningProgressStore atomicity and recovery", () => {
  it("keeps the accepted document intact when publication fails before rename", async () => {
    const stateRoot = await temporaryStateRoot();
    let failBeforePublish = false;
    const hook = async (
      step: LearningProgressAtomicStep,
      details: Readonly<{ target: string; mode: "replace" | "exclusive" }>,
    ) => {
      if (
        failBeforePublish &&
        step === "before_publish" &&
        details.mode === "replace" &&
        details.target === "progress/learning-outcomes.json"
      ) {
        throw new Error("simulated crash before publication");
      }
    };
    const store = makeStore(stateRoot, { onAtomicStep: hook });
    const initial = await store.read();
    const saved = await store.setCompletion({
      expectedVersion: initial.version,
      outcomeId: "4.1:ml:1",
      outcomeVersionId: "version-1",
      completed: true,
    });
    if (saved.status !== "saved") throw new Error("Expected saved completion");
    const acceptedBytes = await readFile(primaryPath(stateRoot));
    failBeforePublish = true;

    await expect(
      store.setCompletion({
        expectedVersion: saved.snapshot.version,
        outcomeId: "4.1:ml:1",
        outcomeVersionId: "version-1",
        completed: false,
      }),
    ).rejects.toThrow(/simulated crash before publication/);

    expect(await readFile(primaryPath(stateRoot))).toEqual(acceptedBytes);
    expect((await makeStore(stateRoot).read()).completions[0]?.completed).toBe(true);
  });

  it("recovers a corrupt canonical document from the latest strict snapshot", async () => {
    const stateRoot = await temporaryStateRoot();
    const store = makeStore(stateRoot);
    const initial = await store.read();
    const saved = await store.setCompletion({
      expectedVersion: initial.version,
      outcomeId: "5.1:theory:1",
      outcomeVersionId: "version-1",
      completed: true,
    });
    if (saved.status !== "saved") throw new Error("Expected saved completion");

    await writeFile(
      primaryPath(stateRoot),
      JSON.stringify({
        schema_version: 1,
        revision: 999,
        completions: [],
        payload_hash: "0".repeat(64),
        note_text: "PRIVATE CONTENT MUST NOT SURVIVE",
        model_mastery_score: 0.99,
      }),
      "utf8",
    );

    const recovered = await makeStore(stateRoot).read();
    expect(recovered).toMatchObject({
      recovered: true,
      revision: 1,
      completions: [{ outcomeId: "5.1:theory:1", completed: true }],
    });
    const repaired = await readFile(primaryPath(stateRoot), "utf8");
    expect(repaired).not.toMatch(/PRIVATE CONTENT|note_text|mastery|score/);
  });

  it("recovers a missing canonical document from its latest snapshot", async () => {
    const stateRoot = await temporaryStateRoot();
    const store = makeStore(stateRoot);
    const initial = await store.read();
    const saved = await store.setCompletion({
      expectedVersion: initial.version,
      outcomeId: "6.1:security:1",
      outcomeVersionId: "version-1",
      completed: true,
    });
    if (saved.status !== "saved") throw new Error("Expected saved completion");
    await unlink(primaryPath(stateRoot));

    const recovered = await makeStore(stateRoot).read();
    expect(recovered).toMatchObject({ recovered: true, version: saved.snapshot.version });
  });

  it("fails closed for corrupt state when no valid recovery snapshot exists", async () => {
    const stateRoot = await temporaryStateRoot();
    await mkdir(recoveryPath(stateRoot), { recursive: true });
    await writeFile(primaryPath(stateRoot), "not-json\n", "utf8");

    await expect(makeStore(stateRoot).read()).rejects.toMatchObject({
      code: "recovery_unavailable",
    });
  });

  it("enforces the bounded completion count even for correctly hashed JSON", async () => {
    const stateRoot = await temporaryStateRoot();
    await mkdir(recoveryPath(stateRoot), { recursive: true });
    const completions = Array.from({ length: 10_001 }, (_, index) => ({
      outcome_id: `outcome-${String(index).padStart(5, "0")}`,
      outcome_version_id: "version-1",
      completed: false,
      completed_at: null,
    }));
    const payload = { schema_version: 1, revision: 1, completions };
    const payloadHash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    await writeFile(
      primaryPath(stateRoot),
      `${JSON.stringify({ ...payload, payload_hash: payloadHash })}\n`,
      "utf8",
    );

    await expect(makeStore(stateRoot).read()).rejects.toMatchObject({
      code: "recovery_unavailable",
    });
  });

  it("rejects symlinked descendants rather than leaving the configured state root", async () => {
    const stateRoot = await temporaryStateRoot();
    const outside = await temporaryStateRoot();
    await symlink(outside, join(stateRoot, "progress"));

    await expect(makeStore(stateRoot).read()).rejects.toMatchObject({ code: "unsafe_path" });
    expect(await readdir(outside)).toEqual([]);
  });
});
