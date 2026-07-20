import { Box, Text, useApp, useInput } from "ink";
import { render } from "ink";
import { useState, type ReactNode } from "react";

import { runTUI } from "./runner.js";
import { enterAltScreen } from "../util/alt-screen.js";
import { loadConfig, type UnconfiguredConfig } from "../config/index.js";
import { loadSettings, saveGlobalSettings } from "../config/settings.js";
import type { Settings } from "../config/settings.js";
import { validateProviderConnection } from "../provider/validate-connection.js";
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

// "testing" covers the connection-check call against the entered credentials;
// "saving" covers the settings write that follows once the test succeeds.
type SubmitPhase = "testing" | "saving";

const SUBMIT_PHASE_LABEL: Record<SubmitPhase, string> = {
  testing: "Testing connection…",
  saving: "Writing settings…",
};

export type SubmitOpts = {
  // True when the operator chose to save despite a failed connection test —
  // some providers speak chat completions but not /models, so validation
  // cannot be a hard gate.
  skipValidation: boolean;
};

export type ProviderSetupPanelProps = {
  // Called when the user completes all fields. The panel shows a phase label
  // until the promise resolves, then calls exit(). `setPhase` lets onSubmit
  // report progress (e.g. move from "testing" to "saving") as it runs. If the
  // promise rejects, the error is shown inline and the user can retry or
  // correct their input; nothing is saved.
  onSubmit: (values: FormValues, setPhase: (phase: SubmitPhase) => void, opts: SubmitOpts) => Promise<void>;
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
  const [submitPhase, setSubmitPhase] = useState<SubmitPhase>("testing");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saveAnywayOffered, setSaveAnywayOffered] = useState(false);

  const currentField = FIELDS[fieldIndex] as Field;
  const val = values[currentField];

  const clearError = (): void => {
    setSubmitError(null);
    setSaveAnywayOffered(false);
  };

  const submit = (skipValidation: boolean): void => {
    setSubmitting(true);
    setSubmitPhase("testing");
    clearError();

    // Track the phase locally so the rejection handler knows whether the
    // failure happened during the connection test (retryable and bypassable)
    // or during the settings write.
    let phase: SubmitPhase = "testing";
    const setPhase = (p: SubmitPhase): void => {
      phase = p;
      setSubmitPhase(p);
    };

    onSubmit(values, setPhase, { skipValidation }).then(
      () => exit(),
      (err: unknown) => {
        setSubmitting(false);
        setSubmitError(err instanceof Error ? err.message : String(err));
        setSaveAnywayOffered(phase === "testing");
      },
    );
  };

  const advance = (): void => {
    // apiKey is optional — blank means a keyless local provider (e.g. Ollama).
    if (currentField !== "apiKey" && val.trim().length === 0) return;

    if (fieldIndex < FIELDS.length - 1) {
      setFieldIndex((i) => i + 1);
      clearError();
      return;
    }

    submit(false);
  };

  useInput((input, key) => {
    if (submitting) return;

    if (saveAnywayOffered && key.ctrl && input === "s") {
      submit(true);
      return;
    }
    if (key.return) {
      advance();
      return;
    }
    if (key.backspace || key.delete) {
      setValues((v) => ({ ...v, [currentField]: v[currentField].slice(0, -1) }));
      clearError();
      return;
    }
    if (key.escape) {
      if (fieldIndex > 0) {
        setFieldIndex((i) => i - 1);
        clearError();
      }
      return;
    }
    if (key.ctrl || key.meta || key.tab) return;
    if (input.length > 0) {
      setValues((v) => ({ ...v, [currentField]: v[currentField] + input }));
      clearError();
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

        {submitError !== null && saveAnywayOffered && (
          <Box>
            <Text color={color("muted")}>Enter retry · Ctrl+S save anyway</Text>
          </Box>
        )}

        {submitting && (
          <Box marginTop={2}>
            <Text color={color("muted")}>{SUBMIT_PHASE_LABEL[submitPhase]}</Text>
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
      onSubmit={async (values, setPhase, { skipValidation }) => {
        const { name, baseURL, apiKey, model } = values;
        const providerName = name.trim();
        const trimmedBaseURL = baseURL.trim();
        const trimmedKey = apiKey.trim();

        // Fail fast on a bad base URL/key here rather than mid-conversation
        // during the first real stream request. The operator can bypass the
        // check (Ctrl+S) for providers that don't expose /models.
        if (!skipValidation) {
          const check = await validateProviderConnection({
            baseURL: trimmedBaseURL,
            apiKey: trimmedKey.length > 0 ? trimmedKey : undefined,
          });
          if (!check.ok) {
            throw new Error(check.error);
          }
        }

        setPhase("saving");
        const newProvider = {
          baseURL: trimmedBaseURL,
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
