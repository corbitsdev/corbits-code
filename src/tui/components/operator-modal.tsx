import { Box, Text, useInput } from "ink";
import type { ReactNode } from "react";
import { useState } from "react";

export type OperatorModalProps = {
  question: string;
  options: string[];
  onSelect: (index: number) => void;
  width?: number;
};

export function OperatorModal({ question, options, onSelect, width = 80 }: OperatorModalProps): ReactNode {
  const [selected, setSelected] = useState(0);

  useInput((_input, key) => {
    if (key.upArrow) {
      setSelected((s) => (s > 0 ? s - 1 : options.length - 1));
      return;
    }
    if (key.downArrow) {
      setSelected((s) => (s < options.length - 1 ? s + 1 : 0));
      return;
    }
    if (key.return) {
      onSelect(selected);
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={2}
      paddingY={1}
      marginX={1}
      marginY={1}
      width={Math.max(24, width - 2)}
    >
      <Text bold color="cyan">Operator Question</Text>
      <Box marginTop={1}>
        <Text wrap="wrap">{question}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {options.map((opt, i) => (
          <Box key={i} flexDirection="row" gap={1}>
            {i === selected ? (
              <Text color="cyan" bold>{">"}</Text>
            ) : (
              <Text>{" "}</Text>
            )}
            {i === selected ? (
              <Text color="cyan" wrap="wrap">{opt}</Text>
            ) : (
              <Text wrap="wrap">{opt}</Text>
            )}
          </Box>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor wrap="truncate-end">↑↓ to navigate, Enter to select</Text>
      </Box>
    </Box>
  );
}
