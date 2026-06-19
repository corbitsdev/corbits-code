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
export function useMouseScroll(
  mouseEvents: EventEmitter | undefined,
  onScrollUp: () => void,
  onScrollDown: () => void,
): void {
  const onScrollUpRef = useRef(onScrollUp);
  onScrollUpRef.current = onScrollUp;
  const onScrollDownRef = useRef(onScrollDown);
  onScrollDownRef.current = onScrollDown;

  useEffect(() => {
    if (!mouseEvents) return;
    const up = () => onScrollUpRef.current();
    const down = () => onScrollDownRef.current();
    mouseEvents.on("scrollUp", up);
    mouseEvents.on("scrollDown", down);
    return () => {
      mouseEvents.off("scrollUp", up);
      mouseEvents.off("scrollDown", down);
    };
  }, [mouseEvents]);
}
