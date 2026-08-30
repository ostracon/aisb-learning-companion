import { mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  TutorThreadBindingStore,
  type TutorThreadBindingAtomicStep,
  type TutorThreadBindingStoreDependencies,
} from "./thread-binding-store";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryStateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "aisb-tutor-bindings-test-"));
  temporaryRoots.push(root);
  return root;
}

function idSequence(prefix = "binding-temp"): () => string {
  let sequence = 0;
  return () => `${prefix}-${String(++sequence).padStart(4, "0")}`;
}

function makeStore(
  stateRoot: string,
  options: {
    readonly times?: readonly string[];
    readonly onAtomicStep?: TutorThreadBindingStoreDependencies["on_atomic_step"];
  } = {},
): TutorThreadBindingStore {
  let timeIndex = 0;
  const times = options.times ?? ["2026-08-29T18:00:00.000Z"];
  return new TutorThreadBindingStore(stateRoot, {
    now() {
      const value = times[Math.min(timeIndex, times.length - 1)] ?? "2026-08-29T18:00:00.000Z";
      timeIndex += 1;
      return new Date(value);
    },
    create_id: idSequence(),
    ...(options.onAtomicStep === undefined ? {} : { on_atomic_step: options.onAtomicStep }),
  });
}

function binding(threadId = "thread-001") {
  return {
    chatId: "chat:4f5052ce-6989-4e4d-82c8-44adb8d2ef61",
    threadId,
    model: "gpt-5.6-sol",
    permissionProfile: "aisb-tutor",
  };
}

function primaryPath(stateRoot: string): string {
  return join(stateRoot, "tutor/thread-bindings/bindings.json");
}

describe("TutorThreadBindingStore metadata contract", () => {
  it("persists only strict binding metadata and reopens it with a stable CAS version", async () => {
    const stateRoot = await temporaryStateRoot();
    const store = makeStore(stateRoot);
    const empty = await store.read();
    expect(empty).toMatchObject({ revision: 0, bindings: [], recovered: false });

    const saved = await store.upsert({
      scopeKey: "event:aisb-2026-017",
      expectedVersion: empty.version,
      binding: binding(),
    });
    expect(saved.status).toBe("saved");
    if (saved.status !== "saved") throw new Error("Expected saved binding");
    expect(saved.snapshot.revision).toBe(1);
    expect(saved.binding).toEqual({
      scopeKey: "event:aisb-2026-017",
      ...binding(),
      updatedAt: "2026-08-29T18:00:00.000Z",
    });

    const raw = await readFile(primaryPath(stateRoot), "utf8");
    const onDisk = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(onDisk).sort()).toEqual(["bindings", "payloadHash", "revision", "schemaVersion"]);
    expect(raw).not.toMatch(/message|prompt|note|auth|api.?key|credential/i);

    const reopened = makeStore(stateRoot);
    const snapshot = await reopened.read();
    expect(snapshot).toEqual({ ...saved.snapshot, recovered: false });
    expect(await reopened.readScope("event:aisb-2026-017")).toEqual({
      version: saved.snapshot.version,
      binding: saved.binding,
      recovered: false,
    });
  });

  it("treats an identical retry as unchanged and updates timestamps monotonically", async () => {
    const stateRoot = await temporaryStateRoot();
    const store = makeStore(stateRoot, {
      times: ["2026-08-29T18:00:00.000Z", "2026-08-29T17:59:00.000Z"],
    });
    const empty = await store.read();
    const first = await store.upsert({
      scopeKey: "day:day1",
      expectedVersion: empty.version,
      binding: binding("thread-001"),
    });
    if (first.status !== "saved") throw new Error("Expected initial save");

    const unchanged = await store.upsert({
      scopeKey: "day:day1",
      expectedVersion: first.snapshot.version,
      binding: binding("thread-001"),
    });
    expect(unchanged.status).toBe("unchanged");
    if (unchanged.status !== "unchanged") throw new Error("Expected unchanged retry");
    expect(unchanged.snapshot.version).toBe(first.snapshot.version);
    expect(unchanged.binding.updatedAt).toBe("2026-08-29T18:00:00.000Z");

    const updated = await store.upsert({
      scopeKey: "day:day1",
      expectedVersion: unchanged.snapshot.version,
      binding: binding("thread-002"),
    });
    expect(updated.status).toBe("saved");
    if (updated.status !== "saved") throw new Error("Expected updated binding");
    expect(updated.snapshot.revision).toBe(2);
    expect(Date.parse(updated.binding.updatedAt)).toBeGreaterThan(Date.parse(unchanged.binding.updatedAt));
  });

  it("supports CAS-safe deletion without advancing revision for a missing scope", async () => {
    const stateRoot = await temporaryStateRoot();
    const store = makeStore(stateRoot);
    const initial = await store.read();
    const missing = await store.delete({ scopeKey: "day:day7", expectedVersion: initial.version });
    expect(missing).toMatchObject({ status: "unchanged", snapshot: { revision: 0 } });
    if (missing.status !== "unchanged") throw new Error("Expected missing delete to be unchanged");

    const saved = await store.upsert({
      scopeKey: "day:day1",
      expectedVersion: missing.snapshot.version,
      binding: binding(),
    });
    if (saved.status !== "saved") throw new Error("Expected saved binding");
    const deleted = await store.delete({
      scopeKey: "day:day1",
      expectedVersion: saved.snapshot.version,
    });
    expect(deleted).toMatchObject({ status: "deleted", snapshot: { revision: 2, bindings: [] } });
  });

  it("rejects message, note, auth, and credential-like values before writing a store", async () => {
    const stateRoot = await temporaryStateRoot();
    const store = makeStore(stateRoot);
    const empty = await store.read();
    const base = {
      scopeKey: "day:day1",
      expectedVersion: empty.version,
      binding: binding(),
    };

    await expect(store.upsert({ ...base, message: "persist this tutor turn" })).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(
      store.upsert({ ...base, binding: { ...base.binding, noteContent: "private learner note" } }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      store.upsert({ ...base, binding: { ...base.binding, auth: { token: "secret" } } }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      store.upsert({
        ...base,
        binding: { ...base.binding, threadId: ["sk", "proj", "credential-canary"].join("-") },
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(readFile(primaryPath(stateRoot))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("TutorThreadBindingStore serialization and CAS", () => {
  it("serializes concurrent mutations so one stale writer conflicts instead of being lost", async () => {
    const stateRoot = await temporaryStateRoot();
    const store = makeStore(stateRoot, {
      times: ["2026-08-29T18:00:00.000Z", "2026-08-29T18:00:01.000Z"],
    });
    const initial = await store.read();

    const results = await Promise.all([
      store.upsert({
        scopeKey: "day:day1",
        expectedVersion: initial.version,
        binding: binding("thread-day1"),
      }),
      store.upsert({
        scopeKey: "day:day2",
        expectedVersion: initial.version,
        binding: binding("thread-day2"),
      }),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(["conflict", "saved"]);
    const current = await store.read();
    expect(current.revision).toBe(1);
    expect(current.bindings).toHaveLength(1);
    expect(current.bindings[0]?.threadId).toBe("thread-day1");
  });

  it("returns the current snapshot on a stale CAS token without touching bytes", async () => {
    const stateRoot = await temporaryStateRoot();
    const store = makeStore(stateRoot);
    const initial = await store.read();
    const first = await store.upsert({
      scopeKey: "day:day1",
      expectedVersion: initial.version,
      binding: binding(),
    });
    if (first.status !== "saved") throw new Error("Expected saved binding");
    const bytesBefore = await readFile(primaryPath(stateRoot));

    const conflict = await store.upsert({
      scopeKey: "day:day2",
      expectedVersion: initial.version,
      binding: binding("thread-other"),
    });
    expect(conflict).toMatchObject({ status: "conflict", current: { version: first.snapshot.version } });
    expect(await readFile(primaryPath(stateRoot))).toEqual(bytesBefore);
  });
});

describe("TutorThreadBindingStore atomicity and recovery", () => {
  it("keeps the last accepted document intact when a write fails before publication", async () => {
    const stateRoot = await temporaryStateRoot();
    let failBeforePublish = false;
    const hook = async (
      step: TutorThreadBindingAtomicStep,
      details: Readonly<{ target: string; mode: "replace" | "exclusive" }>,
    ) => {
      if (
        failBeforePublish &&
        step === "before_publish" &&
        details.mode === "replace" &&
        details.target === "tutor/thread-bindings/bindings.json"
      ) {
        throw new Error("simulated crash before publication");
      }
    };
    const store = makeStore(stateRoot, { onAtomicStep: hook });
    const initial = await store.read();
    const accepted = await store.upsert({
      scopeKey: "day:day1",
      expectedVersion: initial.version,
      binding: binding("thread-accepted"),
    });
    if (accepted.status !== "saved") throw new Error("Expected accepted binding");
    const acceptedBytes = await readFile(primaryPath(stateRoot));
    failBeforePublish = true;

    await expect(
      store.upsert({
        scopeKey: "day:day1",
        expectedVersion: accepted.snapshot.version,
        binding: binding("thread-never-published"),
      }),
    ).rejects.toThrow(/simulated crash before publication/);
    expect(await readFile(primaryPath(stateRoot))).toEqual(acceptedBytes);
    expect((await makeStore(stateRoot).read()).bindings[0]?.threadId).toBe("thread-accepted");
  });

  it("recognizes a committed CAS revision after a simulated crash immediately after publication", async () => {
    const stateRoot = await temporaryStateRoot();
    let failAfterPublish = false;
    const store = makeStore(stateRoot, {
      onAtomicStep(step, details) {
        if (
          failAfterPublish &&
          step === "published" &&
          details.mode === "replace" &&
          details.target === "tutor/thread-bindings/bindings.json"
        ) {
          throw new Error("simulated crash after publication");
        }
      },
    });
    const initial = await store.read();
    const accepted = await store.upsert({
      scopeKey: "day:day1",
      expectedVersion: initial.version,
      binding: binding("thread-v1"),
    });
    if (accepted.status !== "saved") throw new Error("Expected accepted binding");
    failAfterPublish = true;

    await expect(
      store.upsert({
        scopeKey: "day:day1",
        expectedVersion: accepted.snapshot.version,
        binding: binding("thread-v2"),
      }),
    ).rejects.toThrow(/simulated crash after publication/);

    const restarted = makeStore(stateRoot);
    const committed = await restarted.read();
    expect(committed).toMatchObject({ revision: 2, bindings: [{ threadId: "thread-v2" }] });
    const staleRetry = await restarted.upsert({
      scopeKey: "day:day1",
      expectedVersion: accepted.snapshot.version,
      binding: binding("thread-v2"),
    });
    expect(staleRetry.status).toBe("conflict");
  });

  it("recovers a corrupt canonical file from the latest immutable snapshot and discards untrusted fields", async () => {
    const stateRoot = await temporaryStateRoot();
    const store = makeStore(stateRoot);
    const initial = await store.read();
    const saved = await store.upsert({
      scopeKey: "event:aisb-2026-042",
      expectedVersion: initial.version,
      binding: binding("thread-valid"),
    });
    if (saved.status !== "saved") throw new Error("Expected saved binding");

    await writeFile(
      primaryPath(stateRoot),
      JSON.stringify({
        schemaVersion: 1,
        revision: 999,
        bindings: [],
        payloadHash: "0".repeat(64),
        message: "must not survive recovery",
        auth: { apiKey: "must-not-survive" },
      }),
      "utf8",
    );

    const recovered = await makeStore(stateRoot).read();
    expect(recovered).toMatchObject({
      recovered: true,
      revision: 1,
      bindings: [{ threadId: "thread-valid" }],
    });
    const repaired = await readFile(primaryPath(stateRoot), "utf8");
    expect(repaired).not.toMatch(/message|auth|apiKey|must-not-survive/);
    expect((JSON.parse(repaired) as { payloadHash: string }).payloadHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("recovers a missing canonical file from the latest snapshot", async () => {
    const stateRoot = await temporaryStateRoot();
    const store = makeStore(stateRoot);
    const initial = await store.read();
    const saved = await store.upsert({
      scopeKey: "day:day3",
      expectedVersion: initial.version,
      binding: binding("thread-day3"),
    });
    if (saved.status !== "saved") throw new Error("Expected saved binding");
    await unlink(primaryPath(stateRoot));

    const recovered = await makeStore(stateRoot).read();
    expect(recovered).toMatchObject({ recovered: true, version: saved.snapshot.version });
    expect(recovered.bindings[0]?.threadId).toBe("thread-day3");
  });

  it("fails closed when the canonical file is corrupt and no recovery exists", async () => {
    const stateRoot = await temporaryStateRoot();
    const directory = join(stateRoot, "tutor/thread-bindings");
    await mkdir(join(directory, "recovery"), { recursive: true });
    await writeFile(join(directory, "bindings.json"), "not-json\n", "utf8");

    await expect(makeStore(stateRoot).read()).rejects.toMatchObject({ code: "recovery_unavailable" });
  });

  it("does not mistake corrupt recovery residue for a brand-new empty store", async () => {
    const stateRoot = await temporaryStateRoot();
    const recoveryDirectory = join(stateRoot, "tutor/thread-bindings/recovery");
    await mkdir(recoveryDirectory, { recursive: true });
    await writeFile(
      join(recoveryDirectory, "000000000001-aaaaaaaaaaaaaaaa.json"),
      "truncated recovery bytes",
      "utf8",
    );

    await expect(makeStore(stateRoot).read()).rejects.toMatchObject({ code: "recovery_unavailable" });
    await expect(readFile(primaryPath(stateRoot))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects symlinked state descendants instead of reading or writing outside the state root", async () => {
    const stateRoot = await temporaryStateRoot();
    const outside = await temporaryStateRoot();
    await mkdir(join(stateRoot, "tutor"));
    await symlink(outside, join(stateRoot, "tutor/thread-bindings"));

    await expect(makeStore(stateRoot).read()).rejects.toMatchObject({ code: "unsafe_path" });
    await expect(readFile(join(outside, "bindings.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
