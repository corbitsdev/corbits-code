import { useEffect, useRef } from "react";
import { useInput, useStdin } from "ink";

// SGR mouse mode escape sequences. Mode 1000 enables basic button-event
// reporting; mode 1006 switches to the SGR extended format that supports
// coordinates beyond 223 and encodes the button value as a decimal number
// in the sequence body rather than as a single 8-bit byte.
const MOUSE_ENABLE = "\x1b[?1000h\x1b[?1006h";
const MOUSE_DISABLE = "\x1b[?1000l\x1b[?1006l";

// SGR mouse-wheel sequences (after Ink strips the leading ESC byte):
//   scroll up:   "[<64;col;rowM" (press) or "[<64;col;rowm" (release)
//   scroll down: "[<65;col;rowM" (press) or "[<65;col;rowm" (release)
const SCROLL_UP_RE = /^\[<64;\d+;\d+[Mm]$/;
const SCROLL_DOWN_RE = /^\[<65;\d+;\d+[Mm]$/;

export function useMouseScroll(
  onScrollUp: () => void,
  onScrollDown: () => void,
): void {
  const onScrollUpRef = useRef(onScrollUp);
  onScrollUpRef.current = onScrollUp;
  const onScrollDownRef = useRef(onScrollDown);
  onScrollDownRef.current = onScrollDown;

  const { isRawModeSupported } = useStdin();

  // Enable SGR mouse tracking on mount so the terminal sends mouse-wheel
  // events as CSI sequences that Ink's input parser forwards to useInput.
  useEffect(() => {
    if (!isRawModeSupported) return;
    process.stdout.write(MOUSE_ENABLE);
    return () => {
      process.stdout.write(MOUSE_DISABLE);
    };
  }, [isRawModeSupported]);

  // Intercept mouse-wheel sequences that reach the useInput callback.
  // The leading ESC byte has already been stripped by Ink, leaving clean
  // patterns like "[<65;22;80M".
  useInput((input, _key) => {
    if (SCROLL_DOWN_RE.test(input)) {
      onScrollDownRef.current();
    } else if (SCROLL_UP_RE.test(input)) {
      onScrollUpRef.current();
    }
  });
}
