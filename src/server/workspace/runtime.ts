import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";

import type { LearningDayId } from "../../shared/api.js";
import { sanitizedChildEnvironment } from "../config.js";
import { buildParticipantStarter, type CurriculumService } from "../curriculum/service.js";
import type {
  LinkedSectionDescriptor,
  ParticipantFileDiscovery,
  WorkspaceRepositoryStateReader,
} from "./service.js";

const execFileAsync = promisify(execFile);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export class CurriculumParticipantFileDiscovery implements ParticipantFileDiscovery {
  constructor(private readonly curriculum: Pick<CurriculumService, "readRepositoryDay">) {}

  async resolveLinkedSection(sectionId: string): Promise<LinkedSectionDescriptor | null> {
    const match = /^(\d+)\.(\d+)$/.exec(sectionId);
    if (!match) return null;
    const dayNumber = Number(match[1]);
    if (dayNumber < 0 || dayNumber > 7) return null;
    const sections = await this.curriculum.readRepositoryDay(`day${dayNumber}` as LearningDayId);
    const section = sections.find((candidate) => candidate.sectionId === sectionId);
    const target = section?.participantTarget;
    if (!section || !target) return null;
    const [directory, filename, ...rest] = target.relativePath.split("/");
    if (!directory || !filename || rest.length > 0) return null;
    const starter = buildParticipantStarter(section.sectionId, section.title);
    if (sha256(starter) !== target.starterHash) return null;
    return {
      section_id: section.sectionId,
      directory_relative_path: directory,
      source_hash: target.sectionSourceHash,
      participant_files: [
        {
          filename,
          declaration_hash: target.declarationHash,
          starter: {
            provenance: "application-sanitized-visible-scaffold-v1",
            content: starter,
            content_hash: target.starterHash,
          },
          cursor_line: target.cursorLine,
        },
      ],
    };
  }
}

export class GitWorkspaceRepositoryStateReader implements WorkspaceRepositoryStateReader {
  async read(canonicalAisbRoot: string): Promise<unknown> {
    const options = {
      cwd: canonicalAisbRoot,
      env: sanitizedChildEnvironment(),
      timeout: 5_000,
      maxBuffer: 64 * 1024,
      encoding: "utf8" as const,
    };
    const [{ stdout: topLevelOutput }, { stdout: commonDirectoryOutput }, { stdout: revisionOutput }] =
      await Promise.all([
        execFileAsync("git", ["rev-parse", "--show-toplevel"], options),
        execFileAsync("git", ["rev-parse", "--git-common-dir"], options),
        execFileAsync("git", ["rev-parse", "HEAD"], options),
      ]);
    const topLevel = await realpath(topLevelOutput.trim());
    const configured = await realpath(canonicalAisbRoot);
    if (topLevel !== configured) throw new Error("AISB Git root mismatch");
    const rawCommonDirectory = commonDirectoryOutput.trim();
    const commonDirectory = await realpath(
      isAbsolute(rawCommonDirectory) ? rawCommonDirectory : resolve(configured, rawCommonDirectory),
    );
    return {
      repository_identity: sha256(`${configured}\0${commonDirectory}`),
      revision: revisionOutput.trim(),
    };
  }
}
