import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { color } from "../theme.js";

export type HeaderProps = {
  sessionTitle: string;
  latestUserMessage: string;
  width: number;
  profile?: string;
};

const TITLE = "Intercode";

function truncate(s: string, max: number): string {
  if (max <= 1) return s.slice(0, Math.max(0, max));
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function formatPath(cwd: string): string {
  const parts = cwd.split("/");
  if (parts.length <= 2) return cwd;
  const repoName = parts[parts.length - 1];
  const parent = parts[parts.length - 2];
  return `${parent}/${repoName}`;
}

// The header carries identity and context only — the product name, the session
// title, the working directory, and the latest request. All live run telemetry
// (status, turns, cost, tokens, elapsed) lives in the status bar so nothing is
// shown twice.
export function Header({ sessionTitle, latestUserMessage, width, profile }: HeaderProps): ReactNode {
  const cwd = process.cwd();
  const pathDisplay = formatPath(cwd);

  return (
    <Box flexDirection="column" paddingX={1} paddingTop={1}>
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        <Text bold color={color("brand")}>{TITLE}</Text>
        <Text color={color("muted")}>·</Text>
        <Text color={color("muted")}>{pathDisplay}</Text>
        {profile !== undefined && (
          <Text color={color("muted")}>[{profile}]</Text>
        )}
        {sessionTitle.length > 0 && (
          <Box>
            <Text color={color("muted")}>— {truncate(sessionTitle, Math.max(12, Math.floor(width * 0.3)))}</Text>
          </Box>
        )}
      </Box>
      {latestUserMessage.length > 0 && (
        <Text color={color("muted")}>▸ {truncate(latestUserMessage, Math.max(20, width - 4))}</Text>
      )}
    </Box>
  );
}
