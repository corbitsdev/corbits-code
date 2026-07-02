import { Box, Text, useInput } from "ink";
import type { ReactNode } from "react";
import { useState, useEffect, useRef } from "react";
import { color } from "../theme.js";
import pkg from "../../../package.json" with { type: "json" };

export type OnboardingAnimationProps = {
  onComplete: () => void;
  rows: number;
  columns: number;
  isFirstTime: boolean;
};

const BRAND = "Intercode";
const TAGLINE = "Your AI coding partner";

const TYPE_INTERVAL_MS = 65;
const TAGLINE_DELAY_MS = 300;
const HOLD_MS = 800;
const EXIT_MS = 700;

type Phase = "typing" | "hold" | "exit";

export function OnboardingAnimation({ onComplete, rows, columns, isFirstTime }: OnboardingAnimationProps): ReactNode {
  const prefix = isFirstTime ? "Welcome to " : "Welcome back to ";
  const fullPhrase = `${prefix}${BRAND}`;

  const [phase, setPhase] = useState<Phase>("typing");
  const [typed, setTyped] = useState(0);
  const [taglineVisible, setTaglineVisible] = useState(false);
  const [cursorVisible, setCursorVisible] = useState(true);
  const completedRef = useRef(false);

  const complete = (): void => {
    if (completedRef.current) return;
    completedRef.current = true;
    onComplete();
  };

  // Any keypress dismisses the animation immediately.
  useInput(() => complete());

  // Blink cursor while typing
  useEffect(() => {
    if (phase !== "typing") return;
    const interval = setInterval(() => setCursorVisible((v) => !v), 400);
    return () => clearInterval(interval);
  }, [phase]);

  // Typewriter: reveal one character at a time, then show tagline and hold
  useEffect(() => {
    if (phase !== "typing") return;
    if (typed >= fullPhrase.length) {
      const t1 = setTimeout(() => setTaglineVisible(true), TAGLINE_DELAY_MS);
      const t2 = setTimeout(() => setPhase("hold"), TAGLINE_DELAY_MS + 600);
      return () => { clearTimeout(t1); clearTimeout(t2); };
    }
    const t = setTimeout(() => setTyped((c) => c + 1), TYPE_INTERVAL_MS);
    return () => clearTimeout(t);
  }, [phase, typed, fullPhrase.length]);

  // Hold the fully typed screen, then begin the exit slide
  useEffect(() => {
    if (phase !== "hold") return;
    const t = setTimeout(() => setPhase("exit"), HOLD_MS);
    return () => clearTimeout(t);
  }, [phase]);

  // Exit: the screen slides away and the animation completes once it lands.
  useEffect(() => {
    if (phase !== "exit") return;
    const t = setTimeout(complete, EXIT_MS);
    return () => clearTimeout(t);
  }, [phase]);

  // --- Exit phase: brand fades toward the bottom-right ---
  if (phase === "exit") {
    const brandWidth = BRAND.length;
    const paddingLeft = Math.max(0, columns - brandWidth - 1);
    const paddingTop = Math.max(0, rows - 1);

    return (
      <Box flexDirection="column" height={rows} width={columns}>
        <Box paddingTop={paddingTop}>
          <Box paddingLeft={paddingLeft}>
            <Text bold color={color("brand")} dimColor>
              {BRAND}
            </Text>
          </Box>
        </Box>
      </Box>
    );
  }

  // --- Typing / hold phases: centered ---
  const typedPrefix = fullPhrase.slice(0, Math.min(typed, prefix.length));
  const typedBrand = typed > prefix.length ? BRAND.slice(0, typed - prefix.length) : "";
  const showCursor = phase === "typing" && typed < fullPhrase.length && cursorVisible;

  const phraseWidth = fullPhrase.length;
  const phraseLeft = Math.max(0, Math.floor((columns - phraseWidth) / 2));

  const taglineLeft = Math.max(0, Math.floor((columns - TAGLINE.length) / 2));

  const lineCount = taglineVisible ? 3 : 1;
  const paddingTop = Math.max(0, Math.floor((rows - lineCount) / 2));

  return (
    <Box flexDirection="column" height={rows} width={columns}>
      <Box paddingTop={paddingTop}>
        <Box flexDirection="column">
          <Box paddingLeft={phraseLeft}>
            <Text>
              <Text color={color("muted")} dimColor>{typedPrefix}</Text>
              <Text bold color={color("brand")}>{typedBrand}</Text>
              {showCursor && <Text color={color("accent")}>{"▋"}</Text>}
            </Text>
          </Box>
          {taglineVisible && (
            <Box flexDirection="column" marginTop={1}>
              <Box paddingLeft={taglineLeft}>
                <Text color={color("muted")} dimColor>{TAGLINE}</Text>
              </Box>
            </Box>
          )}
        </Box>
      </Box>
      <Box flexGrow={1} />
      <Box paddingLeft={1}>
        <Text color={color("muted")} dimColor>{`v${pkg.version}`}</Text>
      </Box>
    </Box>
  );
}
