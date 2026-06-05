import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { color } from "../theme.js";

export type HeaderProps = {
  sessionTitle: string;
  latestUserMessage: string;
  width: number;
};

const TITLE = "Intercode";

function truncate(s: string, max: number): string {
  if (max <= 1) return s.slice(0, Math.max(0, max));
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function truncatePath(path: string, maxWidth: number): string {
  if (path.length <= maxWidth) return path;
  const segments = path.split("/");
  if (segments.length <= 1) return truncate(path, maxWidth);
  const last = segments[segments.length - 1]!;
  if (last.length + 3 > maxWidth) return truncate(path, maxWidth);
  const availableForMiddle = maxWidth - last.length - 4;
  if (availableForMiddle <= 0) return `…/${last}`;
  const first = segments[0]!;
  const middle = segments.slice(1, -1).join("/");
  const truncatedMiddle = middle.length > availableForMiddle ? `${middle.slice(0, availableForMiddle - 1)}…` : middle;
  return `${first}/${truncatedMiddle}/${last}`;
}

// The header carries identity and context only — the product name, the session
// title, the working directory, and the latest request. All live run telemetry
// (status, turns, cost, tokens, elapsed) lives in the status bar so nothing is
// shown twice.
export function Header({ sessionTitle, latestUserMessage, width }: HeaderProps): ReactNode {
  const showCwd = width >= 80;
  const cwd = process.cwd();
  const cwdMax = Math.max(12, Math.floor(width * 0.35));

  return (
    <Box flexDirection="column" paddingX={1} paddingTop={1}>
      <Box flexDirection="row" gap={1}>
        <Text bold color={color("brand")}>{TITLE}</Text>
        {sessionTitle.length > 0 && (
          <Text color={color("muted")}>— {truncate(sessionTitle, Math.max(12, Math.floor(width * 0.5)))}</Text>
        )}
      </Box>
      {showCwd && (
        <Text color={color("muted")}>{truncatePath(cwd, cwdMax)}</Text>
      )}
      {latestUserMessage.length > 0 && (
        <Text color={color("muted")}>▸ {truncate(latestUserMessage, Math.max(20, width - 4))}</Text>
      )}
    </Box>
  );
}
