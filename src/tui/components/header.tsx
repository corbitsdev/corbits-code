import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { color } from "../theme.js";
import { formatElapsed } from "./status-bar.js";

export type HeaderWorkflow = {
  name: string;
  stepIndex: number;
  total: number;
  label: string;
};

export type HeaderProps = {
  sessionTitle: string;
  latestUserMessage: string;
  width: number;
  profile?: string;
  workflow?: HeaderWorkflow;
  elapsedMs: number;
  usage?: string | undefined;
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

// The header carries identity and context (product name, path, session title,
// latest request) on the left, and live session telemetry (plan usage, clock)
// on the right.
export function Header({ sessionTitle, latestUserMessage, width, profile, workflow, elapsedMs, usage }: HeaderProps): ReactNode {
  const cwd = process.cwd();
  const pathDisplay = formatPath(cwd);

  return (
    <Box flexDirection="column" paddingX={1} paddingTop={1}>
      <Box flexDirection="row">
        <Box flexDirection="row" gap={1} flexWrap="wrap" flexGrow={1}>
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
          {workflow !== undefined && (
            <Box>
              <Text color={color("accent")}>
                ⟳ {truncate(`${workflow.name} · ${workflow.stepIndex + 1}/${workflow.total} ${workflow.label}`, Math.max(16, Math.floor(width * 0.4)))}
              </Text>
            </Box>
          )}
        </Box>
        <Box flexDirection="row" gap={1} flexShrink={0}>
          {usage !== undefined && <Text color={color("warning")}>{usage}</Text>}
          <Text color={color("muted")}>{formatElapsed(elapsedMs)}</Text>
        </Box>
      </Box>
      {latestUserMessage.length > 0 && (
        <Text color={color("muted")}>▸ {truncate(latestUserMessage, Math.max(20, width - 4))}</Text>
      )}
    </Box>
  );
}
