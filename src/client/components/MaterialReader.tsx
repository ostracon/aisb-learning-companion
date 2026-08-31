import {
  isValidElement,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type {
  CurriculumSectionView,
  LearningDayId,
  MaterialDisplayProjection,
  MaterialDocumentResponse,
  MaterialManifestResponse,
} from "../../shared/api.js";
import { MATERIAL_FOLD_DIRECTIVE_LANGUAGE } from "../../shared/api.js";
import { sectionTitleWithoutRepeatedId } from "../curriculum/section-label.js";
import {
  SafeMarkdown,
  markdownHeadingSlug,
  type MarkdownImageRenderInput,
  type MarkdownLinkRenderInput,
} from "./SafeMarkdown.js";

interface MaterialReaderProps {
  readonly dayId: LearningDayId;
  readonly sections: readonly CurriculumSectionView[];
  readonly selectedSectionId: string | null;
  readonly selectedDocumentId: string | null;
  readonly selectedFragment: string | null;
  /** A restored history-entry position wins over replaying its original fragment. */
  readonly allowFragmentScroll?: boolean;
  readonly onNavigate: (path: string, options?: { replace?: boolean }) => void;
  readonly onContextChanged?: (context: {
    readonly sectionId: string;
    readonly documentId: string;
    readonly manifestRevision: string;
    readonly title: string;
    readonly accessClassification: "tutor_readable" | "human_reader_only";
    readonly contentHash: string;
  } | null) => void;
}

async function responsePayload<T>(response: Response, fallback: string): Promise<T> {
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? fallback);
  return body;
}

function documentRoute(
  dayId: LearningDayId,
  sectionId: string,
  documentId: string,
  fragment?: string,
): string {
  const path = `/study/${dayId}/section/${encodeURIComponent(sectionId)}/document/${encodeURIComponent(documentId)}`;
  return fragment ? `${path}#${encodeURIComponent(fragment)}` : path;
}

function decodedFragment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function repositoryDayForSection(sectionId: string): LearningDayId {
  const day = Number(sectionId.split(".")[0]);
  return Number.isInteger(day) && day >= 0 && day <= 7
    ? (`day${day}` as LearningDayId)
    : "day0";
}

function renderedLinkText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(renderedLinkText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return renderedLinkText(node.props.children);
  return "";
}

function materialImageRoute(material: MaterialDocumentResponse, source: string): string {
  const query = new URLSearchParams({
    manifest_revision: material.manifestRevision,
    source,
  });
  return `/api/materials/sections/${encodeURIComponent(material.sectionId)}/documents/${encodeURIComponent(material.document.documentId)}/image?${query.toString()}`;
}

interface MaterialProjectionProps {
  readonly projection: MaterialDisplayProjection;
  readonly material: MaterialDocumentResponse;
  readonly dayId: LearningDayId;
  readonly onNavigate: MaterialReaderProps["onNavigate"];
  readonly foldOpenOverrides: Readonly<Record<string, boolean>>;
  readonly onFoldToggle: (foldId: string, open: boolean, anchor: HTMLElement) => void;
  readonly headingIdPrefix?: string;
}

function MaterialProjection({
  projection,
  material,
  dayId,
  onNavigate,
  foldOpenOverrides,
  onFoldToggle,
  headingIdPrefix = "material-heading-",
}: MaterialProjectionProps) {
  const folds = new Map(projection.folds.map((fold) => [fold.foldId, fold]));
  const renderLink = ({ children, href }: MarkdownLinkRenderInput) => {
    // Web URLs are intentionally trusted at their inline location; they do not
    // need to round-trip through the bounded repository document index.
    if (/^https?:\/\//iu.test(href)) {
      return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
    }
    const label = renderedLinkText(children);
    const matchingLinks = material.document.links.filter((candidate) =>
      candidate.label === label,
    );
    // Label identity must be unique. Falling back to a projection-local link
    // ordinal can misroute a fold link to an unrelated document-global entry.
    const link = matchingLinks.length === 1 ? matchingLinks[0] : undefined;
    if (link?.kind === "document") {
      return (
        <button
          type="button"
          className="markdown-inline-link"
          onClick={() => onNavigate(documentRoute(
            dayId,
            material.sectionId,
            link.documentId,
            link.fragment,
          ))}
        >
          {children}
        </button>
      );
    }
    if (link?.kind === "section") {
      return (
        <button
          type="button"
          className="markdown-inline-link"
          onClick={() => onNavigate([
            `/study/${repositoryDayForSection(link.sectionId)}/section/${encodeURIComponent(link.sectionId)}`,
            link.fragment ? `#${encodeURIComponent(link.fragment)}` : "",
          ].join(""))}
        >
          {children}
        </button>
      );
    }
    if (link?.kind === "external") {
      return <a href={link.url} target="_blank" rel="noreferrer">{children}</a>;
    }
    return (
      <span
        className="markdown-link-disabled"
        title={link?.kind === "unavailable"
          ? link.reason.replaceAll("_", " ")
          : "Repository target unavailable"}
      >
        {children}
      </span>
    );
  };
  const renderImage = ({ alt, src, title }: MarkdownImageRenderInput) => {
    const external = /^https:\/\//iu.test(src);
    if (!external && (/^[a-z][a-z\d+.-]*:/iu.test(src) || src.startsWith("//"))) {
      return null;
    }
    return (
      <img
        className="material-image"
        src={external ? src : materialImageRoute(material, src)}
        alt={alt}
        {...(title ? { title } : {})}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
      />
    );
  };

  return (
    <SafeMarkdown
      markdown={projection.markdown}
      headingIdPrefix={headingIdPrefix}
      inertLinkTitle="This repository target is unavailable"
      omittedImageLabel={null}
      renderLink={renderLink}
      renderImage={renderImage}
      renderBlockDirective={({ language, value }) => {
        if (language !== MATERIAL_FOLD_DIRECTIVE_LANGUAGE) return undefined;
        const fold = folds.get(value);
        if (!fold) return undefined;
        const browserOnly = fold.contextVisibility === "browser_only";
        const open = foldOpenOverrides[fold.foldId] ?? fold.defaultOpen;
        return (
          <details
            className={`material-disclosure${browserOnly ? " browser-only" : " course-context"}`}
            data-context-visibility={fold.contextVisibility}
            open={open}
          >
            <summary
              data-material-fold-id={fold.foldId}
              aria-expanded={open}
              onClick={(event) => {
                event.preventDefault();
                onFoldToggle(fold.foldId, !open, event.currentTarget);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                onFoldToggle(fold.foldId, !open, event.currentTarget);
              }}
            >
              <span>{fold.summary}</span>
            </summary>
            <div className="material-disclosure-body">
              <MaterialProjection
                projection={fold.body}
                material={material}
                dayId={dayId}
                onNavigate={onNavigate}
                foldOpenOverrides={foldOpenOverrides}
                onFoldToggle={onFoldToggle}
                headingIdPrefix={`material-fold-heading-${fold.foldId}-`}
              />
            </div>
          </details>
        );
      }}
    />
  );
}

export function MaterialReader({
  dayId,
  sections,
  selectedSectionId,
  selectedDocumentId,
  selectedFragment,
  allowFragmentScroll = true,
  onNavigate,
  onContextChanged,
}: MaterialReaderProps) {
  const selectedSection = sections.find((section) => section.sectionId === selectedSectionId) ?? null;
  const [manifest, setManifest] = useState<MaterialManifestResponse | null>(null);
  const [material, setMaterial] = useState<MaterialDocumentResponse | null>(null);
  const [manifestLoading, setManifestLoading] = useState(false);
  const [documentLoading, setDocumentLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [foldOpenStateByDocument, setFoldOpenStateByDocument] = useState<
    Readonly<Record<string, Readonly<Record<string, boolean>>>>
  >({});
  const pendingFoldAnchorRef = useRef<{
    readonly foldId: string;
    readonly scroller: HTMLElement;
    readonly summary: HTMLElement;
    readonly viewportTop: number;
    readonly restoreFocus: boolean;
  } | null>(null);
  const loading = manifestLoading || documentLoading;
  const materialDocumentKey = material
    ? `${material.document.documentId}:${material.document.contentHash}`
    : "";
  const foldOpenOverrides = foldOpenStateByDocument[materialDocumentKey] ?? {};
  const onFoldToggle = (foldId: string, open: boolean, anchor: HTMLElement) => {
    if (!materialDocumentKey) return;
    const scroller = anchor.closest<HTMLElement>(".workspace-scroll");
    if (scroller) {
      pendingFoldAnchorRef.current = {
        foldId,
        scroller,
        summary: anchor,
        viewportTop: anchor.getBoundingClientRect().top,
        restoreFocus: document.activeElement === anchor,
      };
    }
    setFoldOpenStateByDocument((current) => {
      const overrides = current[materialDocumentKey] ?? {};
      if (overrides[foldId] === open) return current;
      return {
        ...current,
        [materialDocumentKey]: { ...overrides, [foldId]: open },
      };
    });
  };

  useLayoutEffect(() => {
    const pending = pendingFoldAnchorRef.current;
    if (!pending) return;
    pendingFoldAnchorRef.current = null;
    const summary = pending.summary.isConnected
      ? pending.summary
      : Array.from(pending.scroller.querySelectorAll<HTMLElement>(".material-disclosure > summary"))
        .find((candidate) => candidate.dataset.materialFoldId === pending.foldId);
    if (!summary) return;
    const displacement = summary.getBoundingClientRect().top - pending.viewportTop;
    if (Number.isFinite(displacement) && Math.abs(displacement) >= 0.5) {
      // A controlled <details> update can otherwise make the browser select a
      // different scroll anchor. Keep the summary the learner activated fixed
      // in the viewport without animating the correction.
      const scrollBehavior = pending.scroller.style.scrollBehavior;
      pending.scroller.style.scrollBehavior = "auto";
      try {
        pending.scroller.scrollTop += displacement;
      } finally {
        pending.scroller.style.scrollBehavior = scrollBehavior;
      }
    }
    if (pending.restoreFocus && document.activeElement !== summary) {
      summary.focus({ preventScroll: true });
    }
  }, [foldOpenStateByDocument]);

  useEffect(() => {
    if (selectedSectionId !== null && selectedSection !== null) return;
    const first = sections[0];
    if (first) {
      onNavigate(`/study/${dayId}/section/${encodeURIComponent(first.sectionId)}`, { replace: true });
    }
  }, [dayId, onNavigate, sections, selectedSection, selectedSectionId]);

  useEffect(() => {
    onContextChanged?.(null);
  }, [onContextChanged, selectedSectionId, selectedDocumentId]);

  useEffect(() => {
    if (!selectedSection) {
      setManifest(null);
      setMaterial(null);
      setManifestLoading(false);
      setDocumentLoading(false);
      return;
    }
    const controller = new AbortController();
    setManifestLoading(true);
    setDocumentLoading(false);
    setError(null);
    setManifest(null);
    setMaterial(null);
    void fetch(`/api/materials/sections/${encodeURIComponent(selectedSection.sectionId)}`, {
      signal: controller.signal,
    })
      .then((response) => responsePayload<MaterialManifestResponse>(response, "The section material could not be indexed"))
      .then((nextManifest) => {
        if (!controller.signal.aborted) setManifest(nextManifest);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : "The section material could not be indexed");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setManifestLoading(false);
      });
    return () => controller.abort();
  }, [selectedSection]);

  useEffect(() => {
    if (!selectedSection || !manifest) return;
    const requested = selectedDocumentId === null
      ? null
      : manifest.documents.find((document) => document.documentId === selectedDocumentId);
    const documentId = requested?.documentId ?? manifest.rootDocumentId;
    if (selectedDocumentId !== documentId) {
      onNavigate(documentRoute(
        dayId,
        selectedSection.sectionId,
        documentId,
        selectedFragment ?? undefined,
      ), { replace: true });
    }
  }, [dayId, manifest, onNavigate, selectedDocumentId, selectedFragment, selectedSection]);

  const activeDocumentId = useMemo(() => {
    if (!manifest) return null;
    return manifest.documents.some((document) => document.documentId === selectedDocumentId)
      ? selectedDocumentId
      : manifest.rootDocumentId;
  }, [manifest, selectedDocumentId]);
  const activeDocument = useMemo(
    () => manifest?.documents.find((document) => document.documentId === activeDocumentId) ?? null,
    [activeDocumentId, manifest],
  );

  useEffect(() => {
    if (!selectedSection || !manifest || !activeDocumentId) return;
    const controller = new AbortController();
    setDocumentLoading(true);
    setError(null);
    setMaterial(null);
    const query = new URLSearchParams({ manifest_revision: manifest.revision });
    void fetch(
      `/api/materials/sections/${encodeURIComponent(selectedSection.sectionId)}/documents/${encodeURIComponent(activeDocumentId)}?${query}`,
      { signal: controller.signal },
    )
      .then((response) => responsePayload<MaterialDocumentResponse>(response, "The selected material could not be read"))
      .then((nextMaterial) => {
        if (!controller.signal.aborted) setMaterial(nextMaterial);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : "The selected material could not be read");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setDocumentLoading(false);
      });
    return () => controller.abort();
  }, [activeDocumentId, manifest, selectedSection]);

  useEffect(() => {
    if (!material) return;
    onContextChanged?.({
      sectionId: material.sectionId,
      documentId: material.document.documentId,
      manifestRevision: material.manifestRevision,
      title: material.document.title,
      accessClassification: material.document.accessClassification,
      contentHash: material.document.contentHash,
    });
  }, [material, onContextChanged]);

  useEffect(() => {
    if (!material || !selectedFragment || !allowFragmentScroll) return;
    const targetId = `material-heading-${markdownHeadingSlug(decodedFragment(selectedFragment))}`;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(targetId)?.scrollIntoView({ block: "start" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [allowFragmentScroll, material, selectedFragment]);

  if (sections.length === 0) {
    return (
      <section className="material-reader material-empty" aria-labelledby="materials-heading">
        <p className="page-kicker">Repository day</p>
        <h2 id="materials-heading">No authored sections</h2>
        <p>This repository has no numbered sections for Day {dayId.slice(3)}. Choose another repository day or return to Today.</p>
      </section>
    );
  }

  return (
    <section className="material-reader" aria-labelledby="materials-heading">
      <header className="material-heading">
        <div>
          <p className="page-kicker">Repository material</p>
          <h2 id="materials-heading">
            {activeDocument?.kind === "readme"
              ? "README"
              : activeDocument?.title ?? selectedSection?.title ?? "Choose a section"}
          </h2>
        </div>
        {manifest?.truncated ? <span className="material-badge warning">Index bounded</span> : null}
      </header>

      <div className="material-navigation" aria-label="Curriculum files">
        <nav className="section-strip" aria-label="Sections for this repository day">
          {sections.map((section) => (
            <button
              className={section.sectionId === selectedSection?.sectionId ? "active" : ""}
              key={section.sectionId}
              type="button"
              aria-current={section.sectionId === selectedSection?.sectionId ? "page" : undefined}
              onClick={() => onNavigate(`/study/${dayId}/section/${encodeURIComponent(section.sectionId)}`)}
            >
              <strong>{section.sectionId}</strong>
              <span>{sectionTitleWithoutRepeatedId(section.sectionId, section.title)}</span>
            </button>
          ))}
        </nav>
        {manifest ? (
          <nav className="document-strip" aria-label="Documents in this section graph">
            {manifest.documents.map((document) => (
              <button
                className={document.documentId === activeDocumentId ? "active" : ""}
                key={document.documentId}
                type="button"
                aria-current={document.documentId === activeDocumentId ? "page" : undefined}
                onClick={() => onNavigate(documentRoute(dayId, manifest.sectionId, document.documentId))}
              >
                <span>{document.kind === "readme" ? "Readme" : document.kind === "participant_instructions" ? "Exercises" : "Reading"}</span>
                <strong>{document.title}</strong>
              </button>
            ))}
          </nav>
        ) : null}
      </div>

      {error ? <p className="material-status error" role="alert">{error}</p> : null}
      {loading && !material ? <p className="material-status" role="status">Reading the learner-visible material…</p> : null}
      {material ? (
        <>
          <div className="material-document-meta">
            <span className="material-badge">
              {material.document.kind === "readme"
                ? "Section README"
                : material.document.kind === "participant_instructions"
                  ? "Participant exercises"
                  : "Linked reading"}
            </span>
            {material.displayProjection === "structured_instructions" ? (
              <span className="material-projection-note">
                All course folds available
                {material.browserOnlyFoldCount > 0
                  ? ` · ${material.browserOnlyFoldCount} stay out of tutor context`
                  : ""}
              </span>
            ) : null}
          </div>
          <article className="markdown-reader">
            <MaterialProjection
              projection={material.display}
              material={material}
              dayId={dayId}
              onNavigate={onNavigate}
              foldOpenOverrides={foldOpenOverrides}
              onFoldToggle={onFoldToggle}
            />
          </article>
        </>
      ) : null}
    </section>
  );
}
