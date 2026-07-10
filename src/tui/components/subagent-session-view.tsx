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
  // How many trailing lines of the transcript to show (viewport height).
  visibleRows: number;
  width: number;
};

// Read-only observe view for a child agent session. Parent reactor keeps running;
// this is focus/chrome only — no message injection into the child.
export function SubAgentSessionView({
  session,
  visibleRows,
  width,
}: SubAgentSessionViewProps): ReactNode {
  const lines = renderTranscriptLines(session.entries, Math.max(20, width - 2));
  const start = Math.max(0, lines.length - Math.max(1, visibleRows - 3));
  const visible = lines.slice(start);

  return (
    <Box flexDirection="column" width={width}>
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color={color("accent")}>
          Viewing sub-agent · esc to return
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
