import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { Task } from "../../agent/tasks.js";
import type { SubAgentSession, SubAgentSessionStatus } from "../../subagent/session-store.js";
import { color } from "../theme.js";
import { describeToolCall } from "../tool-formatter.js";

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

// Chrome strip shows only active work: an agent leaves the default visible
// list as it reaches a terminal state. Terminal sessions stay in the store
// for later inspection; Ctrl+E / agents-nav browses the full listForStrip
// surface (running + recent completed).
export function activeStripSessions(
  sessions: readonly SubAgentSession[],
): SubAgentSession[] {
  return sessions.filter((s) => s.status === "running");
}

// Parent stream state (task tool_call.end → tool.done) can show a sub-agent as
// "doing" before the session store has started, or if store updates are missed
// for a frame. Merge those in-flight rows so the chrome strip never stays empty
// while workers are live.
export function mergeInFlightSubAgents(
  storeSessions: readonly SubAgentSession[],
  inFlight: readonly Task[],
): SubAgentSession[] {
  const byId = new Map(storeSessions.map((s) => [s.id, s]));
  for (const task of inFlight) {
    if (task.status !== "doing") continue;
    const existing = byId.get(task.id);
    if (existing !== undefined) {
      if (existing.status === "running") continue;
      // Store already reached a terminal state; parent tool.done may lag one frame.
      if (
        existing.status === "done" ||
        existing.status === "failed" ||
        existing.status === "cancelled"
      ) {
        continue;
      }
    }
    const { agentId, description, currentToolName } = parseSubAgentTaskTitle(task.title);
    byId.set(task.id, {
      id: task.id,
      description,
      agentId,
      brief: "",
      status: "running",
      toolNames: currentToolName !== null ? [currentToolName] : [],
      currentToolName,
      entries: [],
      startedAt: existing?.startedAt ?? 0,
      ...(existing?.parentSessionId !== undefined
        ? { parentSessionId: existing.parentSessionId }
        : {}),
    });
  }
  return [...byId.values()].sort(stripSessionSort);
}

function stripSessionSort(a: SubAgentSession, b: SubAgentSession): number {
  if (a.status === "running" && b.status !== "running") return -1;
  if (a.status !== "running" && b.status === "running") return 1;
  return b.startedAt - a.startedAt;
}

function parseSubAgentTaskTitle(title: string): {
  agentId: string;
  description: string;
  currentToolName: string | null;
} {
  let base = title;
  let currentToolName: string | null = null;
  const toolSep = " · ";
  const toolIdx = base.lastIndexOf(toolSep);
  if (toolIdx !== -1) {
    currentToolName = base.slice(toolIdx + toolSep.length).trim() || null;
    base = base.slice(0, toolIdx);
  }
  const colon = base.indexOf(": ");
  if (colon === -1) {
    return { agentId: "worker", description: base.trim(), currentToolName };
  }
  return {
    agentId: base.slice(0, colon).trim() || "worker",
    description: base.slice(colon + 2).trim(),
    currentToolName,
  };
}

// Chrome shows the strip whenever there is a running worker to surface, or when
// agents-nav is browsing historical sessions.
export function shouldShowAgentsStrip(input: {
  chromeSessions: readonly SubAgentSession[];
  browseSessions: readonly SubAgentSession[];
  agentsNavOpen: boolean;
}): boolean {
  return (
    input.chromeSessions.length > 0 ||
    (input.agentsNavOpen && input.browseSessions.length > 0)
  );
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
  cancelled: "⊘",
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
            ↑↓ select · ⏎ enter · x cancel · esc back
          </Text>
        )}
        {!navActive && (
          <Text color={color("dim")} dimColor>
            Ctrl+E to browse
          </Text>
        )}
      </Box>
      {visible.map((session, index) => {
        const selected = session.id === selectedId;
        const entered = session.id === enteredId;
        const prefix = selected ? "› " : entered ? "· " : "  ";
        const label = formatSessionLabel(session);
        const tree = treeIndent(session, visible, index);
        return (
          <Box key={session.id} gap={1} width="100%">
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
              {tree}
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

// Nested (one-hop) dispatches carry parentSessionId; render them under their
// orchestrator with a tree glyph. Siblings are not necessarily adjacent (the
// strip sorts running-first then by recency), so "last" is determined by
// scanning the remainder of the visible list rather than array position.
function treeIndent(
  session: SubAgentSession,
  visible: readonly SubAgentSession[],
  index: number,
): string {
  if (session.parentSessionId === undefined) return "";
  const hasLaterSibling = visible
    .slice(index + 1)
    .some((s) => s.parentSessionId === session.parentSessionId);
  return hasLaterSibling ? "├─ " : "└─ ";
}

// The transcript entry backing session.currentToolName, if any — used to
// build an argument preview. currentToolName is nulled the moment a result
// lands, so whenever it is set the most recent matching "tool" entry is the
// one still running.
function currentToolArguments(session: SubAgentSession): string {
  if (session.currentToolName === null) return "";
  for (let i = session.entries.length - 1; i >= 0; i--) {
    const entry = session.entries[i];
    if (entry?.kind === "tool" && entry.name === session.currentToolName) return entry.arguments;
  }
  return "";
}

export function formatSessionLabel(session: SubAgentSession): string {
  if (session.status === "running" && session.currentToolName !== null) {
    const args = currentToolArguments(session);
    const { summary, isShell } = describeToolCall(session.currentToolName, args);
    // Shell's summary is already the full command headline (no separate tool
    // name to prefix); other tools read as "<name> <argument summary>".
    const preview = isShell
      ? summary
      : summary.length > 0
        ? `${session.currentToolName} ${summary}`
        : session.currentToolName;
    const tool = ` — ${preview}`;
    return `${session.agentId}: ${session.description}${tool}`;
  }
  const tool =
    session.toolNames.length > 0 && session.status !== "running"
      ? ` · ${session.toolNames.length} tool${session.toolNames.length === 1 ? "" : "s"}`
      : "";
  return `${session.agentId}: ${session.description}${tool}`;
}

function summaryCounts(sessions: readonly SubAgentSession[]): string {
  const running = sessions.filter((s) => s.status === "running").length;
  const done = sessions.filter((s) => s.status === "done").length;
  const failed = sessions.filter((s) => s.status === "failed").length;
  const cancelled = sessions.filter((s) => s.status === "cancelled").length;
  const parts: string[] = [];
  if (running > 0) parts.push(`${running} live`);
  if (done > 0) parts.push(`${done} done`);
  if (failed > 0) parts.push(`${failed} failed`);
  if (cancelled > 0) parts.push(`${cancelled} cancelled`);
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
    case "cancelled":
      return color("muted");
  }
}
