import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type {
  SubAgentSession,
  SubAgentTranscriptEntry,
} from "../../subagent/session-store.js";
import { color } from "../theme.js";
import { formatSessionLabel } from "./agents-strip.js";

export type SubAgentSessionViewProps = {
  session: SubAgentSession;
  // Total rows the view occupies; the transcript viewport is what remains after
  // the header block.
  visibleRows: number;
  width: number;
  // Top line of the transcript window (0 = top, maxOffset = pinned to newest).
  scrollOffset: number;
};

// Rows the header block (title, label, status, margin) reserves above the
// transcript viewport.
export const SUBAGENT_VIEW_HEADER_ROWS = 3;

export function subAgentTranscriptWidth(width: number): number {
  return Math.max(20, width - 2);
}

// Resolve the transcript slice for a given scroll offset. Mirrors the event-log
// window convention: offset is a clamped top-line index, maxOffset pins newest.
export function subAgentScrollWindow(
  lineCount: number,
  visibleRows: number,
  scrollOffset: number,
): { start: number; viewport: number; maxOffset: number } {
  const viewport = Math.max(1, visibleRows - SUBAGENT_VIEW_HEADER_ROWS);
  const maxOffset = Math.max(0, lineCount - viewport);
  const start = Math.min(Math.max(0, scrollOffset), maxOffset);
  return { start, viewport, maxOffset };
}

// Read-only observe view for a child agent session. Parent reactor keeps running;
// this is focus/chrome only — no message injection into the child.
export function SubAgentSessionView({
  session,
  visibleRows,
  width,
  scrollOffset,
}: SubAgentSessionViewProps): ReactNode {
  const lines = renderTranscriptLines(session.entries, subAgentTranscriptWidth(width));
  const { start, viewport } = subAgentScrollWindow(lines.length, visibleRows, scrollOffset);
  const visible = lines.slice(start, start + viewport);

  return (
    <Box flexDirection="column" width={width}>
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color={color("accent")}>
          Viewing sub-agent · esc return · x cancel
        </Text>
        <Text color={color("text")}>{formatSessionLabel(session)}</Text>
        <Text color={color("muted")} dimColor>
          status {session.status}
          {session.currentToolName !== null ? ` · ${session.currentToolName}` : ""}
          {session.error !== undefined ? ` · ${session.error}` : ""}
        </Text>
      </Box>
      {visible.length === 0 ? (
        <Text color={color("dim")} dimColor>
          {session.status === "running" ? "Waiting for activity…" : "No transcript entries."}
        </Text>
      ) : (
        visible.map((line, i) => (
          <Text
            key={`${start + i}`}
            wrap="truncate-end"
            {...(line.color !== undefined ? { color: line.color } : {})}
            {...(line.dim === true ? { dimColor: true } : {})}
          >
            {line.text}
          </Text>
        ))
      )}
    </Box>
  );
}

export type TranscriptLine = {
  text: string;
  color?: string;
  dim?: boolean;
};

export function renderTranscriptLines(
  entries: readonly SubAgentTranscriptEntry[],
  width: number,
): TranscriptLine[] {
  const out: TranscriptLine[] = [];
  for (const entry of entries) {
    switch (entry.kind) {
      case "text":
        for (const part of wrapText(entry.content, width)) {
          out.push({ text: part, color: color("text") });
        }
        break;
      case "thinking":
        for (const part of wrapText(entry.content, width)) {
          out.push({ text: part, color: color("muted"), dim: true });
        }
        break;
      case "tool": {
        const args = entry.arguments.length > 80 ? `${entry.arguments.slice(0, 77)}…` : entry.arguments;
        out.push({
          text: `▸ ${entry.name}${args.length > 0 ? ` ${args}` : ""}`,
          color: color("accent"),
        });
        break;
      }
      case "tool_result": {
        const preview = entry.content.replace(/\s+/g, " ").trim();
        const clipped = preview.length > width - 4 ? `${preview.slice(0, Math.max(0, width - 5))}…` : preview;
        out.push({
          text: `  ↳ ${clipped}`,
          color: entry.isError ? color("danger") : color("muted"),
          dim: !entry.isError,
        });
        break;
      }
      case "report":
        out.push({ text: "── report ──", color: color("accent"), dim: true });
        for (const part of wrapText(entry.content, width)) {
          out.push({ text: part, color: color("text") });
        }
        break;
    }
  }
  return out;
}

function wrapText(text: string, width: number): string[] {
  if (width <= 1) return [text];
  const lines: string[] = [];
  for (const raw of text.split("\n")) {
    if (raw.length === 0) {
      lines.push("");
      continue;
    }
    let rest = raw;
    while (rest.length > width) {
      lines.push(rest.slice(0, width));
      rest = rest.slice(width);
    }
    lines.push(rest);
  }
  return lines;
}
