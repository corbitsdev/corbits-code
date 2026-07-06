import { useEffect, useRef } from "react";
import type { EventEmitter } from "node:events";

// Mouse-wheel events are stripped from stdin before Ink parses them (see
// createFilteredStdin), so scroll arrives on a dedicated emitter rather than
// through useInput. Enabling/disabling SGR mouse reporting is a terminal-level
// side effect owned by the runner, not this hook.
//
// The subscription is a genuine external-source subscription, so useEffect is
// the right tool: with a stable `mouseEvents` it runs once on mount and tears
// down on unmount — it does not re-subscribe per render. The callback refs keep
// the latest handlers without widening the effect's dependencies.
type ScrollHandler = (ticks: number) => void;

export function useMouseScroll(
  mouseEvents: EventEmitter | undefined,
  onScrollUp: ScrollHandler,
  onScrollDown: ScrollHandler,
): void {
  const onScrollUpRef = useRef(onScrollUp);
  onScrollUpRef.current = onScrollUp;
  const onScrollDownRef = useRef(onScrollDown);
  onScrollDownRef.current = onScrollDown;
  const pendingTicksRef = useRef(0);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!mouseEvents) return;

    const flush = () => {
      flushTimerRef.current = null;
      const ticks = pendingTicksRef.current;
      pendingTicksRef.current = 0;
      if (ticks < 0) onScrollUpRef.current(Math.abs(ticks));
      if (ticks > 0) onScrollDownRef.current(ticks);
    };
    const queue = (delta: number) => {
      pendingTicksRef.current += delta;
      if (flushTimerRef.current === null) flushTimerRef.current = setTimeout(flush, 0);
    };
    const up = () => queue(-1);
    const down = () => queue(1);

    mouseEvents.on("scrollUp", up);
    mouseEvents.on("scrollDown", down);
    return () => {
      mouseEvents.off("scrollUp", up);
      mouseEvents.off("scrollDown", down);
      if (flushTimerRef.current !== null) clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
      pendingTicksRef.current = 0;
    };
  }, [mouseEvents]);
}
