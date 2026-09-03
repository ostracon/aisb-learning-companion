import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import type { Nodes, Root } from "mdast";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";

import {
  PopplerPdfTextExtractor,
  type PdfTextExtraction,
  type PdfTextExtractor,
} from "../preparation/pdf-text-extractor.js";

export type MaterialAccessClassification = "tutor_readable" | "human_reader_only";
export type MaterialDocumentKind = "readme" | "participant_instructions" | "learner_markdown" | "learner_pdf";

export type UnavailableMaterialReason =
  | "protected"
  | "outside_repository"
  | "symlink"
  | "missing"
  | "not_learner_markdown"
  | "depth_limit"
  | "file_count_limit"
  | "byte_limit"
  | "invalid_target"
  | "insecure_external"
  | "unsupported_scheme"
  | "unreadable";

export type CurriculumMaterialLink =
  | {
      readonly kind: "document";
      readonly label: string;
      readonly documentId: string;
      readonly fragment?: string;
    }
  | {
      readonly kind: "section";
      readonly label: string;
      readonly sectionId: string;
      readonly fragment?: string;
    }
  | {
      readonly kind: "external";
      readonly label: string;
      readonly url: string;
    }
  | {
      readonly kind: "unavailable";
      readonly label: string;
      readonly reason: UnavailableMaterialReason;
    };

export interface CurriculumMaterialDocument {
  readonly documentId: string;
  readonly title: string;
  readonly filename: string;
  readonly kind: MaterialDocumentKind;
  /**
   * human_reader_only forbids raw file/tool access. A separately typed,
   * server-owned model-safe projection may still provide the surrounding task
   * and question text without protected fold bodies.
   */
  readonly accessClassification: MaterialAccessClassification;
  readonly contentHash: string;
  readonly byteLength: number;
  readonly links: readonly CurriculumMaterialLink[];
  readonly linksTruncated: boolean;
}

export interface CurriculumMaterialLimits {
  readonly maxDepth: number;
  readonly maxDocuments: number;
  readonly maxDocumentBytes: number;
  readonly maxTotalBytes: number;
  readonly maxLinksPerDocument: number;
  readonly maxTotalLinks: number;
}

export interface CurriculumMaterialManifest {
  readonly sectionId: string;
  readonly revision: string;
  readonly rootDocumentId: string;
  readonly documents: readonly CurriculumMaterialDocument[];
  readonly truncated: boolean;
  readonly limits: CurriculumMaterialLimits;
}

export interface ReadCurriculumMaterialInput {
  readonly sectionId: string;
  readonly documentId: string;
  readonly expectedManifestRevision: string;
}

export interface CurriculumMaterialDisplayProjection {
  /** Markdown with app-owned fold directives in place of raw HTML details blocks. */
  readonly markdown: string;
  readonly folds: readonly CurriculumMaterialDisplayFold[];
}

export interface CurriculumMaterialDisplayFold {
  readonly foldId: string;
  readonly summary: string;
  /** Sanitized inline Markdown used only by the browser disclosure label. */
  readonly summaryMarkdown: string;
  readonly body: CurriculumMaterialDisplayProjection;
  /** Browser-only folds are deliberately excluded from tutor/model context. */
  readonly contextVisibility: "included" | "browser_only";
  readonly defaultOpen: boolean;
}

export interface ReadDisplayCurriculumMaterialResult {
  readonly audience: "browser_display";
  readonly sectionId: string;
  readonly manifestRevision: string;
  readonly document: CurriculumMaterialDocument;
  readonly display: CurriculumMaterialDisplayProjection;
  readonly displayProjection: "structured_readme" | "structured_instructions" | "pdf_text";
  readonly browserOnlyFoldCount: number;
}

export interface ReadDisplayCurriculumImageInput extends ReadCurriculumMaterialInput {
  /** Exact Markdown image target authored in the selected document. */
  readonly source: string;
}

export interface ReadDisplayCurriculumImageResult {
  readonly bytes: Buffer;
  readonly contentType: string;
}

export interface ReadModelSafeCurriculumMaterialResult {
  readonly audience: "model_context";
  readonly sectionId: string;
  readonly manifestRevision: string;
  readonly document: CurriculumMaterialDocument;
  /** Server-owned projection. This value must never be returned by an HTTP route. */
  readonly modelSafeMarkdown: string;
  readonly modelProjection: "full_readme" | "spoiler_stripped_instructions" | "local_pdf_text";
  readonly omittedProtectedBlocks: number;
}

export type CurriculumMaterialErrorCode =
  | "invalid_section_id"
  | "section_not_found"
  | "ambiguous_section"
  | "root_document_unavailable"
  | "stale_manifest"
  | "document_not_found"
  | "image_not_found"
  | "image_unavailable"
  | "repository_unavailable";

export class CurriculumMaterialError extends Error {
  public readonly name = "CurriculumMaterialError";

  public constructor(
    public readonly code: CurriculumMaterialErrorCode,
    public readonly statusCode: number,
    message: string,
    public readonly currentManifestRevision?: string,
  ) {
    super(message);
  }
}

const DEFAULT_LIMITS: CurriculumMaterialLimits = Object.freeze({
  maxDepth: 4,
  maxDocuments: 32,
  maxDocumentBytes: 512 * 1024,
  maxTotalBytes: 2 * 1024 * 1024,
  maxLinksPerDocument: 128,
  maxTotalLinks: 512,
});

const MAX_MATERIAL_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_LOCAL_PDF_BYTES = 32 * 1024 * 1024;
const MATERIAL_IMAGE_CONTENT_TYPES = new Map<string, string>([
  [".avif", "image/avif"],
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
]);

const SECTION_ID_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const SECTION_DIRECTORY_PATTERN = /^(\d+)\.(\d+)-/u;
const PROTECTED_SEGMENTS = new Set([
  ".git",
  ".env",
  ".venv",
  "node_modules",
  "reference_solutions",
  "reference-solutions",
  "solutions",
  "solution",
  "hidden",
  "env",
  "secrets",
  "secret",
]);

const PROTECTED_FILENAME_PATTERNS = [
  /_solution\.(?:py|md)$/iu,
  /_reference\.(?:py|md)$/iu,
  /_test\.(?:py|md)$/iu,
  /(?:^|[_-])hidden(?:[_-]|\.)/iu,
  /(?:credential|secret|token|private[_-]?key)/iu,
  /(?:^|[._-])env(?:$|[._-])/iu,
];

interface MutableDocument extends CurriculumMaterialDocument {
  links: CurriculumMaterialLink[];
  linksTruncated: boolean;
}

interface InternalDocument {
  readonly relativePath: string;
  readonly markdown: string;
  readonly publicDocument: MutableDocument;
}

interface InternalManifest {
  readonly publicManifest: CurriculumMaterialManifest;
  readonly documentsById: ReadonlyMap<string, InternalDocument>;
}

type ReadableFileResult =
  | { readonly ok: true; readonly markdown: string; readonly byteLength: number }
  | { readonly ok: false; readonly reason: UnavailableMaterialReason };

type ReadableBytesResult =
  | { readonly ok: true; readonly bytes: Buffer; readonly byteLength: number }
  | { readonly ok: false; readonly reason: UnavailableMaterialReason };

interface ParsedMarkdownLink {
  readonly label: string;
  readonly target: string;
}

interface ParsedMarkdownImage {
  readonly source: string;
}

interface LocalTarget {
  readonly relativePath: string;
  readonly fragment?: string;
}

type ClassifiedTarget =
  | { readonly kind: "external"; readonly url: string }
  | { readonly kind: "local"; readonly target: LocalTarget }
  | { readonly kind: "unavailable"; readonly reason: UnavailableMaterialReason };

function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function versionHash(value: string | Uint8Array): string {
  return `sha256:${hash(value)}`;
}

function documentId(sectionId: string, relativePath: string): string {
  return `doc_${hash(`curriculum-material-v1\0${sectionId}\0${relativePath}`)}`;
}

function normalizedRelativePath(root: string, candidate: string): string | undefined {
  const path = relative(root, candidate);
  if (
    path === "" ||
    path === ".." ||
    path.startsWith(`..${sep}`) ||
    isAbsolute(path)
  ) {
    return undefined;
  }
  return path.split(sep).join("/");
}

function documentClassification(relativePath: string):
  | {
      readonly kind: MaterialDocumentKind;
      readonly accessClassification: MaterialAccessClassification;
    }
  | undefined {
  const name = basename(relativePath);
  if (/\.pdf$/iu.test(name)) {
    return { kind: "learner_pdf", accessClassification: "tutor_readable" };
  }
  if (name.toLowerCase() === "readme.md") {
    return { kind: "readme", accessClassification: "tutor_readable" };
  }
  if (/_instructions\.md$/iu.test(name)) {
    return {
      kind: "participant_instructions",
      accessClassification: "human_reader_only",
    };
  }
  const topLevelDirectory = relativePath.split("/")[0] ?? "";
  if (
    /\.md$/iu.test(name) &&
    (topLevelDirectory === "day0-setup" || SECTION_DIRECTORY_PATTERN.test(topLevelDirectory))
  ) {
    return { kind: "learner_markdown", accessClassification: "human_reader_only" };
  }
  return undefined;
}

function sectionIdForDirectory(directory: string): string | undefined {
  if (directory === "day0-setup") return "0.1";
  const match = directory.match(SECTION_DIRECTORY_PATTERN);
  return match ? `${Number(match[1])}.${Number(match[2])}` : undefined;
}

function protectedPath(relativePath: string): boolean {
  const segments = relativePath.split("/");
  if (
    segments.some((segment) => {
      const lower = segment.toLowerCase();
      return segment.startsWith(".") || PROTECTED_SEGMENTS.has(lower);
    })
  ) {
    return true;
  }
  const name = segments.at(-1) ?? "";
  return PROTECTED_FILENAME_PATTERNS.some((pattern) => pattern.test(name));
}

const markdownParser = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  .freeze();

function parseMarkdown(markdown: string): Root {
  return markdownParser.parse(markdown) as Root;
}

function visitMarkdownNodes(node: Nodes, visitor: (node: Nodes) => void): void {
  visitor(node);
  if (!("children" in node)) return;
  for (const child of node.children) visitMarkdownNodes(child as Nodes, visitor);
}

function markdownNodeText(node: Nodes): string {
  if (node.type === "text" || node.type === "inlineCode" || node.type === "code") {
    return node.value;
  }
  if (node.type === "image") return node.alt ?? "";
  if (!("children" in node)) return "";
  return node.children.map((child) => markdownNodeText(child as Nodes)).join("");
}

function titleFromMarkdown(markdown: string, fallback: string): string {
  const heading = parseMarkdown(markdown).children.find(
    (node) => node.type === "heading" && node.depth === 1,
  );
  if (!heading) return fallback;
  return markdownNodeText(heading).replace(/\s+/gu, " ").trim() || fallback;
}

function publicDocument(document: MutableDocument): CurriculumMaterialDocument {
  return Object.freeze({
    ...document,
    links: Object.freeze(document.links.map((link) => Object.freeze({ ...link }))),
  });
}

const MATERIAL_FOLD_DIRECTIVE_LANGUAGE = "aisb-material-fold";

const VISIBLE_INSTRUCTION_FOLD_SUMMARIES = Object.freeze([
  /^vocabulary(?:\b|\s*:)/u,
  /^background(?:\b|\s*:)/u,
  /^real[- ]world(?:\b|\s*:)/u,
  /^runpod setup(?:\b|\s+)/u,
  /^you just bypassed a defended rag system using a three-stage attack\s*:\s*$/u,
]);

function decodeSummaryEntities(value: string): string {
  return value
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&#(?:39|x27);/giu, "'");
}

function instructionFoldSummary(rawSummary: string): string {
  return decodeSummaryEntities(rawSummary.replace(/<[^>]*>/gu, " "))
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim();
}

const SAFE_SUMMARY_INLINE_TAG = /^<\s*(\/?)\s*(strong|b|em|i|code|sup|small)\s*>$/iu;

function instructionFoldSummaryMarkdown(rawSummary: string): string {
  return decodeSummaryEntities(rawSummary.replace(/<[^>]*>/gu, (tag) => {
    const match = SAFE_SUMMARY_INLINE_TAG.exec(tag);
    if (!match) return " ";
    return `<${match[1] ? "/" : ""}${match[2]!.toLowerCase()}>`;
  }))
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim();
}

function explicitFoldVisibility(openTag: string): "visible" | "protected" | undefined {
  const values: Array<string | null> = [];
  let cursor = /^<details\b/iu.exec(openTag)?.[0].length ?? 0;
  while (cursor < openTag.length) {
    while (/\s/u.test(openTag[cursor] ?? "")) cursor += 1;
    if (cursor >= openTag.length || openTag[cursor] === ">" || openTag[cursor] === "/") break;
    const nameStart = cursor;
    while (cursor < openTag.length && !/[\s=/>]/u.test(openTag[cursor] ?? "")) cursor += 1;
    const name = openTag.slice(nameStart, cursor).toLowerCase();
    while (/\s/u.test(openTag[cursor] ?? "")) cursor += 1;
    let value: string | null = null;
    if (openTag[cursor] === "=") {
      cursor += 1;
      while (/\s/u.test(openTag[cursor] ?? "")) cursor += 1;
      const quote = openTag[cursor];
      if (quote === '"' || quote === "'") {
        cursor += 1;
        const valueStart = cursor;
        while (cursor < openTag.length && openTag[cursor] !== quote) cursor += 1;
        value = openTag.slice(valueStart, cursor);
        if (openTag[cursor] === quote) cursor += 1;
      } else {
        const valueStart = cursor;
        while (cursor < openTag.length && !/[\s>]/u.test(openTag[cursor] ?? "")) cursor += 1;
        value = openTag.slice(valueStart, cursor);
      }
    }
    if (name === "data-aisb-visibility") values.push(value);
    if (cursor === nameStart) cursor += 1;
  }
  if (values.length === 0) return undefined;
  if (values.length !== 1) return "protected";
  return values[0]?.toLowerCase() === "visible" ? "visible" : "protected";
}

function learnerVisibleInstructionFold(openTag: string, summary: string): boolean {
  const explicit = explicitFoldVisibility(openTag);
  if (explicit) return explicit === "visible";
  const normalized = instructionFoldSummary(summary).toLowerCase();
  return VISIBLE_INSTRUCTION_FOLD_SUMMARIES.some((pattern) => pattern.test(normalized));
}

function modelSafeProtectedFoldSummary(summary: string): boolean {
  const normalized = instructionFoldSummary(summary).toLowerCase();
  if (/^(?:answer|hint|solution|reference|reveal|spoiler)(?:\b|\s*:)/u.test(normalized)) {
    return false;
  }
  return normalized.includes("?")
    || /^(?:question(?:\s+\d+)?|task|discussion|difference\s+between|what|why|how|which|where|when|who|can|does|do|is|are|should|would|could|explain|compare|distinguish)(?:\b|\s*:)/u.test(normalized);
}

function escapeMarkdownInline(value: string): string {
  return value.replace(/([\\`*_{}\[\]<>])/gu, "\\$1");
}

function unwrapGeneratedBlockquote(markdown: string): string {
  const trimmed = markdown.trim();
  const opening = /^<blockquote(?:\s[^>]*)?>\s*/iu.exec(trimmed);
  const closing = /\s*<\/blockquote\s*>$/iu.exec(trimmed);
  if (!opening || !closing || opening[0].length + closing[0].length > trimmed.length) {
    return trimmed;
  }
  return trimmed.slice(opening[0].length, trimmed.length - closing[0].length).trim();
}

interface ProjectedInstructionMarkdown {
  readonly markdown: string;
  readonly omittedProtectedBlocks: number;
}

interface MutableDisplayProjectionState {
  nextFold: number;
  browserOnlyFoldCount: number;
}

interface DirectFoldSummary {
  readonly start: number;
  readonly end: number;
  readonly rawSummary: string;
}

interface ScannedHtmlTag {
  readonly name: string;
  readonly closing: boolean;
  readonly start: number;
  readonly end: number;
}

interface StructuralHtmlScan {
  readonly tags: readonly ScannedHtmlTag[];
  /** The first tag-like construct whose extent could not be determined safely. */
  readonly unsafeFrom?: number;
}

interface ParsedHtmlTag {
  readonly name: string;
  readonly closing: boolean;
  readonly start: number;
  readonly end: number;
}

type HtmlTagParse =
  | { readonly kind: "not_tag" }
  | { readonly kind: "malformed" }
  | { readonly kind: "tag"; readonly tag: ParsedHtmlTag };

const STRUCTURAL_HTML_TAGS = new Set(["details", "summary"]);
const RAW_TEXT_HTML_TAGS = new Set(["code", "pre", "script", "style", "textarea"]);

interface MarkdownFence {
  readonly marker: "`" | "~";
  readonly length: number;
}

function stripMarkdownContainerPrefixes(line: string): string {
  let value = line;
  while (true) {
    const quote = /^ {0,3}>[\t ]?/u.exec(value);
    if (quote) {
      value = value.slice(quote[0].length);
      continue;
    }
    const list = /^ {0,3}(?:[-+*]|\d{1,9}[.)])[\t ]+/u.exec(value);
    if (list) {
      value = value.slice(list[0].length);
      continue;
    }
    return value;
  }
}

function indentationWidth(value: string): number {
  let width = 0;
  for (const character of value) width += character === "\t" ? 4 : 1;
  return width;
}

function fenceAtLineStart(line: string): MarkdownFence | undefined {
  const content = stripMarkdownContainerPrefixes(line);
  const match = /^ {0,3}(`{3,}|~{3,})/u.exec(content);
  if (!match?.[1]) return undefined;
  return {
    marker: match[1][0] as "`" | "~",
    length: match[1].length,
  };
}

function closesFence(line: string, fence: MarkdownFence): boolean {
  const content = stripMarkdownContainerPrefixes(line);
  const match = /^([\t ]*)(`+|~+)[\t ]*(?:\r?\n)?$/u.exec(content);
  return Boolean(
    match?.[2]
    // CommonMark permits at most three spaces before a closing fence relative
    // to its stripped container. Four spaces remain code content.
    && indentationWidth(match[1] ?? "") <= 3
    && match[2][0] === fence.marker
    && match[2].length >= fence.length,
  );
}

function maskInlineCodeSpans(markdown: string, mask: (value: string) => string): string {
  let output = "";
  let emittedUntil = 0;
  let searchFrom = 0;
  while (searchFrom < markdown.length) {
    const openingStart = markdown.indexOf("`", searchFrom);
    if (openingStart < 0) break;
    let openingEnd = openingStart;
    while (markdown[openingEnd] === "`") openingEnd += 1;
    const delimiterLength = openingEnd - openingStart;
    let candidateStart = openingEnd;
    let closingEnd = -1;
    while (candidateStart < markdown.length) {
      candidateStart = markdown.indexOf("`", candidateStart);
      if (candidateStart < 0) break;
      let candidateEnd = candidateStart;
      while (markdown[candidateEnd] === "`") candidateEnd += 1;
      if (candidateEnd - candidateStart === delimiterLength) {
        closingEnd = candidateEnd;
        break;
      }
      candidateStart = candidateEnd;
    }
    if (closingEnd < 0) {
      searchFrom = openingEnd;
      continue;
    }
    output += markdown.slice(emittedUntil, openingStart);
    output += mask(markdown.slice(openingStart, closingEnd));
    emittedUntil = closingEnd;
    searchFrom = closingEnd;
  }
  return output + markdown.slice(emittedUntil);
}

function maskMarkdownCode(markdown: string): string {
  // Do not use the Unicode flag here. Replacing each UTF-16 code unit keeps all
  // source offsets stable even when prose contains astral characters/emoji.
  const mask = (value: string) => value.replace(/[^\r\n]/g, " ");
  const lines = markdown.match(/[^\n]*(?:\n|$)/gu) ?? [];
  let fence: MarkdownFence | undefined;
  let masked = "";
  for (const line of lines) {
    if (fence) {
      const closing = closesFence(line, fence);
      masked += mask(line);
      if (closing) fence = undefined;
      continue;
    }
    const opening = fenceAtLineStart(line);
    if (opening) {
      fence = opening;
      masked += mask(line);
      continue;
    }
    const containerContent = stripMarkdownContainerPrefixes(line);
    masked += /^(?: {4}|\t)/u.test(containerContent) ? mask(line) : line;
  }
  const withoutRawConstructs = masked
    .replace(/<!--[\s\S]*?(?:-->|$)/gu, mask)
    .replace(/<\?[\s\S]*?(?:\?>|$)/gu, mask)
    .replace(/<!\[CDATA\[[\s\S]*?(?:\]\]>|$)/giu, mask);
  return maskInlineCodeSpans(withoutRawConstructs, mask);
}

function escapedHtmlDelimiter(markdown: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && markdown[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

/**
 * Parses one HTML tag without treating `>` or tag-shaped text inside a quoted
 * attribute as markup. The caller can fail closed when a tag begins but its
 * boundary cannot be established.
 */
function htmlTagAt(markdown: string, start: number): HtmlTagParse {
  if (markdown[start] !== "<" || escapedHtmlDelimiter(markdown, start)) {
    return { kind: "not_tag" };
  }
  let cursor = start + 1;
  let closing = false;
  if (markdown[cursor] === "/") {
    closing = true;
    cursor += 1;
  }
  if (!/[A-Za-z]/u.test(markdown[cursor] ?? "")) return { kind: "not_tag" };
  const nameStart = cursor;
  while (/[A-Za-z0-9:-]/u.test(markdown[cursor] ?? "")) cursor += 1;
  const name = markdown.slice(nameStart, cursor).toLowerCase();
  if (!/[\s/>]/u.test(markdown[cursor] ?? "")) return { kind: "not_tag" };

  let quote: "\"" | "'" | undefined;
  for (; cursor < markdown.length; cursor += 1) {
    const character = markdown[cursor];
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === ">") {
      return {
        kind: "tag",
        tag: { name, closing, start, end: cursor + 1 },
      };
    }
  }
  return { kind: "malformed" };
}

function rawTextElementClose(
  markdown: string,
  name: string,
  afterOpen: number,
): ParsedHtmlTag | undefined {
  const lower = markdown.toLowerCase();
  let cursor = afterOpen;
  while (cursor < markdown.length) {
    const candidate = lower.indexOf(`</${name}`, cursor);
    if (candidate < 0) return undefined;
    const parsed = htmlTagAt(markdown, candidate);
    if (
      parsed.kind === "tag"
      && parsed.tag.closing
      && parsed.tag.name === name
    ) {
      return parsed.tag;
    }
    cursor = candidate + 1;
  }
  return undefined;
}

/**
 * Finds only real disclosure tags. Generic tags are consumed as whole tokens,
 * so strings such as `<span title="</details>">` cannot phantom-close a fold.
 * Markdown code/comments have already been position-preservingly masked.
 */
function scanStructuralHtmlTags(markdown: string): StructuralHtmlScan {
  const tags: ScannedHtmlTag[] = [];
  let cursor = 0;
  while (cursor < markdown.length) {
    const start = markdown.indexOf("<", cursor);
    if (start < 0) break;
    const parsed = htmlTagAt(markdown, start);
    if (parsed.kind === "not_tag") {
      cursor = start + 1;
      continue;
    }
    if (parsed.kind === "malformed") {
      return { tags: Object.freeze(tags), unsafeFrom: start };
    }
    const { tag } = parsed;
    if (STRUCTURAL_HTML_TAGS.has(tag.name)) tags.push(tag);
    if (!tag.closing && RAW_TEXT_HTML_TAGS.has(tag.name)) {
      const closing = rawTextElementClose(markdown, tag.name, tag.end);
      if (!closing) return { tags: Object.freeze(tags), unsafeFrom: tag.start };
      cursor = closing.end;
      continue;
    }
    cursor = tag.end;
  }
  return { tags: Object.freeze(tags) };
}

function directFoldSummary(
  inner: string,
  searchableInner: string,
): DirectFoldSummary | undefined {
  const scan = scanStructuralHtmlTags(searchableInner);
  const directSummaryTags: ScannedHtmlTag[] = [];
  let detailsDepth = 0;
  for (const tag of scan.tags) {
    if (tag.name === "details" && !tag.closing) {
      detailsDepth += 1;
    } else if (tag.name === "details" && tag.closing) {
      detailsDepth -= 1;
      if (detailsDepth < 0) return undefined;
    } else if (tag.name === "summary" && detailsDepth === 0) {
      directSummaryTags.push(tag);
    }
  }
  const opening = directSummaryTags[0];
  const closing = directSummaryTags[1];
  if (
    directSummaryTags.length !== 2
    || !opening
    || !closing
    || opening.closing
    || !closing.closing
    || searchableInner.slice(0, opening.start).trim().length > 0
    || (scan.unsafeFrom !== undefined && scan.unsafeFrom < closing.end)
  ) {
    return undefined;
  }
  return {
    start: opening.start,
    end: closing.end,
    rawSummary: inner.slice(opening.end, closing.start),
  };
}

function matchingDetailsClose(
  tags: readonly ScannedHtmlTag[],
  opening: ScannedHtmlTag,
): { readonly start: number; readonly end: number } | undefined {
  let depth = 0;
  for (const tag of tags) {
    if (tag.name !== "details" || tag.start < opening.start) continue;
    if (tag.closing) {
      depth -= 1;
      if (depth === 0) {
        return { start: tag.start, end: tag.end };
      }
    } else {
      depth += 1;
    }
  }
  return undefined;
}

interface AstSourceRange {
  readonly start: number;
  readonly end: number;
}

interface AstHtmlTag extends ScannedHtmlTag {
  readonly selfClosing: boolean;
}

interface AstHtmlScan {
  readonly tags: readonly AstHtmlTag[];
  readonly commentRanges: readonly AstSourceRange[];
  readonly unsafeFrom?: number;
}

interface AstMarkdownAnalysis {
  readonly root: Root;
  readonly htmlRanges: readonly AstSourceRange[];
  /** Same UTF-16 length as the source; only actual MDAST HTML ranges remain. */
  readonly htmlProjection: string;
}

function astNodeRange(node: Nodes, sourceLength: number): AstSourceRange | undefined {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (
    start === undefined
    || end === undefined
    || !Number.isInteger(start)
    || !Number.isInteger(end)
    || start < 0
    || end < start
    || end > sourceLength
  ) {
    return undefined;
  }
  return { start, end };
}

function mergeAstRanges(ranges: readonly AstSourceRange[]): readonly AstSourceRange[] {
  const sorted = [...ranges].sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: AstSourceRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) {
      merged[merged.length - 1] = {
        start: previous.start,
        end: Math.max(previous.end, range.end),
      };
    } else {
      merged.push(range);
    }
  }
  return Object.freeze(merged.map((range) => Object.freeze(range)));
}

/**
 * Keep source offsets stable while preventing compact display-math forms from
 * swallowing later raw HTML in remark-math. The browser performs the visible
 * delimiter normalization; this mask exists only for structural HTML analysis.
 */
function maskEdgeFilledDisplayMath(markdown: string): string {
  const mask = (value: string) => value.replace(/[^\r\n]/g, " ");
  const lines = markdown.match(/[^\n]*(?:\n|$)/gu) ?? [];
  const output = [...lines];
  let fence: MarkdownFence | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (fence) {
      if (closesFence(line, fence)) fence = undefined;
      continue;
    }
    const openingFence = fenceAtLineStart(line);
    if (openingFence) {
      fence = openingFence;
      continue;
    }

    const content = stripMarkdownContainerPrefixes(line).replace(/\r?\n$/u, "");
    if (/^(?: {4}|\t)/u.test(content)) continue;
    const singleLine = /^ {0,3}\$\$(.+?)\$\$[\t ]*$/u.exec(content);
    if (singleLine?.[1] && !singleLine[1].includes("$$")) {
      output[index] = mask(line);
      continue;
    }
    const opening = /^ {0,3}\$\$(.+)$/u.exec(content);
    if (!opening?.[1] || opening[1].includes("$$")) continue;

    let closingIndex = -1;
    for (let candidate = index + 1; candidate < lines.length; candidate += 1) {
      const candidateLine = lines[candidate] ?? "";
      if (fenceAtLineStart(candidateLine)) break;
      const candidateContent = stripMarkdownContainerPrefixes(candidateLine)
        .replace(/\r?\n$/u, "");
      if (/^.*\$\$[\t ]*$/u.test(candidateContent)) {
        closingIndex = candidate;
        break;
      }
    }
    if (closingIndex < 0) continue;
    for (let candidate = index; candidate <= closingIndex; candidate += 1) {
      output[candidate] = mask(lines[candidate] ?? "");
    }
    index = closingIndex;
  }
  return output.join("");
}

function analyzeMarkdownAst(markdown: string): AstMarkdownAnalysis {
  const root = parseMarkdown(maskEdgeFilledDisplayMath(markdown));
  const discovered: AstSourceRange[] = [];
  visitMarkdownNodes(root, (node) => {
    if (node.type !== "html") return;
    const range = astNodeRange(node, markdown.length);
    if (range) discovered.push(range);
  });
  const htmlRanges = mergeAstRanges(discovered);
  // MDAST and String#slice both use UTF-16 offsets. Masking by code unit keeps
  // structural locations stable even when prose contains astral characters.
  const projection = markdown.replace(/[^\r\n]/g, " ").split("");
  for (const range of htmlRanges) {
    for (let index = range.start; index < range.end; index += 1) {
      projection[index] = markdown[index] ?? "";
    }
  }
  return Object.freeze({ root, htmlRanges, htmlProjection: projection.join("") });
}

function omitAstRanges(
  markdown: string,
  ranges: readonly AstSourceRange[],
  start = 0,
  end = markdown.length,
): string {
  const output: string[] = [];
  let cursor = start;
  for (const range of ranges) {
    if (range.end <= cursor) continue;
    if (range.start >= end) break;
    const overlapStart = Math.max(cursor, range.start);
    const overlapEnd = Math.min(end, range.end);
    if (cursor < overlapStart) output.push(markdown.slice(cursor, overlapStart));
    // Keep line boundaries while ensuring raw HTML text cannot reach a model.
    output.push(markdown.slice(overlapStart, overlapEnd).replace(/[^\r\n]/g, ""));
    cursor = overlapEnd;
  }
  if (cursor < end) output.push(markdown.slice(cursor, end));
  return output.join("");
}

function stripRawHtmlMarkdown(markdown: string): string {
  const analysis = analyzeMarkdownAst(markdown);
  return omitAstRanges(markdown, analysis.htmlRanges);
}

function astHtmlTagAt(markdown: string, start: number):
  | { readonly kind: "not_tag" }
  | { readonly kind: "malformed" }
  | { readonly kind: "tag"; readonly tag: AstHtmlTag } {
  if (markdown[start] !== "<") return { kind: "not_tag" };
  let cursor = start + 1;
  let closing = false;
  if (markdown[cursor] === "/") {
    closing = true;
    cursor += 1;
  }
  if (!/[A-Za-z]/u.test(markdown[cursor] ?? "")) return { kind: "not_tag" };
  const nameStart = cursor;
  while (/[A-Za-z0-9:-]/u.test(markdown[cursor] ?? "")) cursor += 1;
  const name = markdown.slice(nameStart, cursor).toLowerCase();
  if (!/[\s/>]/u.test(markdown[cursor] ?? "")) return { kind: "not_tag" };

  let quote: "\"" | "'" | undefined;
  for (; cursor < markdown.length; cursor += 1) {
    const character = markdown[cursor];
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === ">") {
      let beforeClose = cursor - 1;
      while (beforeClose > start && /\s/u.test(markdown[beforeClose] ?? "")) beforeClose -= 1;
      return {
        kind: "tag",
        tag: {
          name,
          closing,
          selfClosing: !closing && markdown[beforeClose] === "/",
          start,
          end: cursor + 1,
        },
      };
    }
  }
  return { kind: "malformed" };
}

function astTerminatedConstructEnd(
  markdown: string,
  start: number,
  terminator: string,
): number | undefined {
  const end = markdown.indexOf(terminator, start);
  return end < 0 ? undefined : end + terminator.length;
}

function astDeclarationEnd(markdown: string, start: number): number | undefined {
  let quote: "\"" | "'" | undefined;
  for (let cursor = start + 2; cursor < markdown.length; cursor += 1) {
    const character = markdown[cursor];
    if (quote) {
      if (character === quote) quote = undefined;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return cursor + 1;
    }
  }
  return undefined;
}

function astRawTextClose(
  markdown: string,
  name: string,
  afterOpen: number,
): AstHtmlTag | undefined {
  const pattern = new RegExp(`</${name}\\b`, "giu");
  pattern.lastIndex = afterOpen;
  while (pattern.lastIndex < markdown.length) {
    const match = pattern.exec(markdown);
    if (!match) return undefined;
    const parsed = astHtmlTagAt(markdown, match.index);
    if (parsed.kind === "tag" && parsed.tag.closing && parsed.tag.name === name) {
      return parsed.tag;
    }
    pattern.lastIndex = match.index + 1;
  }
  return undefined;
}

/** Tokenize only source ranges that the CommonMark parser classified as HTML. */
function scanAstStructuralHtml(markdown: string): AstHtmlScan {
  const tags: AstHtmlTag[] = [];
  const commentRanges: AstSourceRange[] = [];
  let cursor = 0;
  while (cursor < markdown.length) {
    const start = markdown.indexOf("<", cursor);
    if (start < 0) break;
    if (markdown.startsWith("<!--", start)) {
      const end = astTerminatedConstructEnd(markdown, start + 4, "-->");
      if (end === undefined) {
        commentRanges.push({ start, end: markdown.length });
        return { tags, commentRanges, unsafeFrom: start };
      }
      commentRanges.push({ start, end });
      cursor = end;
      continue;
    }
    if (markdown.slice(start, start + 9).toUpperCase() === "<![CDATA[") {
      const end = astTerminatedConstructEnd(markdown, start + 9, "]]>");
      if (end === undefined) return { tags, commentRanges, unsafeFrom: start };
      cursor = end;
      continue;
    }
    if (markdown.startsWith("<?", start)) {
      const end = astTerminatedConstructEnd(markdown, start + 2, "?>");
      if (end === undefined) return { tags, commentRanges, unsafeFrom: start };
      cursor = end;
      continue;
    }
    if (markdown.startsWith("<!", start)) {
      const end = astDeclarationEnd(markdown, start);
      if (end === undefined) return { tags, commentRanges, unsafeFrom: start };
      cursor = end;
      continue;
    }

    const parsed = astHtmlTagAt(markdown, start);
    if (parsed.kind === "not_tag") {
      cursor = start + 1;
      continue;
    }
    if (parsed.kind === "malformed") return { tags, commentRanges, unsafeFrom: start };
    const { tag } = parsed;
    if (STRUCTURAL_HTML_TAGS.has(tag.name)) tags.push(tag);
    if (!tag.closing && !tag.selfClosing && RAW_TEXT_HTML_TAGS.has(tag.name)) {
      const closing = astRawTextClose(markdown, tag.name, tag.end);
      if (!closing) return { tags, commentRanges, unsafeFrom: tag.start };
      cursor = closing.end;
      continue;
    }
    cursor = tag.end;
  }
  return { tags, commentRanges };
}

function astDirectFoldSummary(inner: string): DirectFoldSummary | undefined {
  const analysis = analyzeMarkdownAst(inner);
  const scan = scanAstStructuralHtml(analysis.htmlProjection);
  const directSummaryTags: AstHtmlTag[] = [];
  let detailsDepth = 0;
  for (const tag of scan.tags) {
    if (tag.name === "details" && !tag.closing && !tag.selfClosing) {
      detailsDepth += 1;
    } else if (tag.name === "details" && tag.closing) {
      detailsDepth -= 1;
      if (detailsDepth < 0) return undefined;
    } else if (tag.name === "summary" && detailsDepth === 0 && !tag.selfClosing) {
      directSummaryTags.push(tag);
    }
  }
  const opening = directSummaryTags[0];
  const closing = directSummaryTags[1];
  if (
    directSummaryTags.length !== 2
    || !opening
    || !closing
    || opening.closing
    || !closing.closing
    || omitAstRanges(inner, scan.commentRanges, 0, opening.start).trim().length > 0
    || (scan.unsafeFrom !== undefined && scan.unsafeFrom < closing.end)
  ) {
    return undefined;
  }
  return {
    start: opening.start,
    end: closing.end,
    rawSummary: omitAstRanges(inner, scan.commentRanges, opening.end, closing.start),
  };
}

function astMatchingDetailsClose(
  tags: readonly AstHtmlTag[],
  opening: AstHtmlTag,
): AstSourceRange | undefined {
  let depth = 0;
  for (const tag of tags) {
    if (
      tag.name !== "details"
      || tag.start < opening.start
      || tag.selfClosing
    ) {
      continue;
    }
    if (tag.closing) {
      depth -= 1;
      if (depth === 0) return { start: tag.start, end: tag.end };
    } else {
      depth += 1;
    }
  }
  return undefined;
}

interface ParsedAstFold {
  readonly summary: DirectFoldSummary;
  readonly closing: AstSourceRange;
}

function astTagIsMarkdownLiteral(markdown: string, tag: AstHtmlTag): boolean {
  const masked = markdown.split("");
  visitMarkdownNodes(parseMarkdown(maskEdgeFilledDisplayMath(markdown)), (node) => {
    if (node.type !== "link" && node.type !== "linkReference" && node.type !== "definition") {
      return;
    }
    const range = astNodeRange(node, markdown.length);
    if (!range) return;
    for (let index = range.start; index < range.end; index += 1) {
      if (masked[index] !== "\r" && masked[index] !== "\n") masked[index] = " ";
    }
  });
  const lexical = masked.join("");
  const runs = [...lexical.matchAll(/`+/gu)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    length: match[0].length,
  }));
  // Pair each delimiter run with the next run of the same length before
  // considering another opener. This mirrors Markdown code-span matching and
  // avoids joining two unrelated, already-closed code spans across real HTML.
  for (let openingIndex = 0; openingIndex < runs.length;) {
    const opening = runs[openingIndex]!;
    const relativeClosingIndex = runs.slice(openingIndex + 1).findIndex(
      (candidate) => candidate.length === opening.length,
    );
    if (relativeClosingIndex < 0) {
      openingIndex += 1;
      continue;
    }
    const closingIndex = openingIndex + 1 + relativeClosingIndex;
    const closing = runs[closingIndex]!;
    if (opening.end <= tag.start && closing.start >= tag.end) return true;
    openingIndex = closingIndex + 1;
  }

  const neutralized = [
    markdown.slice(0, tag.start),
    markdown.slice(tag.start, tag.end).replace(/[^\r\n]/g, " "),
    markdown.slice(tag.end),
  ].join("");
  const root = parseMarkdown(maskEdgeFilledDisplayMath(neutralized));
  let literal = false;
  visitMarkdownNodes(root, (node) => {
    if (
      node.type !== "code"
      && node.type !== "inlineCode"
      && node.type !== "math"
      && node.type !== "inlineMath"
    ) {
      return;
    }
    const range = astNodeRange(node, neutralized.length);
    if (range && range.start <= tag.start && range.end >= tag.end) literal = true;
  });
  return literal;
}

function leadingGeneratedBlockquoteEnd(markdown: string): number {
  const firstContent = /^\s*/u.exec(markdown)?.[0].length ?? 0;
  const analysis = analyzeMarkdownAst(markdown);
  if (analysis.htmlProjection[firstContent] !== "<") return 0;
  const parsed = astHtmlTagAt(analysis.htmlProjection, firstContent);
  if (
    parsed.kind !== "tag"
    || parsed.tag.closing
    || parsed.tag.selfClosing
    || parsed.tag.name !== "blockquote"
  ) {
    return 0;
  }
  return parsed.tag.end;
}

function astFoldAt(
  markdown: string,
  opening: AstHtmlTag,
  recursionDepth = 0,
): ParsedAstFold | undefined {
  if (recursionDepth > 64) return undefined;
  const tail = markdown.slice(opening.end);
  const tailAnalysis = analyzeMarkdownAst(tail);
  const tailScan = scanAstStructuralHtml(tailAnalysis.htmlProjection);
  let summaryOpening: AstHtmlTag | undefined;
  let summaryClosing: AstHtmlTag | undefined;
  for (const tag of tailScan.tags) {
    if (tag.name === "details" && !tag.selfClosing) return undefined;
    if (tag.name !== "summary" || tag.selfClosing) continue;
    if (!summaryOpening) {
      if (tag.closing) return undefined;
      summaryOpening = tag;
      continue;
    }
    if (!tag.closing) return undefined;
    summaryClosing = tag;
    break;
  }
  if (
    !summaryOpening
    || !summaryClosing
    || omitAstRanges(tail, tailScan.commentRanges, 0, summaryOpening.start).trim().length > 0
    || (tailScan.unsafeFrom !== undefined && tailScan.unsafeFrom < summaryClosing.end)
  ) {
    return undefined;
  }

  const summary: DirectFoldSummary = {
    start: summaryOpening.start,
    end: summaryClosing.end,
    rawSummary: omitAstRanges(
      tail,
      tailScan.commentRanges,
      summaryOpening.end,
      summaryClosing.start,
    ),
  };
  const afterSummaryAbsolute = opening.end + summary.end;
  const afterSummary = markdown.slice(afterSummaryAbsolute);
  const blockquoteEnd = leadingGeneratedBlockquoteEnd(afterSummary);
  const bodyContentAbsolute = afterSummaryAbsolute + blockquoteEnd;
  const body = markdown.slice(bodyContentAbsolute);
  const bodyAnalysis = analyzeMarkdownAst(body);
  const bodyScan = scanAstStructuralHtml(bodyAnalysis.htmlProjection);
  let skipThroughAbsolute = bodyContentAbsolute;

  for (const tag of bodyScan.tags) {
    if (astTagIsMarkdownLiteral(body, tag)) continue;
    const absoluteTag: AstHtmlTag = {
      ...tag,
      start: bodyContentAbsolute + tag.start,
      end: bodyContentAbsolute + tag.end,
    };
    if (absoluteTag.start < skipThroughAbsolute) continue;
    // A fold has exactly one direct summary. A second one is ambiguous and
    // must not turn its following text into reviewed teaching content.
    if (absoluteTag.name === "summary") return undefined;
    if (absoluteTag.name !== "details") continue;
    if (absoluteTag.closing) {
      return {
        summary,
        closing: { start: absoluteTag.start, end: absoluteTag.end },
      };
    }
    if (absoluteTag.selfClosing) continue;
    const nested = astFoldAt(markdown, absoluteTag, recursionDepth + 1);
    if (!nested) return undefined;
    skipThroughAbsolute = nested.closing.end;
  }
  return undefined;
}

function projectInstructionMarkdown(markdown: string): ProjectedInstructionMarkdown {
  const projected: string[] = [];
  const analysis = analyzeMarkdownAst(markdown);
  const scan = scanAstStructuralHtml(analysis.htmlProjection);
  const openings = scan.tags.filter(
    (tag) => tag.name === "details" && !tag.closing && !tag.selfClosing,
  );
  let cursor = 0;
  let omittedProtectedBlocks = 0;

  for (const opening of openings) {
    if (opening.start < cursor) continue;
    projected.push(stripRawHtmlMarkdown(markdown.slice(cursor, opening.start)));
    const fold = astFoldAt(markdown, opening);
    if (!fold) {
      // An unterminated fold could otherwise leak its body. Treat the remainder
      // as protected and stop projecting this document.
      omittedProtectedBlocks += Math.max(
        1,
        openings.filter((candidate) => candidate.start >= opening.start).length,
      );
      cursor = markdown.length;
      break;
    }

    const { closing, summary } = fold;
    const inner = markdown.slice(opening.end, closing.start);
    const rawSummary = summary?.rawSummary ?? "";
    if (
      !summary
      || !learnerVisibleInstructionFold(markdown.slice(opening.start, opening.end), rawSummary)
    ) {
      if (summary && modelSafeProtectedFoldSummary(rawSummary)) {
        const label = escapeMarkdownInline(instructionFoldSummary(rawSummary || "Course note"));
        projected.push(`\n\n> **${label}**\n\n`);
      }
      omittedProtectedBlocks += 1;
      cursor = closing.end;
      continue;
    }

    const body = unwrapGeneratedBlockquote(inner.slice(summary.end));
    const nested = projectInstructionMarkdown(body);
    const label = escapeMarkdownInline(instructionFoldSummary(rawSummary || "More context"));
    projected.push(`\n\n> **${label}**\n\n${nested.markdown}\n\n`);
    omittedProtectedBlocks += nested.omittedProtectedBlocks;
    cursor = closing.end;
  }
  const safeEnd = scan.unsafeFrom ?? markdown.length;
  if (cursor < safeEnd) {
    projected.push(stripRawHtmlMarkdown(markdown.slice(cursor, safeEnd)));
  }
  if (scan.unsafeFrom !== undefined && cursor < markdown.length) {
    omittedProtectedBlocks += 1;
  }
  return Object.freeze({
    markdown: projected.join("").replace(/\n{4,}/gu, "\n\n\n"),
    omittedProtectedBlocks,
  });
}

/**
 * Instruction documents can embed both teaching content and protected answers
 * in HTML details blocks. Preserve only reviewed learner-facing fold classes,
 * and fail closed for hints, answers, solutions, unknown labels, or malformed
 * markup. Raw HTML is converted to Markdown rather than sent to the client.
 * Authors can make future intent unambiguous with data-aisb-visibility.
 */
export function spoilerStripInstructionMarkdown(markdown: string): {
  readonly markdown: string;
  readonly omittedProtectedBlocks: number;
} {
  return projectInstructionMarkdown(markdown);
}

function materialFoldDirective(foldId: string): string {
  return `\n\n\`\`\`${MATERIAL_FOLD_DIRECTIVE_LANGUAGE}\n${foldId}\n\`\`\`\n\n`;
}

function projectMarkdownForBrowser(
  markdown: string,
  instructionDocument: boolean,
  ancestorIncludedInContext: boolean,
  state: MutableDisplayProjectionState,
): CurriculumMaterialDisplayProjection {
  const projected: string[] = [];
  const folds: CurriculumMaterialDisplayFold[] = [];
  const analysis = analyzeMarkdownAst(markdown);
  const scan = scanAstStructuralHtml(analysis.htmlProjection);
  const openings = scan.tags.filter(
    (tag) => tag.name === "details" && !tag.closing && !tag.selfClosing,
  );
  let cursor = 0;

  for (const opening of openings) {
    if (opening.start < cursor) continue;
    projected.push(markdown.slice(cursor, opening.start));
    const fold = astFoldAt(markdown, opening);
    if (!fold) {
      // A malformed disclosure cannot be represented faithfully. Preserve the
      // preceding document and fail closed for the ambiguous remainder.
      cursor = markdown.length;
      break;
    }

    const { closing, summary: summaryMatch } = fold;
    const inner = markdown.slice(opening.end, closing.start);
    const rawSummary = summaryMatch.rawSummary;
    const summary = instructionFoldSummary(rawSummary) || "Course note";
    const summaryMarkdown = instructionFoldSummaryMarkdown(rawSummary) || "Course note";
    const contextIncluded = ancestorIncludedInContext && (
      !instructionDocument
      || learnerVisibleInstructionFold(markdown.slice(opening.start, opening.end), rawSummary)
    );
    if (!contextIncluded) state.browserOnlyFoldCount += 1;

    const foldNumber = state.nextFold;
    state.nextFold += 1;
    const bodyMarkdown = unwrapGeneratedBlockquote(
      inner.slice(summaryMatch.end),
    );
    const body = projectMarkdownForBrowser(
      bodyMarkdown,
      instructionDocument,
      contextIncluded,
      state,
    );
    const foldId = `material-fold-${foldNumber}-${hash([
      markdown.slice(opening.start, opening.end),
      summary,
      bodyMarkdown,
    ].join("\n")).slice(0, 12)}`;
    folds.push(Object.freeze({
      foldId,
      summary,
      summaryMarkdown,
      body,
      contextVisibility: contextIncluded ? "included" : "browser_only",
      // The previous safe projection flattened teaching folds, so keeping them
      // open avoids hiding content that was already intentionally visible.
      // Browser-only answer/hint/solution bodies always start closed.
      defaultOpen: contextIncluded,
    }));
    projected.push(materialFoldDirective(foldId));
    cursor = closing.end;
  }

  const safeEnd = scan.unsafeFrom ?? markdown.length;
  if (cursor < safeEnd) projected.push(markdown.slice(cursor, safeEnd));
  return Object.freeze({
    markdown: projected.join("").replace(/\n{4,}/gu, "\n\n\n"),
    folds: Object.freeze(folds),
  });
}

/** Browser-only representation of every authored disclosure without raw HTML. */
export function projectCurriculumMarkdownForBrowser(
  markdown: string,
  instructionDocument = true,
): {
  readonly display: CurriculumMaterialDisplayProjection;
  readonly browserOnlyFoldCount: number;
} {
  const state: MutableDisplayProjectionState = {
    nextFold: 1,
    browserOnlyFoldCount: 0,
  };
  return Object.freeze({
    display: projectMarkdownForBrowser(markdown, instructionDocument, true, state),
    browserOnlyFoldCount: state.browserOnlyFoldCount,
  });
}

function markdownLinks(markdown: string): ParsedMarkdownLink[] {
  const links: ParsedMarkdownLink[] = [];
  const root = parseMarkdown(markdown);
  const definitions = new Map<string, string>();
  visitMarkdownNodes(root, (node) => {
    if (node.type === "definition") definitions.set(node.identifier, node.url);
  });
  visitMarkdownNodes(root, (node) => {
    if (node.type !== "link" && node.type !== "linkReference") return;
    const target = node.type === "link" ? node.url : definitions.get(node.identifier);
    if (!target?.trim()) return;
    const label = markdownNodeText(node).replace(/\s+/gu, " ").trim() || "Link";
    links.push({ label: label.slice(0, 240), target: target.trim() });
  });
  return links;
}

function protectedArxivReferenceLinks(
  authoredMarkdown: string,
  learnerVisibleLinks: readonly ParsedMarkdownLink[],
): ParsedMarkdownLink[] {
  const visibleIdentifiers = new Set(
    learnerVisibleLinks
      .map(({ target }) => arxivIdentifierFromReference(target))
      .filter((identifier): identifier is string => identifier !== null),
  );
  const protectedIdentifiers = new Set<string>();
  const links: ParsedMarkdownLink[] = [];

  for (const match of authoredMarkdown.matchAll(
    /https:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\/((?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z]{2})?\/\d{7})(?:v\d+)?)(?:\.pdf)?/giu,
  )) {
    const identifier = match[1];
    if (
      identifier === undefined
      || visibleIdentifiers.has(identifier.toLowerCase())
      || protectedIdentifiers.has(identifier.toLowerCase())
    ) continue;

    protectedIdentifiers.add(identifier.toLowerCase());
    links.push({
      label: "Referenced arXiv paper",
      target: `https://arxiv.org/pdf/${identifier}`,
    });
  }
  return links;
}

function arxivIdentifierFromReference(value: string): string | null {
  const match = value.match(
    /^https:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\/((?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z]{2})?\/\d{7})(?:v\d+)?)(?:\.pdf)?(?:[?#].*)?$/iu,
  );
  return match?.[1]?.toLowerCase() ?? null;
}

function markdownImages(markdown: string): ParsedMarkdownImage[] {
  const images: ParsedMarkdownImage[] = [];
  const root = parseMarkdown(markdown);
  const definitions = new Map<string, string>();
  visitMarkdownNodes(root, (node) => {
    if (node.type === "definition") definitions.set(node.identifier, node.url);
  });
  visitMarkdownNodes(root, (node) => {
    if (node.type !== "image" && node.type !== "imageReference") return;
    const source = node.type === "image" ? node.url : definitions.get(node.identifier);
    if (!source?.trim()) return;
    images.push({ source: source.trim() });
  });
  return images;
}

function splitLocalTarget(rawTarget: string):
  | { readonly path: string; readonly fragment?: string }
  | undefined {
  const hashIndex = rawTarget.indexOf("#");
  const beforeFragment = hashIndex >= 0 ? rawTarget.slice(0, hashIndex) : rawTarget;
  const rawFragment = hashIndex >= 0 ? rawTarget.slice(hashIndex + 1) : undefined;
  const queryIndex = beforeFragment.indexOf("?");
  const rawPath = queryIndex >= 0 ? beforeFragment.slice(0, queryIndex) : beforeFragment;
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch {
    return undefined;
  }
  if (decodedPath.includes("\0") || decodedPath.includes("\\")) return undefined;
  return {
    path: decodedPath,
    ...(rawFragment ? { fragment: rawFragment.slice(0, 512) } : {}),
  };
}

function classifyLinkTarget(
  canonicalRoot: string,
  sourceRelativePath: string,
  rawTarget: string,
): ClassifiedTarget {
  const target = rawTarget.trim();
  if (!target) return { kind: "unavailable", reason: "invalid_target" };

  if (/^https:/iu.test(target)) {
    try {
      const url = new URL(target);
      if (url.protocol !== "https:") {
        return { kind: "unavailable", reason: "unsupported_scheme" };
      }
      return { kind: "external", url: url.toString() };
    } catch {
      return { kind: "unavailable", reason: "invalid_target" };
    }
  }
  if (/^http:/iu.test(target)) {
    return { kind: "unavailable", reason: "insecure_external" };
  }
  if (/^[a-z][a-z\d+.-]*:/iu.test(target) || target.startsWith("//")) {
    return { kind: "unavailable", reason: "unsupported_scheme" };
  }

  const split = splitLocalTarget(target);
  if (!split) return { kind: "unavailable", reason: "invalid_target" };
  if (split.path === "") {
    return {
      kind: "local",
      target: {
        relativePath: sourceRelativePath,
        ...(split.fragment ? { fragment: split.fragment } : {}),
      },
    };
  }
  if (isAbsolute(split.path)) {
    return { kind: "unavailable", reason: "outside_repository" };
  }

  const candidate = resolve(canonicalRoot, dirname(sourceRelativePath), split.path);
  const relativePath = normalizedRelativePath(canonicalRoot, candidate);
  if (!relativePath) {
    return { kind: "unavailable", reason: "outside_repository" };
  }
  if (protectedPath(relativePath)) {
    return { kind: "unavailable", reason: "protected" };
  }
  if (!documentClassification(relativePath)) {
    return { kind: "unavailable", reason: "not_learner_markdown" };
  }
  return {
    kind: "local",
    target: {
      relativePath,
      ...(split.fragment ? { fragment: split.fragment } : {}),
    },
  };
}

function localImageTarget(
  canonicalRoot: string,
  sourceRelativePath: string,
  rawTarget: string,
): { readonly relativePath: string; readonly contentType: string } | undefined {
  const target = rawTarget.trim();
  if (
    !target
    || /^[a-z][a-z\d+.-]*:/iu.test(target)
    || target.startsWith("//")
  ) {
    return undefined;
  }
  const split = splitLocalTarget(target);
  if (!split?.path || isAbsolute(split.path)) return undefined;
  const candidate = resolve(canonicalRoot, dirname(sourceRelativePath), split.path);
  const relativePath = normalizedRelativePath(canonicalRoot, candidate);
  if (!relativePath || protectedPath(relativePath)) return undefined;
  const contentType = MATERIAL_IMAGE_CONTENT_TYPES.get(extname(relativePath).toLowerCase());
  return contentType ? { relativePath, contentType } : undefined;
}

async function readBoundedMaterialImage(
  canonicalRoot: string,
  relativePath: string,
): Promise<Buffer | undefined> {
  const segments = relativePath.split("/");
  let candidate = canonicalRoot;
  try {
    for (const segment of segments) {
      candidate = join(candidate, segment);
      const metadata = await lstat(candidate);
      if (metadata.isSymbolicLink()) return undefined;
    }
  } catch {
    return undefined;
  }

  let canonicalCandidate: string;
  try {
    canonicalCandidate = await realpath(candidate);
  } catch {
    return undefined;
  }
  if (!normalizedRelativePath(canonicalRoot, canonicalCandidate)) return undefined;

  let handle;
  try {
    handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > MAX_MATERIAL_IMAGE_BYTES) return undefined;
    const bytes = await handle.readFile();
    return bytes.byteLength <= MAX_MATERIAL_IMAGE_BYTES ? bytes : undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

async function readBoundedRegularFile(
  canonicalRoot: string,
  relativePath: string,
  maxDocumentBytes: number,
  remainingTotalBytes: number,
): Promise<ReadableFileResult> {
  const read = await readBoundedRegularBytes(
    canonicalRoot,
    relativePath,
    maxDocumentBytes,
    remainingTotalBytes,
  );
  if (!read.ok) return read;
  try {
    return {
      ok: true,
      markdown: new TextDecoder("utf-8", { fatal: true }).decode(read.bytes),
      byteLength: read.byteLength,
    };
  } catch {
    return { ok: false, reason: "unreadable" };
  }
}

async function readBoundedRegularBytes(
  canonicalRoot: string,
  relativePath: string,
  maxFileBytes: number,
  remainingTotalBytes: number,
): Promise<ReadableBytesResult> {
  const segments = relativePath.split("/");
  let candidate = canonicalRoot;
  try {
    for (const segment of segments) {
      candidate = join(candidate, segment);
      const metadata = await lstat(candidate);
      if (metadata.isSymbolicLink()) return { ok: false, reason: "symlink" };
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { ok: false, reason: code === "ENOENT" ? "missing" : "unreadable" };
  }

  let canonicalCandidate: string;
  try {
    canonicalCandidate = await realpath(candidate);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { ok: false, reason: code === "ENOENT" ? "missing" : "unreadable" };
  }
  if (!normalizedRelativePath(canonicalRoot, canonicalCandidate)) {
    return { ok: false, reason: "outside_repository" };
  }

  let handle;
  try {
    handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile()) return { ok: false, reason: "unreadable" };
    if (metadata.size > maxFileBytes || metadata.size > remainingTotalBytes) {
      return { ok: false, reason: "byte_limit" };
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength > maxFileBytes || bytes.byteLength > remainingTotalBytes) {
      return { ok: false, reason: "byte_limit" };
    }
    return { ok: true, bytes, byteLength: bytes.byteLength };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP") return { ok: false, reason: "symlink" };
    if (code === "ENOENT") return { ok: false, reason: "missing" };
    return { ok: false, reason: "unreadable" };
  } finally {
    await handle?.close();
  }
}

function validateLimits(overrides: Partial<CurriculumMaterialLimits>): CurriculumMaterialLimits {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive integer`);
    }
  }
  return Object.freeze(limits);
}

function manifestRevision(
  sectionId: string,
  documents: readonly InternalDocument[],
  limits: CurriculumMaterialLimits,
  truncated: boolean,
): string {
  return versionHash(
    JSON.stringify({
      schema: 1,
      sectionId,
      limits,
      truncated,
      documents: documents.map(({ relativePath, publicDocument: document }) => ({
        relativePath,
        documentId: document.documentId,
        contentHash: document.contentHash,
        links: document.links,
        linksTruncated: document.linksTruncated,
      })),
    }),
  );
}

function localPdfMarkdown(extraction: PdfTextExtraction, title: string): string {
  const pages = extraction.pages.map(({ pageNumber, text }) => [
    `## Page ${pageNumber}`,
    "",
    text || "_No extractable text was found on this page._",
  ].join("\n")).join("\n\n");
  return [
    `# ${escapeMarkdownInline(title)}`,
    "",
    "> Local curriculum PDF. This deterministic text view preserves PDF page order for reading and tutor retrieval.",
    "",
    pages,
    "",
  ].join("\n");
}

/**
 * Builds a read-only, learner-visible Markdown graph rooted at a section README.
 * It never fetches links, returns filesystem paths, or renders Markdown/HTML.
 */
export class CurriculumMaterialService {
  private readonly limits: CurriculumMaterialLimits;
  private readonly pdfMarkdownByHash = new Map<string, Promise<string>>();

  public constructor(
    private readonly aisbRoot: string,
    limits: Partial<CurriculumMaterialLimits> = {},
    private readonly pdfTextExtractor: PdfTextExtractor = new PopplerPdfTextExtractor(),
  ) {
    this.limits = validateLimits(limits);
  }

  public async manifest(sectionId: string): Promise<CurriculumMaterialManifest> {
    return (await this.buildManifest(sectionId)).publicManifest;
  }

  private async projectLocalPdf(bytes: Buffer, filename: string): Promise<string> {
    const contentHash = versionHash(bytes);
    const existing = this.pdfMarkdownByHash.get(contentHash);
    if (existing) return await existing;
    const projection = this.pdfTextExtractor
      .extract(bytes, new AbortController().signal)
      .then((extraction) => localPdfMarkdown(extraction, filename.replace(/\.pdf$/iu, "")));
    this.pdfMarkdownByHash.set(contentHash, projection);
    try {
      return await projection;
    } catch (error) {
      this.pdfMarkdownByHash.delete(contentHash);
      throw error;
    }
  }

  public async readForDisplay(
    input: ReadCurriculumMaterialInput,
  ): Promise<ReadDisplayCurriculumMaterialResult> {
    const { internal, selected } = await this.resolveRead(input);
    const pdf = selected.publicDocument.kind === "learner_pdf";
    const projected = pdf
      ? Object.freeze({
          display: Object.freeze({ markdown: selected.markdown, folds: Object.freeze([]) }),
          browserOnlyFoldCount: 0,
        })
      : projectCurriculumMarkdownForBrowser(
          selected.markdown,
          selected.publicDocument.kind !== "readme",
        );
    return Object.freeze({
      audience: "browser_display",
      sectionId: input.sectionId,
      manifestRevision: internal.publicManifest.revision,
      document: publicDocument(selected.publicDocument),
      display: projected.display,
      displayProjection: pdf
        ? "pdf_text"
        : selected.publicDocument.kind === "readme"
          ? "structured_readme"
          : "structured_instructions",
      browserOnlyFoldCount: projected.browserOnlyFoldCount,
    });
  }

  /**
   * Reads one image explicitly referenced by the selected learner document.
   * The caller never supplies a filesystem path with independent authority:
   * the exact source must occur as a Markdown image in the revision-bound
   * document, then resolve to a bounded regular image inside the repository.
   */
  public async readImageForDisplay(
    input: ReadDisplayCurriculumImageInput,
  ): Promise<ReadDisplayCurriculumImageResult> {
    const { selected } = await this.resolveRead(input);
    const referenced = markdownImages(selected.markdown)
      .some((image) => image.source === input.source);
    if (!referenced) {
      throw new CurriculumMaterialError(
        "image_not_found",
        404,
        "The image is not referenced by the selected curriculum document",
      );
    }

    let canonicalRoot: string;
    try {
      canonicalRoot = await realpath(this.aisbRoot);
    } catch {
      throw new CurriculumMaterialError(
        "repository_unavailable",
        503,
        "The AISB curriculum repository is unavailable",
      );
    }
    const target = localImageTarget(canonicalRoot, selected.relativePath, input.source);
    if (!target) {
      throw new CurriculumMaterialError(
        "image_unavailable",
        404,
        "The referenced image is not an available local curriculum asset",
      );
    }
    const bytes = await readBoundedMaterialImage(canonicalRoot, target.relativePath);
    if (!bytes) {
      throw new CurriculumMaterialError(
        "image_unavailable",
        404,
        "The referenced image is not an available bounded regular file",
      );
    }
    return Object.freeze({ bytes, contentType: target.contentType });
  }

  public async readForModelContext(
    input: ReadCurriculumMaterialInput,
  ): Promise<ReadModelSafeCurriculumMaterialResult> {
    const { internal, selected } = await this.resolveRead(input);
    const projection = selected.publicDocument.kind === "readme"
      ? { markdown: stripRawHtmlMarkdown(selected.markdown), omittedProtectedBlocks: 0 }
      : selected.publicDocument.kind === "learner_pdf"
        ? { markdown: selected.markdown, omittedProtectedBlocks: 0 }
        : spoilerStripInstructionMarkdown(selected.markdown);
    return Object.freeze({
      audience: "model_context",
      sectionId: input.sectionId,
      manifestRevision: internal.publicManifest.revision,
      document: publicDocument(selected.publicDocument),
      modelSafeMarkdown: projection.markdown,
      modelProjection: selected.publicDocument.kind === "readme"
        ? "full_readme"
        : selected.publicDocument.kind === "learner_pdf"
          ? "local_pdf_text"
          : "spoiler_stripped_instructions",
      omittedProtectedBlocks: projection.omittedProtectedBlocks,
    });
  }

  private async resolveRead(input: ReadCurriculumMaterialInput): Promise<{
    readonly internal: InternalManifest;
    readonly selected: InternalDocument;
  }> {
    const internal = await this.buildManifest(input.sectionId);
    if (input.expectedManifestRevision !== internal.publicManifest.revision) {
      throw new CurriculumMaterialError(
        "stale_manifest",
        409,
        "The curriculum material manifest changed; refresh it before reading",
        internal.publicManifest.revision,
      );
    }
    const selected = internal.documentsById.get(input.documentId);
    if (!selected) {
      throw new CurriculumMaterialError(
        "document_not_found",
        404,
        "The document is not present in this section manifest",
      );
    }
    return { internal, selected };
  }

  private async buildManifest(sectionId: string): Promise<InternalManifest> {
    if (!SECTION_ID_PATTERN.test(sectionId)) {
      throw new CurriculumMaterialError(
        "invalid_section_id",
        400,
        "A canonical numeric section ID such as 1.1 is required",
      );
    }

    let canonicalRoot: string;
    try {
      canonicalRoot = await realpath(this.aisbRoot);
      const metadata = await lstat(canonicalRoot);
      if (!metadata.isDirectory()) throw new Error("not-directory");
    } catch {
      throw new CurriculumMaterialError(
        "repository_unavailable",
        503,
        "The AISB curriculum repository is unavailable",
      );
    }

    const sectionDirectory = await this.resolveSectionDirectory(canonicalRoot, sectionId);
    const rootRelativePath = `${sectionDirectory}/README.md`;
    const documentsByPath = new Map<string, InternalDocument>();
    const documentsById = new Map<string, InternalDocument>();
    let totalBytes = 0;
    let totalLinks = 0;
    let truncated = false;

    const visit = async (
      relativePath: string,
      depth: number,
      rootDocument: boolean,
    ): Promise<{ readonly documentId?: string; readonly reason?: UnavailableMaterialReason }> => {
      const existing = documentsByPath.get(relativePath);
      if (existing) return { documentId: existing.publicDocument.documentId };
      if (depth > this.limits.maxDepth) {
        truncated = true;
        return { reason: "depth_limit" };
      }
      if (documentsByPath.size >= this.limits.maxDocuments) {
        truncated = true;
        return { reason: "file_count_limit" };
      }

      const classification = documentClassification(relativePath);
      if (!classification || protectedPath(relativePath)) {
        return { reason: classification ? "protected" : "not_learner_markdown" };
      }
      let markdown: string;
      let contentHash: string;
      let byteLength: number;
      if (classification.kind === "learner_pdf") {
        const read = await readBoundedRegularBytes(
            canonicalRoot,
            relativePath,
            MAX_LOCAL_PDF_BYTES,
            this.limits.maxTotalBytes - totalBytes,
          );
        if (!read.ok) {
          if (read.reason === "byte_limit") truncated = true;
          return { reason: read.reason };
        }
        try {
          markdown = await this.projectLocalPdf(read.bytes, basename(relativePath));
        } catch {
          return { reason: "unreadable" };
        }
        contentHash = versionHash(read.bytes);
        byteLength = read.byteLength;
      } else {
        const read = await readBoundedRegularFile(
            canonicalRoot,
            relativePath,
            this.limits.maxDocumentBytes,
            this.limits.maxTotalBytes - totalBytes,
          );
        if (!read.ok) {
          if (read.reason === "byte_limit") truncated = true;
          if (rootDocument) {
            throw new CurriculumMaterialError(
              "root_document_unavailable",
              404,
              "The section README is not an available regular learner document",
            );
          }
          return { reason: read.reason };
        }
        markdown = read.markdown;
        contentHash = versionHash(markdown);
        byteLength = read.byteLength;
      }
      totalBytes += byteLength;
      const modelSafeDocumentMarkdown = classification.kind === "readme"
        ? stripRawHtmlMarkdown(markdown)
        : classification.kind === "learner_pdf"
          ? markdown
          : spoilerStripInstructionMarkdown(markdown).markdown;
      const id = documentId(sectionId, relativePath);
      const document: MutableDocument = {
        documentId: id,
        // Browser-only folds must not influence any metadata that can flow to
        // tutor, review, manager, or preparation contexts.
        title: titleFromMarkdown(modelSafeDocumentMarkdown, basename(relativePath)),
        filename: basename(relativePath),
        ...classification,
        contentHash,
        byteLength,
        links: [],
        linksTruncated: false,
      };
      const internal: InternalDocument = {
        relativePath,
        markdown,
        publicDocument: document,
      };
      // Publish before following links so a cycle resolves to this document.
      documentsByPath.set(relativePath, internal);
      documentsById.set(id, internal);

      const learnerVisibleLinks = classification.kind === "learner_pdf"
        ? []
        : markdownLinks(modelSafeDocumentMarkdown);
      const discoveredLinks = classification.kind === "learner_pdf"
        ? []
        : classification.kind === "readme"
          ? learnerVisibleLinks
          : [
              ...learnerVisibleLinks,
              ...protectedArxivReferenceLinks(markdown, learnerVisibleLinks),
            ];
      const perDocumentLinks = discoveredLinks.slice(0, this.limits.maxLinksPerDocument);
      if (perDocumentLinks.length < discoveredLinks.length) {
        document.linksTruncated = true;
        truncated = true;
      }

      for (const discovered of perDocumentLinks) {
        if (totalLinks >= this.limits.maxTotalLinks) {
          document.linksTruncated = true;
          truncated = true;
          break;
        }
        totalLinks += 1;
        const classified = classifyLinkTarget(
          canonicalRoot,
          relativePath,
          discovered.target,
        );
        if (classified.kind === "external") {
          document.links.push({
            kind: "external",
            label: discovered.label,
            url: classified.url,
          });
          continue;
        }
        if (classified.kind === "unavailable") {
          document.links.push({
            kind: "unavailable",
            label: discovered.label,
            reason: classified.reason,
          });
          continue;
        }

        const targetTopLevel = classified.target.relativePath.split("/")[0] ?? "";
        const targetSectionId = sectionIdForDirectory(targetTopLevel);
        if (
          targetTopLevel !== sectionDirectory &&
          targetSectionId !== undefined &&
          basename(classified.target.relativePath).toLowerCase() === "readme.md"
        ) {
          document.links.push({
            kind: "section",
            label: discovered.label,
            sectionId: targetSectionId,
            ...(classified.target.fragment ? { fragment: classified.target.fragment } : {}),
          });
          continue;
        }
        if (targetTopLevel !== sectionDirectory) {
          document.links.push({
            kind: "unavailable",
            label: discovered.label,
            reason: "outside_repository",
          });
          continue;
        }

        const destination = await visit(classified.target.relativePath, depth + 1, false);
        if (destination.documentId) {
          document.links.push({
            kind: "document",
            label: discovered.label,
            documentId: destination.documentId,
            ...(classified.target.fragment
              ? { fragment: classified.target.fragment }
              : {}),
          });
        } else {
          document.links.push({
            kind: "unavailable",
            label: discovered.label,
            reason: destination.reason ?? "unreadable",
          });
        }
      }
      return { documentId: id };
    };

    const root = await visit(rootRelativePath, 0, true);
    if (!root.documentId) {
      throw new CurriculumMaterialError(
        "root_document_unavailable",
        404,
        "The section README is unavailable",
      );
    }

    const internalDocuments = [...documentsByPath.values()];
    const revision = manifestRevision(sectionId, internalDocuments, this.limits, truncated);
    const publicManifest: CurriculumMaterialManifest = Object.freeze({
      sectionId,
      revision,
      rootDocumentId: root.documentId,
      documents: Object.freeze(
        internalDocuments.map(({ publicDocument: document }) => publicDocument(document)),
      ),
      truncated,
      limits: this.limits,
    });
    return { publicManifest, documentsById };
  }

  private async resolveSectionDirectory(
    canonicalRoot: string,
    sectionId: string,
  ): Promise<string> {
    let entries;
    try {
      entries = await readdir(canonicalRoot, { withFileTypes: true });
    } catch {
      throw new CurriculumMaterialError(
        "repository_unavailable",
        503,
        "The AISB curriculum repository is unavailable",
      );
    }

    const matches = entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .filter((entry) => {
        if (sectionId === "0.1" && entry.name === "day0-setup") return true;
        const match = entry.name.match(SECTION_DIRECTORY_PATTERN);
        return match ? `${Number(match[1])}.${Number(match[2])}` === sectionId : false;
      })
      .map((entry) => entry.name)
      .sort();

    if (matches.length === 0) {
      throw new CurriculumMaterialError(
        "section_not_found",
        404,
        "No curriculum folder matches this section ID",
      );
    }
    if (matches.length > 1) {
      throw new CurriculumMaterialError(
        "ambiguous_section",
        409,
        "More than one curriculum folder matches this section ID",
      );
    }
    return matches[0]!;
  }
}
