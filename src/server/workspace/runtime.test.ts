import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { CurriculumSectionView } from "../../shared/api.js";
import { buildParticipantStarter } from "../curriculum/service.js";
import { CurriculumParticipantFileDiscovery } from "./runtime.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

describe("CurriculumParticipantFileDiscovery", () => {
  it("turns only server-projected participant metadata into a safe launch descriptor", async () => {
    const starter = buildParticipantStarter("1.1", "Example");
    const section: CurriculumSectionView = {
      sectionId: "1.1",
      title: "Example",
      sourcePath: "1.1-example/README.md",
      outcomes: [],
      participantTarget: {
        relativePath: "1.1-example/day1_answers.py",
        declaredByPath: "1.1-example/section1_instructions.md",
        declarationHash: hash("declaration"),
        sectionSourceHash: hash("source"),
        starterHash: hash(starter),
        cursorLine: 5,
        state: "missing",
      },
    };
    const discovery = new CurriculumParticipantFileDiscovery({
      async readRepositoryDay() {
        return [section];
      },
    });

    await expect(discovery.resolveLinkedSection("1.1")).resolves.toEqual({
      section_id: "1.1",
      directory_relative_path: "1.1-example",
      source_hash: hash("source"),
      participant_files: [{
        filename: "day1_answers.py",
        declaration_hash: hash("declaration"),
        starter: {
          provenance: "application-sanitized-visible-scaffold-v1",
          content: starter,
          content_hash: hash(starter),
        },
        cursor_line: 5,
      }],
    });
  });

  it("returns no descriptor for unlinked, malformed, or projection-mismatched sections", async () => {
    const discovery = new CurriculumParticipantFileDiscovery({ async readRepositoryDay() { return []; } });
    await expect(discovery.resolveLinkedSection("1.1")).resolves.toBeNull();
    await expect(discovery.resolveLinkedSection("nope")).resolves.toBeNull();
  });
});
