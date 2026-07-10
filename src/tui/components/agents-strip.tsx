import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { SubAgentSession, SubAgentSessionStatus } from "../../subagent/session-store.js";
import { color } from "../theme.js";

export type AgentsStripProps = {
  sessions: readonly SubAgentSession[];
  // When set, that row is the keyboard selection (agents-nav mode).
  selectedId?: string | null;
  // Session currently entered for live/historical observe.
  enteredId?: string | null;
  // Show selection chrome + hint row.
  navActive?: boolean;
};

const STATUS_GLYPH: Record<SubAgentSessionStatus, string> = {
  running: "●",
  done: "✓",
  failed: "✗",
};

export function AgentsStrip({
  sessions,
  selectedId = null,
  enteredId = null,
  navActive = false,
}: AgentsStripProps): ReactNode {
  if (sessions.length === 0) return null;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box gap={1}>
        <Text bold color={color("accent")}>
          Agents
        </Text>
        <Text color={color("dim")} dimColor>
          {summaryCounts(sessions)}
        </Text>
        {navActive && (
          <Text color={color("muted")} dimColor>
            ↑↓ select · ⏎ enter · esc cancel
          </Text>
        )}
        {!navActive && (
          <Text color={color("dim")} dimColor>
            Ctrl+E to browse
          </Text>
        )}
      </Box>
      {sessions.map((session) => {
        const selected = session.id === selectedId;
        const entered = session.id === enteredId;
        const prefix = selected ? "› " : entered ? "· " : "  ";
        const label = formatSessionLabel(session);
        return (
          <Box key={session.id} gap={1}>
            <Text
              color={statusColor(session.status)}
              bold={session.status === "running" || selected}
            >
              {STATUS_GLYPH[session.status]}
            </Text>
            <Text
              color={selected || entered ? color("text") : color("muted")}
              bold={selected || entered}
              wrap="truncate-end"
            >
              {prefix}
              {label}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

export function formatSessionLabel(session: SubAgentSession): string {
  const tool =
    session.status === "running" && session.currentToolName !== null
      ? ` · ${session.currentToolName}`
      : session.toolNames.length > 0 && session.status !== "running"
        ? ` · ${session.toolNames.length} tool${session.toolNames.length === 1 ? "" : "s"}`
        : "";
  return `${session.agentId}: ${session.description}${tool}`;
}

function summaryCounts(sessions: readonly SubAgentSession[]): string {
  const running = sessions.filter((s) => s.status === "running").length;
  const done = sessions.filter((s) => s.status === "done").length;
  const failed = sessions.filter((s) => s.status === "failed").length;
  const parts: string[] = [];
  if (running > 0) parts.push(`${running} live`);
  if (done > 0) parts.push(`${done} done`);
  if (failed > 0) parts.push(`${failed} failed`);
  return parts.length > 0 ? parts.join(" · ") : `${sessions.length}`;
}

function statusColor(status: SubAgentSessionStatus): string {
  switch (status) {
    case "running":
      return color("text");
    case "done":
      return color("success");
    case "failed":
      return color("danger");
  }
}
