import { Box, Text, useInput } from "ink";
import type { ReactNode } from "react";
import { color } from "../theme.js";
import { SHORTCUTS, SLASH_COMMANDS, type ShortcutEntry } from "../keymap-table.js";

export type HelpOverlayProps = {
  onClose: () => void;
};

function Row({ entry }: { entry: ShortcutEntry }): ReactNode {
  return (
    <Box flexDirection="row" gap={1}>
      <Box width={18}>
        <Text bold color={color("brand")}>{entry.keys}</Text>
      </Box>
      <Text color={color("text")}>{entry.description}</Text>
    </Box>
  );
}

export function HelpOverlay({ onClose }: HelpOverlayProps): ReactNode {
  useInput((_input, key) => {
    if (key.escape || key.return) onClose();
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
      <Text bold color={color("accent")}>Keyboard Shortcuts</Text>
      <Box flexDirection="column" marginTop={1}>
        {SHORTCUTS.map((entry) => (
          <Row key={entry.keys} entry={entry} />
        ))}
      </Box>
      <Box marginTop={1}>
        <Text bold color={color("accent")}>Slash Commands</Text>
      </Box>
      <Box flexDirection="column">
        {SLASH_COMMANDS.map((entry) => (
          <Row key={entry.keys} entry={entry} />
        ))}
      </Box>
      <Box marginTop={1}>
        <Text color={color("muted")}>ESC to close</Text>
      </Box>
    </Box>
  );
}
