import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { useState, useEffect, useRef } from "react";
import { color } from "../theme.js";

export type OnboardingAnimationProps = {
  onComplete: () => void;
  rows: number;
  columns: number;
  isFirstTime?: boolean;
};

const BRAND = "Intercode";
const TAGLINE = "Your AI coding partner";

const TYPE_INTERVAL_MS = 65;
const TAGLINE_DELAY_MS = 300;
const HOLD_MS = 800;
const EXIT_MS = 700;
const EXIT_STEPS = 14;

type Phase = "typing" | "hold" | "exit";

export function OnboardingAnimation({ onComplete, rows, columns, isFirstTime = true }: OnboardingAnimationProps): ReactNode {
  const prefix = isFirstTime ? "Welcome to " : "Welcome back to ";
  const fullPhrase = `${prefix}${BRAND}`;

  const [phase, setPhase] = useState<Phase>("typing");
  const [typed, setTyped] = useState(0);
  const [taglineVisible, setTaglineVisible] = useState(false);
  const [cursorVisible, setCursorVisible] = useState(true);
  const [exitStep, setExitStep] = useState(0);
  const completedRef = useRef(false);

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

  // Exit: "Intercode" slides from center to the bottom-right corner
  useEffect(() => {
    if (phase !== "exit") return;
    const stepMs = EXIT_MS / EXIT_STEPS;
    let step = 0;
    const interval = setInterval(() => {
      step++;
      setExitStep(step);
      if (step >= EXIT_STEPS) {
        clearInterval(interval);
        if (!completedRef.current) {
          completedRef.current = true;
          onComplete();
        }
      }
    }, stepMs);
    return () => clearInterval(interval);
  }, [phase, onComplete]);

  const progress = exitStep / EXIT_STEPS;

  // --- Exit phase: brand slides toward bottom-right ---
  if (phase === "exit") {
    const brandWidth = BRAND.length;
    const centerH = Math.floor((columns - brandWidth) / 2);
    const rightH = Math.max(0, columns - brandWidth - 1);
    const paddingLeft = Math.round(centerH + (rightH - centerH) * progress);

    const centerV = Math.floor((rows - 1) / 2);
    const bottomV = Math.max(0, rows - 1);
    const paddingTop = Math.round(centerV + (bottomV - centerV) * progress);

    return (
      <Box flexDirection="column" height={rows} width={columns}>
        <Box paddingTop={paddingTop}>
          <Box paddingLeft={paddingLeft}>
            <Text bold color={color("brand")} dimColor={progress > 0.45}>
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
              {showCursor && <Text color={color("accent")}>{"\u258B"}</Text>}
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
    </Box>
  );
}
