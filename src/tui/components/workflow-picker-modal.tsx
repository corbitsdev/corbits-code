import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { ReactNode } from "react";
import { color } from "../theme.js";
import type { Workflow } from "../../workflows/types.js";

export type WorkflowPickerModalProps = {
  workflows: Workflow[];
  onSelect: (name: string) => void;
  onClose: () => void;
};

export function WorkflowPickerModal({ workflows, onSelect, onClose }: WorkflowPickerModalProps): ReactNode {
  const [index, setIndex] = useState(0);

  useInput((input, key) => {
    if (key.upArrow) {
      setIndex((i) => (i > 0 ? i - 1 : workflows.length - 1));
      return;
    }
    if (key.downArrow) {
      setIndex((i) => (i < workflows.length - 1 ? i + 1 : 0));
      return;
    }
    if (key.return) {
      const workflow = workflows[index];
      if (workflow !== undefined) onSelect(workflow.name);
      return;
    }
    if (key.escape) {
      onClose();
    }
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
      <Text bold color={color("accent")}>Workflows</Text>
      <Box marginTop={1} flexDirection="column">
        {workflows.map((w, i) => {
          const isCursor = i === index;
          return (
            <Box key={w.name} flexDirection="row" gap={1}>
              <Text color={isCursor ? color("accent") : color("muted")} bold={isCursor}>
                {isCursor ? ">" : " "}
              </Text>
              <Box width={20} flexShrink={0}>
                <Text color={isCursor ? color("accent") : color("text")}>{w.name}</Text>
              </Box>
              <Text color={color("muted")}>{w.description}</Text>
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Up/Down navigate · Enter start · Esc close</Text>
      </Box>
    </Box>
  );
}
