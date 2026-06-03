import { Box, Text, useInput } from "ink";
import type { ReactNode } from "react";
import { useState } from "react";
import { color } from "../theme.js";

// Provider identity for display only — name and models, never credentials. The
// App holds the full catalog (with keys) and builds the InferenceSource when a
// selection is applied, so secrets never enter this component or the event log.
export type AgentProvider = {
  name: string;
  models: string[];
  defaultModel?: string;
};

// Project provider catalog entries (which carry credentials) down to what the
// modal is allowed to see: name + models only. This is the boundary that keeps
// apiKey/baseURL out of the component tree and the event log.
export function toAgentProviders(
  entries: ReadonlyArray<{ name: string; models: string[]; defaultModel?: string }>,
): AgentProvider[] {
  return entries.map((p) => ({
    name: p.name,
    models: p.models,
    ...(p.defaultModel !== undefined ? { defaultModel: p.defaultModel } : {}),
  }));
}

export type AgentModalProps = {
  providers: AgentProvider[];
  activeProvider: string;
  activeModel: string;
  // Switch the running session to this provider/model immediately.
  onApply: (provider: string, model: string) => void;
  // Switch immediately AND persist it as this project's default selection.
  onPersistDefault: (provider: string, model: string) => void;
  onClose: () => void;
};

// The /agent surface. Built as a two-step selection (provider, then model) under
// a single section header so future sections (system prompt, profiles) can be
// added as sibling steps without introducing new top-level slash commands.
export function AgentModal({
  providers,
  activeProvider,
  activeModel,
  onApply,
  onPersistDefault,
  onClose,
}: AgentModalProps): ReactNode {
  const initialProvider = Math.max(
    0,
    providers.findIndex((p) => p.name === activeProvider),
  );
  const [step, setStep] = useState<"provider" | "model">("provider");
  const [providerIndex, setProviderIndex] = useState(initialProvider);
  const [modelIndex, setModelIndex] = useState(0);

  const selectedProvider = providers[providerIndex];
  const models = selectedProvider?.models ?? [];

  const enterModelStep = (): void => {
    const provider = providers[providerIndex];
    if (provider === undefined) return;
    // Land on the model currently active for this provider, else its default,
    // else the first one.
    const active = provider.name === activeProvider ? activeModel : provider.defaultModel;
    const idx = active !== undefined ? provider.models.indexOf(active) : -1;
    setModelIndex(idx >= 0 ? idx : 0);
    setStep("model");
  };

  useInput((input, key) => {
    if (step === "provider") {
      if (key.upArrow) {
        setProviderIndex((i) => (i > 0 ? i - 1 : providers.length - 1));
        return;
      }
      if (key.downArrow) {
        setProviderIndex((i) => (i < providers.length - 1 ? i + 1 : 0));
        return;
      }
      if (key.return) {
        enterModelStep();
        return;
      }
      if (key.escape) {
        onClose();
      }
      return;
    }

    // Model step.
    if (key.upArrow) {
      setModelIndex((i) => (i > 0 ? i - 1 : models.length - 1));
      return;
    }
    if (key.downArrow) {
      setModelIndex((i) => (i < models.length - 1 ? i + 1 : 0));
      return;
    }
    if (key.escape) {
      setStep("provider");
      return;
    }
    const provider = providers[providerIndex];
    const model = models[modelIndex];
    if (provider === undefined || model === undefined) return;
    if (key.return) {
      onApply(provider.name, model);
      onClose();
      return;
    }
    if (input === "d") {
      onPersistDefault(provider.name, model);
      onClose();
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={color("accent")}
      paddingX={2}
      paddingY={1}
      marginX={1}
      marginY={1}
    >
      <Text bold color={color("accent")}>
        Agent Configuration
      </Text>
      <Box marginTop={1}>
        <Text color={color("muted")}>Provider / Model</Text>
      </Box>

      {step === "provider" ? (
        <Box marginTop={1} flexDirection="column">
          {providers.map((p, i) => {
            const isActive = p.name === activeProvider;
            const isCursor = i === providerIndex;
            return (
              <Box key={p.name} flexDirection="row" gap={1}>
                <Text color={isCursor ? color("accent") : color("muted")} bold={isCursor}>
                  {isCursor ? ">" : " "}
                </Text>
                <Text color={isCursor ? color("accent") : color("text")}>
                  {isActive ? "● " : "  "}
                  {p.name}
                </Text>
                <Text color={color("muted")}>
                  ({p.models.length} model{p.models.length === 1 ? "" : "s"})
                </Text>
              </Box>
            );
          })}
        </Box>
      ) : (
        <Box marginTop={1} flexDirection="column">
          <Text color={color("muted")}>{selectedProvider?.name}</Text>
          {models.map((m, i) => {
            const isActive = selectedProvider?.name === activeProvider && m === activeModel;
            const isCursor = i === modelIndex;
            return (
              <Box key={m} flexDirection="row" gap={1}>
                <Text color={isCursor ? color("accent") : color("muted")} bold={isCursor}>
                  {isCursor ? ">" : " "}
                </Text>
                <Text color={isCursor ? color("accent") : color("text")}>
                  {isActive ? "● " : "  "}
                  {m}
                </Text>
              </Box>
            );
          })}
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>
          {step === "provider"
            ? "↑↓ navigate · Enter choose provider · Esc close"
            : "↑↓ navigate · Enter use now · d set as default · Esc back"}
        </Text>
      </Box>
    </Box>
  );
}
