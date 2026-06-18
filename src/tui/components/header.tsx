import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { color } from "../theme.js";

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
  // Codex plan usage (e.g. "50% used") — shown only for prepaid Codex accounts.
  usage?: string | undefined;
};

function truncate(s: string, max: number): string {
  if (max <= 1) return s.slice(0, Math.max(0, max));
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

// The header carries session context (profile, session title, latest request)
// on the left and live telemetry (plan usage) on the right. The product name
// lives in the status bar so the top line stays clear for user content.
export function Header({ sessionTitle, latestUserMessage, width, profile, workflow, usage }: HeaderProps): ReactNode {
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box flexDirection="row">
        <Box flexDirection="row" gap={1} flexWrap="wrap" flexGrow={1}>
          {profile !== undefined && (
            <Text color={color("muted")} dimColor>[{profile}]</Text>
          )}
          {sessionTitle.length > 0 && (
            <Box>
              <Text color={color("muted")} dimColor>— {truncate(sessionTitle, Math.max(12, Math.floor(width * 0.3)))}</Text>
            </Box>
          )}
          {workflow !== undefined && (
            <Box>
              <Text color={color("accent")}>
                {`\u27F3 ${truncate(`${workflow.name} \u00B7 ${workflow.stepIndex + 1}/${workflow.total} ${workflow.label}`, Math.max(16, Math.floor(width * 0.4)))}`}
              </Text>
            </Box>
          )}
        </Box>
        {usage !== undefined && (
          <Box flexShrink={0}>
            <Text color={color("warning")}>{usage}</Text>
          </Box>
        )}
      </Box>
      {latestUserMessage.length > 0 && (
        <Text color={color("muted")} dimColor>{`\u25B8 ${truncate(latestUserMessage, Math.max(20, width - 4))}`}</Text>
      )}
    </Box>
  );
}
