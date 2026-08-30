import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  EVENT_CURRICULUM_BINDINGS_LOGICAL_PATH,
  EventCurriculumBindingStore,
  EventCurriculumBindingStoreError,
  type EventCurriculumBindingAtomicStep,
} from "../../src/server/curriculum/event-binding-store.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryStateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "aisb-event-curriculum-bindings-"));
  temporaryRoots.push(root);
  return root;
}

function idSequence(): () => string {
  let value = 0;
  return () => `temporary-${String(++value).padStart(4, "0")}`;
}

describe("EventCurriculumBindingStore explicit mapping operations", () => {
  it("keeps absence explicit and persists ordered add, replace, and clear operations", async () => {
    const stateRoot = await temporaryStateRoot();
    const store = new EventCurriculumBindingStore(stateRoot, { createId: idSequence() });

    const initial = await store.read();
    expect(initial.bindings).toEqual([]);
    await expect(store.resolve("aisb-2026-016")).resolves.toEqual({
      status: "unmapped",
      eventBindingId: "aisb-2026-016",
      sectionIds: [],
      revision: initial.revision,
    });

    const first = await store.add(initial.revision, "aisb-2026-016", "2.1");
    const second = await store.add(first.revision, "aisb-2026-016", "2.2");
    expect(await store.resolve("aisb-2026-016")).toEqual({
      status: "mapped",
      source: "explicit",
      eventBindingId: "aisb-2026-016",
      sectionIds: ["2.1", "2.2"],
      revision: second.revision,
    });

    const replaced = await store.replace(second.revision, "aisb-2026-016", ["2.4", "2.1"]);
    expect(replaced.bindings[0]).toEqual({
      eventBindingId: "aisb-2026-016",
      sectionIds: ["2.4", "2.1"],
      source: "explicit",
    });

    const reopened = new EventCurriculumBindingStore(stateRoot, { createId: idSequence() });
    expect(await reopened.read()).toEqual(replaced);
    const cleared = await reopened.clear(replaced.revision, "aisb-2026-016");
    expect(cleared.bindings).toEqual([]);
    expect((await reopened.resolve("aisb-2026-016")).status).toBe("unmapped");

    const repeatedClear = await reopened.clear(cleared.revision, "aisb-2026-016");
    expect(repeatedClear.revision).toBe(cleared.revision);
  });

  it("sorts binding records deterministically without changing section order", async () => {
    const stateRoot = await temporaryStateRoot();
    const store = new EventCurriculumBindingStore(stateRoot, { createId: idSequence() });
    const initial = await store.read();
    const later = await store.replace(initial.revision, "aisb-2026-030", ["3.2", "3.1"]);
    const earlier = await store.replace(later.revision, "aisb-2026-002", ["1.2", "1.1"]);

    expect(earlier.bindings.map((binding) => binding.eventBindingId)).toEqual([
      "aisb-2026-002",
      "aisb-2026-030",
    ]);
    expect(earlier.bindings.map((binding) => binding.sectionIds)).toEqual([
      ["1.2", "1.1"],
      ["3.2", "3.1"],
    ]);
    const persisted = JSON.parse(
      await readFile(join(stateRoot, EVENT_CURRICULUM_BINDINGS_LOGICAL_PATH), "utf8"),
    ) as { bindings: { event_binding_id: string; section_ids: string[] }[] };
    expect(persisted.bindings).toEqual([
      { event_binding_id: "aisb-2026-002", section_ids: ["1.2", "1.1"] },
      { event_binding_id: "aisb-2026-030", section_ids: ["3.2", "3.1"] },
    ]);
  });
});

describe("EventCurriculumBindingStore validation and compare-and-swap", () => {
  it("allows exactly one concurrent writer for an expected revision", async () => {
    const store = new EventCurriculumBindingStore(await temporaryStateRoot(), {
      createId: idSequence(),
    });
    const initial = await store.read();
    const results = await Promise.allSettled([
      store.add(initial.revision, "aisb-2026-016", "2.1"),
      store.add(initial.revision, "aisb-2026-017", "2.2"),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(EventCurriculumBindingStoreError);
    expect(rejected.reason).toMatchObject({ code: "conflict" });
    expect((rejected.reason as EventCurriculumBindingStoreError).currentRevision).toBe(
      (await store.read()).revision,
    );
  });

  it("rejects malformed and duplicate identifiers without changing durable state", async () => {
    const stateRoot = await temporaryStateRoot();
    const store = new EventCurriculumBindingStore(stateRoot, { createId: idSequence() });
    const initial = await store.read();

    await expect(store.add(initial.revision, "event-16", "2.1")).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(store.add(initial.revision, "aisb-2026-016", "02.1")).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(store.replace(initial.revision, "aisb-2026-016", [])).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(
      store.replace(initial.revision, "aisb-2026-016", ["2.1", "2.1"]),
    ).rejects.toMatchObject({ code: "invalid_request" });

    const added = await store.add(initial.revision, "aisb-2026-016", "2.1");
    await expect(store.add(added.revision, "aisb-2026-016", "2.1")).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect((await store.read()).bindings).toEqual(added.bindings);
  });

  it("fails closed when persisted JSON has unknown or unordered fields", async () => {
    const stateRoot = await temporaryStateRoot();
    const store = new EventCurriculumBindingStore(stateRoot, { createId: idSequence() });
    await store.read();
    await writeFile(
      join(stateRoot, EVENT_CURRICULUM_BINDINGS_LOGICAL_PATH),
      `${JSON.stringify({
        schema_version: 1,
        revision: 1,
        bindings: [
          { event_binding_id: "aisb-2026-020", section_ids: ["2.1"] },
          { event_binding_id: "aisb-2026-010", section_ids: ["1.1"] },
        ],
        inferred: true,
      })}\n`,
      "utf8",
    );

    await expect(store.read()).rejects.toMatchObject({ code: "invalid_state" });
  });
});

describe("EventCurriculumBindingStore atomic publication and recovery", () => {
  it("preserves the accepted revision when publication fails before rename", async () => {
    const stateRoot = await temporaryStateRoot();
    let failPublication = false;
    const store = new EventCurriculumBindingStore(stateRoot, {
      createId: idSequence(),
      onAtomicStep(step: EventCurriculumBindingAtomicStep, details) {
        if (
          failPublication &&
          step === "before_publish" &&
          details.logicalPath === EVENT_CURRICULUM_BINDINGS_LOGICAL_PATH
        ) {
          throw new Error("simulated crash before binding publication");
        }
      },
    });
    const initial = await store.read();
    failPublication = true;

    await expect(store.add(initial.revision, "aisb-2026-016", "2.1")).rejects.toThrow(
      /simulated crash/,
    );
    expect(await store.read()).toEqual(initial);
  });

  it("restores the latest successfully published immutable recovery snapshot", async () => {
    const stateRoot = await temporaryStateRoot();
    const store = new EventCurriculumBindingStore(stateRoot, { createId: idSequence() });
    const initial = await store.read();
    const saved = await store.replace(initial.revision, "aisb-2026-016", ["2.1", "2.2"]);
    await writeFile(
      join(stateRoot, EVENT_CURRICULUM_BINDINGS_LOGICAL_PATH),
      "{ definitely not valid json\n",
      "utf8",
    );

    await expect(store.read()).rejects.toMatchObject({ code: "invalid_state" });
    const recovery = await store.recover();
    expect(recovery.status).toBe("recovered");
    expect(recovery.snapshot).toEqual(saved);
    expect(recovery.recoveryLogicalPath).toMatch(
      /^curriculum\/recovery\/event-bindings\/000000000002-[a-f0-9]{16}\.json$/,
    );
    expect(await store.read()).toEqual(saved);
  });
});
