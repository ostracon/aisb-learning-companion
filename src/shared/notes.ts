import { z } from "zod";

/**
 * Shared note-domain types and the canonical Markdown/frontmatter codec.
 *
 * Logical paths are state-root relative and are derived only from validated
 * application identities. Titles and mutable links never participate in a
 * filename, so renaming or rescheduling a note cannot move it accidentally.
 */

export const NOTE_SCHEMA_VERSION = 1 as const;
export const NOTE_KINDS = ["day", "lesson", "event", "ad_hoc"] as const;
export const NOTE_STATUSES = ["active", "archived", "cancelled", "orphaned"] as const;

function normalizedNoteHeading(title: string): string {
  return title.replace(/\s+/gu, " ").trim() || "Notes";
}

function noteTemplateForHeading(heading: string): string {
  return `# ${heading}\n\n## Raw Notes\n\n\n## Key ideas\n\n\n## Questions\n\n\n## Reflection\n\n`;
}

export function createNoteTemplate(title: string): string {
  return noteTemplateForHeading(normalizedNoteHeading(title));
}

const BLANK_NOTE_SKELETONS = [
  ["## Raw Notes", "## Key ideas", "## Questions", "## Reflection"],
  ["## Raw Notes", "## Key ideas", "## Questions", "## Answers", "## Reflection"],
  ["## Key ideas", "## Questions", "## Answers", "## Reflection"],
  ["## Key ideas", "## Questions", "## Reflection"],
] as const;

/**
 * Report whether the saved body contains learner-authored material rather than
 * only a current or legacy blank template. Metadata and title changes are not
 * learner content, and whitespace-only formatting does not create a marker.
 *
 * This display-only classifier is deliberately broader than the exact-match
 * migration guard: template migrations must never rewrite an ambiguous
 * body, while this marker can safely avoid a cosmetic false positive.
 */
export function noteHasLearnerContent(markdown: string): boolean {
  const nonBlankLines = markdown
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (nonBlankLines.length === 0) return false;

  const bodyLines = /^#(?:\s|$)/u.test(nonBlankLines[0] ?? "")
    ? nonBlankLines.slice(1)
    : nonBlankLines;
  return !BLANK_NOTE_SKELETONS.some((skeleton) =>
    skeleton.length === bodyLines.length
    && skeleton.every((line, index) => line === bodyLines[index]));
}

/**
 * Upgrade only exact, untouched templates from earlier heading layouts.
 * This removes the former separate `## Answers` heading so responses can sit
 * directly with their questions. Both pre-Raw-Notes shapes remain supported.
 *
 * Returning null for every other body ensures learner-authored Markdown is
 * never rewritten as part of a template migration.
 */
export function upgradeUntouchedNoteTemplate(markdown: string, expectedTitle: string): string | null {
  const match = markdown.match(
    /^# ([^\r\n]+)\n\n## Raw Notes\n\n\n## Key ideas\n\n\n## Questions\n\n\n## Answers\n\n\n## Reflection\n\n$/u,
  ) ?? markdown.match(
    /^# ([^\r\n]+)\n\n## Key ideas\n\n\n## Questions\n\n\n## Answers\n\n\n## Reflection\n\n$/u,
  ) ?? markdown.match(
    /^# ([^\r\n]+)\n\n## Key ideas\n\n\n## Questions\n\n\n## Reflection\n\n$/u,
  );
  const expectedHeading = normalizedNoteHeading(expectedTitle);
  return match?.[1] === expectedHeading ? noteTemplateForHeading(expectedHeading) : null;
}

export type NoteKind = (typeof NOTE_KINDS)[number];
export type NoteStatus = (typeof NOTE_STATUSES)[number];

export interface NoteLinks {
  readonly section_ids: readonly string[];
  readonly canonical_outcome_ids: readonly string[];
  readonly programme_day_id?: string;
  readonly event_binding_id?: string;
  readonly event_start?: string;
  readonly event_end?: string;
  readonly time_zone?: string;
  /** Immutable path identity for an ad-hoc note. */
  readonly creation_date?: string;
}

export interface NoteFrontmatter {
  readonly schema_version: typeof NOTE_SCHEMA_VERSION;
  readonly note_id: string;
  readonly note_kind: NoteKind;
  readonly title: string;
  readonly created_at: string;
  readonly last_modified_at: string;
  readonly revision: number;
  readonly status: NoteStatus;
  readonly links: NoteLinks;
}

export interface ParsedNoteMarkdown {
  readonly frontmatter: NoteFrontmatter;
  readonly markdown: string;
}

export type NoteLocator =
  | {
      readonly kind: "day";
      readonly programme_day_id: string;
    }
  | {
      readonly kind: "lesson";
      readonly section_id: string;
    }
  | {
      readonly kind: "event";
      readonly event_binding_id: string;
    }
  | {
      readonly kind: "ad_hoc";
      readonly creation_date: string;
      /** Present only for legacy timestamp-prefixed ad-hoc paths. */
      readonly timestamp_slug?: string;
      readonly note_id: string;
    };

export interface NoteRecord extends ParsedNoteMarkdown {
  readonly locator: NoteLocator;
  readonly logical_path: string;
  /** SHA-256 of the complete canonical Markdown file. */
  readonly content_hash: string;
}

export interface NoteSummary {
  readonly note_id: string;
  readonly note_kind: NoteKind;
  readonly title: string;
  readonly revision: number;
  readonly status: NoteStatus;
  readonly last_modified_at: string;
  readonly locator: NoteLocator;
  readonly logical_path: string;
  readonly content_hash: string;
  readonly has_learner_content: boolean;
}

export class NoteValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoteValidationError";
  }
}

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const PATH_IDENTIFIER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;
const LINK_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const RFC3339_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const AD_HOC_TIMESTAMP_PATTERN = /^\d{8}T\d{9}Z$/;

const PathIdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(PATH_IDENTIFIER_PATTERN)
  .refine((value) => value !== "." && value !== ".." && !value.includes(".."), {
    message: "must not contain a traversal segment",
  });

const LinkIdentifierSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(LINK_IDENTIFIER_PATTERN);

const CalendarDateSchema = z
  .string()
  .regex(DATE_PATTERN)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, "must be a real YYYY-MM-DD calendar date");

const InstantSchema = z
  .string()
  .max(40)
  .regex(RFC3339_PATTERN)
  .refine((value) => Number.isFinite(Date.parse(value)), "must be a valid RFC3339 timestamp");

const NoteLinksSchema = z
  .object({
    section_ids: z.array(LinkIdentifierSchema).max(64),
    canonical_outcome_ids: z.array(LinkIdentifierSchema).max(256),
    programme_day_id: LinkIdentifierSchema.optional(),
    event_binding_id: LinkIdentifierSchema.optional(),
    event_start: InstantSchema.optional(),
    event_end: InstantSchema.optional(),
    time_zone: z.string().min(1).max(100).optional(),
    creation_date: CalendarDateSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.section_ids).size !== value.section_ids.length) {
      context.addIssue({ code: "custom", path: ["section_ids"], message: "must be unique" });
    }
    if (new Set(value.canonical_outcome_ids).size !== value.canonical_outcome_ids.length) {
      context.addIssue({
        code: "custom",
        path: ["canonical_outcome_ids"],
        message: "must be unique",
      });
    }
    if (
      value.event_start !== undefined &&
      value.event_end !== undefined &&
      Date.parse(value.event_end) <= Date.parse(value.event_start)
    ) {
      context.addIssue({
        code: "custom",
        path: ["event_end"],
        message: "must be after event_start",
      });
    }
    if (value.time_zone !== undefined) {
      try {
        new Intl.DateTimeFormat("en", { timeZone: value.time_zone }).format(0);
      } catch {
        context.addIssue({
          code: "custom",
          path: ["time_zone"],
          message: "must be a valid IANA time zone",
        });
      }
    }
  });

const NoteFrontmatterSchema = z
  .object({
    schema_version: z.literal(NOTE_SCHEMA_VERSION),
    note_id: PathIdentifierSchema,
    note_kind: z.enum(NOTE_KINDS),
    title: z
      .string()
      .trim()
      .min(1)
      .max(240)
      .refine((value) => !CONTROL_CHARACTER_PATTERN.test(value), "must not contain controls"),
    created_at: InstantSchema,
    last_modified_at: InstantSchema,
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    status: z.enum(NOTE_STATUSES),
    links: NoteLinksSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (Date.parse(value.last_modified_at) < Date.parse(value.created_at)) {
      context.addIssue({
        code: "custom",
        path: ["last_modified_at"],
        message: "must not precede created_at",
      });
    }
    if (value.note_kind === "day" && value.links.programme_day_id === undefined) {
      context.addIssue({
        code: "custom",
        path: ["links", "programme_day_id"],
        message: "is required for a day note",
      });
    }
    if (value.note_kind === "lesson" && value.links.section_ids.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["links", "section_ids"],
        message: "must name the path-owning section first for a lesson note",
      });
    }
    if (value.note_kind === "event" && value.links.event_binding_id === undefined) {
      context.addIssue({
        code: "custom",
        path: ["links", "event_binding_id"],
        message: "is required for an event note",
      });
    }
    if (value.note_kind === "ad_hoc" && value.links.creation_date === undefined) {
      context.addIssue({
        code: "custom",
        path: ["links", "creation_date"],
        message: "is required for an ad-hoc note",
      });
    }
  });

function validationMessage(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "frontmatter"}: ${issue.message}`)
    .join("; ");
}

export function validatePathIdentifier(value: string, label = "identifier"): string {
  const result = PathIdentifierSchema.safeParse(value);
  if (!result.success) {
    throw new NoteValidationError(`${label}: ${validationMessage(result.error)}`);
  }
  return result.data;
}

export function validateCalendarDate(value: string, label = "date"): string {
  const result = CalendarDateSchema.safeParse(value);
  if (!result.success) {
    throw new NoteValidationError(`${label}: ${validationMessage(result.error)}`);
  }
  return result.data;
}

export function validateInstant(value: string, label = "instant"): string {
  const result = InstantSchema.safeParse(value);
  if (!result.success) {
    throw new NoteValidationError(`${label}: ${validationMessage(result.error)}`);
  }
  return result.data;
}

export function validateNoteFrontmatter(value: unknown): NoteFrontmatter {
  const result = NoteFrontmatterSchema.safeParse(value);
  if (!result.success) {
    throw new NoteValidationError(`invalid note frontmatter: ${validationMessage(result.error)}`);
  }
  const parsedLinks = result.data.links;
  const links: {
    section_ids: readonly string[];
    canonical_outcome_ids: readonly string[];
    programme_day_id?: string;
    event_binding_id?: string;
    event_start?: string;
    event_end?: string;
    time_zone?: string;
    creation_date?: string;
  } = {
    section_ids: Object.freeze([...result.data.links.section_ids]),
    canonical_outcome_ids: Object.freeze([...result.data.links.canonical_outcome_ids]),
  };
  if (parsedLinks.programme_day_id !== undefined) {
    links.programme_day_id = parsedLinks.programme_day_id;
  }
  if (parsedLinks.event_binding_id !== undefined) {
    links.event_binding_id = parsedLinks.event_binding_id;
  }
  if (parsedLinks.event_start !== undefined) links.event_start = parsedLinks.event_start;
  if (parsedLinks.event_end !== undefined) links.event_end = parsedLinks.event_end;
  if (parsedLinks.time_zone !== undefined) links.time_zone = parsedLinks.time_zone;
  if (parsedLinks.creation_date !== undefined) links.creation_date = parsedLinks.creation_date;
  return Object.freeze({ ...result.data, links });
}

export function validateNoteMarkdown(markdown: string): string {
  if (typeof markdown !== "string") {
    throw new NoteValidationError("markdown: expected a string");
  }
  if (new TextEncoder().encode(markdown).byteLength > 8 * 1024 * 1024) {
    throw new NoteValidationError("markdown: exceeds the 8 MiB note limit");
  }
  if (markdown.includes("\u0000")) {
    throw new NoteValidationError("markdown: must not contain a NUL byte");
  }
  return markdown;
}

export function makeAdHocTimestampSlug(instant: string): string {
  const normalized = new Date(validateInstant(instant)).toISOString();
  return normalized.replace(/[-:.]/g, "");
}

export function validateAdHocTimestampSlug(value: string): string {
  if (!AD_HOC_TIMESTAMP_PATTERN.test(value)) {
    throw new NoteValidationError(
      "timestamp_slug: expected a UTC slug such as 20260829T163254123Z",
    );
  }
  return value;
}

/** Return the canonical state-root-relative path for a note identity. */
export function noteLogicalPath(locator: NoteLocator): string {
  switch (locator.kind) {
    case "day":
      return `notes/days/${validatePathIdentifier(locator.programme_day_id, "programme_day_id")}/overview.md`;
    case "lesson":
      return `notes/lessons/${validatePathIdentifier(locator.section_id, "section_id")}/notes.md`;
    case "event":
      return `notes/events/${validatePathIdentifier(locator.event_binding_id, "event_binding_id")}/notes.md`;
    case "ad_hoc":
      return `notes/ad-hoc/${validateCalendarDate(locator.creation_date, "creation_date")}/${
        locator.timestamp_slug === undefined
          ? validatePathIdentifier(locator.note_id, "note_id")
          : `${validateAdHocTimestampSlug(locator.timestamp_slug)}-${validatePathIdentifier(locator.note_id, "note_id")}`
      }.md`;
  }
}

/** Enforce immutable identity fields and the logical-path shape. */
export function assertNoteMatchesLocator(
  frontmatter: NoteFrontmatter,
  locator: NoteLocator,
): void {
  if (frontmatter.note_kind !== locator.kind) {
    throw new NoteValidationError(
      `note_kind ${frontmatter.note_kind} does not match ${locator.kind} path`,
    );
  }
  switch (locator.kind) {
    case "day":
      if (frontmatter.links.programme_day_id !== locator.programme_day_id) {
        throw new NoteValidationError("day path does not match links.programme_day_id");
      }
      return;
    case "lesson":
      if (frontmatter.links.section_ids[0] !== locator.section_id) {
        throw new NoteValidationError("lesson path does not match the first links.section_ids value");
      }
      return;
    case "event":
      if (frontmatter.links.event_binding_id !== locator.event_binding_id) {
        throw new NoteValidationError("event path does not match links.event_binding_id");
      }
      return;
    case "ad_hoc":
      if (frontmatter.note_id !== locator.note_id) {
        throw new NoteValidationError("ad-hoc filename does not match note_id");
      }
      if (frontmatter.links.creation_date !== locator.creation_date) {
        throw new NoteValidationError("ad-hoc directory does not match links.creation_date");
      }
  }
}

function parseYamlScalar(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "";
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    // Accept uncomplicated human-edited YAML strings (for example
    // `status: active`) while keeping structured values JSON-shaped.
    return trimmed;
  }
}

export function parseNoteMarkdown(source: string): ParsedNoteMarkdown {
  if (typeof source !== "string" || source.length === 0) {
    throw new NoteValidationError("note file is empty");
  }
  const normalized = source.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines[0] !== "---") {
    throw new NoteValidationError("note file must start with YAML frontmatter");
  }
  const closingIndex = lines.indexOf("---", 1);
  if (closingIndex < 0) {
    throw new NoteValidationError("note frontmatter is missing its closing delimiter");
  }

  const record: Record<string, unknown> = {};
  for (const [offset, line] of lines.slice(1, closingIndex).entries()) {
    const separator = line.indexOf(":");
    if (separator <= 0) {
      throw new NoteValidationError(`frontmatter line ${offset + 2}: expected key: value`);
    }
    const key = line.slice(0, separator).trim();
    if (Object.hasOwn(record, key)) {
      throw new NoteValidationError(`frontmatter line ${offset + 2}: duplicate key ${key}`);
    }
    record[key] = parseYamlScalar(line.slice(separator + 1));
  }

  const body = lines.slice(closingIndex + 1);
  if (body[0] === "") body.shift();
  return Object.freeze({
    frontmatter: validateNoteFrontmatter(record),
    markdown: validateNoteMarkdown(body.join("\n")),
  });
}

/** Serialize the deliberately small, deterministic YAML subset used by notes. */
export function serializeNoteMarkdown(value: ParsedNoteMarkdown): string {
  const frontmatter = validateNoteFrontmatter(value.frontmatter);
  const markdown = validateNoteMarkdown(value.markdown);
  const lines = [
    "---",
    `schema_version: ${frontmatter.schema_version}`,
    `note_id: ${JSON.stringify(frontmatter.note_id)}`,
    `note_kind: ${JSON.stringify(frontmatter.note_kind)}`,
    `title: ${JSON.stringify(frontmatter.title)}`,
    `created_at: ${JSON.stringify(frontmatter.created_at)}`,
    `last_modified_at: ${JSON.stringify(frontmatter.last_modified_at)}`,
    `revision: ${frontmatter.revision}`,
    `status: ${JSON.stringify(frontmatter.status)}`,
    `links: ${JSON.stringify(frontmatter.links)}`,
    "---",
    "",
    markdown,
  ];
  return lines.join("\n");
}

export function noteSummary(record: NoteRecord): NoteSummary {
  return Object.freeze({
    note_id: record.frontmatter.note_id,
    note_kind: record.frontmatter.note_kind,
    title: record.frontmatter.title,
    revision: record.frontmatter.revision,
    status: record.frontmatter.status,
    last_modified_at: record.frontmatter.last_modified_at,
    locator: record.locator,
    logical_path: record.logical_path,
    content_hash: record.content_hash,
    has_learner_content: noteHasLearnerContent(record.markdown),
  });
}
