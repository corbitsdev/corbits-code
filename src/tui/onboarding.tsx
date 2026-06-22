import { Box, Text, useApp, useInput } from "ink";
import { render } from "ink";
import { useState, type ReactNode } from "react";

import { runTUI } from "./runner.js";
import { enterAltScreen } from "../util/alt-screen.js";
import { loadConfig, type UnconfiguredConfig } from "../config/index.js";
import { loadSettings, saveGlobalSettings } from "../config/settings.js";
import type { Settings } from "../config/settings.js";
import { color } from "./theme.js";
import { useTerminalSize } from "./hooks/use-terminal-size.js";

type Field = "name" | "baseURL" | "apiKey" | "model";

const FIELDS: Field[] = ["name", "baseURL", "apiKey", "model"];

const FIELD_LABELS: Record<Field, string> = {
  name: "Provider name",
  baseURL: "Base URL",
  apiKey: "API key",
  model: "Default model",
};

const FIELD_HINTS: Record<Field, string> = {
  name: "openai, anthropic, fireworks, ...",
  baseURL: "https://api.openai.com/v1",
  apiKey: "sk-... (blank for keyless/local)",
  model: "gpt-4o",
};

type FormValues = Record<Field, string>;

export type ProviderSetupPanelProps = {
  // Called when the user completes all fields. The panel shows a spinner until
  // the promise resolves, then calls exit(). If it rejects, the error is shown
  // inline and the user can retry or correct their input.
  onSubmit: (values: FormValues) => Promise<void>;
};

export function ProviderSetupPanel({ onSubmit }: ProviderSetupPanelProps): ReactNode {
  const { rows } = useTerminalSize();
  const { exit } = useApp();
  const [fieldIndex, setFieldIndex] = useState(0);
  const [values, setValues] = useState<FormValues>({
    name: "",
    baseURL: "",
    apiKey: "",
    model: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const currentField = FIELDS[fieldIndex] as Field;
  const val = values[currentField];

  const advance = (): void => {
    // apiKey is optional — blank means a keyless local provider (e.g. Ollama).
    if (currentField !== "apiKey" && val.trim().length === 0) return;

    if (fieldIndex < FIELDS.length - 1) {
      setFieldIndex((i) => i + 1);
      setSubmitError(null);
      return;
    }

    setSubmitting(true);
    setSubmitError(null);
    onSubmit(values).then(
      () => exit(),
      (err: unknown) => {
        setSubmitting(false);
        setSubmitError(err instanceof Error ? err.message : String(err));
      },
    );
  };

  useInput((input, key) => {
    if (submitting) return;

    if (key.return) {
      advance();
      return;
    }
    if (key.backspace || key.delete) {
      setValues((v) => ({ ...v, [currentField]: v[currentField].slice(0, -1) }));
      setSubmitError(null);
      return;
    }
    if (key.escape) {
      if (fieldIndex > 0) {
        setFieldIndex((i) => i - 1);
        setSubmitError(null);
      }
      return;
    }
    if (key.ctrl || key.meta || key.tab) return;
    if (input.length > 0) {
      setValues((v) => ({ ...v, [currentField]: v[currentField] + input }));
      setSubmitError(null);
    }
  });

  const maskValue = (field: Field, v: string): string =>
    field === "apiKey" ? "●".repeat(Math.min(v.length, 16)) : v;

  return (
    <Box flexDirection="column" height={rows}>
      {/* Header */}
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
        <Text color={color("muted")}>Provider setup</Text>
      </Box>

      {/* Main content */}
      <Box flexGrow={1} flexDirection="column" paddingX={4} paddingY={2}>
        <Box marginBottom={2}>
          <Text color={color("text")}>
            No inference provider is configured. Add one to get started.
          </Text>
        </Box>

        <Box marginBottom={1}>
          <Text color={color("muted")} bold>
            Provider
          </Text>
        </Box>

        {FIELDS.map((field, i) => {
          const isCurrent = i === fieldIndex;
          const isDone = i < fieldIndex;
          const fieldVal = values[field];

          return (
            <Box key={field} flexDirection="column" marginBottom={1}>
              <Box flexDirection="row" gap={2}>
                <Box width={16} flexShrink={0}>
                  <Text
                    color={isCurrent ? color("accent") : color("muted")}
                    bold={isCurrent}
                    dimColor={!isCurrent && !isDone}
                  >
                    {FIELD_LABELS[field]}
                  </Text>
                </Box>
                {isDone ? (
                  <Text color={color("text")}>{maskValue(field, fieldVal)}</Text>
                ) : isCurrent ? (
                  <Box flexDirection="row">
                    <Text dimColor>{FIELD_HINTS[field]}{"  "}</Text>
                    <Text color={color("text")}>{maskValue(field, fieldVal)}</Text>
                    <Text color={color("accent")}>▌</Text>
                  </Box>
                ) : (
                  <Text dimColor>—</Text>
                )}
              </Box>
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
            <Text color={color("muted")}>Writing settings…</Text>
          </Box>
        )}
      </Box>

      {/* Footer */}
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
        <Text dimColor>Enter confirm · Esc back · Ctrl+C cancel</Text>
      </Box>
    </Box>
  );
}

export async function runOnboarding(config: UnconfiguredConfig): Promise<number> {
  const settingsPath = config.globalSettingsPath;
  const existing = await loadSettings(settingsPath);

  const exitAltScreen = enterAltScreen();

  let submitted = false;

  const { waitUntilExit } = render(
    <ProviderSetupPanel
      onSubmit={async (values) => {
        const { name, baseURL, apiKey, model } = values;
        const providerName = name.trim();
        const trimmedKey = apiKey.trim();
        const newProvider = {
          baseURL: baseURL.trim(),
          models: [model.trim()],
          defaultModel: model.trim(),
          ...(trimmedKey.length > 0
            ? { apiKey: trimmedKey }
            : { keyless: true }),
        };
        // Merge new provider with any pre-existing ones. Single write — the TUI
        // stays open (spinner) until saveGlobalSettings resolves, so the user
        // sees confirmation before the screen is cleared.
        const merged: Settings = {
          defaultProvider: providerName,
          providers:
            existing !== null && Object.keys(existing.providers).length > 0
              ? { ...existing.providers, [providerName]: newProvider }
              : { [providerName]: newProvider },
        };
        await saveGlobalSettings(settingsPath, merged);
        submitted = true;
      }}
    />,
    { exitOnCtrlC: true },
  );

  await waitUntilExit();
  exitAltScreen();

  // If the user cancelled (Ctrl+C) onSubmit was never called and settings were
  // never written. Skip launching the TUI.
  if (!submitted) {
    return 1;
  }

  const argv: string[] = ["--cwd", config.cwd];
  if (config.dangerouslySkipPermissions) argv.push("--dangerously-skip-permissions");
  if (config.force) argv.push("--force");
  if (config.task.length > 0) argv.push(config.task);

  const newConfig = await loadConfig(argv, { globalSettingsPath: settingsPath });
  return runTUI(newConfig);
}
