import { Box, Text, useInput } from "ink";
import type { ReactNode } from "react";
import { useState } from "react";
import { color } from "../theme.js";
import { type ProviderSubmission } from "../../provider-catalog.js";

export type AgentProvider = {
  name: string;
  baseURL: string;
  models: string[];
  defaultModel?: string;
};

export type { ProviderSubmission, ProviderSubmission as ProviderFormSubmission };

export type ProviderFormField = "name" | "baseURL" | "apiKey" | "models" | "defaultModel";
export type ProviderFormValues = Record<ProviderFormField, string>;
type Step = "provider" | "model" | "form" | "delete";

const FORM_FIELDS: readonly ProviderFormField[] = ["name", "baseURL", "apiKey", "models", "defaultModel"];

const FIELD_LABELS: Record<ProviderFormField, string> = {
  name: "Provider name",
  baseURL: "Base URL",
  apiKey: "API key",
  models: "Models",
  defaultModel: "Default model",
};

const FIELD_HINTS: Record<ProviderFormField, string> = {
  name: "openai, anthropic, fireworks, ...",
  baseURL: "https://api.openai.com/v1",
  apiKey: "sk-...",
  models: "model-a, model-b",
  defaultModel: "optional; must be in models",
};

// Project provider catalog entries carry credentials. The modal receives the
// editable fields it must display plus model metadata, but never receives
// provider API keys.
export function toAgentProviders(
  entries: ReadonlyArray<{ name: string; baseURL: string; apiKey?: string; models: string[]; defaultModel?: string }>,
): AgentProvider[] {
  return entries.map((p) => ({
    name: p.name,
    baseURL: p.baseURL,
    models: p.models,
    ...(p.defaultModel !== undefined ? { defaultModel: p.defaultModel } : {}),
  }));
}

export type AgentModalProps = {
  providers: AgentProvider[];
  activeProvider: string;
  activeModel: string;
  onApply: (provider: string, model: string) => void;
  onPersistDefault: (provider: string, model: string) => void;
  onSaveProvider: (provider: ProviderSubmission) => { ok: true } | { ok: false; error: string };
  onDeleteProvider: (provider: string) => void;
  onClose: () => void;
};

function initialFormValues(provider: AgentProvider | undefined): ProviderFormValues {
  return {
    name: provider?.name ?? "",
    baseURL: provider?.baseURL ?? "",
    apiKey: "",
    models: provider?.models.join(", ") ?? "",
    defaultModel: provider?.defaultModel ?? provider?.models[0] ?? "",
  };
}

function parseModels(raw: string): string[] {
  return raw
    .split(",")
    .map((model) => model.trim())
    .filter((model) => model.length > 0);
}

export function validateProviderForm(
  values: ProviderFormValues,
  originalName: string | undefined,
): { ok: true; submission: ProviderSubmission } | { ok: false; error: string } {
  const name = values.name.trim();
  const baseURL = values.baseURL.trim();
  const apiKey = values.apiKey.trim();
  const models = parseModels(values.models);
  const defaultModel = values.defaultModel.trim();

  if (name.length === 0) return { ok: false, error: "Provider name is required" };
  if (baseURL.length === 0) return { ok: false, error: "Base URL is required" };
  if (originalName === undefined && apiKey.length === 0) {
    return { ok: false, error: "API key is required" };
  }
  if (models.length === 0) return { ok: false, error: "At least one model is required" };
  if (defaultModel.length > 0 && !models.includes(defaultModel)) {
    return { ok: false, error: "Default model must be listed in models" };
  }

  return {
    ok: true,
    submission: {
      ...(originalName !== undefined ? { originalName } : {}),
      name,
      baseURL,
      ...(apiKey.length > 0 ? { apiKey } : {}),
      models,
      ...(defaultModel.length > 0 ? { defaultModel } : {}),
    },
  };
}

function maskInput(field: ProviderFormField, value: string): string {
  return field === "apiKey" ? "*".repeat(Math.min(value.length, 16)) : value;
}

export function AgentModal({
  providers,
  activeProvider,
  activeModel,
  onApply,
  onPersistDefault,
  onSaveProvider,
  onDeleteProvider,
  onClose,
}: AgentModalProps): ReactNode {
  const initialProvider = Math.max(
    0,
    providers.findIndex((p) => p.name === activeProvider),
  );
  const [step, setStep] = useState<Step>("provider");
  const [providerIndex, setProviderIndex] = useState(initialProvider);
  const [modelIndex, setModelIndex] = useState(0);
  const [formIndex, setFormIndex] = useState(0);
  const [formValues, setFormValues] = useState<ProviderFormValues>(() => initialFormValues(undefined));
  const [editingProvider, setEditingProvider] = useState<string | undefined>(undefined);
  const [formError, setFormError] = useState<string | null>(null);

  const selectedProvider = providers[providerIndex];
  const models = selectedProvider?.models ?? [];
  const currentField = FORM_FIELDS[formIndex] ?? "name";

  const enterModelStep = (): void => {
    const provider = providers[providerIndex];
    if (provider === undefined) return;
    const active = provider.name === activeProvider ? activeModel : provider.defaultModel;
    const idx = active !== undefined ? provider.models.indexOf(active) : -1;
    setModelIndex(idx >= 0 ? idx : 0);
    setStep("model");
  };

  const enterAddForm = (): void => {
    setEditingProvider(undefined);
    setFormValues(initialFormValues(undefined));
    setFormIndex(0);
    setFormError(null);
    setStep("form");
  };

  const enterEditForm = (): void => {
    const provider = providers[providerIndex];
    if (provider === undefined) return;
    setEditingProvider(provider.name);
    setFormValues(initialFormValues(provider));
    setFormIndex(0);
    setFormError(null);
    setStep("form");
  };

  const submitForm = (): void => {
    const result = validateProviderForm(formValues, editingProvider);
    if (!result.ok) {
      setFormError(result.error);
      return;
    }
    const saved = onSaveProvider(result.submission);
    if (!saved.ok) {
      setFormError(saved.error);
      return;
    }
    setStep("provider");
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
      if (input === "a") {
        enterAddForm();
        return;
      }
      if (input === "e") {
        enterEditForm();
        return;
      }
      if (input === "x") {
        if (selectedProvider !== undefined) setStep("delete");
        return;
      }
      if (key.escape) onClose();
      return;
    }

    if (step === "model") {
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
      return;
    }

    if (step === "delete") {
      if (input === "y" && selectedProvider !== undefined) {
        onDeleteProvider(selectedProvider.name);
        setStep("provider");
        return;
      }
      if (input === "n" || key.escape) {
        setStep("provider");
      }
      return;
    }

    if (key.upArrow) {
      setFormIndex((i) => (i > 0 ? i - 1 : FORM_FIELDS.length - 1));
      return;
    }
    if (key.downArrow || key.tab) {
      setFormIndex((i) => (i < FORM_FIELDS.length - 1 ? i + 1 : 0));
      return;
    }
    if (key.return) {
      if (formIndex < FORM_FIELDS.length - 1) {
        setFormIndex((i) => i + 1);
        return;
      }
      submitForm();
      return;
    }
    if (key.escape) {
      setStep("provider");
      setFormError(null);
      return;
    }
    if (key.backspace || key.delete) {
      setFormValues((values) => ({ ...values, [currentField]: values[currentField].slice(0, -1) }));
      setFormError(null);
      return;
    }
    if (key.ctrl || key.meta || input.length === 0) return;
    setFormValues((values) => ({ ...values, [currentField]: values[currentField] + input }));
    setFormError(null);
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

      {step === "provider" && (
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
                  {isActive ? "* " : "  "}
                  {p.name}
                </Text>
                <Text color={color("muted")}>
                  ({p.models.length} model{p.models.length === 1 ? "" : "s"})
                </Text>
              </Box>
            );
          })}
        </Box>
      )}

      {step === "model" && (
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
                  {isActive ? "* " : "  "}
                  {m}
                </Text>
              </Box>
            );
          })}
        </Box>
      )}

      {step === "delete" && (
        <Box marginTop={1} flexDirection="column">
          <Text color={color("danger")}>Remove provider {selectedProvider?.name}?</Text>
          <Text color={color("muted")}>y remove · n cancel · Esc cancel</Text>
        </Box>
      )}

      {step === "form" && (
        <Box marginTop={1} flexDirection="column">
          <Text color={color("muted")}>
            {editingProvider === undefined ? "Add provider" : `Edit provider ${editingProvider}`}
          </Text>
          {FORM_FIELDS.map((field, i) => {
            const isCursor = i === formIndex;
            const value = formValues[field];
            const hint = field === "apiKey" && editingProvider !== undefined ? "leave blank to keep existing" : FIELD_HINTS[field];
            return (
              <Box key={field} flexDirection="row" gap={1}>
                <Box width={16} flexShrink={0}>
                  <Text color={isCursor ? color("accent") : color("muted")} bold={isCursor}>
                    {FIELD_LABELS[field]}
                  </Text>
                </Box>
                <Text color={value.length > 0 ? color("text") : color("muted")}>
                  {value.length > 0 ? maskInput(field, value) : hint}
                </Text>
                {isCursor && <Text color={color("accent")}>|</Text>}
              </Box>
            );
          })}
          {formError !== null && (
            <Box marginTop={1}>
              <Text color={color("danger")}>{formError}</Text>
            </Box>
          )}
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>
          {step === "provider" && "Up/Down navigate · Enter models · a add · e edit · x remove · Esc close"}
          {step === "model" && "Up/Down navigate · Enter use now · d set as default · Esc back"}
          {step === "form" && "Up/Down fields · Enter next/save · Esc cancel"}
          {step === "delete" && "y remove · n cancel · Esc back"}
        </Text>
      </Box>
    </Box>
  );
}
