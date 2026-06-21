import { Box, Text, useApp, useInput } from "ink";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";

import type { SessionSummary } from "../../session/index.js";
import { color } from "../theme.js";

export type SessionResumePickerProps = {
  sessions: SessionSummary[];
  onSelect: (session: SessionSummary) => void;
  onCancel: () => void;
};

function formatLabel(session: SessionSummary): string {
  const task = session.task.trim();
  const title = task.length > 0 ? task : "(no task title)";
  const shortId = session.sessionId.slice(0, 8);
  return `${title} · ${shortId} · ${session.status}`;
}

export function SessionResumePicker({ sessions, onSelect, onCancel }: SessionResumePickerProps): ReactNode {
  const { exit } = useApp();
  const [cursor, setCursor] = useState(0);
  const rows = useMemo(() => sessions.map((s) => ({ session: s, label: formatLabel(s) })), [sessions]);
  const clamped = rows.length > 0 ? Math.min(cursor, rows.length - 1) : 0;

  useInput((input, key) => {
    if (rows.length === 0) {
      if (key.escape) {
        onCancel();
        exit();
      }
      return;
    }
    if (key.upArrow) {
      setCursor((i) => (i > 0 ? i - 1 : rows.length - 1));
      return;
    }
    if (key.downArrow) {
      setCursor((i) => (i < rows.length - 1 ? i + 1 : 0));
      return;
    }
    if (key.return) {
      const row = rows[clamped];
      if (row !== undefined) {
        onSelect(row.session);
        exit();
      }
      return;
    }
    if (key.escape) {
      onCancel();
      exit();
    }
  });

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Text bold color={color("accent")}>
        Resume conversation
      </Text>
      <Box marginTop={1}>
        <Text color={color("muted")}>Choose a previous session in this repo</Text>
      </Box>
      {rows.length === 0 ? (
        <Box marginTop={1}>
          <Text color={color("warning")}>No saved sessions found.</Text>
        </Box>
      ) : (
        <Box marginTop={1} flexDirection="column">
          {rows.map((row, i) => {
            const active = i === clamped;
            return (
              <Box key={row.session.sessionId} flexDirection="row" gap={1}>
                <Text color={active ? color("accent") : color("muted")} bold={active}>
                  {active ? ">" : " "}
                </Text>
                <Text color={active ? color("accent") : color("text")} wrap="truncate-end">
                  {row.label}
                </Text>
              </Box>
            );
          })}
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>↑↓ navigate · Enter select · Esc cancel</Text>
      </Box>
    </Box>
  );
}