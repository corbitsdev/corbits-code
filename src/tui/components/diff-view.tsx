import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { DiffLine, DiffResult } from "../git-diff.js";
import { color } from "../theme.js";

export type DiffViewProps = {
  result: DiffResult | null;
  scrollOffset: number;
  visibleRows: number;
  width: number;
};

function lineColor(kind: DiffLine["kind"]): string {
  switch (kind) {
    case "added":
      return color("success");
    case "removed":
      return color("danger");
    case "hunk":
    case "meta":
      return color("accent");
    case "context":
      return color("muted");
  }
}

function truncate(text: string, max: number): string {
  if (max <= 1) return text.slice(0, Math.max(0, max));
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function DiffView({ result, scrollOffset, visibleRows, width }: DiffViewProps): ReactNode {
  const contentWidth = Math.max(8, width - 4);

  let body: ReactNode;
  if (result !== null && !result.available) {
    body = <Text color={color("warning")}>Git unavailable — not a repository or git not found.</Text>;
  } else if (result === null) {
    body = <Text color={color("muted")}>Loading diff…</Text>;
  } else {
    const lines = result.files.flatMap((file) => file.lines);
    if (lines.length === 0) {
      body = <Text color={color("muted")}>No changes yet.</Text>;
    } else {
      const start = Math.max(0, Math.min(scrollOffset, Math.max(0, lines.length - visibleRows)));
      const visible = lines.slice(start, start + visibleRows);
      body = (
        <>
          {visible.map((line, i) => (
            <Text key={`diff-${start + i}`} color={lineColor(line.kind)}>
              {truncate(line.text.length === 0 ? " " : line.text, contentWidth)}
            </Text>
          ))}
        </>
      );
    }
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color("accent")} paddingX={1} width={width} flexGrow={1}>
      <Text bold color={color("accent")}>Diff</Text>
      {body}
    </Box>
  );
}
