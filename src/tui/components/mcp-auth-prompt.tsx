import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { color } from "../theme.js";
import { osc8 } from "../util/clipboard.js";

export type McpAuthPromptProps = {
  servers: Array<{ name: string; url: string }>;
};

// Surfaced when one or more MCP servers need OAuth authorization. The URL renders
// as an OSC 8 hyperlink (clickable in terminals that support it); pressing `c`
// copies it (handled by the keymap) for pasting into a separate browser.
export function McpAuthPrompt({ servers }: McpAuthPromptProps): ReactNode {
  if (servers.length === 0) return null;
  return (
    <Box flexDirection="column" paddingX={1} borderStyle="round" borderColor={color("warning")}>
      <Text color={color("warning")} bold>
        MCP authorization required
      </Text>
      {servers.map((s) => (
        <Box key={s.name} flexDirection="column">
          <Text>
            <Text color={color("accent")}>{s.name}</Text>
            <Text color={color("muted")}> — </Text>
            <Text color={color("accent")}>{osc8(s.url, "open in browser")}</Text>
          </Text>
          <Text color={color("muted")}>{s.url}</Text>
        </Box>
      ))}
      <Text color={color("muted")}>press Alt+C to copy URL</Text>
    </Box>
  );
}
