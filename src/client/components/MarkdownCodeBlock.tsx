import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import plaintext from "highlight.js/lib/languages/plaintext";
import powershell from "highlight.js/lib/languages/powershell";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import {
  isValidElement,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

for (const [name, language] of [
  ["bash", bash],
  ["c", c],
  ["cpp", cpp],
  ["css", css],
  ["diff", diff],
  ["dockerfile", dockerfile],
  ["go", go],
  ["javascript", javascript],
  ["json", json],
  ["markdown", markdown],
  ["plaintext", plaintext],
  ["powershell", powershell],
  ["python", python],
  ["rust", rust],
  ["sql", sql],
  ["typescript", typescript],
  ["xml", xml],
  ["yaml", yaml],
] as const) {
  hljs.registerLanguage(name, language);
}

const AUTO_LANGUAGES = [
  "python",
  "javascript",
  "typescript",
  "json",
  "bash",
  "xml",
  "css",
  "yaml",
  "markdown",
  "sql",
  "c",
  "cpp",
  "rust",
  "go",
  "diff",
  "dockerfile",
  "powershell",
] as const;

const LANGUAGE_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  cxx: "cpp",
  docker: "dockerfile",
  htm: "xml",
  html: "xml",
  js: "javascript",
  jsx: "javascript",
  md: "markdown",
  ps: "powershell",
  ps1: "powershell",
  pwsh: "powershell",
  py: "python",
  python3: "python",
  sh: "bash",
  shell: "bash",
  text: "plaintext",
  ts: "typescript",
  tsx: "typescript",
  txt: "plaintext",
  yml: "yaml",
  zsh: "bash",
});

const LANGUAGE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  bash: "Shell",
  c: "C",
  cpp: "C++",
  css: "CSS",
  diff: "Diff",
  dockerfile: "Dockerfile",
  go: "Go",
  javascript: "JavaScript",
  json: "JSON",
  markdown: "Markdown",
  plaintext: "Code",
  powershell: "PowerShell",
  python: "Python",
  rust: "Rust",
  sql: "SQL",
  typescript: "TypeScript",
  xml: "HTML / XML",
  yaml: "YAML",
});

export interface HighlightedCode {
  readonly html: string;
  readonly language: string | null;
  readonly label: string;
  readonly source: "declared" | "detected" | "plain";
}

function codeText(value: ReactNode): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(codeText).join("");
  if (isValidElement<{ children?: ReactNode }>(value)) return codeText(value.props.children);
  return "";
}

function declaredLanguage(className: string | undefined): string | null {
  const raw = className?.match(/(?:^|\s)language-([^\s]+)/u)?.[1]?.toLowerCase() ?? null;
  if (!raw) return null;
  return LANGUAGE_ALIASES[raw] ?? raw;
}

function displayLanguage(language: string): string {
  return LANGUAGE_LABELS[language]
    ?? language.replaceAll(/[-_]+/gu, " ").replace(/^./u, (character) => character.toUpperCase());
}

/**
 * Explicit Markdown fence labels always win. Unlabelled blocks are detected
 * only when the common-language classifier has enough evidence; otherwise the
 * block remains deliberately plain rather than wearing a misleading label.
 */
export function highlightMarkdownCode(source: string, className?: string): HighlightedCode {
  const declared = declaredLanguage(className);
  if (declared) {
    const supported = hljs.getLanguage(declared) !== undefined;
    return {
      html: hljs.highlight(source, {
        language: supported ? declared : "plaintext",
        ignoreIllegals: true,
      }).value,
      language: supported ? declared : null,
      label: displayLanguage(declared),
      source: "declared",
    };
  }

  if (source.trim().length >= 32) {
    const detected = hljs.highlightAuto(source, [...AUTO_LANGUAGES]);
    if (detected.language && detected.relevance >= 3) {
      return {
        html: detected.value,
        language: detected.language,
        label: displayLanguage(detected.language),
        source: "detected",
      };
    }
  }

  return {
    html: hljs.highlight(source, { language: "plaintext" }).value,
    language: null,
    label: "Code",
    source: "plain",
  };
}

type CopyState = "idle" | "copied" | "failed";

export interface MarkdownCodeBlockProps {
  readonly children?: ReactNode;
}

/** Rendered Markdown code with conservative language detection and local copy feedback. */
export function MarkdownCodeBlock({ children }: MarkdownCodeBlockProps) {
  const child = Array.isArray(children) ? children[0] : children;
  const childProps = isValidElement<{ className?: string; children?: ReactNode }>(child)
    ? child.props
    : undefined;
  const source = codeText(childProps?.children ?? child).replace(/\n$/u, "");
  const highlighted = useMemo(
    () => highlightMarkdownCode(source, childProps?.className),
    [childProps?.className, source],
  );
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const resetTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
  }, []);

  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(source);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => setCopyState("idle"), 1_800);
  };

  const languageLabel = highlighted.source === "detected"
    ? `${highlighted.label} · detected`
    : highlighted.label;
  const copyLabel = copyState === "copied"
    ? "Copied"
    : copyState === "failed"
      ? "Copy failed"
      : "Copy code";
  const copyAriaLabel = highlighted.label === "Code"
    ? "Copy code"
    : `Copy ${highlighted.label.toLowerCase()} code`;

  return (
    <div className="markdown-code-block" data-language-source={highlighted.source}>
      <div className="markdown-code-toolbar">
        <span>{languageLabel}</span>
        <button
          type="button"
          className="markdown-copy-code"
          aria-label={copyAriaLabel}
          onClick={() => void copy()}
        >
          {copyLabel}
        </button>
      </div>
      <pre>
        <code
          className="hljs"
          data-language={highlighted.language ?? undefined}
          dangerouslySetInnerHTML={{ __html: highlighted.html }}
        />
      </pre>
    </div>
  );
}
