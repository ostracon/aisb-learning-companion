import { isValidElement, type ReactNode } from "react";
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
    output += replaceBracketMathOutsideInlineCode(prose);
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
}: SafeMarkdownProps) {
  const slugger = new MarkdownHeadingSlugger();
  let linkIndex = 0;
  const headingId = (children: ReactNode) => `${headingIdPrefix}${slugger.slug(headingText(children))}`;

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, [remarkMath, { singleDollarTextMath: allowSingleDollarMath }]]}
      rehypePlugins={[[rehypeKatex, {
        maxExpand: 1_000,
        maxSize: 50,
        output: "htmlAndMathml",
        strict: "ignore",
        trust: false,
      }]]}
      skipHtml={!showRawHtmlSource}
      components={{
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
