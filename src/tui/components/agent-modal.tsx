import { Box, Text, useInput } from "ink";
import type { ReactNode } from "react";
import { useState } from "react";
import { color } from "../theme.js";
import { type ProviderSubmission } from "../../config/providers.js";
import { supportedEfforts, type ReasoningEffort } from "../../provider/reasoning-effort.js";
import { PROVIDER_TIERS, type ProviderTier, type TierAssignment } from "../../config/settings.js";
import type { AgentProfile } from "../../agent/profiles.js";

// Effort display: undefined means "no override" (field omitted); "none" is
// OpenAI's explicit disable-reasoning value. Both read as "off".
function effortLabel(effort: ReasoningEffort | undefined): string {
  if (effort === undefined) return "Default (no override)";
  if (effort === "none") return "None (disable reasoning)";
  if (effort === "xhigh") return "Extra high";
  return effort[0]!.toUpperCase() + effort.slice(1);
}

const EFFORT_DESCRIPTIONS: Partial<Record<ReasoningEffort, string>> = {
  low: "Fast responses with lighter reasoning",
  medium: "Balances speed and reasoning depth for everyday tasks",
  high: "Greater reasoning depth for complex problems",
  xhigh: "Extra high reasoning depth for complex problems",
};

const MODEL_DESCRIPTIONS: Record<string, string> = {
  "gpt-5.5": "Frontier model for complex coding, research, and real-world work",
  "gpt-5.4": "Strong model for everyday coding",
  "gpt-5.4-mini": "Small, fast, and cost-efficient model for simpler coding tasks",
};

export type AgentProvider = {
  name: string;
  baseURL: string;
  models: string[];
  defaultModel?: string;
  codexProfile?: string;
};

export type { ProviderSubmission, ProviderSubmission as ProviderFormSubmission };

export type ProviderFormField = "name" | "baseURL" | "apiKey" | "models" | "defaultModel";
export type ProviderFormValues = Record<ProviderFormField, string>;
type Step = "provider" | "model" | "effort" | "form" | "delete" | "tiers" | "profiles" | "profile-form" | "profile-delete";

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
  entries: ReadonlyArray<{ name: string; baseURL: string; apiKey?: string; models: string[]; defaultModel?: string; codexProfile?: string }>,
): AgentProvider[] {
  return entries.map((p) => ({
    name: p.name,
    baseURL: p.baseURL,
    models: p.models,
    ...(p.defaultModel !== undefined ? { defaultModel: p.defaultModel } : {}),
    ...(p.codexProfile !== undefined ? { codexProfile: p.codexProfile } : {}),
  }));
}

export type AgentModalProps = {
  providers: AgentProvider[];
  activeProvider: string;
  activeModel: string;
  activeEffort: ReasoningEffort | undefined;
  onApply: (provider: string, model: string, effort: ReasoningEffort | undefined) => void;
  onPersistDefault: (provider: string, model: string, effort: ReasoningEffort | undefined) => void;
  onSaveProvider: (provider: ProviderSubmission) => { ok: true } | { ok: false; error: string };
  onDeleteProvider: (provider: string) => void;
  onClose: () => void;
  tiers: Partial<Record<ProviderTier, TierAssignment>>;
  onSaveTier: (tier: ProviderTier, provider: string, model: string) => void;
  profiles: AgentProfile[];
  onSaveProfile: (profile: AgentProfile) => { ok: true } | { ok: false; error: string };
  onDeleteProfile: (id: string) => void;
  codexUsage?: string | undefined;
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

type ProfileFormValues = { id: string; description: string; tier: ProviderTier | "" };

const PROFILE_TIER_OPTIONS: ReadonlyArray<ProviderTier | ""> = ["", ...PROVIDER_TIERS];

function initialProfileFormValues(profile: AgentProfile | undefined): ProfileFormValues {
  return {
    id: profile?.id ?? "",
    description: profile?.description ?? "",
    tier: profile?.tier ?? "",
  };
}

type ProfileFormField = "id" | "description" | "tier";
const PROFILE_FORM_FIELDS: readonly ProfileFormField[] = ["id", "description", "tier"];
const PROFILE_FIELD_LABELS: Record<ProfileFormField, string> = {
  id: "ID",
  description: "Description",
  tier: "Tier",
};
const PROFILE_FIELD_HINTS: Record<ProfileFormField, string> = {
  id: "greybeard, fast-thinker, ...",
  description: "optional label",
  tier: "fast / standard / clever (optional)",
};

export function AgentModal({
  providers,
  activeProvider,
  activeModel,
  activeEffort,
  onApply,
  onPersistDefault,
  onSaveProvider,
  onDeleteProvider,
  onClose,
  tiers,
  onSaveTier,
  profiles,
  onSaveProfile,
  onDeleteProfile,
  codexUsage,
}: AgentModalProps): ReactNode {
  const initialProvider = Math.max(
    0,
    providers.findIndex((p) => p.name === activeProvider),
  );
  const [step, setStep] = useState<Step>("provider");
  const [providerIndex, setProviderIndex] = useState(initialProvider);
  const [modelIndex, setModelIndex] = useState(0);
  const [pendingProvider, setPendingProvider] = useState<string | undefined>(undefined);
  const [pendingModel, setPendingModel] = useState<string | undefined>(undefined);
  const [effortIndex, setEffortIndex] = useState(0);
  const [formIndex, setFormIndex] = useState(0);
  const [formValues, setFormValues] = useState<ProviderFormValues>(() => initialFormValues(undefined));
  const [editingProvider, setEditingProvider] = useState<string | undefined>(undefined);
  const [formError, setFormError] = useState<string | null>(null);
  const [tierIndex, setTierIndex] = useState(0);
  const [pendingTierAssign, setPendingTierAssign] = useState<ProviderTier | null>(null);
  const [profileIndex, setProfileIndex] = useState(0);
  const [profileFormIndex, setProfileFormIndex] = useState(0);
  const [profileFormValues, setProfileFormValues] = useState<ProfileFormValues>(() => initialProfileFormValues(undefined));
  const [editingProfileId, setEditingProfileId] = useState<string | undefined>(undefined);
  const [profileFormError, setProfileFormError] = useState<string | null>(null);

  const selectedProvider = providers[providerIndex];
  const models = selectedProvider?.models ?? [];
  // Real effort levels the selected model accepts, from supportedEfforts().
  // An empty array means no model is selected or the model has no reasoning capability.
  const isCodexProvider = (name: string | undefined): boolean =>
    providers.find((p) => p.name === name)?.codexProfile !== undefined;
  const efforts: ReasoningEffort[] =
    pendingModel !== undefined ? supportedEfforts(pendingModel, undefined, isCodexProvider(pendingProvider)) : [];
  const currentField = FORM_FIELDS[formIndex] ?? "name";

  const enterModelStep = (): void => {
    const provider = providers[providerIndex];
    if (provider === undefined) return;
    const active = provider.name === activeProvider ? activeModel : provider.defaultModel;
    const idx = active !== undefined ? provider.models.indexOf(active) : -1;
    setModelIndex(idx >= 0 ? idx : 0);
    setStep("model");
  };

  const enterEffortStep = (providerName: string, modelName: string): void => {
    setPendingProvider(providerName);
    setPendingModel(modelName);
    const active = providerName === activeProvider && modelName === activeModel ? activeEffort : undefined;
    const options = supportedEfforts(modelName, undefined, isCodexProvider(providerName));
    const idx = active !== undefined ? options.indexOf(active) : -1;
    const fallback = options.indexOf("medium");
    setEffortIndex(idx >= 0 ? idx : fallback >= 0 ? fallback : 0);
    setStep("effort");
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
    if (pendingTierAssign !== null) {
      setStep("tiers");
    } else {
      setStep("provider");
    }
  };

  const enterTierModelStep = (tierName: ProviderTier): void => {
    setPendingTierAssign(tierName);
    const provider = providers[providerIndex];
    if (provider === undefined) return;
    const active = provider.name === activeProvider ? activeModel : provider.defaultModel;
    const idx = active !== undefined ? provider.models.indexOf(active) : -1;
    setModelIndex(idx >= 0 ? idx : 0);
    setStep("model");
  };

  const enterAddProfileForm = (): void => {
    setEditingProfileId(undefined);
    setProfileFormValues(initialProfileFormValues(undefined));
    setProfileFormIndex(0);
    setProfileFormError(null);
    setStep("profile-form");
  };

  const enterEditProfileForm = (): void => {
    const profile = profiles[profileIndex];
    if (profile === undefined) return;
    setEditingProfileId(profile.id);
    setProfileFormValues(initialProfileFormValues(profile));
    setProfileFormIndex(0);
    setProfileFormError(null);
    setStep("profile-form");
  };

  const submitProfileForm = (): void => {
    const id = profileFormValues.id.trim();
    const description = profileFormValues.description.trim();
    const tierValue = profileFormValues.tier.trim() as ProviderTier | "";
    if (id.length === 0) {
      setProfileFormError("ID is required");
      return;
    }
    if (!/^[\w-]+$/.test(id)) {
      setProfileFormError("ID must be alphanumeric with hyphens/underscores only");
      return;
    }
    const profile: AgentProfile = {
      id,
      ...(description.length > 0 ? { description } : {}),
      ...(tierValue.length > 0 ? { tier: tierValue as ProviderTier } : {}),
    };
    const result = onSaveProfile(profile);
    if (!result.ok) {
      setProfileFormError(result.error);
      return;
    }
    setStep("profiles");
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
      if (input === "t") {
        setStep("tiers");
        return;
      }
      if (input === "p") {
        setProfileIndex(0);
        setStep("profiles");
        return;
      }
      if (key.escape) onClose();
      return;
    }

    if (step === "profiles") {
      if (key.upArrow) {
        setProfileIndex((i) => (i > 0 ? i - 1 : profiles.length - 1));
        return;
      }
      if (key.downArrow) {
        setProfileIndex((i) => (i < profiles.length - 1 ? i + 1 : 0));
        return;
      }
      if (input === "a") {
        enterAddProfileForm();
        return;
      }
      if (input === "e") {
        if (profiles.length > 0) enterEditProfileForm();
        return;
      }
      if (input === "x") {
        if (profiles.length > 0) setStep("profile-delete");
        return;
      }
      if (key.escape) {
        setStep("provider");
        return;
      }
      return;
    }

    if (step === "profile-delete") {
      if (input === "y") {
        const profile = profiles[profileIndex];
        if (profile !== undefined) {
          onDeleteProfile(profile.id);
          setProfileIndex(0);
        }
        setStep("profiles");
        return;
      }
      if (input === "n" || key.escape) {
        setStep("profiles");
        return;
      }
      return;
    }

    if (step === "profile-form") {
      const currentProfileField = PROFILE_FORM_FIELDS[profileFormIndex] ?? "id";
      if (currentProfileField === "tier") {
        if (key.upArrow) {
          setProfileFormValues((v) => {
            const idx = PROFILE_TIER_OPTIONS.indexOf(v.tier);
            const next = PROFILE_TIER_OPTIONS[idx > 0 ? idx - 1 : PROFILE_TIER_OPTIONS.length - 1] ?? "";
            return { ...v, tier: next };
          });
          return;
        }
        if (key.downArrow) {
          setProfileFormValues((v) => {
            const idx = PROFILE_TIER_OPTIONS.indexOf(v.tier);
            const next = PROFILE_TIER_OPTIONS[idx < PROFILE_TIER_OPTIONS.length - 1 ? idx + 1 : 0] ?? "";
            return { ...v, tier: next };
          });
          return;
        }
      } else {
        if (key.upArrow) {
          setProfileFormIndex((i) => (i > 0 ? i - 1 : PROFILE_FORM_FIELDS.length - 1));
          return;
        }
        if (key.downArrow || key.tab) {
          setProfileFormIndex((i) => (i < PROFILE_FORM_FIELDS.length - 1 ? i + 1 : 0));
          return;
        }
      }
      if (key.return) {
        if (profileFormIndex < PROFILE_FORM_FIELDS.length - 1) {
          setProfileFormIndex((i) => i + 1);
          return;
        }
        submitProfileForm();
        return;
      }
      if (key.escape) {
        setStep("profiles");
        setProfileFormError(null);
        return;
      }
      if (currentProfileField !== "tier") {
        if (key.backspace || key.delete) {
          setProfileFormValues((v) => ({ ...v, [currentProfileField]: v[currentProfileField].slice(0, -1) }));
          setProfileFormError(null);
          return;
        }
        if (!key.ctrl && !key.meta && input.length > 0) {
          setProfileFormValues((v) => ({ ...v, [currentProfileField]: v[currentProfileField] + input }));
          setProfileFormError(null);
        }
      }
      return;
    }

    if (step === "tiers") {
      if (key.upArrow) {
        setTierIndex((i) => (i > 0 ? i - 1 : PROVIDER_TIERS.length - 1));
        return;
      }
      if (key.downArrow) {
        setTierIndex((i) => (i < PROVIDER_TIERS.length - 1 ? i + 1 : 0));
        return;
      }
      if (key.return) {
        const tier = PROVIDER_TIERS[tierIndex];
        if (tier !== undefined) {
          enterTierModelStep(tier);
        }
        return;
      }
      if (key.escape) {
        setStep("provider");
        return;
      }
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
        if (pendingTierAssign !== null) {
          setPendingTierAssign(null);
          setStep("tiers");
        } else {
          setStep("provider");
        }
        return;
      }
      const provider = providers[providerIndex];
      const model = models[modelIndex];
      if (provider === undefined || model === undefined) return;
      if (key.return) {
        if (pendingTierAssign !== null) {
          onSaveTier(pendingTierAssign, provider.name, model);
          setPendingTierAssign(null);
          setStep("tiers");
        } else {
          enterEffortStep(provider.name, model);
        }
      }
      return;
    }

    if (step === "effort") {
      if (key.upArrow) {
        setEffortIndex((i) => (i > 0 ? i - 1 : efforts.length - 1));
        return;
      }
      if (key.downArrow) {
        setEffortIndex((i) => (i < efforts.length - 1 ? i + 1 : 0));
        return;
      }
      if (key.escape) {
        setStep("model");
        return;
      }
      if (pendingProvider === undefined || pendingModel === undefined) return;
      const effort = efforts[effortIndex];
      if (key.return) {
        onApply(pendingProvider, pendingModel, effort);
        onClose();
        return;
      }
      if (input === "d") {
        onPersistDefault(pendingProvider, pendingModel, effort);
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
      setPendingTierAssign(null);
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
      {codexUsage !== undefined && (
        <Box marginTop={1} flexDirection="column">
          {codexUsage.split("\n").map((line, i) => (
            <Text key={i} color={color("warning")}>{line}</Text>
          ))}
        </Box>
      )}
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

      {step === "tiers" && (
        <Box marginTop={1} flexDirection="column">
          {PROVIDER_TIERS.map((tier, i) => {
            const assignment = tiers[tier];
            const isCursor = i === tierIndex;
            const assignmentLabel =
              assignment !== undefined
                ? `${assignment.provider} · ${assignment.model}`
                : "unset";
            return (
              <Box key={tier} flexDirection="row" gap={2}>
                <Text color={isCursor ? color("accent") : color("muted")} bold={isCursor}>
                  {isCursor ? ">" : " "}
                </Text>
                <Box width={10} flexShrink={0}>
                  <Text color={isCursor ? color("accent") : color("text")}>{tier}</Text>
                </Box>
                <Text color={assignment !== undefined ? color("text") : color("muted")}>
                  {assignmentLabel}
                </Text>
              </Box>
            );
          })}
        </Box>
      )}

      {step === "model" && (
        <Box marginTop={1} flexDirection="column">
          <Text color={color("muted")}>
            {pendingTierAssign !== null
              ? `Assign provider for tier: ${pendingTierAssign}`
              : selectedProvider?.name}
          </Text>
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
                {MODEL_DESCRIPTIONS[m] !== undefined && (
                  <Text color={color("muted")}>— {MODEL_DESCRIPTIONS[m]}</Text>
                )}
              </Box>
            );
          })}
        </Box>
      )}

      {step === "effort" && (
        <Box marginTop={1} flexDirection="column">
          <Text color={color("muted")}>
            {pendingProvider} · {pendingModel} — reasoning effort
          </Text>
          {pendingModel !== undefined && supportedEfforts(pendingModel).length === 0 && (
            <Text color={color("muted")}>(this model does not support reasoning effort)</Text>
          )}
          {efforts.map((e, i) => {
            const isActive = e === activeEffort;
            const isCursor = i === effortIndex;
            return (
              <Box key={e} flexDirection="row" gap={1}>
                <Text color={isCursor ? color("accent") : color("muted")} bold={isCursor}>
                  {isCursor ? ">" : " "}
                </Text>
                <Text color={isCursor ? color("accent") : color("text")}>
                  {isActive ? "* " : "  "}
                  {effortLabel(e)}
                </Text>
                {EFFORT_DESCRIPTIONS[e] !== undefined && (
                  <Text color={color("muted")}>— {EFFORT_DESCRIPTIONS[e]}</Text>
                )}
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

      {step === "profiles" && (
        <Box marginTop={1} flexDirection="column">
          {profiles.length === 0 && (
            <Text color={color("muted")}>(no profiles — press a to add one)</Text>
          )}
          {profiles.map((p, i) => {
            const isCursor = i === profileIndex;
            return (
              <Box key={p.id} flexDirection="row" gap={2}>
                <Text color={isCursor ? color("accent") : color("muted")} bold={isCursor}>
                  {isCursor ? ">" : " "}
                </Text>
                <Box width={20} flexShrink={0}>
                  <Text color={isCursor ? color("accent") : color("text")}>{p.id}</Text>
                </Box>
                <Text color={color("muted")}>
                  {p.tier !== undefined ? `[${p.tier}]` : ""}
                  {p.description !== undefined ? ` ${p.description}` : ""}
                </Text>
              </Box>
            );
          })}
        </Box>
      )}

      {step === "profile-delete" && (
        <Box marginTop={1} flexDirection="column">
          <Text color={color("danger")}>Remove agent profile {profiles[profileIndex]?.id}?</Text>
          <Text color={color("muted")}>y remove · n cancel · Esc cancel</Text>
        </Box>
      )}

      {step === "profile-form" && (
        <Box marginTop={1} flexDirection="column">
          <Text color={color("muted")}>
            {editingProfileId === undefined ? "Add agent profile" : `Edit profile ${editingProfileId}`}
          </Text>
          {PROFILE_FORM_FIELDS.map((field, i) => {
            const isCursor = i === profileFormIndex;
            return (
              <Box key={field} flexDirection="row" gap={1}>
                <Box width={14} flexShrink={0}>
                  <Text color={isCursor ? color("accent") : color("muted")} bold={isCursor}>
                    {PROFILE_FIELD_LABELS[field]}
                  </Text>
                </Box>
                {field === "tier" ? (
                  <Text color={profileFormValues.tier.length > 0 ? color("text") : color("muted")}>
                    {isCursor ? "< " : "  "}
                    {profileFormValues.tier.length > 0 ? profileFormValues.tier : "none"}
                    {isCursor ? " >" : ""}
                  </Text>
                ) : (
                  <>
                    <Text color={profileFormValues[field].length > 0 ? color("text") : color("muted")}>
                      {profileFormValues[field].length > 0 ? profileFormValues[field] : PROFILE_FIELD_HINTS[field]}
                    </Text>
                    {isCursor && <Text color={color("accent")}>|</Text>}
                  </>
                )}
              </Box>
            );
          })}
          {profileFormError !== null && (
            <Box marginTop={1}>
              <Text color={color("danger")}>{profileFormError}</Text>
            </Box>
          )}
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>
          {step === "provider" && "Up/Down navigate · Enter models · a add · e edit · x remove · t tiers · p profiles · Esc close"}
          {step === "tiers" && "Up/Down navigate · Enter assign · Esc back"}
          {step === "profiles" && "Up/Down navigate · a add · e edit · x remove · Esc back"}
          {step === "profile-form" && "Up/Down fields · Left/Right for tier · Enter next/save · Esc cancel"}
          {step === "profile-delete" && "y remove · n cancel · Esc back"}
          {step === "model" && "Up/Down navigate · Enter effort · Esc back"}
          {step === "effort" && "Up/Down navigate · Enter use now · d set as default · Esc back"}
          {step === "form" && "Up/Down fields · Enter next/save · Esc cancel"}
          {step === "delete" && "y remove · n cancel · Esc back"}
        </Text>
      </Box>
    </Box>
  );
}
