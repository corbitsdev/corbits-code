import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { color } from "../theme.js";

export type InFlightIndicatorProps = {
  active: boolean;
  frame: string;
  elapsedMs: number;
};

// The "still working" hint only appears once a wait runs past this, so a fast
// reply never flashes a counter — only a genuinely slow one earns the seconds.
const SLOW_THRESHOLD_MS = 2000;

// A single dim line that spins while the model is composing and clears the
// instant its first token streams. The row is always rendered (blank when
// idle) so the surrounding layout never shifts as it appears and disappears.
export function InFlightIndicator({ active, frame, elapsedMs }: InFlightIndicatorProps): ReactNode {
  if (!active) {
    return (
      <Box paddingX={1}>
        <Text> </Text>
      </Box>
    );
  }
  const seconds = Math.floor(elapsedMs / 1000);
  const suffix = elapsedMs >= SLOW_THRESHOLD_MS ? ` ${seconds}s` : "";
  return (
    <Box paddingX={1}>
      <Text color={color("brand")}>{frame}</Text>
      <Text color={color("muted")} dimColor>{` Thinking…${suffix}`}</Text>
    </Box>
  );
}
