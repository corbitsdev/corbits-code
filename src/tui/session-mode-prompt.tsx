import { Box, Text, useApp, useInput } from "ink";
import { render } from "ink";
import { useState, type ReactNode } from "react";

import {
  loadSettings,
  saveGlobalSettings,
  type Settings,
} from "../config/settings.js";
import type { SessionMode } from "../config/session-mode.js";
import { enterAltScreen } from "../util/alt-screen.js";
import { color } from "./theme.js";
import { useTerminalSize } from "./hooks/use-terminal-size.js";

const OPTIONS: { mode: SessionMode; title: string; description: string }[] = [
  {
    mode: "single",
    title: "Single agent",
    description:
      "You chat with one agent that edits, runs commands, and answers directly. Sub-agents are off — best for focused fixes and reviews.",
  },
  {
    mode: "orchestrator",
    title: "Orchestrator",
    description:
      "The top-level agent delegates work via task, manages parallel workers, and synthesizes reports. Best for large backlogs and fleet-style execution.",
  },
];

type SessionModePanelProps = {
  onSubmit: (mode: SessionMode) => Promise<void>;
};

function SessionModePanel({ onSubmit }: SessionModePanelProps): ReactNode {
  const { rows } = useTerminalSize();
  const { exit } = useApp();
  const [index, setIndex] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useInput((_input, key) => {
    if (submitting) return;
    if (key.upArrow) {
      setIndex((i) => (i > 0 ? i - 1 : OPTIONS.length - 1));
      setSubmitError(null);
      return;
    }
    if (key.downArrow) {
      setIndex((i) => (i < OPTIONS.length - 1 ? i + 1 : 0));
      setSubmitError(null);
      return;
    }
    if (key.return) {
      const choice = OPTIONS[index];
      if (choice === undefined) return;
      setSubmitting(true);
      setSubmitError(null);
      onSubmit(choice.mode).then(
        () => exit(),
        (err: unknown) => {
          setSubmitting(false);
          setSubmitError(err instanceof Error ? err.message : String(err));
        },
      );
    }
  });

  return (
    <Box flexDirection="column" height={rows}>
      <Box
        flexShrink={0}
        paddingX={2}
        paddingY={1}
        borderStyle="single"
        borderColor={color("muted")}
        borderTop={false}
        borderLeft={false}
        borderRight={false}
      >
        <Text bold color={color("brand")}>
          Intercode
        </Text>
        <Text color={color("muted")}> · </Text>
        <Text color={color("muted")}>Session mode</Text>
      </Box>

      <Box flexGrow={1} flexDirection="column" paddingX={4} paddingY={2}>
        <Box marginBottom={2}>
          <Text color={color("text")}>
            Choose how the primary session behaves. You can change this later in Settings or in
            ~/.intercode/settings.json (sessionMode).
          </Text>
        </Box>

        {OPTIONS.map((opt, i) => {
          const active = i === index;
          return (
            <Box key={opt.mode} flexDirection="column" marginBottom={1}>
              <Text bold={active} color={active ? color("accent") : color("text")}>
                {active ? "› " : "  "}
                {opt.title}
              </Text>
              <Text color={color("muted")} wrap="wrap">
                {"    "}
                {opt.description}
              </Text>
            </Box>
          );
        })}

        {submitError !== null && (
          <Box marginTop={2}>
            <Text color={color("danger")}>{submitError}</Text>
          </Box>
        )}

        {submitting && (
          <Box marginTop={2}>
            <Text color={color("muted")}>Saving…</Text>
          </Box>
        )}
      </Box>

      <Box
        flexShrink={0}
        paddingX={2}
        paddingY={1}
        borderStyle="single"
        borderColor={color("muted")}
        borderBottom={false}
        borderLeft={false}
        borderRight={false}
      >
        <Text dimColor>
          ↑↓ select · Enter save · Ctrl+C orchestrator this session only (not saved)
        </Text>
      </Box>
    </Box>
  );
}

export async function promptSessionModeIfUnset(
  globalSettingsPath: string,
): Promise<SessionMode | undefined> {
  const existing = await loadSettings(globalSettingsPath);
  if (existing?.sessionMode !== undefined) return existing.sessionMode;

  const exitAltScreen = enterAltScreen();
  let chosen: SessionMode | undefined;

  try {
    const { waitUntilExit } = render(
      <SessionModePanel
        onSubmit={async (mode) => {
          const base: Settings = existing ?? { providers: {} };
          await saveGlobalSettings(globalSettingsPath, { ...base, sessionMode: mode });
          chosen = mode;
        }}
      />,
      { exitOnCtrlC: true },
    );
    await waitUntilExit();
  } finally {
    exitAltScreen();
  }

  return chosen;
}