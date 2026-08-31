// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  CurriculumSectionView,
  MaterialDocumentResponse,
  MaterialManifestResponse,
} from "../../shared/api.js";
import { MATERIAL_FOLD_DIRECTIVE_LANGUAGE } from "../../shared/api.js";
import { MaterialReader } from "./MaterialReader.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
});

const documentId = `doc_${"a".repeat(64)}`;
const manifestRevision = `sha256:${"b".repeat(64)}`;
const section: CurriculumSectionView = {
  sectionId: "1.1",
  title: "Model boundaries",
  sourcePath: "1.1-model-boundaries/README.md",
  outcomes: [],
};

const manifest: MaterialManifestResponse = {
  sectionId: "1.1",
  revision: manifestRevision,
  rootDocumentId: documentId,
  truncated: false,
  documents: [{
    documentId,
    kind: "readme",
    title: "Model boundaries",
    filename: "README.md",
    accessClassification: "tutor_readable",
    contentHash: "d".repeat(64),
    byteLength: 240,
    linksTruncated: false,
    links: [
      { kind: "document", label: "Raw relative link", documentId, fragment: "safe-page" },
      { kind: "external", label: "Official guide", url: "https://example.com/guide" },
      { kind: "section", label: "Next section", sectionId: "1.2" },
    ],
  }],
};

const material: MaterialDocumentResponse = {
  audience: "browser_display",
  sectionId: "1.1",
  manifestRevision,
  document: manifest.documents[0]!,
  displayProjection: "structured_readme",
  browserOnlyFoldCount: 0,
  display: {
    markdown: [
      "# Safe page",
      "",
      "Bare URL: https://bare.example/path",
      "",
      "[Raw relative link](./private.md)",
      "",
      "[Official guide](https://example.com/guide)",
      "",
      "[Next section](../1.2/README.md)",
      "",
      "![Remote diagram](https://tracker.example/image.png)",
      "",
      "![Local inspect view](day2_utils/inspect-view.png)",
    ].join("\n"),
    folds: [],
  },
};

function response(body: unknown): Response {
  return { ok: true, json: async () => body } as Response;
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("MaterialReader", () => {
  it("renders working inline links through the repository document graph", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(manifest))
      .mockResolvedValueOnce(response(material));
    vi.stubGlobal("fetch", fetchMock);
    const navigate = vi.fn();
    const contextChanged = vi.fn();
    const user = userEvent.setup();

    render(
      <MaterialReader
        dayId="day1"
        sections={[section]}
        selectedSectionId="1.1"
        selectedDocumentId={documentId}
        selectedFragment={null}
        onNavigate={navigate}
        onContextChanged={contextChanged}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Safe page" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "README" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /1\.1\s*Model boundaries/ }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("button", { name: /Readme\s*Model boundaries/ }).getAttribute("aria-current")).toBe("page");
    expect(screen.queryByRole("link", { name: "Raw relative link" })).toBeNull();
    expect(screen.queryByText(/Image omitted from the safe reader/)).toBeNull();
    const remoteImage = screen.getByRole("img", { name: "Remote diagram" });
    expect(remoteImage.getAttribute("src")).toBe("https://tracker.example/image.png");
    expect(remoteImage.getAttribute("loading")).toBe("lazy");
    expect(remoteImage.getAttribute("referrerpolicy")).toBe("no-referrer");
    const localImage = screen.getByRole("img", { name: "Local inspect view" });
    expect(localImage.getAttribute("src")).toBe(
      `/api/materials/sections/1.1/documents/${documentId}/image?manifest_revision=${encodeURIComponent(manifestRevision)}&source=day2_utils%2Finspect-view.png`,
    );

    const bareUrl = screen.getByRole("link", { name: "https://bare.example/path" });
    expect(bareUrl.getAttribute("href")).toBe("https://bare.example/path");

    const officialGuide = screen.getByRole("link", { name: /Official guide/ });
    expect(officialGuide.getAttribute("href")).toBe("https://example.com/guide");
    expect(officialGuide.getAttribute("rel")).toBe("noreferrer");

    await user.click(screen.getByRole("button", { name: "Raw relative link" }));
    expect(navigate).toHaveBeenCalledWith(
      `/study/day1/section/1.1/document/${documentId}#safe-page`,
    );

    await user.click(screen.getByRole("button", { name: /Next section/ }));
    expect(navigate).toHaveBeenCalledWith("/study/day1/section/1.2");
    await waitFor(() => expect(contextChanged).toHaveBeenLastCalledWith(expect.objectContaining({
      sectionId: "1.1",
      documentId,
      manifestRevision,
    })));
  });

  it("keeps the section manifest and navigation stable when changing documents", async () => {
    const secondDocumentId = `doc_${"e".repeat(64)}`;
    const secondDocument = {
      ...manifest.documents[0]!,
      documentId: secondDocumentId,
      kind: "participant_instructions" as const,
      title: "Boundary exercises",
      filename: "boundary_instructions.md",
      contentHash: "f".repeat(64),
      links: [],
    };
    const twoDocumentManifest: MaterialManifestResponse = {
      ...manifest,
      documents: [manifest.documents[0]!, secondDocument],
    };
    const secondMaterial: MaterialDocumentResponse = {
      ...material,
      document: secondDocument,
      displayProjection: "structured_instructions",
      display: {
        markdown: "# Boundary exercises\n\nWork from the learner-visible trust boundary.",
        folds: [],
      },
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(twoDocumentManifest))
      .mockResolvedValueOnce(response(material))
      .mockResolvedValueOnce(response(secondMaterial));
    vi.stubGlobal("fetch", fetchMock);
    const navigate = vi.fn();

    const view = render(
      <MaterialReader
        dayId="day1"
        sections={[section]}
        selectedSectionId="1.1"
        selectedDocumentId={documentId}
        selectedFragment={null}
        onNavigate={navigate}
      />,
    );
    expect(await screen.findByRole("heading", { name: "Safe page" })).toBeTruthy();

    view.rerender(
      <MaterialReader
        dayId="day1"
        sections={[section]}
        selectedSectionId="1.1"
        selectedDocumentId={secondDocumentId}
        selectedFragment={null}
        onNavigate={navigate}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Boundary exercises" })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.filter(([url]) =>
      String(url) === "/api/materials/sections/1.1",
    )).toHaveLength(1);
    expect(screen.getByRole("button", { name: /Exercises\s*Boundary exercises/ }).getAttribute("aria-current")).toBe("page");
  });

  it("preserves a verified heading fragment while canonicalizing a section route to its README", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(response(manifest))
      .mockResolvedValueOnce(response(material)));
    const navigate = vi.fn();

    render(
      <MaterialReader
        dayId="day1"
        sections={[section]}
        selectedSectionId="1.1"
        selectedDocumentId={null}
        selectedFragment="safe-page"
        onNavigate={navigate}
      />,
    );

    await waitFor(() => expect(navigate).toHaveBeenCalledWith(
      `/study/day1/section/1.1/document/${documentId}#safe-page`,
      { replace: true },
    ));
  });

  it("does not replay a fragment over a restored history-entry scroll position", async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(response(manifest))
      .mockResolvedValueOnce(response(material)));

    render(
      <MaterialReader
        dayId="day1"
        sections={[section]}
        selectedSectionId="1.1"
        selectedDocumentId={documentId}
        selectedFragment="safe-page"
        allowFragmentScroll={false}
        onNavigate={vi.fn()}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Safe page" })).toBeTruthy();
    await act(async () => undefined);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("scrolls punctuation and duplicate-suffixed verified fragments to the rendered heading", async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(response(manifest))
      .mockResolvedValueOnce(response({
        ...material,
        display: {
          markdown: "## Threat Models & Boundaries\n\nFirst.\n\n## Threat Models & Boundaries\n\nSecond.",
          folds: [],
        },
      })));

    render(
      <MaterialReader
        dayId="day1"
        sections={[section]}
        selectedSectionId="1.1"
        selectedDocumentId={documentId}
        selectedFragment="threat-models-boundaries-1"
        onNavigate={vi.fn()}
      />,
    );

    expect((await screen.findAllByRole("heading", { name: "Threat Models & Boundaries" }))[1]?.id)
      .toBe("material-heading-threat-models-boundaries-1");
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledOnce());
  });

  it("ignores an older manifest whose JSON resolves after its section was abandoned", async () => {
    const staleManifest = deferred<MaterialManifestResponse>();
    const nextDocumentId = `doc_${"6".repeat(64)}`;
    const nextSection: CurriculumSectionView = {
      sectionId: "1.2",
      title: "Prompt boundaries",
      sourcePath: "1.2-prompt-boundaries/README.md",
      outcomes: [],
    };
    const nextManifest: MaterialManifestResponse = {
      ...manifest,
      sectionId: nextSection.sectionId,
      rootDocumentId: nextDocumentId,
      documents: [{
        ...manifest.documents[0]!,
        documentId: nextDocumentId,
        title: nextSection.title,
        contentHash: "7".repeat(64),
      }],
    };
    const nextMaterial: MaterialDocumentResponse = {
      ...material,
      sectionId: nextSection.sectionId,
      document: nextManifest.documents[0]!,
      display: { markdown: "# Current prompt boundaries", folds: [] },
    };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/materials/sections/1.1") {
        return Promise.resolve({ ok: true, json: () => staleManifest.promise } as Response);
      }
      if (url === "/api/materials/sections/1.2") return Promise.resolve(response(nextManifest));
      if (url.includes(`/api/materials/sections/1.2/documents/${nextDocumentId}`)) {
        return Promise.resolve(response(nextMaterial));
      }
      throw new Error(`Unexpected material request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = render(
      <MaterialReader
        dayId="day1"
        sections={[section, nextSection]}
        selectedSectionId="1.1"
        selectedDocumentId={null}
        selectedFragment={null}
        onNavigate={vi.fn()}
      />,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/materials/sections/1.1",
      expect.any(Object),
    ));

    view.rerender(
      <MaterialReader
        dayId="day1"
        sections={[section, nextSection]}
        selectedSectionId="1.2"
        selectedDocumentId={nextDocumentId}
        selectedFragment={null}
        onNavigate={vi.fn()}
      />,
    );
    expect(await screen.findByRole("heading", { name: "Current prompt boundaries", level: 1 })).toBeTruthy();

    await act(async () => {
      staleManifest.resolve(manifest);
      await staleManifest.promise;
    });
    expect(fetchMock.mock.calls.some(([url]) =>
      String(url).includes(`/api/materials/sections/1.2/documents/${documentId}`),
    )).toBe(false);
    expect(screen.getByRole("heading", { name: "Current prompt boundaries", level: 1 })).toBeTruthy();
  });

  it("ignores an older document whose JSON resolves after another document becomes active", async () => {
    const staleDocument = deferred<MaterialDocumentResponse>();
    const secondDocumentId = `doc_${"8".repeat(64)}`;
    const secondDocument = {
      ...manifest.documents[0]!,
      documentId: secondDocumentId,
      kind: "participant_instructions" as const,
      title: "Current exercises",
      filename: "current_instructions.md",
      contentHash: "9".repeat(64),
      links: [],
    };
    const twoDocumentManifest: MaterialManifestResponse = {
      ...manifest,
      documents: [manifest.documents[0]!, secondDocument],
    };
    const currentMaterial: MaterialDocumentResponse = {
      ...material,
      document: secondDocument,
      displayProjection: "structured_instructions",
      display: {
        markdown: "# Current exercises\n\nCurrent learner material.",
        folds: [],
      },
    };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/materials/sections/1.1") return Promise.resolve(response(twoDocumentManifest));
      if (url.includes(`/documents/${documentId}`)) {
        return Promise.resolve({ ok: true, json: () => staleDocument.promise } as Response);
      }
      if (url.includes(`/documents/${secondDocumentId}`)) return Promise.resolve(response(currentMaterial));
      throw new Error(`Unexpected material request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const contextChanged = vi.fn();
    const view = render(
      <MaterialReader
        dayId="day1"
        sections={[section]}
        selectedSectionId="1.1"
        selectedDocumentId={documentId}
        selectedFragment={null}
        onNavigate={vi.fn()}
        onContextChanged={contextChanged}
      />,
    );
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) =>
      String(url).includes(`/documents/${documentId}`),
    )).toBe(true));

    view.rerender(
      <MaterialReader
        dayId="day1"
        sections={[section]}
        selectedSectionId="1.1"
        selectedDocumentId={secondDocumentId}
        selectedFragment={null}
        onNavigate={vi.fn()}
        onContextChanged={contextChanged}
      />,
    );
    expect(await screen.findByRole("heading", { name: "Current exercises", level: 1 })).toBeTruthy();

    await act(async () => {
      staleDocument.resolve(material);
      await staleDocument.promise;
    });
    expect(screen.queryByRole("heading", { name: "Safe page", level: 1 })).toBeNull();
    expect(contextChanged).toHaveBeenLastCalledWith(expect.objectContaining({
      documentId: secondDocumentId,
    }));
  });

  it("shows folded questions immediately and reveals browser-only guidance on demand", async () => {
    const foldId = "material-fold-1-question";
    const foldedMaterial: MaterialDocumentResponse = {
      ...material,
      document: {
        ...material.document,
        kind: "participant_instructions",
        accessClassification: "human_reader_only",
      },
      displayProjection: "structured_instructions",
      browserOnlyFoldCount: 1,
      display: {
        markdown: [
          "# Participant task",
          `\`\`\`${MATERIAL_FOLD_DIRECTIVE_LANGUAGE}`,
          foldId,
          "```",
        ].join("\n"),
        folds: [{
          foldId,
          summary: "Question: Why is prompt injection structurally different?",
          contextVisibility: "browser_only",
          defaultOpen: false,
          body: {
            markdown: [
              "BROWSER_ONLY_GUIDANCE_CANARY",
              "",
              "[Fold-only relative](./browser-only.md)",
              "",
              "<script>window.__unsafe = true</script>",
            ].join("\n"),
            folds: [],
          },
        }],
      },
    };
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(response(manifest))
      .mockResolvedValueOnce(response(foldedMaterial)));
    const user = userEvent.setup();
    const view = render(
      <MaterialReader
        dayId="day1"
        sections={[section]}
        selectedSectionId="1.1"
        selectedDocumentId={documentId}
        selectedFragment={null}
        onNavigate={vi.fn()}
      />,
    );

    const summaryText = await screen.findByText(
      "Question: Why is prompt injection structurally different?",
    );
    const disclosure = summaryText.closest("details");
    const summary = disclosure?.querySelector("summary") as HTMLElement;
    const currentDisclosure = () => screen.getByText(
      "Question: Why is prompt injection structurally different?",
    ).closest("details");
    expect(disclosure?.open).toBe(false);
    expect(screen.queryByText("Browser only")).toBeNull();
    expect(screen.getByText("BROWSER_ONLY_GUIDANCE_CANARY")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Fold-only relative" })).toBeNull();
    expect(screen.getByText("Fold-only relative").classList.contains("markdown-link-disabled"))
      .toBe(true);
    expect(view.container.querySelector("script")).toBeNull();

    await user.click(summary);
    await waitFor(() => expect(currentDisclosure()?.open).toBe(true));

    const currentSummary = currentDisclosure()?.querySelector("summary") as HTMLElement;
    currentSummary.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(currentDisclosure()?.open).toBe(false));
    (currentDisclosure()?.querySelector("summary") as HTMLElement).focus();
    await user.keyboard(" ");
    await waitFor(() => expect(currentDisclosure()?.open).toBe(true));

    view.rerender(
      <MaterialReader
        dayId="day1"
        sections={[section]}
        selectedSectionId="1.1"
        selectedDocumentId={documentId}
        selectedFragment={null}
        onNavigate={vi.fn()}
      />,
    );
    expect(screen.getByText(
      "Question: Why is prompt injection structurally different?",
    ).closest("details")?.open).toBe(true);
  });

  it("keeps the activated fold summary fixed when disclosure layout shifts", async () => {
    const foldId = "material-fold-scroll-anchor";
    const foldedMaterial: MaterialDocumentResponse = {
      ...material,
      document: {
        ...material.document,
        kind: "participant_instructions",
        accessClassification: "human_reader_only",
      },
      displayProjection: "structured_instructions",
      browserOnlyFoldCount: 1,
      display: {
        markdown: `\`\`\`${MATERIAL_FOLD_DIRECTIVE_LANGUAGE}\n${foldId}\n\`\`\``,
        folds: [{
          foldId,
          summary: "Question: keep this line still",
          contextVisibility: "browser_only",
          defaultOpen: false,
          body: { markdown: "A deliberately tall answer body.", folds: [] },
        }],
      },
    };
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(response(manifest))
      .mockResolvedValueOnce(response(foldedMaterial)));
    const user = userEvent.setup();
    const view = render(
      <div className="workspace-scroll" data-testid="workspace-scroll">
        <MaterialReader
          dayId="day1"
          sections={[section]}
          selectedSectionId="1.1"
          selectedDocumentId={documentId}
          selectedFragment={null}
          onNavigate={vi.fn()}
        />
      </div>,
    );

    const summary = (await screen.findByText("Question: keep this line still")).closest("summary") as HTMLElement;
    const scroller = view.getByTestId("workspace-scroll");
    let scrollTop = 500;
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const isFoldSummary = this.dataset.materialFoldId === foldId;
      const top = isFoldSummary && this.closest("details")?.open ? 100 : isFoldSummary ? 180 : 0;
      return {
        bottom: top + 45,
        height: 45,
        left: 0,
        right: 600,
        top,
        width: 600,
        x: 0,
        y: top,
        toJSON: () => ({}),
      };
    });

    await user.click(summary);
    const currentSummary = await screen.findByText("Question: keep this line still");
    await waitFor(() => expect(currentSummary.closest("details")?.open).toBe(true));
    expect(scrollTop).toBe(420);
    expect(currentSummary.closest("summary")).toBe(document.activeElement);
  });

  it("preserves independent fold choices while navigating between documents", async () => {
    const secondDocumentId = `doc_${"e".repeat(64)}`;
    const secondDocument = {
      ...manifest.documents[0]!,
      documentId: secondDocumentId,
      title: "Second exercises",
      filename: "second_instructions.md",
      kind: "participant_instructions" as const,
      accessClassification: "human_reader_only" as const,
      contentHash: "f".repeat(64),
      links: [],
    };
    const twoDocumentManifest: MaterialManifestResponse = {
      ...manifest,
      documents: [manifest.documents[0]!, secondDocument],
    };
    const foldedDocument = (
      document: MaterialDocumentResponse["document"],
      foldId: string,
      summary: string,
    ): MaterialDocumentResponse => ({
      ...material,
      document,
      displayProjection: "structured_instructions",
      browserOnlyFoldCount: 1,
      display: {
        markdown: `\`\`\`${MATERIAL_FOLD_DIRECTIVE_LANGUAGE}\n${foldId}\n\`\`\``,
        folds: [{
          foldId,
          summary,
          contextVisibility: "browser_only",
          defaultOpen: false,
          body: { markdown: `${summary} body`, folds: [] },
        }],
      },
    });
    const firstFolded = foldedDocument(
      { ...manifest.documents[0]!, kind: "participant_instructions", accessClassification: "human_reader_only" },
      "material-fold-first",
      "Question in the first document?",
    );
    const secondFolded = foldedDocument(
      secondDocument,
      "material-fold-second",
      "Question in the second document?",
    );
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(response(twoDocumentManifest))
      .mockResolvedValueOnce(response(firstFolded))
      .mockResolvedValueOnce(response(secondFolded))
      .mockResolvedValueOnce(response(firstFolded)));
    const user = userEvent.setup();
    const view = render(
      <MaterialReader
        dayId="day1"
        sections={[section]}
        selectedSectionId="1.1"
        selectedDocumentId={documentId}
        selectedFragment={null}
        onNavigate={vi.fn()}
      />,
    );

    await user.click(await screen.findByText("Question in the first document?"));
    expect(screen.getByText("Question in the first document?").closest("details")?.open).toBe(true);

    view.rerender(
      <MaterialReader
        dayId="day1"
        sections={[section]}
        selectedSectionId="1.1"
        selectedDocumentId={secondDocumentId}
        selectedFragment={null}
        onNavigate={vi.fn()}
      />,
    );
    await user.click(await screen.findByText("Question in the second document?"));
    expect(screen.getByText("Question in the second document?").closest("details")?.open).toBe(true);

    view.rerender(
      <MaterialReader
        dayId="day1"
        sections={[section]}
        selectedSectionId="1.1"
        selectedDocumentId={documentId}
        selectedFragment={null}
        onNavigate={vi.fn()}
      />,
    );
    expect((await screen.findByText("Question in the first document?")).closest("details")?.open)
      .toBe(true);
  });
});
