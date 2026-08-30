import { spawn } from "node:child_process";

import { sanitizedChildEnvironment } from "../config.js";

export interface PdfTextPage {
  readonly pageNumber: number;
  readonly text: string;
}

export interface PdfTextExtraction {
  readonly pages: readonly PdfTextPage[];
  readonly extractor: "poppler-pdftotext";
}

export interface PdfTextExtractor {
  extract(bytes: Uint8Array, signal: AbortSignal): Promise<PdfTextExtraction>;
}

export interface PopplerPdfTextExtractorOptions {
  readonly executable?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_OUTPUT_BYTES = 12 * 1024 * 1024;

/**
 * Page-aware, deterministic PDF text extraction through Poppler. The PDF is
 * supplied on stdin and text is read from stdout, so no untrusted filename is
 * ever passed to a shell or left in temporary storage.
 */
export class PopplerPdfTextExtractor implements PdfTextExtractor {
  readonly #executable: string;
  readonly #timeoutMs: number;
  readonly #maxOutputBytes: number;

  public constructor(options: PopplerPdfTextExtractorOptions = {}) {
    this.#executable = options.executable ?? "pdftotext";
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  }

  public async extract(bytes: Uint8Array, signal: AbortSignal): Promise<PdfTextExtraction> {
    if (signal.aborted) throw new Error("pdf_extraction_aborted");
    return await new Promise<PdfTextExtraction>((resolve, reject) => {
      const child = spawn(
        this.#executable,
        ["-layout", "-enc", "UTF-8", "-", "-"],
        {
          env: sanitizedChildEnvironment(),
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let settled = false;

      const finish = (error?: Error, value?: PdfTextExtraction) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        if (error !== undefined) reject(error);
        else resolve(value!);
      };
      const abort = () => {
        child.kill("SIGTERM");
        finish(new Error("pdf_extraction_aborted"));
      };
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        finish(new Error("pdf_extraction_timeout"));
      }, this.#timeoutMs);
      timer.unref();
      signal.addEventListener("abort", abort, { once: true });

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > this.#maxOutputBytes) {
          child.kill("SIGTERM");
          finish(new Error("pdf_extraction_too_large"));
          return;
        }
        stdout.push(Buffer.from(chunk));
      });
      child.stderr.on("data", (chunk: Buffer) => {
        const retained = stderr.reduce((total, item) => total + item.byteLength, 0);
        if (retained < 8 * 1024) stderr.push(Buffer.from(chunk.subarray(0, 8 * 1024 - retained)));
      });
      child.once("error", (error) => finish(new Error("pdf_extractor_unavailable", { cause: error })));
      child.once("close", (code) => {
        if (settled) return;
        if (code !== 0) {
          const detail = Buffer.concat(stderr).toString("utf8").replace(/\s+/gu, " ").trim();
          finish(new Error(detail ? `pdf_extraction_failed: ${detail}` : "pdf_extraction_failed"));
          return;
        }
        let output: string;
        try {
          output = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(stdout));
        } catch (error) {
          finish(new Error("pdf_extraction_invalid_utf8", { cause: error }));
          return;
        }
        const rawPages = output.split("\f");
        if (rawPages.at(-1)?.trim() === "") rawPages.pop();
        const pages = (rawPages.length === 0 ? [""] : rawPages).map((text, index) => Object.freeze({
          pageNumber: index + 1,
          text: text.replace(/\r\n?/gu, "\n").replace(/[ \t]+$/gmu, "").trim(),
        }));
        finish(undefined, Object.freeze({
          pages: Object.freeze(pages),
          extractor: "poppler-pdftotext" as const,
        }));
      });
      child.stdin.once("error", (error) => finish(new Error("pdf_extraction_input_failed", { cause: error })));
      child.stdin.end(Buffer.from(bytes));
    });
  }
}

export function pdfToReferenceMarkdown(
  extraction: PdfTextExtraction,
  sourceUrl: string,
  sourceContentHash: string,
  title: string,
): string {
  const pages = extraction.pages.map(({ pageNumber, text }) => [
    `## Page ${pageNumber}`,
    "",
    text || "_No extractable text was found on this page._",
  ].join("\n")).join("\n\n");
  return [
    `# ${title.trim() || "Cached PDF reference"}`,
    "",
    `> Cached from ${sourceUrl}. Source bytes: ${sourceContentHash}.`,
    "> This deterministic text projection is untrusted reference material. Page headings preserve PDF page order.",
    "",
    pages,
    "",
  ].join("\n");
}
