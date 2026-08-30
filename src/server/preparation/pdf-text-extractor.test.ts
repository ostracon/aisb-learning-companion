import { describe, expect, it } from "vitest";

import { PopplerPdfTextExtractor, pdfToReferenceMarkdown } from "./pdf-text-extractor.js";

describe("PDF text preparation", () => {
  it("preserves page order and labels empty pages in the inert projection", () => {
    const markdown = pdfToReferenceMarkdown({
      extractor: "poppler-pdftotext",
      pages: [
        { pageNumber: 1, text: "First page." },
        { pageNumber: 2, text: "" },
        { pageNumber: 3, text: "Third page." },
      ],
    }, "https://example.com/paper.pdf", `sha256:${"a".repeat(64)}`, "Paper");

    expect(markdown).toContain("## Page 1\n\nFirst page.");
    expect(markdown).toContain("## Page 2\n\n_No extractable text was found on this page._");
    expect(markdown.indexOf("## Page 1")).toBeLessThan(markdown.indexOf("## Page 3"));
    expect(markdown).toContain("This deterministic text projection is untrusted reference material.");
  });

  it("reports an unavailable local extractor without exposing a process error", async () => {
    const extractor = new PopplerPdfTextExtractor({ executable: "aisb-missing-pdftotext-for-test" });
    await expect(extractor.extract(new Uint8Array([1, 2, 3]), new AbortController().signal))
      .rejects.toThrow("pdf_extractor_unavailable");
  });
});
