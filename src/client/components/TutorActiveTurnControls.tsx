import type { TutorActiveTurnView } from "../../shared/api.js";

export interface TutorActiveTurnControlsProps {
  readonly activeTurn: TutorActiveTurnView | null;
  readonly sending: boolean;
  readonly stopping: boolean;
  readonly onStop: () => void;
}

function progressText(
  activeTurn: TutorActiveTurnView | null,
  sending: boolean,
  stopping: boolean,
): string | null {
  if (stopping || activeTurn?.state === "stopping") {
    return "Stopping after Codex confirms the turn ended…";
  }
  if (activeTurn?.state === "running") return "Tutor is thinking…";
  if (activeTurn?.state === "preparing" || sending) return "Tutor is thinking…";
  return null;
}

/** Compact, non-streaming progress and authoritative Stop affordance. */
export function TutorActiveTurnControls({
  activeTurn,
  sending,
  stopping,
  onStop,
}: TutorActiveTurnControlsProps) {
  const text = progressText(activeTurn, sending, stopping);
  if (text === null) return null;
  const isStopping = stopping || activeTurn?.state === "stopping";
  return (
    <div className="message assistant tutor-active-turn" role="status" aria-live="polite">
      <span className="tutor-thinking-copy">
        <span className="tutor-thinking-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        <span>{text}</span>
      </span>
      {activeTurn === null ? null : (
        <button
          type="button"
          className="danger-quiet"
          disabled={isStopping}
          onClick={onStop}
        >
          {isStopping ? "Stopping…" : "Stop"}
        </button>
      )}
    </div>
  );
}
