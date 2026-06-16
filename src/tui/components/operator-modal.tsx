import { Box, Text, useInput } from "ink";
import type { ReactNode } from "react";
import { useState } from "react";
import type { OperatorResult } from "../../agent/tools.js";

export type OperatorModalProps = {
  question: string;
  options: string[];
  onSelect: (result: OperatorResult) => void;
  width?: number;
};

const OTHER_LABEL = "Other (type your own answer)";
const CLOSE_LABEL = "Close (dismiss without answering)";

export function OperatorModal({ question, options, onSelect, width = 80 }: OperatorModalProps): ReactNode {
  // The "Other" and "Close" entries always sit below the offered options, so the
  // operator can answer freely or back out without the agent having to anticipate it.
  const items = [...options, OTHER_LABEL, CLOSE_LABEL];
  const otherIndex = options.length;
  const closeIndex = options.length + 1;

  const [selected, setSelected] = useState(0);
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState("");

  useInput((input, key) => {
    if (typing) {
      if (key.escape) {
        setTyping(false);
        setDraft("");
        return;
      }
      if (key.return) {
        const text = draft.trim();
        if (text.length > 0) onSelect({ kind: "custom", text });
        return;
      }
      if (key.backspace || key.delete) {
        setDraft((d) => d.slice(0, -1));
        return;
      }
      if (!key.ctrl && !key.meta && input.length > 0) {
        setDraft((d) => d + input);
      }
      return;
    }

    if (key.escape || (key.ctrl && input === "c")) {
      onSelect({ kind: "cancel" });
      return;
    }
    if (key.upArrow) {
      setSelected((s) => (s > 0 ? s - 1 : items.length - 1));
      return;
    }
    if (key.downArrow) {
      setSelected((s) => (s < items.length - 1 ? s + 1 : 0));
      return;
    }
    if (key.return) {
      if (selected === closeIndex) {
        onSelect({ kind: "cancel" });
        return;
      }
      if (selected === otherIndex) {
        setTyping(true);
        return;
      }
      onSelect({ kind: "option", index: selected });
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
      {typing ? (
        <>
          <Box marginTop={1} flexDirection="row" gap={1}>
            <Text color="cyan" bold>{">"}</Text>
            <Text wrap="wrap">{draft.length > 0 ? draft : <Text dimColor>Type your answer…</Text>}</Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor wrap="truncate-end">Enter to submit, Esc to go back</Text>
          </Box>
        </>
      ) : (
        <>
          <Box marginTop={1} flexDirection="column">
            {items.map((opt, i) => {
              const active = i === selected;
              const dim = i === otherIndex || i === closeIndex;
              return (
                <Box key={i} flexDirection="row" gap={1}>
                  {active ? <Text color="cyan" bold>{">"}</Text> : <Text>{" "}</Text>}
                  {active ? (
                    <Text color="cyan" wrap="wrap">{opt}</Text>
                  ) : (
                    <Text dimColor={dim} wrap="wrap">{opt}</Text>
                  )}
                </Box>
              );
            })}
          </Box>
          <Box marginTop={1}>
            <Text dimColor wrap="truncate-end">↑↓ to navigate, Enter to select, Esc to dismiss</Text>
          </Box>
        </>
      )}
    </Box>
  );
}
