import { isValidElement, type ReactNode } from "react";
import type { Nodes, Parent, Root } from "mdast";
import rehypeKatex from "rehype-katex";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

import { MarkdownCodeBlock } from "./MarkdownCodeBlock.js";
import { MermaidDiagram } from "./MermaidDiagram.js";

export interface MarkdownLinkRenderInput {
  readonly children: ReactNode;
  readonly href: string;
  readonly index: number;
}

export interface MarkdownBlockDirectiveInput {
  readonly language: string;
  readonly value: string;
}

export interface MarkdownImageRenderInput {
  readonly alt: string;
  readonly src: string;
  readonly title?: string;
}

export interface SafeMarkdownProps {
  readonly markdown: string;
  /** Prefix keeps heading anchors isolated when several projections are mounted. */
  readonly headingIdPrefix: string;
  readonly inertLinkTitle: string;
  /** Null omits remote images silently when a reading surface should not show security chrome. */
  readonly omittedImageLabel: string | null;
  /** Normal browser navigation for safe URLs. The default remains inert for model text. */
  readonly activateLinks?: boolean;
  /** Material readers may route repository-relative links without exposing file paths. */
  readonly renderLink?: (input: MarkdownLinkRenderInput) => ReactNode;
  /** Trusted reading surfaces may resolve authored images through app-owned routes. */
  readonly renderImage?: (input: MarkdownImageRenderInput) => ReactNode;
  /** App-owned fenced directives may render structured UI instead of code. */
  readonly renderBlockDirective?: (input: MarkdownBlockDirectiveInput) => ReactNode | undefined;
  /** Model output may show raw tag syntax as escaped text; content readers omit it. */
  readonly showRawHtmlSource?: boolean;
  /** Authored Markdown may use the conventional $…$ form for inline maths. */
  readonly allowSingleDollarMath?: boolean;
  /** Authored Markdown may render fenced Mermaid source as a diagram. */
  readonly allowMermaidDiagrams?: boolean;
  /** Authored material may opt into a tiny semantic HTML allowlist. */
  readonly allowSafeInlineHtml?: boolean;
  /** Compact labels can render Markdown without an invalid paragraph wrapper. */
  readonly inline?: boolean;
}

function headingText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(headingText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return headingText(node.props.children);
  return "";
}

export function markdownHeadingSlug(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^\p{Letter}\p{Number}\p{Mark}\s_-]/gu, "")
    .replace(/\s+/gu, "-");
}

/** GitHub-style duplicate suffixes keep rendered headings and verified fragments aligned. */
class MarkdownHeadingSlugger {
  readonly #seen = new Map<string, number>();

  public slug(value: string): string {
    const base = markdownHeadingSlug(value);
    const seen = this.#seen.get(base) ?? 0;
    this.#seen.set(base, seen + 1);
    return seen === 0 ? base : `${base}-${seen}`;
  }
}

function backslashIsEscaped(value: string, index: number): boolean {
  let count = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) {
    count += 1;
  }
  return count % 2 === 1;
}

function replaceBracketMath(value: string): string {
  let output = "";
  let cursor = 0;

  while (cursor < value.length) {
    if (
      value[cursor] !== "\\"
      || (value[cursor + 1] !== "(" && value[cursor + 1] !== "[")
      || backslashIsEscaped(value, cursor)
    ) {
      output += value[cursor];
      cursor += 1;
      continue;
    }

    const opening = value[cursor + 1];
    const closing = opening === "(" ? ")" : "]";
    let closeAt = cursor + 2;
    while (closeAt < value.length) {
      if (
        value[closeAt] === "\\"
        && value[closeAt + 1] === closing
        && !backslashIsEscaped(value, closeAt)
      ) {
        break;
      }
      closeAt += 1;
    }

    if (closeAt >= value.length) {
      output += value.slice(cursor);
      break;
    }

    output += `$$${value.slice(cursor + 2, closeAt)}$$`;
    cursor = closeAt + 2;
  }

  return output;
}

function replaceBracketMathOutsideInlineCode(value: string): string {
  let output = "";
  let plainStart = 0;
  let cursor = 0;

  while (cursor < value.length) {
    if (value[cursor] !== "`") {
      cursor += 1;
      continue;
    }

    let runLength = 1;
    while (value[cursor + runLength] === "`") runLength += 1;
    const delimiter = "`".repeat(runLength);
    let closeAt = cursor + runLength;
    while ((closeAt = value.indexOf(delimiter, closeAt)) !== -1) {
      if (value[closeAt - 1] !== "`" && value[closeAt + runLength] !== "`") break;
      closeAt += runLength;
    }

    if (closeAt === -1) {
      cursor += runLength;
      continue;
    }

    output += replaceBracketMath(value.slice(plainStart, cursor));
    output += value.slice(cursor, closeAt + runLength);
    cursor = closeAt + runLength;
    plainStart = cursor;
  }

  return output + replaceBracketMath(value.slice(plainStart));
}

interface MarkdownContainerLine {
  readonly openingPrefix: string;
  readonly continuationPrefix: string;
  readonly content: string;
  readonly newline: string;
}

function markdownContainerLine(line: string): MarkdownContainerLine {
  const newline = line.endsWith("\n") ? "\n" : "";
  const value = newline ? line.slice(0, -1) : line;
  let openingPrefix = "";
  let continuationPrefix = "";
  let remainder = value;

  while (true) {
    const quote = /^ {0,3}>[\t ]?/u.exec(remainder);
    if (quote) {
      openingPrefix += quote[0];
      continuationPrefix += quote[0];
      remainder = remainder.slice(quote[0].length);
      continue;
    }
    const list = /^ {0,3}(?:[-+*]|\d{1,9}[.)])[\t ]+/u.exec(remainder);
    if (list) {
      openingPrefix += list[0];
      continuationPrefix += " ".repeat(indentationWidth(list[0]));
      remainder = remainder.slice(list[0].length);
      continue;
    }
    const indentation = /^ {0,3}/u.exec(remainder)?.[0] ?? "";
    openingPrefix += indentation;
    continuationPrefix += indentation;
    remainder = remainder.slice(indentation.length);
    break;
  }

  return { openingPrefix, continuationPrefix, content: remainder, newline };
}

/**
 * remark-math treats one-line $$…$$ as inline maths, and requires multiline
 * display delimiters to occupy their own lines. Course material commonly uses
 * both compact forms, so canonicalize only line-leading standalone blocks.
 */
function normalizeStandaloneDisplayMath(value: string): string {
  const lines = value.match(/[^\n]*(?:\n|$)/gu) ?? [];
  const output: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = markdownContainerLine(lines[index] ?? "");
    const singleLine = /^\$\$(.+?)\$\$[\t ]*$/u.exec(line.content);
    if (singleLine?.[1] && !singleLine[1].includes("$$")) {
      output.push(
        `${line.openingPrefix}$$${line.newline || "\n"}`,
        `${line.continuationPrefix}${singleLine[1]}${line.newline || "\n"}`,
        `${line.continuationPrefix}$$${line.newline}`,
      );
      continue;
    }

    const opening = /^\$\$(.+)$/u.exec(line.content);
    if (!opening?.[1] || opening[1].includes("$$")) {
      output.push(lines[index] ?? "");
      continue;
    }

    let closingIndex = -1;
    let closingBody = "";
    for (let candidate = index + 1; candidate < lines.length; candidate += 1) {
      const candidateLine = markdownContainerLine(lines[candidate] ?? "");
      const closing = /^(.*?)\$\$[\t ]*$/u.exec(candidateLine.content);
      if (!closing) continue;
      closingIndex = candidate;
      closingBody = closing[1] ?? "";
      break;
    }
    if (closingIndex < 0) {
      output.push(lines[index] ?? "");
      continue;
    }

    output.push(
      `${line.openingPrefix}$$${line.newline || "\n"}`,
      `${line.continuationPrefix}${opening[1]}${line.newline || "\n"}`,
    );
    for (let candidate = index + 1; candidate < closingIndex; candidate += 1) {
      output.push(lines[candidate] ?? "");
    }
    const closing = markdownContainerLine(lines[closingIndex] ?? "");
    if (closingBody) {
      output.push(`${closing.openingPrefix}${closingBody}${closing.newline || "\n"}`);
    }
    output.push(`${closing.openingPrefix}$$${closing.newline}`);
    index = closingIndex;
  }

  return output.join("");
}

const SAFE_INLINE_HTML_TAG = /^<\s*(\/?)\s*(strong|b|em|i|code|sup|small)\s*>$/iu;

type SafeInlineHtmlNode = Nodes & {
  data?: { hName?: string };
};

function safeInlineNode(tag: string, children: Nodes[]): SafeInlineHtmlNode {
  if (tag === "strong" || tag === "b") {
    return { type: "strong", children } as SafeInlineHtmlNode;
  }
  if (tag === "em" || tag === "i") {
    return { type: "emphasis", children } as SafeInlineHtmlNode;
  }
  if (tag === "code") {
    const value = children.map((child) => (
      child.type === "text" || child.type === "inlineCode" ? child.value : ""
    )).join("");
    return { type: "inlineCode", value } as SafeInlineHtmlNode;
  }
  return {
    type: "safeInlineHtml",
    data: { hName: tag },
    children,
  } as unknown as SafeInlineHtmlNode;
}

function transformSafeInlineHtmlChildren(children: Nodes[]): Nodes[] {
  const output: Nodes[] = [];
  for (let index = 0; index < children.length; index += 1) {
    const node = children[index]!;
    const opening = node.type === "html" ? SAFE_INLINE_HTML_TAG.exec(node.value) : null;
    if (!opening || opening[1]) {
      output.push(node);
      continue;
    }

    const tag = opening[2]!.toLowerCase();
    let depth = 1;
    let closingIndex = -1;
    for (let candidate = index + 1; candidate < children.length; candidate += 1) {
      const possible = children[candidate]!;
      const match = possible.type === "html" ? SAFE_INLINE_HTML_TAG.exec(possible.value) : null;
      if (!match || match[2]!.toLowerCase() !== tag) continue;
      depth += match[1] ? -1 : 1;
      if (depth === 0) {
        closingIndex = candidate;
        break;
      }
    }
    if (closingIndex < 0) {
      output.push(node);
      continue;
    }

    const inner = transformSafeInlineHtmlChildren(children.slice(index + 1, closingIndex));
    output.push(safeInlineNode(tag, inner));
    index = closingIndex;
  }
  return output;
}

/** Exact, attribute-free semantic tags only; all other authored HTML stays inert. */
function remarkSafeInlineHtml() {
  return (tree: Root) => {
    const visit = (node: Nodes | Root) => {
      if (!("children" in node)) return;
      const parent = node as Parent;
      parent.children = transformSafeInlineHtmlChildren(parent.children as Nodes[]) as Parent["children"];
      for (const child of parent.children) visit(child as Nodes);
    };
    visit(tree);
  };
}

interface MarkdownFence {
  readonly marker: "`" | "~";
  readonly length: number;
  readonly maxClosingIndent: number;
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

function fenceAtLineStart(line: string): MarkdownFence | null {
  const content = stripMarkdownContainerPrefixes(line);
  const match = /^ {0,3}(`{3,}|~{3,})/u.exec(content);
  if (!match?.[1]) return null;
  const markerAt = line.indexOf(match[1]);
  return {
    marker: match[1][0] as "`" | "~",
    length: match[1].length,
    maxClosingIndent: Math.max(0, markerAt) + 3,
  };
}

function closesFence(line: string, fence: MarkdownFence): boolean {
  const content = stripMarkdownContainerPrefixes(line);
  const match = /^([\t ]*)(`+|~+)[\t ]*(?:\r?\n)?$/u.exec(content);
  return Boolean(
    match?.[2]
    && indentationWidth(match[1] ?? "") <= fence.maxClosingIndent
    && match[2][0] === fence.marker
    && match[2].length >= fence.length,
  );
}

/**
 * Normalizes the two LaTeX delimiter forms models commonly emit into the
 * Markdown-math forms understood by remark-math. Fenced and inline code stay
 * byte-for-byte presentation-equivalent, and unmatched delimiters stay literal.
 * The stored transcript is never changed.
 */
export function normalizeMarkdownMathDelimiters(markdown: string): string {
  const lines = markdown.match(/[^\n]*(?:\n|$)/gu) ?? [];
  let output = "";
  let prose = "";
  let fence: MarkdownFence | null = null;

  const flushProse = () => {
    output += normalizeStandaloneDisplayMath(replaceBracketMathOutsideInlineCode(prose));
    prose = "";
  };

  for (const line of lines) {
    if (fence) {
      output += line;
      if (closesFence(line, fence)) fence = null;
      continue;
    }

    const openingFence = fenceAtLineStart(line);
    if (openingFence) {
      flushProse();
      output += line;
      fence = openingFence;
      continue;
    }

    if (/^(?: {4}|\t)/u.test(line)) {
      flushProse();
      output += line;
      continue;
    }

    prose += line;
  }

  flushProse();
  return output;
}

/**
 * Renders untrusted Markdown without activating raw HTML, unverified links, or
 * remote images. Literal HTML syntax stays visible as escaped text; navigation
 * and media actions remain application-owned.
 */
export function SafeMarkdown({
  markdown,
  headingIdPrefix,
  inertLinkTitle,
  omittedImageLabel,
  activateLinks = false,
  renderLink,
  renderImage,
  renderBlockDirective,
  showRawHtmlSource = false,
  allowSingleDollarMath = false,
  allowMermaidDiagrams = false,
  allowSafeInlineHtml = false,
  inline = false,
}: SafeMarkdownProps) {
  const slugger = new MarkdownHeadingSlugger();
  let linkIndex = 0;
  const headingId = (children: ReactNode) => `${headingIdPrefix}${slugger.slug(headingText(children))}`;

  return (
    <ReactMarkdown
      remarkPlugins={[
        remarkGfm,
        [remarkMath, { singleDollarTextMath: allowSingleDollarMath }],
        ...(allowSafeInlineHtml ? [remarkSafeInlineHtml] : []),
      ]}
      rehypePlugins={[[rehypeKatex, {
        maxExpand: 1_000,
        maxSize: 50,
        output: "htmlAndMathml",
        strict: "ignore",
        trust: false,
      }]]}
      skipHtml={!showRawHtmlSource}
      components={{
        p: ({ children }) => inline ? <span className="markdown-inline">{children}</span> : <p>{children}</p>,
        h1: ({ children }) => <h1 id={headingId(children)}>{children}</h1>,
        h2: ({ children }) => <h2 id={headingId(children)}>{children}</h2>,
        h3: ({ children }) => <h3 id={headingId(children)}>{children}</h3>,
        h4: ({ children }) => <h4 id={headingId(children)}>{children}</h4>,
        a: ({ children, href = "" }) => {
          const currentIndex = linkIndex;
          linkIndex += 1;
          if (renderLink) return renderLink({ children, href, index: currentIndex });
          if (activateLinks && href) {
            const targetHref = href.startsWith("#")
              ? `#${headingIdPrefix}${markdownHeadingSlug(href.slice(1))}`
              : href;
            const external = /^https?:\/\//iu.test(targetHref);
            return (
              <a
                href={targetHref}
                {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
              >
                {children}
              </a>
            );
          }
          return (
            <span className="markdown-link-disabled" title={inertLinkTitle}>
              {children}
            </span>
          );
        },
        img: ({ alt = "", src = "", title }) => {
          if (renderImage && src) return renderImage({ alt, src, ...(title ? { title } : {}) });
          if (omittedImageLabel === null) return null;
          return (
            <span className="markdown-image-omitted">
              {omittedImageLabel}{alt ? `: ${alt}` : ""}
            </span>
          );
        },
        pre: ({ children }) => {
          const child = Array.isArray(children) ? children[0] : children;
          const childProps = isValidElement<{ className?: string; children?: ReactNode }>(child)
            ? child.props
            : undefined;
          const language = childProps?.className
            ?.match(/(?:^|\s)language-([^\s]+)/u)?.[1]
            ?.toLowerCase();
          const value = headingText(childProps?.children ?? child).replace(/\n$/u, "");
          if (language && renderBlockDirective) {
            const rendered = renderBlockDirective({
              language,
              value,
            });
            if (rendered !== undefined) return rendered;
          }
          if (allowMermaidDiagrams && language === "mermaid") {
            return <MermaidDiagram source={value} />;
          }
          return <MarkdownCodeBlock>{children}</MarkdownCodeBlock>;
        },
      }}
    >
      {normalizeMarkdownMathDelimiters(markdown)}
    </ReactMarkdown>
  );
}
