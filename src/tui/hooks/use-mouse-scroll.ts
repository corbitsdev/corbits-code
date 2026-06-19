import { useEffect, useRef } from "react";
import { useStdin } from "ink";
import type { EventEmitter } from "node:events";

// SGR mouse mode escape sequences. Mode 1000 enables basic button-event
// reporting; mode 1006 switches to the SGR extended format that supports
// coordinates beyond 223 and encodes the button value as a decimal number
// in the sequence body rather than as a single 8-bit byte.
const MOUSE_ENABLE = "\x1b[?1000h\x1b[?1006h";
const MOUSE_DISABLE = "\x1b[?1000l\x1b[?1006l";

// Mouse-wheel events are stripped from stdin before Ink parses them (see
// createFilteredStdin), so scroll arrives on a dedicated emitter rather than
// through useInput. This keeps the raw `[<64;..M` sequences from ever leaking
// into any text input.
export function useMouseScroll(
  mouseEvents: EventEmitter | undefined,
  onScrollUp: () => void,
  onScrollDown: () => void,
): void {
  const onScrollUpRef = useRef(onScrollUp);
  onScrollUpRef.current = onScrollUp;
  const onScrollDownRef = useRef(onScrollDown);
  onScrollDownRef.current = onScrollDown;

  const { isRawModeSupported } = useStdin();

  // Enable SGR mouse tracking on mount so the terminal sends mouse-wheel events
  // as CSI sequences that the stdin filter can detect.
  useEffect(() => {
    if (!isRawModeSupported) return;
    process.stdout.write(MOUSE_ENABLE);
    return () => {
      process.stdout.write(MOUSE_DISABLE);
    };
  }, [isRawModeSupported]);

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
