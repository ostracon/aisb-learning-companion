import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CurriculumService } from "./service.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(instructions: string) {
  const root = await mkdtemp(join(tmpdir(), "aisb-curriculum-"));
  roots.push(root);
  const section = join(root, "1.1-example");
  await mkdir(section);
  await writeFile(join(section, "README.md"), [
    "# Example section",
    "",
    "**Exercises:** [Open the participant instructions](section1_instructions.md)",
    "",
    "| Category | Prerequisites | Learning outcomes |",
    "| --- | --- | --- |",
    "| Engineering | - | Build a safe participant workflow. |",
    "| Engineering | - | Explain why the workflow is safe. |",
  ].join("\n"));
  await writeFile(join(section, "section1_instructions.md"), instructions);
  return { root, section, service: new CurriculumService(root) };
}

describe("participant target metadata", () => {
  it("extracts only the declared answer path and never projects folded content", async () => {
    const { service } = await fixture([
      "Create a file named `day1_answers.py` in the `1.1-example` directory.",
      "",
      "<details><summary>Reference solution</summary>DO_NOT_PROJECT_THIS</details>",
    ].join("\n"));

    const [section] = await service.readDay("day1");
    expect(section?.participantTarget).toMatchObject({
      relativePath: "1.1-example/day1_answers.py",
      declaredByPath: "1.1-example/section1_instructions.md",
      state: "missing",
    });
    expect(section?.participantTarget?.declarationHash).toMatch(/^[a-f0-9]{64}$/);
    expect(section?.participantTarget?.sectionSourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(section?.participantTarget?.starterHash).toMatch(/^[a-f0-9]{64}$/);
    expect(section?.participantTarget?.cursorLine).toBe(5);
    expect(section?.outcomes.map((outcome) => outcome.outcomeId)).toEqual([
      "1.1:engineering:1",
      "1.1:engineering:2",
    ]);
    expect(JSON.stringify(section)).not.toContain("DO_NOT_PROJECT_THIS");
  });

  it("reports regular files separately from blocked directories", async () => {
    const { section, service } = await fixture("Create `day1_answers.py` in `1.1-example/`.");
    const target = join(section, "day1_answers.py");
    await writeFile(target, "# learner work\n");
    expect((await service.readDay("day1"))[0]?.participantTarget?.state).toBe("file");
    await rm(target);
    await mkdir(target);
    expect((await service.readDay("day1"))[0]?.participantTarget?.state).toBe("blocked");
  });

  it("does not guess when participant instructions declare multiple targets", async () => {
    const { service } = await fixture([
      "Create `day1_answers.py` in `1.1-example/`.",
      "Create `day1_answers.md` in `1.1-example/`.",
    ].join("\n"));
    expect((await service.readDay("day1"))[0]?.participantTarget).toBeUndefined();
  });

  it("projects the repository Day 0 setup as a first-class preparation section", async () => {
    const { root, service } = await fixture("Create `day1_answers.py` in `1.1-example/`.");
    const setup = join(root, "day0-setup");
    await mkdir(setup);
    await writeFile(join(setup, "README.md"), [
      "Welcome to AISB.",
      "",
      "**Exercises:** [Open setup](day0_instructions.md)",
    ].join("\n"));
    await writeFile(
      join(setup, "day0_instructions.md"),
      "Create a file named `day0_answers.py` in the `day0-setup` directory.",
    );

    const sections = await service.readDay("day0");
    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({
      sectionId: "0.1",
      title: "Day 0 setup",
      sourcePath: "day0-setup/README.md",
      participantTarget: { relativePath: "day0-setup/day0_answers.py" },
    });
  });

  it("keeps the visit schedule-only and maps programme Day 5 to repository Day 5", async () => {
    const { root, service } = await fixture("Create `day1_answers.py` in `1.1-example/`.");
    const modelEditing = join(root, "5.1-model-editing");
    await mkdir(modelEditing);
    await writeFile(join(modelEditing, "README.md"), [
      "# 5.1 — Model editing",
      "",
      "| Area | Prerequisites | Main learnings going out |",
      "| --- | --- | --- |",
      "| Security | - | Threat-model who can edit model weights. |",
    ].join("\n"));

    expect(await service.readDay("day4")).toEqual([]);
    expect(await service.readDay("day5")).toEqual([
      expect.objectContaining({ sectionId: "5.1", sourcePath: "5.1-model-editing/README.md" }),
    ]);
    expect(await service.readRepositoryDay("day4")).toEqual([]);
    expect(await service.readRepositoryDay("day5")).toEqual([
      expect.objectContaining({ sectionId: "5.1", sourcePath: "5.1-model-editing/README.md" }),
    ]);
    expect((await service.readAllRepositoryDays()).day5).toHaveLength(1);
  });
});
