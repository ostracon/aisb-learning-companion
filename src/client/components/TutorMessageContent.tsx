import type { TutorSessionMessageView } from "../../shared/api.js";
import { renderGeneratedVisualImage } from "./GeneratedVisualImage.js";
import { SafeMarkdown } from "./SafeMarkdown.js";

function safeCitationUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      || parsed.username !== ""
      || parsed.password !== ""
    ) {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

export function TutorMessageContent({ message }: { readonly message: TutorSessionMessageView }) {
  if (message.role !== "assistant") return <>{message.text}</>;

  const citations = message.citations.flatMap((citation) => {
    const href = safeCitationUrl(citation.url);
    return href ? [{ ...citation, href }] : [];
  });

  return (
    <>
      <SafeMarkdown
        markdown={message.text}
        headingIdPrefix={`tutor-${message.message_id}-`}
        inertLinkTitle="Tutor-authored links are inactive; use the verified sources below."
        omittedImageLabel="Remote image omitted; use Useful visuals for generated learning aids"
        renderImage={(input) => renderGeneratedVisualImage(
          input,
          "Remote image omitted; use Useful visuals for generated learning aids",
        )}
        showRawHtmlSource
      />
      {citations.length > 0 ? (
        <footer className="tutor-message-citations" aria-label="Sources for tutor reply">
          <span>Sources</span>
          <ol>
            {citations.map((citation, index) => (
              <li key={`${citation.href}:${citation.label}:${index}`}>
                <a href={citation.href} target="_blank" rel="noreferrer">{citation.label}</a>
              </li>
            ))}
          </ol>
        </footer>
      ) : null}
    </>
  );
}
