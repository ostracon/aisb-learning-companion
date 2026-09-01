import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export type SourceDecision =
  | { allowed: true; canonicalPath: string; relativePath: string; kind: "visible-curriculum" | "participant-work" }
  | { allowed: false; reason: string };

export type SourceClassification =
  | { allowed: true; relativePath: string; kind: "visible-curriculum" | "participant-work" }
  | { allowed: false; reason: string };

const protectedSegments = new Set([
  ".git",
  ".env",
  ".venv",
  "node_modules",
  "reference_solutions",
  "solutions",
  "secrets",
]);

const protectedFilePatterns = [
  /_solution\.py$/i,
  /_reference\.py$/i,
  /_test\.py$/i,
  /_instructions\.md$/i,
  /(^|\.)env($|\.)/i,
  /(?:^|[/._-])(?:credentials?|secrets?|tokens?|private[_-]?keys?)(?:$|[/._-])/i,
];

function pathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}

export function classifyRelativeAisbPath(relativePath: string): SourceClassification {
  if (!relativePath || isAbsolute(relativePath) || relativePath.includes("\0")) {
    return { allowed: false, reason: "A repository-relative file path is required" };
  }
  const normalized = relativePath.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === ".." || protectedSegments.has(segment.toLowerCase()))) {
    return { allowed: false, reason: "The path crosses a protected repository boundary" };
  }
  if (protectedFilePatterns.some((pattern) => pattern.test(normalized))) {
    return { allowed: false, reason: "The file is protected learning or secret material" };
  }
  if (normalized.endsWith("/README.md") || normalized === "README.md") {
    return { allowed: true, relativePath: normalized, kind: "visible-curriculum" };
  }
  if (/\/(?:day\d+_answers|answers?)\.(?:py|md|ipynb)$/i.test(`/${normalized}`)) {
    return { allowed: true, relativePath: normalized, kind: "participant-work" };
  }
  return { allowed: false, reason: "The file is not in an explicitly readable source class" };
}

export async function assertReadableAisbPath(aisbRoot: string, relativePath: string): Promise<SourceDecision> {
  const classification = classifyRelativeAisbPath(relativePath);
  if (!classification.allowed) return classification;

  const canonicalRoot = await realpath(aisbRoot);
  const requested = resolve(canonicalRoot, classification.relativePath);
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(requested);
  } catch {
    return { allowed: false, reason: "The selected file does not exist" };
  }
  if (!pathInside(canonicalRoot, canonicalPath)) {
    return { allowed: false, reason: "The selected file resolves outside the AISB repository" };
  }
  const metadata = await stat(canonicalPath);
  if (!metadata.isFile()) return { allowed: false, reason: "The selected path is not a regular file" };
  return { ...classification, canonicalPath };
}
