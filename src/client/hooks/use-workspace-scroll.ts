import { useLayoutEffect, useRef, type RefObject } from "react";

export const historyWorkspaceScrollKey = "aisbWorkspaceScroll";
const historyEntryIdKey = "aisbHistoryEntryId";

export interface WorkspaceScrollLocation {
  readonly key: string;
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
}

export interface WorkspaceScrollSnapshot {
  readonly version: 1;
  readonly historyEntryId: string;
  readonly route: string;
  readonly top: number;
  readonly left: number;
}

interface ArrivalState {
  readonly locationKey: string;
  readonly hadSnapshot: boolean;
}

function routeIdentity(location: Pick<WorkspaceScrollLocation, "pathname" | "search" | "hash">): string {
  return `${location.pathname}${location.search}${location.hash}`;
}

function historyRecord(): Record<string, unknown> {
  const value = window.history.state as unknown;
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function safeOffset(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function readWorkspaceScrollSnapshot(
  location: Pick<WorkspaceScrollLocation, "pathname" | "search" | "hash">,
): WorkspaceScrollSnapshot | null {
  const state = historyRecord();
  const entryId = state[historyEntryIdKey];
  const candidate = state[historyWorkspaceScrollKey];
  if (
    typeof entryId !== "string" ||
    !candidate ||
    typeof candidate !== "object" ||
    Array.isArray(candidate)
  ) {
    return null;
  }
  const snapshot = candidate as Partial<WorkspaceScrollSnapshot>;
  if (
    snapshot.version !== 1 ||
    snapshot.historyEntryId !== entryId ||
    snapshot.route !== routeIdentity(location) ||
    !safeOffset(snapshot.top) ||
    !safeOffset(snapshot.left)
  ) {
    return null;
  }
  return {
    version: 1,
    historyEntryId: entryId,
    route: snapshot.route,
    top: snapshot.top,
    left: snapshot.left,
  };
}

function ensureHistoryEntryId(): string {
  const state = historyRecord();
  const existing = state[historyEntryIdKey];
  if (typeof existing === "string" && existing.length > 0) return existing;
  const created = crypto.randomUUID();
  window.history.replaceState({ ...state, [historyEntryIdKey]: created }, "");
  return created;
}

export function writeWorkspaceScrollSnapshot(
  location: Pick<WorkspaceScrollLocation, "pathname" | "search" | "hash">,
  top: number,
  left: number,
): void {
  if (!safeOffset(top) || !safeOffset(left)) return;
  const historyEntryId = ensureHistoryEntryId();
  const state = historyRecord();
  const snapshot: WorkspaceScrollSnapshot = {
    version: 1,
    historyEntryId,
    route: routeIdentity(location),
    top,
    left,
  };
  const current = readWorkspaceScrollSnapshot(location);
  if (current?.top === top && current.left === left) return;
  window.history.replaceState(
    { ...state, [historyWorkspaceScrollKey]: snapshot },
    "",
  );
}

export interface WorkspaceScrollRestoration {
  readonly scrollRef: RefObject<HTMLDivElement | null>;
  /** True only when this route entry arrived with a saved position. */
  readonly arrivedWithSavedPosition: boolean;
}

/**
 * Persists the actual workspace scroller, not `window`, into each browser
 * history entry. Restores again after layout geometry changes and waits for
 * asynchronously loaded material to make a deeper saved position reachable.
 */
export function useWorkspaceScrollRestoration(
  location: WorkspaceScrollLocation,
  layoutIdentity: string,
): WorkspaceScrollRestoration {
  const scrollRef = useRef<HTMLDivElement>(null);
  const arrivalRef = useRef<ArrivalState | null>(null);
  if (arrivalRef.current?.locationKey !== location.key) {
    arrivalRef.current = {
      locationKey: location.key,
      hadSnapshot: readWorkspaceScrollSnapshot(location) !== null,
    };
  }

  useLayoutEffect(() => {
    ensureHistoryEntryId();
    const element = scrollRef.current;
    if (!element) return;

    const saved = readWorkspaceScrollSnapshot(location);
    const target = saved ?? {
      version: 1 as const,
      historyEntryId: ensureHistoryEntryId(),
      route: routeIdentity(location),
      top: 0,
      left: 0,
    };
    let pending = true;
    let applyFrame: number | null = null;
    let observer: ResizeObserver | null = null;
    let mutationObserver: MutationObserver | null = null;

    const saveCurrentPosition = () => {
      writeWorkspaceScrollSnapshot(location, element.scrollTop, element.scrollLeft);
    };
    const stopWatchingGeometry = () => {
      if (applyFrame !== null) {
        window.cancelAnimationFrame(applyFrame);
        applyFrame = null;
      }
      observer?.disconnect();
      mutationObserver?.disconnect();
    };
    const finishRestorationIfAtTarget = () => {
      if (
        Math.abs(element.scrollTop - target.top) >= 1 ||
        Math.abs(element.scrollLeft - target.left) >= 1
      ) {
        return false;
      }
      pending = false;
      writeWorkspaceScrollSnapshot(location, target.top, target.left);
      stopWatchingGeometry();
      return true;
    };
    const applyTarget = () => {
      if (!pending) return;
      // History restoration is positional state, not an animated navigation.
      // Override the workspace's smooth-scroll CSS for this exact jump.
      const inlineScrollBehavior = element.style.scrollBehavior;
      element.style.scrollBehavior = "auto";
      try {
        element.scrollTop = target.top;
        element.scrollLeft = target.left;
      } finally {
        element.style.scrollBehavior = inlineScrollBehavior;
      }
      finishRestorationIfAtTarget();
    };
    const scheduleApplyTarget = () => {
      if (!pending || applyFrame !== null) return;
      applyFrame = window.requestAnimationFrame(() => {
        applyFrame = null;
        applyTarget();
      });
    };
    const cancelPending = () => {
      if (!pending) return;
      pending = false;
      stopWatchingGeometry();
      saveCurrentPosition();
    };
    const onScroll = () => {
      if (pending) {
        finishRestorationIfAtTarget();
        return;
      }
      saveCurrentPosition();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (["ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp", "End", "Home", "PageDown", "PageUp", " "].includes(event.key)) {
        cancelPending();
      }
    };

    applyTarget();
    // A route's asynchronous content can change scrollHeight without changing
    // the observed scroller or its first child's border box. Retry after the
    // first paint, then wake pending restoration for descendant DOM changes.
    scheduleApplyTarget();
    element.addEventListener("scroll", onScroll, { passive: true });
    element.addEventListener("wheel", cancelPending, { passive: true });
    element.addEventListener("touchstart", cancelPending, { passive: true });
    element.addEventListener("pointerdown", cancelPending, { passive: true });
    element.addEventListener("keydown", onKeyDown);

    const onGeometryChange = () => {
      applyTarget();
      scheduleApplyTarget();
    };
    if (pending) {
      observer = typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(onGeometryChange);
      observer?.observe(element);
      if (element.firstElementChild) observer?.observe(element.firstElementChild);
      mutationObserver = typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(onGeometryChange);
      mutationObserver?.observe(element, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    }

    return () => {
      stopWatchingGeometry();
      element.removeEventListener("scroll", onScroll);
      element.removeEventListener("wheel", cancelPending);
      element.removeEventListener("touchstart", cancelPending);
      element.removeEventListener("pointerdown", cancelPending);
      element.removeEventListener("keydown", onKeyDown);
    };
  }, [layoutIdentity, location.hash, location.key, location.pathname, location.search]);

  return {
    scrollRef,
    arrivedWithSavedPosition: arrivalRef.current?.hadSnapshot ?? false,
  };
}
