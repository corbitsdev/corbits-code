import { Box, Text, useInput } from "ink";
import type { ReactNode } from "react";
import { useState } from "react";
import type { OperatorResult } from "../../agent/tools.js";
import { createMemoizedParseMarkdown } from "../markdown-parser.js";
import type { StyledSegment } from "../markdown-parser.js";
import { color } from "../theme.js";
import { inkPropsForSegment } from "../styled-segment-props.js";

export type OperatorModalProps = {
  question: string;
  options: string[];
  onSelect: (result: OperatorResult) => void;
  width?: number;
};

function segmentProps(seg: StyledSegment): Record<string, unknown> {
  return inkPropsForSegment(seg);
}

// The question text is fixed for the modal's lifetime; only the draft input
// and selection change while it's open, so re-parsing it on every keystroke
// re-render is pure waste. A small bounded cache turns that into a cache hit.
const memoizedParseMarkdown = createMemoizedParseMarkdown();

function MarkdownText({ text, width }: { text: string; width: number }): ReactNode {
  const lines = memoizedParseMarkdown(text, width);
  return (
    <Box flexDirection="column">
      {lines.map((line, li) => (
        <Text key={li} wrap="wrap">
          {line.length === 0 ? " " : line.map((seg, si) => (
            <Text key={si} {...segmentProps(seg)}>{seg.text}</Text>
          ))}
        </Text>
      ))}
    </Box>
  );
}

// Two-column layout when all options are short enough to fit side by side.
// Each column gets half the inner width minus a small gap for the number prefix.
function renderOptionsGrid(options: string[], selected: number, innerWidth: number): ReactNode {
  const colWidth = Math.floor((innerWidth - 3) / 2); // 3 for " │ " separator
  const rows: ReactNode[] = [];

  for (let i = 0; i < options.length; i += 2) {
    const leftOpt = options[i]!;
    const rightOpt = options[i + 1];
    const leftIdx = i;
    const rightIdx = i + 1;
    const leftActive = leftIdx === selected;
    const rightActive = rightIdx === selected;

    rows.push(
      <Box key={i} flexDirection="row">
        <Box width={colWidth}>
          <Text>
            <Text color={leftActive ? color("brand") : color("muted")} bold={leftActive}>{leftActive ? "› " : "  "}</Text>
            <Text color={color("muted")}>{`${leftIdx + 1}. `}</Text>
            <Text color={leftActive ? color("text") : color("muted")} bold={leftActive}>{leftOpt}</Text>
          </Text>
        </Box>
        {rightOpt !== undefined && (
          <>
            <Text color={color("dim")}> │ </Text>
            <Box width={colWidth}>
              <Text>
                <Text color={rightActive ? color("brand") : color("muted")} bold={rightActive}>{rightActive ? "› " : "  "}</Text>
                <Text color={color("muted")}>{`${rightIdx + 1}. `}</Text>
                <Text color={rightActive ? color("text") : color("muted")} bold={rightActive}>{rightOpt}</Text>
              </Text>
            </Box>
          </>
        )}
      </Box>,
    );
  }

  return <Box flexDirection="column">{rows}</Box>;
}

function renderOptionsList(options: string[], selected: number): ReactNode {
  return (
    <Box flexDirection="column">
      {options.map((opt, i) => {
        const active = i === selected;
        return (
          <Text key={i} wrap="wrap">
            <Text color={active ? color("brand") : color("muted")} bold={active}>{active ? "› " : "  "}</Text>
            <Text color={color("muted")}>{`${i + 1}. `}</Text>
            <Text color={active ? color("text") : color("muted")} bold={active}>{opt}</Text>
          </Text>
        );
      })}
    </Box>
  );
}

export function OperatorModal({ question, options, onSelect, width = 80 }: OperatorModalProps): ReactNode {
  const [selected, setSelected] = useState(0);
  const [draft, setDraft] = useState("");
  const typing = draft.length > 0;

  // Available width for text inside the box: border(2) + paddingX(4) + marginX(2)
  const innerWidth = Math.max(1, width - 8);
  // Options fit side by side when each is shorter than half the inner width, minus prefix "1. › " (5 chars)
  const colWidth = Math.floor((innerWidth - 3) / 2);
  const maxOptLen = options.reduce((n, o) => Math.max(n, o.length), 0);
  const useGrid = options.length >= 2 && options.length <= 4 && maxOptLen <= colWidth - 5;

  useInput((input, key) => {
    if (typing) {
      if (key.escape) {
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
      if (!key.ctrl && !key.meta && input.length > 0 && /^[\x20-\x7E -￿]+$/.test(input)) {
        setDraft((d) => d + input);
      }
      return;
    }

    if (key.escape || (key.ctrl && input === "c")) {
      onSelect({ kind: "cancel" });
      return;
    }
    if (key.ctrl && (key.upArrow || key.downArrow)) return;
    if (key.upArrow || input === "\x1B[A" || input === "[A") {
      setSelected((s) => (s > 0 ? s - 1 : options.length - 1));
      return;
    }
    if (key.downArrow || input === "\x1B[B" || input === "[B") {
      setSelected((s) => (s < options.length - 1 ? s + 1 : 0));
      return;
    }
    if (key.return) {
      onSelect({ kind: "option", index: selected });
      return;
    }
    if (/^[1-9]$/.test(input)) {
      const index = Number(input) - 1;
      if (index < options.length) {
        onSelect({ kind: "option", index });
        return;
      }
    }
    // Any printable char starts a custom response
    if (input && !key.ctrl && !key.meta && /^[\x20-\x7E -￿]+$/.test(input)) {
      setDraft(input);
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={color("muted")}
      paddingX={2}
      paddingY={1}
      marginX={1}
      width={Math.max(24, width - 2)}
    >
      <Box marginBottom={1}>
        <MarkdownText text={question} width={innerWidth} />
      </Box>
      {typing ? (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Text color={color("brand")} bold>›</Text>
            <Text color={color("text")}>{draft}</Text>
            <Text color={color("brand")}>▌</Text>
          </Box>
          <Box marginTop={1}>
            <Text color={color("muted")}>Enter to confirm · Esc to cancel</Text>
          </Box>
        </Box>
      ) : (
        <Box flexDirection="column">
          {useGrid
            ? renderOptionsGrid(options, selected, innerWidth)
            : renderOptionsList(options, selected)}
          <Box marginTop={1}>
            <Text color={color("dim")} wrap="truncate-end">
              {`1-${options.length} select · ↑↓ navigate · Enter choose · type to respond · Esc dismiss`}
            </Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}
