import { Box, Text } from "ink";
import type { ReactNode } from "react";

export type AtSuggestionsProps = {
  suggestions: string[];
  selectedIdx: number;
};

export function AtSuggestions({ suggestions, selectedIdx }: AtSuggestionsProps): ReactNode {
  if (suggestions.length === 0) return null;
  const clamped = Math.min(selectedIdx, suggestions.length - 1);
  return (
    <Box flexDirection="column" paddingX={1} paddingBottom={0}>
      {suggestions.map((s, i) => (
        <Box key={s} flexDirection="row">
          <Text color={i === clamped ? "cyan" : "white"} bold={i === clamped} wrap="truncate-end">
            @{s}
          </Text>
        </Box>
      ))}
    </Box>
  );
}
