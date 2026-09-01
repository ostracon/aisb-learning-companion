import { useRef, type KeyboardEvent, type PointerEvent } from "react";

interface PaneResizeHandleProps {
  readonly className?: string;
  readonly label: string;
  readonly valueNow: number;
  readonly valueMin: number;
  readonly valueMax: number;
  readonly valueText: string;
  readonly onPointerPosition: (clientX: number) => void;
  readonly onNudge: (delta: number) => void;
  readonly onReset: () => void;
  readonly onResizeStateChange: (resizing: boolean) => void;
}

export function PaneResizeHandle({
  className = "",
  label,
  valueNow,
  valueMin,
  valueMax,
  valueText,
  onPointerPosition,
  onNudge,
  onReset,
  onResizeStateChange,
}: PaneResizeHandleProps) {
  const activePointerId = useRef<number | null>(null);

  const finishPointerResize = (event: PointerEvent<HTMLDivElement>) => {
    if (activePointerId.current !== event.pointerId) return;
    activePointerId.current = null;
    onResizeStateChange(false);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const direction = event.key === "ArrowRight" ? 1 : -1;
    onNudge(direction * (event.shiftKey ? 48 : 12));
  };

  return (
    <div
      className={`pane-resizer ${className}`.trim()}
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={Math.round(valueMin)}
      aria-valuemax={Math.round(valueMax)}
      aria-valuenow={Math.round(valueNow)}
      aria-valuetext={valueText}
      title="Drag to resize · arrow keys adjust · double-click resets"
      onDoubleClick={onReset}
      onKeyDown={handleKeyDown}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        activePointerId.current = event.pointerId;
        event.currentTarget.setPointerCapture?.(event.pointerId);
        onResizeStateChange(true);
      }}
      onPointerMove={(event) => {
        if (activePointerId.current === event.pointerId) onPointerPosition(event.clientX);
      }}
      onPointerUp={finishPointerResize}
      onPointerCancel={finishPointerResize}
      onLostPointerCapture={finishPointerResize}
    />
  );
}
