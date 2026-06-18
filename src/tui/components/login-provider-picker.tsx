import { Box, Text, useInput } from "ink";
import type { ReactNode } from "react";
import { useState } from "react";
import { color } from "../theme.js";

// The providers offered by the bare /login command. The picker routes into the
// existing per-provider login modal (CodexLoginModal), so each entry only needs
// enough to identify which provider the user picked.
export type LoginProvider = "codex" | "xai";

export type LoginProviderPickerProps = {
  onSelect: (provider: LoginProvider) => void;
  onClose: () => void;
};

const OPTIONS: Array<{ provider: LoginProvider; label: string; hint: string }> = [
  { provider: "codex", label: "OpenAI Codex", hint: "ChatGPT Plus/Pro subscription" },
  { provider: "xai", label: "xAI Grok", hint: "SuperGrok or X Premium+ subscription" },
];

export function LoginProviderPicker({ onSelect, onClose }: LoginProviderPickerProps): ReactNode {
  const [cursor, setCursor] = useState(0);

  useInput((input, key) => {
    if (key.upArrow) {
      setCursor((i) => (i > 0 ? i - 1 : OPTIONS.length - 1));
      return;
    }
    if (key.downArrow) {
      setCursor((i) => (i < OPTIONS.length - 1 ? i + 1 : 0));
      return;
    }
    if (key.return) {
      onSelect(OPTIONS[cursor]!.provider);
      return;
    }
    if (key.escape) onClose();
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={color("accent")}
      paddingX={2}
      paddingY={1}
      marginX={1}
      marginY={1}
    >
      <Text bold color={color("accent")}>
        Sign in
      </Text>
      <Box marginTop={1}>
        <Text color={color("muted")}>Choose a provider to sign in with</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {OPTIONS.map((opt, i) => {
          const isCursor = i === cursor;
          return (
            <Box key={opt.provider} flexDirection="column">
              <Box flexDirection="row" gap={1}>
                <Text color={isCursor ? color("accent") : color("muted")} bold={isCursor}>
                  {isCursor ? ">" : " "}
                </Text>
                <Text color={isCursor ? color("accent") : color("text")} bold={isCursor}>
                  {opt.label}
                </Text>
              </Box>
              <Box flexDirection="row" gap={1}>
                <Text>{"  "}</Text>
                <Text color={color("muted")}>{opt.hint}</Text>
              </Box>
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Up/Down navigate · Enter select · Esc close</Text>
      </Box>
    </Box>
  );
}
