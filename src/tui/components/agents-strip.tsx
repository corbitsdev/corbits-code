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
  // Cap on rendered rows. The store retains far more completed sessions than
  // belong on screen; without a cap the strip can crowd out the transcript.
  maxVisible?: number;
};

// Default row cap for the strip, independent of how many completed sessions the
// store retains for later inspection.
export const DEFAULT_STRIP_MAX_VISIBLE = 6;

// The strip shows only active work: an agent leaves the visible list as it
// reaches a terminal state. Terminal sessions stay in the store for later
// inspection but are not part of the strip or its navigation.
export function activeStripSessions(
  sessions: readonly SubAgentSession[],
): SubAgentSession[] {
  return sessions.filter((s) => s.status === "running");
}

// Rows the strip occupies for a given session count: the "Agents" header, the
// capped session rows, and an overflow row when sessions are hidden.
export function agentsStripRowCount(sessionCount: number, maxVisible: number): number {
  if (sessionCount === 0) return 0;
  const shown = Math.min(sessionCount, maxVisible);
  const overflow = sessionCount > shown ? 1 : 0;
  return 1 + shown + overflow;
}

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
  maxVisible = DEFAULT_STRIP_MAX_VISIBLE,
}: AgentsStripProps): ReactNode {
  if (sessions.length === 0) return null;

  // sessions arrive running-first then newest, so the head keeps live and
  // recent work visible while older completed sessions fold into the count.
  const visible = sessions.slice(0, Math.max(1, maxVisible));
  const hiddenCount = sessions.length - visible.length;

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
      {visible.map((session) => {
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
      {hiddenCount > 0 && (
        <Text color={color("dim")} dimColor>
          {`  … +${hiddenCount} more`}
        </Text>
      )}
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
