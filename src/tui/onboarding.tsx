import { Box, Text, useApp, useInput } from "ink";
import { render } from "ink";
import { useState, type ReactNode } from "react";

import type { UnconfiguredConfig } from "../config.js";
import { globalSettingsPath, loadSettings, saveGlobalSettings } from "../settings.js";
import type { Settings } from "../settings.js";
import { color } from "./theme.js";

type Field = "name" | "baseURL" | "apiKey" | "model";

const FIELDS: Field[] = ["name", "baseURL", "apiKey", "model"];

const FIELD_LABELS: Record<Field, string> = {
  name: "Provider name",
  baseURL: "Base URL",
  apiKey: "API key",
  model: "Default model",
};

const FIELD_EXAMPLES: Record<Field, string> = {
  name: "e.g. openai",
  baseURL: "e.g. https://api.openai.com/v1",
  apiKey: "sk-...",
  model: "e.g. gpt-4o",
};

type FormValues = Record<Field, string>;

type OnboardingProps = {
  settingsPath: string;
  onComplete: (settings: Settings) => void;
  onError: (message: string) => void;
};

function OnboardingForm({ settingsPath, onComplete, onError }: OnboardingProps): ReactNode {
  const [fieldIndex, setFieldIndex] = useState(0);
  const [values, setValues] = useState<FormValues>({ name: "", baseURL: "", apiKey: "", model: "" });
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const currentField = FIELDS[fieldIndex] as Field;

  useInput((input, key) => {
    if (submitting) return;

    if (key.return) {
      const val = values[currentField].trim();
      if (val.length === 0) return;
      if (fieldIndex < FIELDS.length - 1) {
        setFieldIndex((i) => i + 1);
        return;
      }
      // Last field — submit.
      setSubmitting(true);
      const { name, baseURL, apiKey, model } = values;
      const settings: Settings = {
        defaultProvider: name.trim(),
        providers: {
          [name.trim()]: {
            baseURL: baseURL.trim(),
            apiKey: apiKey.trim(),
            models: [model.trim()],
            defaultModel: model.trim(),
          },
        },
      };
      saveGlobalSettings(settingsPath, settings).then(
        () => onComplete(settings),
        (err: unknown) => {
          setSubmitting(false);
          setSubmitError(err instanceof Error ? err.message : String(err));
        },
      );
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

  return (
    <Box flexDirection="column" padding={2}>
      <Box marginBottom={1}>
        <Text bold color={color("accent")}>
          interchange-code setup
        </Text>
      </Box>
      <Box marginBottom={1}>
        <Text color={color("muted")}>
          No provider configured. Enter credentials to get started.
        </Text>
      </Box>
      {FIELDS.map((field, i) => {
        const isCurrent = i === fieldIndex;
        const isDone = i < fieldIndex;
        const val = values[field];
        const display = field === "apiKey" && !isCurrent && val.length > 0
          ? "●".repeat(Math.min(val.length, 8))
          : field === "apiKey" && isCurrent
          ? val.replace(/./g, "●")
          : val;

        return (
          <Box key={field} flexDirection="column" marginBottom={isCurrent ? 1 : 0}>
            <Box flexDirection="row" gap={1}>
              <Text color={isDone ? color("muted") : isCurrent ? color("accent") : color("muted")}>
                {isDone ? "✓" : isCurrent ? "›" : " "}
              </Text>
              <Text color={isCurrent ? color("accent") : isDone ? color("text") : color("muted")} bold={isCurrent}>
                {FIELD_LABELS[field]}
              </Text>
              {isDone && (
                <Text color={color("muted")}>
                  {field === "apiKey" ? "●".repeat(Math.min(val.length, 8)) : val}
                </Text>
              )}
            </Box>
            {isCurrent && (
              <Box flexDirection="row" paddingLeft={2} marginTop={0}>
                <Text color={color("muted")} dimColor>
                  {FIELD_EXAMPLES[field]}
                  {"  "}
                </Text>
                <Text>{display}</Text>
                <Text color={color("muted")}>_</Text>
              </Box>
            )}
          </Box>
        );
      })}
      {submitting && (
        <Box marginTop={1}>
          <Text color={color("muted")}>Writing settings…</Text>
        </Box>
      )}
      {submitError !== null && (
        <Box marginTop={1}>
          <Text color="red">{submitError}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>Enter confirm · Esc back · Ctrl+C cancel</Text>
      </Box>
    </Box>
  );
}

// Wraps OnboardingForm in an Ink app that exits on completion or error, then
// calls back with the written settings so the caller can reinitialize the session.
function OnboardingApp({
  settingsPath,
  onComplete,
}: {
  settingsPath: string;
  onComplete: (settings: Settings) => void;
}): ReactNode {
  const { exit } = useApp();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  if (errorMessage !== null) {
    return (
      <Box padding={2}>
        <Text color="red">Setup failed: {errorMessage}</Text>
      </Box>
    );
  }

  return (
    <OnboardingForm
      settingsPath={settingsPath}
      onComplete={(settings) => {
        onComplete(settings);
        exit();
      }}
      onError={(message) => {
        setErrorMessage(message);
      }}
    />
  );
}

export async function runOnboarding(config: UnconfiguredConfig): Promise<number> {
  const settingsPath = config.globalSettingsPath;

  // Merge new settings into any existing ones (keeps other providers intact).
  const existing = await loadSettings(settingsPath);

  const exitAltScreen = (): void => {
    process.stdout.write("\x1b[?1049l");
  };
  process.stdout.write("\x1b[?1049h");
  process.once("exit", exitAltScreen);

  const result: { settings: Settings | null } = { settings: null };

  const { waitUntilExit } = render(
    <OnboardingApp
      settingsPath={settingsPath}
      onComplete={(s) => {
        result.settings = s;
      }}
    />,
    { exitOnCtrlC: true },
  );

  await waitUntilExit();
  process.removeListener("exit", exitAltScreen);
  exitAltScreen();

  const writtenSettings = result.settings;
  if (writtenSettings === null) {
    return 1;
  }

  // Merge written settings with any pre-existing providers so we don't clobber
  // other configured providers.
  if (existing !== null && Object.keys(existing.providers).length > 0) {
    const merged: Settings = {
      ...(writtenSettings.defaultProvider !== undefined
        ? { defaultProvider: writtenSettings.defaultProvider }
        : {}),
      providers: { ...existing.providers, ...writtenSettings.providers },
    };
    await saveGlobalSettings(settingsPath, merged);
  }

  // Dynamically import runTUI to avoid circular dependency at module load time.
  const { runTUI } = await import("./runner.js");

  // Reload config now that settings exist. Dynamic import keeps the circular
  // dep at runtime only.
  const { loadConfig } = await import("../config.js");
  const newConfig = await loadConfig(
    [
      "--cwd",
      config.cwd,
      ...(config.dangerouslySkipPermissions ? ["--dangerously-skip-permissions"] : []),
      ...(config.task.length > 0 ? [config.task] : []),
    ],
    { globalSettingsPath: settingsPath },
  );

  if (newConfig.configured === false) {
    // Should not happen — we just wrote a valid settings file.
    process.stderr.write(`interchange-code: ${newConfig.providerError}\n`);
    return 1;
  }

  return runTUI(newConfig);
}
