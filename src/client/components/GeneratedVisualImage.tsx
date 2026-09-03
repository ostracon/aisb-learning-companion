import type { MarkdownImageRenderInput } from "./SafeMarkdown.js";

const GENERATED_VISUAL_PATH = /^\/api\/visuals\/visual_[0-9a-f-]{36}\/image$/u;

export function renderGeneratedVisualImage(
  { alt, src, title }: MarkdownImageRenderInput,
  omittedLabel: string,
) {
  if (!GENERATED_VISUAL_PATH.test(src)) {
    return (
      <span className="markdown-image-omitted">
        {omittedLabel}{alt ? `: ${alt}` : ""}
      </span>
    );
  }

  return (
    <img
      className="assistant-generated-visual"
      src={src}
      alt={alt}
      {...(title ? { title } : {})}
    />
  );
}
