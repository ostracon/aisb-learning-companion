import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type {
  CurriculumSectionView,
  LearningDayId,
  OutcomeView,
  ParticipantTargetView,
} from "../../shared/api.js";
import { assertReadableAisbPath } from "../policy/source-policy.js";

const sectionDirectoryPattern = /^(\d+)\.(\d+)-(.+)$/;
const rowPattern = /^\|\s*(Engineering|ML|Security|Theory)\s*\|.*?\|\s*(.*?)\s*\|\s*$/i;
const participantInstructionLinkPattern = /\]\((?:\.\/)?([^()/\s]+_instructions\.md)(?:#[^)]*)?\)/giu;
const participantAnswerDeclarationPattern =
  /\bcreat(?:e|ing)\b[^\n]{0,180}?`((?:[A-Za-z0-9._-]+\/)?day\d+_answers\.(?:py|md|ipynb))`/giu;

/**
 * Programme day 4 is schedule-only and has no standalone exercise folder.
 * The following content day is authored under the repo's historical Day 4
 * section IDs. Keep this mismatch explicit instead of guessing from event
 * titles or silently dropping material.
 */
export const CURRICULUM_SOURCE_DAY_BY_PROGRAMME_DAY: Readonly<
  Record<LearningDayId, number | null>
> = Object.freeze({
  day0: 0,
  day1: 1,
  day2: 2,
  day3: 3,
  day4: null,
  day5: 4,
  day6: 6,
  day7: 7,
});

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function fullHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function buildParticipantStarter(sectionId: string, title: string): string {
  return [
    "# AISB participant answer file",
    `# ${sectionId} · ${title}`,
    "",
    "# %%",
    "",
  ].join("\n");
}

function titleFromReadme(markdown: string, fallback: string): string {
  const heading = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return heading ?? fallback;
}

function parseOutcomes(sectionId: string, sourcePath: string, markdown: string): OutcomeView[] {
  const outcomes: OutcomeView[] = [];
  const ordinalByCategory = new Map<OutcomeView["category"], number>();
  for (const line of markdown.split(/\r?\n/u)) {
    const match = line.match(rowPattern);
    if (!match) continue;
    const category = match[1]?.toLowerCase() as OutcomeView["category"];
    const text = match[2]?.trim();
    if (!text || text === "-") continue;
    const ordinal = (ordinalByCategory.get(category) ?? 0) + 1;
    ordinalByCategory.set(category, ordinal);
    const versionId = stableHash(`${sourcePath}\0${category}\0${text}`);
    outcomes.push({
      outcomeId: `${sectionId}:${category}:${ordinal}`,
      versionId,
      category,
      text,
      sourcePath,
    });
  }
  return outcomes;
}

async function pathState(path: string): Promise<ParticipantTargetView["state"]> {
  try {
    const metadata = await lstat(path);
    return metadata.isFile() && !metadata.isSymbolicLink() ? "file" : "blocked";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

async function parseParticipantTarget(
  aisbRoot: string,
  sectionDirectory: string,
  sectionId: string,
  title: string,
  readme: string,
): Promise<ParticipantTargetView | undefined> {
  const linkedInstructionNames = new Set(
    [...readme.matchAll(participantInstructionLinkPattern)].map((match) => match[1]!),
  );
  if (linkedInstructionNames.size !== 1) return undefined;
  const instructionName = [...linkedInstructionNames][0]!;
  if (basename(instructionName) !== instructionName) return undefined;
  const declaredByPath = `${sectionDirectory}/${instructionName}`;
  const instructionPath = join(aisbRoot, sectionDirectory, instructionName);
  let instructions: string;
  try {
    const metadata = await lstat(instructionPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return undefined;
    instructions = await readFile(instructionPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }

  const declaredNames = new Set<string>();
  for (const match of instructions.matchAll(participantAnswerDeclarationPattern)) {
    const declared = match[1]!;
    const parts = declared.split("/");
    if (parts.length > 2 || (parts.length === 2 && parts[0] !== sectionDirectory)) continue;
    const filename = parts.at(-1)!;
    if (!/^day\d+_answers\.(?:py|md|ipynb)$/iu.test(filename)) continue;
    declaredNames.add(filename);
  }
  if (declaredNames.size !== 1) return undefined;

  const filename = [...declaredNames][0]!;
  const relativePath = `${sectionDirectory}/${filename}`;
  const declarationHash = createHash("sha256")
    .update(`${declaredByPath}\0${filename}\0${createHash("sha256").update(instructions).digest("hex")}`)
    .digest("hex");
  const starter = buildParticipantStarter(sectionId, title);
  return {
    relativePath,
    declaredByPath,
    declarationHash,
    sectionSourceHash: fullHash(readme),
    starterHash: fullHash(starter),
    cursorLine: 5,
    state: await pathState(join(aisbRoot, relativePath)),
  };
}

export class CurriculumService {
  constructor(private readonly aisbRoot: string) {}

  async readDay(dayId: LearningDayId): Promise<CurriculumSectionView[]> {
    const dayNumber = CURRICULUM_SOURCE_DAY_BY_PROGRAMME_DAY[dayId];
    if (dayNumber === null) return [];
    return this.#readSourceDay(dayNumber);
  }

  /**
   * Read the repository's own day identity without applying the programme
   * calendar projection. Study navigation uses this boundary so a schedule
   * renumbering cannot hide or rename repository sections.
   */
  async readRepositoryDay(dayId: LearningDayId): Promise<CurriculumSectionView[]> {
    return this.#readSourceDay(Number(dayId.slice(3)));
  }

  async #readSourceDay(dayNumber: number): Promise<CurriculumSectionView[]> {
    const entries = await readdir(this.aisbRoot, { withFileTypes: true });
    const sections: CurriculumSectionView[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const match = entry.name.match(sectionDirectoryPattern);
      const isDayZeroSetup = dayNumber === 0 && entry.name === "day0-setup";
      if (!isDayZeroSetup && (!match || Number(match[1]) !== dayNumber)) continue;
      const sectionId = isDayZeroSetup ? "0.1" : `${match![1]}.${match![2]}`;
      const sourcePath = `${entry.name}/README.md`;
      const decision = await assertReadableAisbPath(this.aisbRoot, sourcePath);
      if (!decision.allowed) continue;
      const markdown = await readFile(join(this.aisbRoot, sourcePath), "utf8");
      const title = titleFromReadme(markdown, isDayZeroSetup ? "Day 0 setup" : entry.name);
      const participantTarget = await parseParticipantTarget(
        this.aisbRoot,
        entry.name,
        sectionId,
        title,
        markdown,
      );
      sections.push({
        sectionId,
        title,
        sourcePath,
        outcomes: parseOutcomes(sectionId, sourcePath, markdown),
        ...(participantTarget ? { participantTarget } : {}),
      });
    }

    return sections.sort((left, right) => left.sectionId.localeCompare(right.sectionId, undefined, { numeric: true }));
  }

  async readAllDays(): Promise<Partial<Record<LearningDayId, CurriculumSectionView[]>>> {
    const result: Partial<Record<LearningDayId, CurriculumSectionView[]>> = {};
    for (let day = 0; day <= 7; day += 1) {
      const dayId = `day${day}` as LearningDayId;
      result[dayId] = await this.readDay(dayId);
    }
    return result;
  }

  async readAllRepositoryDays(): Promise<Partial<Record<LearningDayId, CurriculumSectionView[]>>> {
    const result: Partial<Record<LearningDayId, CurriculumSectionView[]>> = {};
    for (let day = 0; day <= 7; day += 1) {
      const dayId = `day${day}` as LearningDayId;
      result[dayId] = await this.readRepositoryDay(dayId);
    }
    return result;
  }
}
