import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CurriculumMaterialError,
  CurriculumMaterialService,
  projectCurriculumMarkdownForBrowser,
  spoilerStripInstructionMarkdown,
} from "./service.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function temporaryAisbRoot(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "aisb-materials-test-"));
  temporaryRoots.push(parent);
  const root = join(parent, "aisb");
  await mkdir(root);
  return root;
}

async function write(root: string, relativePath: string, content: string): Promise<void> {
  const target = join(root, ...relativePath.split("/"));
  await mkdir(join(target, ".."), { recursive: true });
  await writeFile(target, content, "utf8");
}

async function writeBytes(root: string, relativePath: string, content: Buffer): Promise<void> {
  const target = join(root, ...relativePath.split("/"));
  await mkdir(join(target, ".."), { recursive: true });
  await writeFile(target, content);
}

function linkByLabel(
  links: readonly { readonly label: string }[],
  label: string,
): Record<string, unknown> {
  const link = links.find((candidate) => candidate.label === label);
  expect(link).toBeDefined();
  return link as unknown as Record<string, unknown>;
}

describe("CurriculumMaterialService", () => {
  it("serves only bounded repository images referenced by the selected document", async () => {
    const root = await temporaryAisbRoot();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await write(
      root,
      "1.1-intro/README.md",
      [
        "# Section one",
        "![Architecture](resources/architecture.png)",
        "![Remote](https://images.example.test/architecture.png)",
      ].join("\n"),
    );
    await writeBytes(root, "1.1-intro/resources/architecture.png", png);
    await writeBytes(root, "1.1-intro/resources/unreferenced.png", png);

    const service = new CurriculumMaterialService(root);
    const manifest = await service.manifest("1.1");
    const image = await service.readImageForDisplay({
      sectionId: "1.1",
      documentId: manifest.rootDocumentId,
      expectedManifestRevision: manifest.revision,
      source: "resources/architecture.png",
    });

    expect(image.contentType).toBe("image/png");
    expect(image.bytes).toEqual(png);
    await expect(service.readImageForDisplay({
      sectionId: "1.1",
      documentId: manifest.rootDocumentId,
      expectedManifestRevision: manifest.revision,
      source: "resources/unreferenced.png",
    })).rejects.toMatchObject({ code: "image_not_found", statusCode: 404 });
    await expect(service.readImageForDisplay({
      sectionId: "1.1",
      documentId: manifest.rootDocumentId,
      expectedManifestRevision: manifest.revision,
      source: "https://images.example.test/architecture.png",
    })).rejects.toMatchObject({ code: "image_unavailable", statusCode: 404 });
  });

  it("starts at the section README and exposes linked instructions, sibling READMEs, HTTPS, and cycles", async () => {
    const root = await temporaryAisbRoot();
    await write(
      root,
      "1.1-intro/README.md",
      [
        "# Section one",
        "[Exercises](section1_instructions.md)",
        "[Next section](../1.2-next/README.md#background)",
        "[External guide](https://example.test/guide?q=1)",
        "Bare paper https://arxiv.org/pdf/1412.6572",
      ].join("\n"),
    );
    await write(root, "1.1-intro/section1_instructions.md", "# Participant exercises\nDo the work.");
    await write(
      root,
      "1.2-next/README.md",
      "# Next section\n[Back](../1.1-intro/README.md)",
    );

    const service = new CurriculumMaterialService(root);
    const manifest = await service.manifest("1.1");

    expect(manifest.documents).toHaveLength(2);
    const readme = manifest.documents.find(
      (document) => document.documentId === manifest.rootDocumentId,
    )!;
    const instructions = manifest.documents.find(
      (document) => document.kind === "participant_instructions",
    )!;
    expect(readme).toMatchObject({
      title: "Section one",
      filename: "README.md",
      kind: "readme",
      accessClassification: "tutor_readable",
    });
    expect(instructions).toMatchObject({
      filename: "section1_instructions.md",
      accessClassification: "human_reader_only",
    });
    expect(linkByLabel(readme.links, "Exercises")).toMatchObject({
      kind: "document",
      documentId: instructions.documentId,
    });
    expect(linkByLabel(readme.links, "Next section")).toMatchObject({
      kind: "section",
      sectionId: "1.2",
      fragment: "background",
    });
    expect(linkByLabel(readme.links, "External guide")).toEqual({
      kind: "external",
      label: "External guide",
      url: "https://example.test/guide?q=1",
    });
    expect(linkByLabel(readme.links, "https://arxiv.org/pdf/1412.6572")).toEqual({
      kind: "external",
      label: "https://arxiv.org/pdf/1412.6572",
      url: "https://arxiv.org/pdf/1412.6572",
    });
    expect(new Set(manifest.documents.map((document) => document.documentId)).size).toBe(2);

    const rendered = JSON.stringify(manifest);
    expect(rendered).not.toContain(root);
    expect(rendered).not.toContain("1.1-intro/");

    const result = await service.readForModelContext({
      sectionId: "1.1",
      documentId: instructions.documentId,
      expectedManifestRevision: manifest.revision,
    });
    expect(result.modelSafeMarkdown).toBe("# Participant exercises\nDo the work.");
    expect(result.document.accessClassification).toBe("human_reader_only");
    expect(result.modelProjection).toBe("spoiler_stripped_instructions");
    expect(result.omittedProtectedBlocks).toBe(0);
  });

  it("admits linked learner Markdown inside the canonical section folder", async () => {
    const root = await temporaryAisbRoot();
    await write(
      root,
      "7.1-report/README.md",
      "# Report\n[Optional discussion](optional-iaps-sl5-discussion.md)",
    );
    await write(
      root,
      "7.1-report/optional-iaps-sl5-discussion.md",
      "# Optional discussion\nLearner-visible reading.",
    );

    const manifest = await new CurriculumMaterialService(root).manifest("7.1");
    const linked = manifest.documents.find((document) => document.kind === "learner_markdown");
    expect(linked).toMatchObject({
      title: "Optional discussion",
      accessClassification: "human_reader_only",
    });
    expect(linkByLabel(manifest.documents[0]!.links, "Optional discussion")).toMatchObject({
      kind: "document",
      documentId: linked?.documentId,
    });
  });

  it("extracts a linked local PDF into browser and tutor-readable page text", async () => {
    const root = await temporaryAisbRoot();
    await write(root, "7.1-report/README.md", "# Report\n[SL5 recommendations](SL5.pdf)");
    await writeBytes(root, "7.1-report/SL5.pdf", Buffer.from("%PDF-test"));
    const service = new CurriculumMaterialService(root, {}, {
      extract: async () => ({
        extractor: "poppler-pdftotext" as const,
        pages: [
          { pageNumber: 1, text: "SUPPLY_CHAIN_CANARY" },
          { pageNumber: 2, text: "NETWORK_SECURITY_CANARY" },
        ],
      }),
    });

    const manifest = await service.manifest("7.1");
    const pdf = manifest.documents.find((document) => document.kind === "learner_pdf");
    expect(pdf).toMatchObject({
      filename: "SL5.pdf",
      accessClassification: "tutor_readable",
    });
    expect(linkByLabel(manifest.documents[0]!.links, "SL5 recommendations")).toMatchObject({
      kind: "document",
      documentId: pdf?.documentId,
    });

    const input = {
      sectionId: "7.1",
      documentId: pdf!.documentId,
      expectedManifestRevision: manifest.revision,
    };
    const [display, model] = await Promise.all([
      service.readForDisplay(input),
      service.readForModelContext(input),
    ]);
    expect(display.displayProjection).toBe("pdf_text");
    expect(display.display.markdown).toContain("## Page 2");
    expect(display.display.markdown).toContain("NETWORK_SECURITY_CANARY");
    expect(model.modelProjection).toBe("local_pdf_text");
    expect(model.modelSafeMarkdown).toContain("SUPPLY_CHAIN_CANARY");
    expect(JSON.stringify(manifest)).not.toContain(root);
  });

  it("removes folded hints and answers from the Study projection", async () => {
    const root = await temporaryAisbRoot();
    await write(
      root,
      "1.1-projection/README.md",
      "# Projection\n[Exercises](section1_instructions.md)",
    );
    await write(
      root,
      "1.1-projection/section1_instructions.md",
      [
        "# Participant exercises",
        "Try the task first.",
        "<details><summary>Hint PROTECTED_TITLE_CANARY</summary>",
        "DO_NOT_RENDER_HINT",
        "</details>",
        "Continue with the learner-visible task.",
      ].join("\n"),
    );
    const service = new CurriculumMaterialService(root);
    const manifest = await service.manifest("1.1");
    const instructions = manifest.documents.find(
      (document) => document.kind === "participant_instructions",
    )!;
    const result = await service.readForModelContext({
      sectionId: "1.1",
      documentId: instructions.documentId,
      expectedManifestRevision: manifest.revision,
    });

    expect(result.modelSafeMarkdown).toContain("Try the task first.");
    expect(result.modelSafeMarkdown).toContain("Continue with the learner-visible task.");
    expect(result.modelSafeMarkdown).not.toContain("A protected hint or answer block was omitted");
    expect(result.modelSafeMarkdown).not.toContain("DO_NOT_RENDER_HINT");
    expect(result.modelSafeMarkdown).not.toContain("PROTECTED_TITLE_CANARY");
    expect(result.omittedProtectedBlocks).toBe(1);
  });

  it("keeps reviewed teaching folds while omitting the adjacent reference solution", async () => {
    const root = await temporaryAisbRoot();
    await write(
      root,
      "1.4-projection/README.md",
      "# Prompt injection\n[Exercises](section4_instructions.md)",
    );
    await write(
      root,
      "1.4-projection/section4_instructions.md",
      [
        "# Participant exercises",
        "#### What just happened, and why it's hard to fix",
        "<details>",
        "<summary>You just bypassed a defended RAG system using a three-stage attack:</summary><blockquote>",
        "",
        "1. First learner-visible stage",
        "2. Second learner-visible stage",
        "3. Third learner-visible stage",
        "</blockquote></details>",
        "",
        "| | Traditional injection | LLM prompt injection |",
        "|---|---|---|",
        "| Root cause | Shared protocol string | Shared context window |",
        "",
        "<details><summary>Vocabulary: Confused Deputy</summary><blockquote>",
        "A learner-visible definition.",
        "</blockquote></details>",
        "",
        "### Exercise 1.4.3: The State of Defenses",
        "Try the exercise before opening course guidance.",
        "<details><summary><b>Reference solution</b></summary><blockquote>",
        "DO_NOT_RENDER_REFERENCE_SOLUTION",
        "</blockquote></details>",
        "",
        "<details><summary>Real-world: a reviewed case study</summary><blockquote>",
        "A learner-visible case study.",
        "</blockquote></details>",
      ].join("\n"),
    );

    const service = new CurriculumMaterialService(root);
    const manifest = await service.manifest("1.4");
    const instructions = manifest.documents.find(
      (document) => document.kind === "participant_instructions",
    )!;
    const result = await service.readForModelContext({
      sectionId: "1.4",
      documentId: instructions.documentId,
      expectedManifestRevision: manifest.revision,
    });

    expect(result.modelSafeMarkdown).toContain("First learner-visible stage");
    expect(result.modelSafeMarkdown).toContain("Vocabulary: Confused Deputy");
    expect(result.modelSafeMarkdown).toContain("A learner-visible definition.");
    expect(result.modelSafeMarkdown).toContain("Traditional injection");
    expect(result.modelSafeMarkdown).toContain("Exercise 1.4.3");
    expect(result.modelSafeMarkdown).toContain("Real-world: a reviewed case study");
    expect(result.modelSafeMarkdown).toContain("A learner-visible case study.");
    expect(result.modelSafeMarkdown).not.toContain("DO_NOT_RENDER_REFERENCE_SOLUTION");
    expect(result.modelSafeMarkdown).not.toMatch(/<\/?(?:details|summary|blockquote)/iu);
    expect(result.omittedProtectedBlocks).toBe(1);
  });

  it("does not join unrelated inline-code spans across adjacent course folds", () => {
    const source = [
      "<details><summary>Vocabulary: Lethal Trifecta</summary><blockquote>",
      "Combine `private data`, `untrusted content`, and an `external channel`.",
      "</blockquote></details>",
      "",
      "### Exercise 1.4.3: The State of Defenses",
      "<details><summary><b>Reference solution</b></summary><blockquote>",
      "PROTECTED_REFERENCE_BODY",
      "</blockquote></details>",
      "",
      "<details><summary>Real-world: the Morris II AI worm</summary><blockquote>",
      "VISIBLE_CASE_STUDY",
      "</blockquote></details>",
    ].join("\n");

    const browser = projectCurriculumMarkdownForBrowser(source);
    expect(browser.display.folds.map((fold) => fold.summary)).toEqual([
      "Vocabulary: Lethal Trifecta",
      "Reference solution",
      "Real-world: the Morris II AI worm",
    ]);
    const model = spoilerStripInstructionMarkdown(source);
    expect(model.markdown).toContain("VISIBLE_CASE_STUDY");
    expect(model.markdown).not.toContain("PROTECTED_REFERENCE_BODY");
  });

  it("fails closed for unknown or malformed folds and honors explicit visibility metadata", () => {
    const result = spoilerStripInstructionMarkdown([
      "Before.",
      "<details data-aisb-visibility=\"visible\"><summary>Reviewed diagram notes</summary>",
      "VISIBLE_BY_METADATA",
      "<details><summary>Answer</summary>HIDDEN_NESTED_ANSWER</details>",
      "</details>",
      "<details><summary>Unclassified material</summary>HIDDEN_UNKNOWN</details>",
      "<details data-aisb-visibility=\"protected\"><summary>Vocabulary: protected override</summary>",
      "HIDDEN_BY_METADATA",
      "</details>",
      "<details data-aisb-visibility=protected><summary>Vocabulary: unquoted protected</summary>",
      "HIDDEN_BY_UNQUOTED_METADATA",
      "</details>",
      "<details data-aisb-visibility=visible><summary>Reviewed unquoted teaching note</summary>",
      "VISIBLE_BY_UNQUOTED_METADATA",
      "</details>",
      "<details data-aisb-visibility=visible data-aisb-visibility=protected>",
      "<summary>Vocabulary: conflicting metadata</summary>HIDDEN_BY_CONFLICTING_METADATA</details>",
      "<details title=\"data-aisb-visibility=visible\"><summary>Answer</summary>",
      "HIDDEN_ATTRIBUTE_TEXT_METADATA</details>",
      "<details><summary>Vocabulary: malformed duplicate</summary>",
      "<summary>Answer</summary>HIDDEN_DUPLICATE_SUMMARY</details>",
      "<details><summary>Vocabulary: unterminated</summary>",
      "HIDDEN_AFTER_MALFORMED_OPEN",
    ].join("\n"));

    expect(result.markdown).toContain("Before.");
    expect(result.markdown).toContain("Reviewed diagram notes");
    expect(result.markdown).toContain("VISIBLE_BY_METADATA");
    expect(result.markdown).not.toContain("HIDDEN_NESTED_ANSWER");
    expect(result.markdown).not.toContain("HIDDEN_UNKNOWN");
    expect(result.markdown).not.toContain("HIDDEN_BY_METADATA");
    expect(result.markdown).not.toContain("HIDDEN_BY_UNQUOTED_METADATA");
    expect(result.markdown).toContain("VISIBLE_BY_UNQUOTED_METADATA");
    expect(result.markdown).not.toContain("HIDDEN_BY_CONFLICTING_METADATA");
    expect(result.markdown).not.toContain("HIDDEN_ATTRIBUTE_TEXT_METADATA");
    expect(result.markdown).not.toContain("HIDDEN_DUPLICATE_SUMMARY");
    expect(result.markdown).not.toContain("HIDDEN_AFTER_MALFORMED_OPEN");
    expect(result.omittedProtectedBlocks).toBe(8);
  });

  it("keeps every fold available to the browser while excluding protected bodies from model context", async () => {
    const root = await temporaryAisbRoot();
    await write(
      root,
      "1.1-fold-boundary/README.md",
      "# Fold boundary\n[Exercises](section1_instructions.md)",
    );
    await write(
      root,
      "1.1-fold-boundary/section1_instructions.md",
      [
        "# Participant exercises",
        "OUTSIDE_FOLD_MODEL_SAFE_CANARY",
        "<details open><summary><b>Question:</b> What crosses the boundary?</summary><blockquote>",
        "BROWSER_ONLY_ANSWER_CANARY",
        "[BROWSER_ONLY_LINK_CANARY](hidden_instructions.md)",
        "</blockquote></details>",
        "<details data-aisb-visibility=\"visible\"><summary>Reviewed teaching note</summary>",
        "VISIBLE_TEACHING_CANARY",
        "<details><summary>Hint</summary>NESTED_BROWSER_ONLY_CANARY</details>",
        "</details>",
      ].join("\n"),
    );
    await write(root, "1.1-fold-boundary/hidden_instructions.md", "# Hidden destination");

    const service = new CurriculumMaterialService(root);
    const manifest = await service.manifest("1.1");
    const instructions = manifest.documents.find(
      (document) => document.kind === "participant_instructions",
    )!;
    const input = {
      sectionId: "1.1",
      documentId: instructions.documentId,
      expectedManifestRevision: manifest.revision,
    };
    const [display, model] = await Promise.all([
      service.readForDisplay(input),
      service.readForModelContext(input),
    ]);

    expect(display.audience).toBe("browser_display");
    expect(display.display.folds.map((fold) => fold.summary)).toEqual([
      "Question: What crosses the boundary?",
      "Reviewed teaching note",
    ]);
    expect(display.display.folds[0]?.summaryMarkdown).toBe(
      "<b>Question:</b> What crosses the boundary?",
    );
    expect(JSON.stringify(display.display)).toContain("BROWSER_ONLY_ANSWER_CANARY");
    expect(JSON.stringify(display.display)).toContain("NESTED_BROWSER_ONLY_CANARY");
    expect(display.browserOnlyFoldCount).toBe(2);
    expect(display.display.folds[0]).toMatchObject({
      contextVisibility: "browser_only",
      defaultOpen: false,
    });
    expect(display.display.folds[1]).toMatchObject({
      contextVisibility: "included",
      defaultOpen: true,
    });

    expect(model.audience).toBe("model_context");
    expect(model.modelSafeMarkdown).toContain("OUTSIDE_FOLD_MODEL_SAFE_CANARY");
    expect(model.modelSafeMarkdown).toContain("Question: What crosses the boundary?");
    expect(model.modelSafeMarkdown).toContain("VISIBLE_TEACHING_CANARY");
    expect(model.modelSafeMarkdown).not.toContain("BROWSER_ONLY_ANSWER_CANARY");
    expect(model.modelSafeMarkdown).not.toContain("NESTED_BROWSER_ONLY_CANARY");
    expect(JSON.stringify(model)).not.toContain("BROWSER_ONLY_ANSWER_CANARY");
    expect(JSON.stringify(manifest)).not.toContain("BROWSER_ONLY_LINK_CANARY");
    expect(JSON.stringify(manifest)).not.toContain("Hidden destination");
  });

  it("does not interpret literal details examples in Markdown code as course folds", () => {
    const source = [
      "Before.",
      "`<details><summary>Inline example</summary>INLINE_LITERAL</details>`",
      "```html",
      "<details><summary>Fenced example</summary>FENCED_LITERAL</details>",
      "```",
      "````html",
      "<details><summary>Long fence example</summary>LONG_FENCE_LITERAL</details>",
      "`````",
      "> ```html",
      "> <details><summary>Quoted fence example</summary>QUOTED_FENCE_LITERAL</details>",
      "> ```",
      "    <details><summary>Indented example</summary>INDENTED_LITERAL</details>",
      "After.",
    ].join("\n");

    const browser = projectCurriculumMarkdownForBrowser(source);
    const model = spoilerStripInstructionMarkdown(source);
    expect(browser.display.folds).toHaveLength(0);
    expect(browser.display.markdown).toBe(source);
    expect(model.markdown).toBe(source);
    expect(model.omittedProtectedBlocks).toBe(0);
  });

  it("uses CommonMark AST boundaries for links, math, definitions, comments, and raw HTML", () => {
    const visibleLiterals = [
      "[link title](https://example.test \"</details>\")",
      "[angle destination](</details>)",
      "[reference][safe]",
      "[safe]: </details> \"reference title\"",
      "-     </details>",
      "$</details>$",
      "$$\n</details>\n$$",
    ];
    for (const literal of visibleLiterals) {
      const source = `Before.\n${literal}\nAfter.`;
      const browser = projectCurriculumMarkdownForBrowser(source);
      const model = spoilerStripInstructionMarkdown(source);
      expect(browser.display.folds, literal).toHaveLength(0);
      expect(model.omittedProtectedBlocks, literal).toBe(0);
      expect(model.markdown, literal).toContain("After.");
    }

    const raw = [
      "Before İ.",
      "<!-- <details><summary>Vocabulary: COMMENT_TITLE</summary>COMMENT_SECRET</details> -->",
      "<script>MODEL_ONLY_SECRET</script>",
      "After Unicode.",
    ].join("\n");
    const browser = projectCurriculumMarkdownForBrowser(raw);
    const model = spoilerStripInstructionMarkdown(raw);
    expect(browser.display.folds).toHaveLength(0);
    expect(model.markdown).toContain("Before İ.");
    expect(model.markdown).toContain("After Unicode.");
    expect(model.markdown).not.toContain("COMMENT_TITLE");
    expect(model.markdown).not.toContain("COMMENT_SECRET");
    expect(model.markdown).not.toContain("MODEL_ONLY_SECRET");
  });

  it("keeps disclosures after edge-filled display maths structurally visible", () => {
    const source = [
      "Before formula.",
      "$$x = a",
      "+ b.$$",
      "<details><summary><b>Discussion:</b> why is this linear?</summary>",
      "DISCUSSION_BODY_AFTER_MATH",
      "</details>",
      "After disclosure.",
    ].join("\n");

    const browser = projectCurriculumMarkdownForBrowser(source);
    expect(browser.display.folds).toHaveLength(1);
    expect(browser.display.folds[0]).toMatchObject({
      summary: "Discussion: why is this linear?",
      summaryMarkdown: "<b>Discussion:</b> why is this linear?",
    });
    expect(browser.display.folds[0]?.body.markdown).toContain("DISCUSSION_BODY_AFTER_MATH");
    expect(browser.display.markdown).toContain("After disclosure.");
  });

  it("keeps a disclosure containing several compact display-math forms intact", () => {
    const source = [
      "<details>",
      "<summary><b>Discussion: matrix projection</b></summary><blockquote>",
      "$$\\text{oproj}(x) = x - a",
      "= x - b",
      "= (I - P)x.$$",
      "Narrative between formulae.",
      "$$x = W_E e + \\sum_\\ell W_\\ell v_\\ell,$$",
      "More narrative.",
      "$$(I - P)x = \\sum_\\ell (I - P)W_\\ell v_\\ell.$$",
      "$$W' := (I - P)W",
      "\\Longrightarrow r^\\top(W'v)=0.$$",
      "DISCUSSION_END_CANARY",
      "</blockquote></details>",
      "AFTER_DISCUSSION_CANARY",
    ].join("\n");

    const browser = projectCurriculumMarkdownForBrowser(source);
    expect(browser.display.folds).toHaveLength(1);
    expect(browser.display.folds[0]?.body.markdown).toContain("DISCUSSION_END_CANARY");
    expect(browser.display.markdown).toContain("AFTER_DISCUSSION_CANARY");
  });

  it("cannot end a protected fold with details syntax inside code or comments", () => {
    const cases: ReadonlyArray<readonly [readonly string[], string]> = [
      [["````text", "</details>", "`````", "LONGER_FENCE_PROTECTED_CANARY"], "LONGER_FENCE_PROTECTED_CANARY"],
      [["> ```text", "> </details>", "> ```", "QUOTED_FENCE_PROTECTED_CANARY"], "QUOTED_FENCE_PROTECTED_CANARY"],
      [["> ```text", ">     ```", "> </details>", "> QUOTED_FENCE_LEAK", "> ```"], "QUOTED_FENCE_LEAK"],
      [[">     </details>", "BLOCKQUOTE_INDENTED_PROTECTED_CANARY"], "BLOCKQUOTE_INDENTED_PROTECTED_CANARY"],
      [["<!-- </details> -->", "COMMENT_PROTECTED_CANARY"], "COMMENT_PROTECTED_CANARY"],
      [["\\</details>", "ESCAPED_CLOSE_PROTECTED_CANARY"], "ESCAPED_CLOSE_PROTECTED_CANARY"],
      [["<span title=\"</details>\">decorative</span>", "ATTRIBUTE_CLOSE_PROTECTED_CANARY"], "ATTRIBUTE_CLOSE_PROTECTED_CANARY"],
      [["<span title=\"<details>\">decorative</span>", "ATTRIBUTE_OPEN_PROTECTED_CANARY"], "ATTRIBUTE_OPEN_PROTECTED_CANARY"],
      [["<pre>", "</details>", "</pre>", "RAW_PRE_PROTECTED_CANARY"], "RAW_PRE_PROTECTED_CANARY"],
      [["<textarea>", "</details>", "</textarea>", "TEXTAREA_LEAK"], "TEXTAREA_LEAK"],
      [["<![CDATA[", "</details>", "]]>", "CDATA_LEAK"], "CDATA_LEAK"],
      [["<?xml", "</details>", "?>", "PROCESSING_LEAK"], "PROCESSING_LEAK"],
      [["``literal begins", "</details>", "literal ends``", "MULTILINE_CODE_SPAN_LEAK"], "MULTILINE_CODE_SPAN_LEAK"],
      [["[safe](https://example.test \"</details>\")", "LINK_TITLE_CANARY"], "LINK_TITLE_CANARY"],
      [["[safe](</details>)", "ANGLE_DESTINATION_CANARY"], "ANGLE_DESTINATION_CANARY"],
      [["[safe]: </details> \"title\"", "REFERENCE_DEFINITION_CANARY"], "REFERENCE_DEFINITION_CANARY"],
      [["<!DOCTYPE raw", "</details>", "DECLARATION_CANARY"], "DECLARATION_CANARY"],
      [["-     </details>", "LIST_CODE_CANARY"], "LIST_CODE_CANARY"],
      [["$</details>$", "INLINE_MATH_CANARY"], "INLINE_MATH_CANARY"],
      [["$$", "</details>", "$$", "DISPLAY_MATH_CANARY"], "DISPLAY_MATH_CANARY"],
      [["```html", "> ```", "</details>", "CONTAINER_FENCE_CANARY", "```"], "CONTAINER_FENCE_CANARY"],
      [["```text", "</details>", "UNCLOSED_FENCE_PROTECTED_CANARY"], "UNCLOSED_FENCE_PROTECTED_CANARY"],
    ];

    for (const [index, [body, canary]] of cases.entries()) {
      const source = [
        `Before ${index}.`,
        "<details><summary>Answer</summary>",
        ...body,
        "</details>",
        `After ${index}.`,
      ].join("\n");
      const model = spoilerStripInstructionMarkdown(source);
      expect(model.markdown).toContain(`Before ${index}.`);
      expect(model.markdown).not.toContain(canary);
      expect(model.omittedProtectedBlocks).toBe(1);
    }
  });

  it("does not let a backtick in a link title mask a real protected fold", () => {
    const source = [
      "[safe](https://example.test \"`\")",
      "<details><summary>Answer</summary>BACKTICK_LINK_SECRET</details>",
      "`",
    ].join("\n");
    const model = spoilerStripInstructionMarkdown(source);
    expect(model.markdown).not.toContain("BACKTICK_LINK_SECRET");
    expect(model.omittedProtectedBlocks).toBe(1);
  });

  it("keeps a question label when the question mark is followed by context", () => {
    const model = spoilerStripInstructionMarkdown([
      "<details><summary>Tokens per training step? (batch size × sequence length)</summary>",
      "QUESTION_ANSWER_SECRET",
      "</details>",
    ].join("\n"));
    expect(model.markdown).toContain("Tokens per training step? (batch size × sequence length)");
    expect(model.markdown).not.toContain("QUESTION_ANSWER_SECRET");
    expect(model.omittedProtectedBlocks).toBe(1);
  });

  it("excludes protected documents and labels while retaining neutral arXiv references", async () => {
    const root = await temporaryAisbRoot();
    await write(
      root,
      "1.1-fold-links/README.md",
      "# Fold links\n[Exercises](section1_instructions.md)",
    );
    await write(
      root,
      "1.1-fold-links/section1_instructions.md",
      [
        "# Participant exercises",
        "<details><summary>Reference solution</summary>",
        "<!-- </details> -->",
        "[SECRET LABEL](secret_instructions.md)",
        "https://arxiv.org/abs/2410.01294",
        "</details>",
      ].join("\n"),
    );
    await write(root, "1.1-fold-links/secret_instructions.md", "# Hidden destination");

    const manifest = await new CurriculumMaterialService(root).manifest("1.1");
    expect(manifest.documents).toHaveLength(2);
    expect(JSON.stringify(manifest)).not.toContain("SECRET LABEL");
    expect(JSON.stringify(manifest)).not.toContain("Hidden destination");
    const instructions = manifest.documents.find(
      (document) => document.kind === "participant_instructions",
    )!;
    expect(linkByLabel(instructions.links, "Referenced arXiv paper")).toEqual({
      kind: "external",
      label: "Referenced arXiv paper",
      url: "https://arxiv.org/pdf/2410.01294",
    });
  });

  it("maps canonical section 0.1 to the day0-setup README", async () => {
    const root = await temporaryAisbRoot();
    await write(root, "day0-setup/README.md", "# Day zero setup");

    const manifest = await new CurriculumMaterialService(root).manifest("0.1");

    expect(manifest.sectionId).toBe("0.1");
    expect(manifest.documents).toHaveLength(1);
    expect(manifest.documents[0]).toMatchObject({
      documentId: manifest.rootDocumentId,
      title: "Day zero setup",
      kind: "readme",
    });
  });

  it("denies protected files, repository escapes, insecure links, and all symlinks", async () => {
    const root = await temporaryAisbRoot();
    await write(
      root,
      "1.1-safety/README.md",
      [
        "# Safety",
        "[Solution](lesson_solution.py)",
        "[Reference](reference_solutions/README.md)",
        "[Test](lesson_test.py)",
        "[Hidden](.hidden/README.md)",
        "[Named hidden](hidden/README.md)",
        "[Environment](.env/README.md)",
        "[Named env](env/README.md)",
        "[Escape](../../outside/README.md)",
        "[Linked directory](linked/README.md)",
        "[Linked file](linked_instructions.md)",
        "[HTTP](http://example.test/insecure)",
        "[File URL](file:///etc/passwd)",
      ].join("\n"),
    );
    await write(root, "1.1-safety/real/README.md", "# Not through a symlink");
    await write(root, "1.1-safety/real_instructions.md", "# Also not through a symlink");
    await symlink("real", join(root, "1.1-safety/linked"), "dir");
    await symlink(
      "real_instructions.md",
      join(root, "1.1-safety/linked_instructions.md"),
      "file",
    );
    await write(join(root, ".."), "outside/README.md", "# Outside");

    const manifest = await new CurriculumMaterialService(root).manifest("1.1");
    const readme = manifest.documents[0]!;

    for (const label of [
      "Solution",
      "Reference",
      "Test",
      "Hidden",
      "Named hidden",
      "Environment",
      "Named env",
    ]) {
      expect(linkByLabel(readme.links, label)).toMatchObject({
        kind: "unavailable",
        reason: "protected",
      });
    }
    expect(linkByLabel(readme.links, "Escape")).toMatchObject({
      kind: "unavailable",
      reason: "outside_repository",
    });
    for (const label of ["Linked directory", "Linked file"]) {
      expect(linkByLabel(readme.links, label)).toMatchObject({
        kind: "unavailable",
        reason: "symlink",
      });
    }
    expect(linkByLabel(readme.links, "HTTP")).toMatchObject({
      kind: "unavailable",
      reason: "insecure_external",
    });
    expect(linkByLabel(readme.links, "File URL")).toMatchObject({
      kind: "unavailable",
      reason: "unsupported_scheme",
    });
    expect(manifest.documents).toHaveLength(1);
  });

  it("rejects stale revisions and never accepts a client filesystem path as an ID", async () => {
    const root = await temporaryAisbRoot();
    await write(
      root,
      "1.1-revision/README.md",
      "# Revision\n[Exercises](section1_instructions.md)",
    );
    await write(root, "1.1-revision/section1_instructions.md", "# Version one");
    const service = new CurriculumMaterialService(root);
    const first = await service.manifest("1.1");
    const instructions = first.documents.find(
      (document) => document.kind === "participant_instructions",
    )!;

    await expect(
      service.readForModelContext({
        sectionId: "1.1",
        documentId: "README.md",
        expectedManifestRevision: first.revision,
      }),
    ).rejects.toMatchObject({
      code: "document_not_found",
      statusCode: 404,
    });

    await write(root, "1.1-revision/section1_instructions.md", "# Version two");
    const staleRead = service.readForModelContext({
      sectionId: "1.1",
      documentId: instructions.documentId,
      expectedManifestRevision: first.revision,
    });
    await expect(staleRead).rejects.toBeInstanceOf(CurriculumMaterialError);
    await expect(staleRead).rejects.toMatchObject({
      code: "stale_manifest",
      statusCode: 409,
    });
  });

  it("bounds depth, document count, bytes, and link descriptors", async () => {
    const root = await temporaryAisbRoot();
    await write(
      root,
      "1.1-bounds/README.md",
      [
        "# Bounds",
        "[First](a/README.md)",
        "[Second](b/README.md)",
        "[Third](c/README.md)",
      ].join("\n"),
    );
    await write(root, "1.1-bounds/a/README.md", "# A\n[Deep](nested/README.md)");
    await write(root, "1.1-bounds/a/nested/README.md", "# Too deep");
    await write(root, "1.1-bounds/b/README.md", "# B");
    await write(root, "1.1-bounds/c/README.md", "# C");

    const manifest = await new CurriculumMaterialService(root, {
      maxDepth: 1,
      maxDocuments: 2,
      maxLinksPerDocument: 2,
      maxTotalLinks: 3,
    }).manifest("1.1");

    expect(manifest.truncated).toBe(true);
    expect(manifest.documents).toHaveLength(2);
    expect(manifest.documents[0]?.links).toHaveLength(2);
    expect(manifest.documents[0]?.linksTruncated).toBe(true);
    expect(linkByLabel(manifest.documents[0]!.links, "Second")).toMatchObject({
      kind: "unavailable",
      reason: "file_count_limit",
    });
    expect(linkByLabel(manifest.documents[1]!.links, "Deep")).toMatchObject({
      kind: "unavailable",
      reason: "depth_limit",
    });
  });

  it("does not read a linked document beyond the byte budget", async () => {
    const root = await temporaryAisbRoot();
    await write(
      root,
      "1.1-bytes/README.md",
      "# Byte bound\n[Large](large_instructions.md)",
    );
    await write(
      root,
      "1.1-bytes/large_instructions.md",
      `# Large\n${"x".repeat(512)}`,
    );

    const manifest = await new CurriculumMaterialService(root, {
      maxDocumentBytes: 128,
    }).manifest("1.1");

    expect(manifest.truncated).toBe(true);
    expect(manifest.documents).toHaveLength(1);
    expect(linkByLabel(manifest.documents[0]!.links, "Large")).toMatchObject({
      kind: "unavailable",
      reason: "byte_limit",
    });
  });
});
