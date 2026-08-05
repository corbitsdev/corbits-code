import { Box, Text, useInput } from "ink";
import type { ReactNode } from "react";
import { useMemo, useState, useRef } from "react";
import { color } from "../theme.js";
import { type ProviderSubmission } from "../../config/providers.js";
import { supportedEfforts, type ReasoningEffort } from "../../provider/reasoning-effort.js";
import {
  PROVIDER_TIERS,
  type ModelRef,
  type ProviderTier,
  type TierConfig,
} from "../../config/settings.js";
import { formatTierChain, normalizeTierDefinition } from "../../config/inference-sources.js";
import type { AgentProfile } from "../../agent/profiles.js";
import { useTerminalSize } from "../hooks/use-terminal-size.js";
import {
  STACK_FORM_COLUMNS,
  fitTrailingText,
  formContentWidth,
  wrapHelpSegments,
} from "./form-reflow.js";
import {
  connectListProviders,
  firstClassPathAsProvider,
  type FirstClassProviderDef,
  type FirstClassProviderPath,
  validateGoApiKey,
} from "../../../packages/first-class-providers/src/index.js";
import { billingProductForProvider, isGoModelOnZenPath } from "../../provider/billing-product.js";
import { buildModelsFirstList, type ModelPick } from "../model-picker.js";

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
  max: "Maximum reasoning depth for the hardest problems",
  ultra: "Maximum reasoning with automatic task delegation",
};

const MODEL_DESCRIPTIONS: Record<string, string> = {
  "gpt-5.5": "Frontier model for complex coding, research, and real-world work",
  "gpt-5.6-sol": "Latest frontier agentic coding model",
  "gpt-5.6-terra": "Balanced agentic coding model for everyday work",
  "gpt-5.6-luna": "Fast and affordable agentic coding model",
  "gpt-5.4": "Strong model for everyday coding",
  "gpt-5.4-mini": "Small, fast, and cost-efficient model for simpler coding tasks",
};

export type AgentProvider = {
  name: string;
  baseURL: string;
  models: string[];
  defaultModel?: string;
  keyless?: boolean;
  codexProfile?: string;
  xaiProfile?: string;
  bifrostVirtualKey?: boolean;
  anthropic?: boolean;
  opencodeGo?: boolean;
};

export type { ProviderSubmission, ProviderSubmission as ProviderFormSubmission };

export type ProviderFormField = "name" | "baseURL" | "keyless" | "apiKey" | "models" | "defaultModel";
export type ProviderFormValues = Record<ProviderFormField, string>;
type Step =
  | "models"
  | "provider"
  | "connect"
  | "connect-path"
  | "model"
  | "effort"
  | "form"
  | "delete"
  | "tiers"
  | "tier-chain"
  | "profiles"
  | "profile-form"
  | "profile-delete";

function connectAuthLabel(auth: FirstClassProviderDef["auth"]): string {
  switch (auth) {
    case "oauth":
      return "OAuth";
    case "api-key":
      return "API key";
    case "chooser":
      return "choose path";
    case "custom":
      return "custom";
  }
}

const FORM_FIELDS: readonly ProviderFormField[] = ["name", "baseURL", "keyless", "apiKey", "models", "defaultModel"];
/** First-class connect only collects credentials; catalog seeds the rest. */
const AUTH_ONLY_FIELDS: readonly ProviderFormField[] = ["apiKey"];

const FIELD_LABELS: Record<ProviderFormField, string> = {
  name: "Provider name",
  baseURL: "Base URL",
  keyless: "Keyless",
  apiKey: "API key",
  models: "Models",
  defaultModel: "Default model",
};

const FIELD_HINTS: Record<ProviderFormField, string> = {
  name: "openai, anthropic, fireworks, ...",
  baseURL: "https://api.openai.com/v1",
  keyless: "no auth needed (e.g. Ollama)",
  apiKey: "sk-...",
  models: "model-a, model-b",
  defaultModel: "optional; must be in models",
};

// Project provider catalog entries carry credentials. The modal receives the
// editable fields it must display plus model metadata, but never receives
// provider API keys.
export function toAgentProviders(
  entries: ReadonlyArray<{
    name: string;
    baseURL: string;
    apiKey?: string;
    models: string[];
    defaultModel?: string;
    keyless?: boolean;
    codexProfile?: string;
    xaiProfile?: string;
    bifrostVirtualKey?: boolean;
    anthropic?: boolean;
    opencodeGo?: boolean;
  }>,
): AgentProvider[] {
  return entries.map((p) => ({
    name: p.name,
    baseURL: p.baseURL,
    models: p.models,
    ...(p.defaultModel !== undefined ? { defaultModel: p.defaultModel } : {}),
    ...(p.keyless === true ? { keyless: true } : {}),
    ...(p.codexProfile !== undefined ? { codexProfile: p.codexProfile } : {}),
    ...(p.xaiProfile !== undefined ? { xaiProfile: p.xaiProfile } : {}),
    ...(p.bifrostVirtualKey === true ? { bifrostVirtualKey: true } : {}),
    ...(p.anthropic === true ? { anthropic: true } : {}),
    ...(p.opencodeGo === true ? { opencodeGo: true } : {}),
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
  tiers: Partial<Record<ProviderTier, TierConfig>>;
  onSaveTier: (
    tier: ProviderTier,
    provider: string,
    model: string,
    effort?: ReasoningEffort,
  ) => void;
  onCycleTierMode?: (tier: ProviderTier) => void;
  onClearTier?: (tier: ProviderTier) => void;
  onRemoveTierLeg?: (tier: ProviderTier, legIndex: number) => void;
  onMoveTierLeg?: (tier: ProviderTier, legIndex: number, direction: -1 | 1) => void;
  profiles: AgentProfile[];
  onSaveProfile: (profile: AgentProfile) => { ok: true } | { ok: false; error: string };
  onDeleteProfile: (id: string) => void;
  usage?: string | undefined;
  /** Called when keyboard cursor lands on (or selects) a usage-supporting provider so parent can live-fetch. */
  onRequestUsage?: (kind: "codex" | "xai", profile: string, baseURL?: string) => void;
  /** Provider names (not profile names) that have expired/missing OAuth tokens. */
  unauthedProviders?: ReadonlySet<string>;
  /** Called when user presses Enter on an unauthed OAuth provider to trigger login. */
  onRequestLogin?: (kind: "codex" | "xai", profile: string) => void;
  /** Recent provider+model pairs for the models-first list (newest first). */
  recentModels?: ModelRef[];
  /** Favorite provider+model pairs. */
  favoriteModels?: ModelRef[];
  /** Toggle favorite for the highlighted model (Alt+F). */
  onToggleFavorite?: (ref: ModelRef) => void;
};

function initialFormValues(provider: AgentProvider | undefined): ProviderFormValues {
  return {
    name: provider?.name ?? "",
    baseURL: provider?.baseURL ?? "",
    keyless: provider?.keyless === true ? "yes" : "no",
    apiKey: "",
    models: provider?.models.join(", ") ?? "",
    defaultModel: provider?.defaultModel ?? provider?.models[0] ?? "",
  };
}

/** Pre-seed the Connect form for an API-key first-class provider.
 *  If the catalog already has that id, treat Connect as re-key/edit so save
 *  upserts instead of failing with "already exists".
 *
 *  OpenCode Go always seeds catalog baseURL/models/defaultModel so a prior
 *  wrong Zen URL cannot stick. Zen always seeds catalog baseURL for the same
 *  reason. Other first-class providers keep operator-customized models/URL. */
export function seedConnectForm(
  def: FirstClassProviderDef,
  existing: AgentProvider | undefined,
): {
  editingProvider: string | undefined;
  formValues: ProviderFormValues;
  connectDraft: { anthropic: boolean; opencodeGo: boolean };
} {
  const isGo = def.opencodeGo === true || def.id === "opencode-go";
  const isZen = def.id === "zen";
  const base: ProviderFormValues = {
    name: def.id,
    baseURL: def.baseURL ?? "",
    keyless: "no",
    apiKey: "",
    models: (def.models ?? []).join(", "),
    defaultModel: def.defaultModel ?? def.models?.[0] ?? "",
  };

  let formValues: ProviderFormValues = base;
  if (existing !== undefined) {
    if (isGo) {
      // Pin catalog baseURL/models/defaultModel; only keyless may carry over.
      // API key is always re-entered on Connect.
      formValues = {
        ...base,
        keyless: existing.keyless === true ? "yes" : "no",
      };
    } else if (isZen) {
      // Pin catalog baseURL; keep operator-customized models when present.
      formValues = {
        ...base,
        baseURL: base.baseURL,
        keyless: existing.keyless === true ? "yes" : "no",
        models: existing.models.length > 0 ? existing.models.join(", ") : base.models,
        defaultModel:
          existing.defaultModel ?? existing.models[0] ?? base.defaultModel,
      };
    } else {
      formValues = {
        ...base,
        baseURL: existing.baseURL.length > 0 ? existing.baseURL : base.baseURL,
        keyless: existing.keyless === true ? "yes" : "no",
        models: existing.models.length > 0 ? existing.models.join(", ") : base.models,
        defaultModel:
          existing.defaultModel ?? existing.models[0] ?? base.defaultModel,
      };
    }
  }

  return {
    editingProvider: existing?.name,
    formValues,
    connectDraft: {
      anthropic: def.anthropic === true || existing?.anthropic === true,
      opencodeGo: isGo || existing?.opencodeGo === true,
    },
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
  extras?: { anthropic?: boolean; opencodeGo?: boolean },
): { ok: true; submission: ProviderSubmission } | { ok: false; error: string } {
  const name = values.name.trim();
  const baseURL = values.baseURL.trim();
  const apiKey = values.apiKey.trim();
  const keyless = values.keyless === "yes";
  const models = parseModels(values.models);
  const defaultModel = values.defaultModel.trim();

  if (name.length === 0) return { ok: false, error: "Provider name is required" };
  if (baseURL.length === 0) return { ok: false, error: "Base URL is required" };
  if (!keyless && originalName === undefined && apiKey.length === 0) {
    return { ok: false, error: "API key is required (or enable keyless)" };
  }
  if (models.length === 0) return { ok: false, error: "At least one model is required" };
  if (defaultModel.length > 0 && !models.includes(defaultModel)) {
    return { ok: false, error: "Default model must be listed in models" };
  }
  if (extras?.opencodeGo === true && apiKey.length > 0) {
    const goKey = validateGoApiKey(apiKey);
    if (!goKey.ok) return { ok: false, error: goKey.error };
  }

  return {
    ok: true,
    submission: {
      ...(originalName !== undefined ? { originalName } : {}),
      name,
      baseURL,
      ...(keyless ? { keyless: true } : {}),
      ...(apiKey.length > 0 ? { apiKey } : {}),
      models,
      ...(defaultModel.length > 0 ? { defaultModel } : {}),
      ...(extras?.anthropic === true ? { anthropic: true } : {}),
      ...(extras?.opencodeGo === true ? { opencodeGo: true } : {}),
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
  onCycleTierMode,
  onClearTier,
  onRemoveTierLeg,
  onMoveTierLeg,
  profiles,
  onSaveProfile,
  onDeleteProfile,
  usage,
  onRequestUsage,
  unauthedProviders,
  onRequestLogin,
  recentModels = [],
  favoriteModels = [],
  onToggleFavorite,
}: AgentModalProps): ReactNode {
  const { columns } = useTerminalSize();
  const stackFields = columns < STACK_FORM_COLUMNS;
  const contentWidth = formContentWidth(columns, stackFields);
  // Label column widths used in row layout; stacked layout uses full content width for values.
  const providerLabelWidth = 16;
  const profileLabelWidth = 14;
  const valueWidth = stackFields
    ? contentWidth
    : Math.max(8, contentWidth - Math.max(providerLabelWidth, profileLabelWidth) - 1);
  const initialProvider = Math.max(
    0,
    providers.findIndex((p) => p.name === activeProvider),
  );
  const [step, setStep] = useState<Step>("models");
  const [pickIndex, setPickIndex] = useState(0);
  const [providerIndex, setProviderIndex] = useState(initialProvider);
  const [modelIndex, setModelIndex] = useState(0);
  const [pendingProvider, setPendingProvider] = useState<string | undefined>(undefined);
  const [pendingModel, setPendingModel] = useState<string | undefined>(undefined);
  const [effortIndex, setEffortIndex] = useState(0);
  const [formIndex, setFormIndex] = useState(0);
  const [formAuthOnly, setFormAuthOnly] = useState(false);
  // Where Esc returns from connect/profiles when entered from models-first vs advanced.
  const [navReturnStep, setNavReturnStep] = useState<"models" | "provider">("models");
  const [formValues, setFormValues] = useState<ProviderFormValues>(() => initialFormValues(undefined));
  const [editingProvider, setEditingProvider] = useState<string | undefined>(undefined);
  const [formError, setFormError] = useState<string | null>(null);
  const [tierIndex, setTierIndex] = useState(0);
  const [tierChainFocus, setTierChainFocus] = useState<ProviderTier | null>(null);
  const [tierLegIndex, setTierLegIndex] = useState(0);
  const [pendingTierAssign, setPendingTierAssign] = useState<ProviderTier | null>(null);
  const [profileIndex, setProfileIndex] = useState(0);
  const [profileFormIndex, setProfileFormIndex] = useState(0);
  const [profileFormValues, setProfileFormValues] = useState<ProfileFormValues>(() => initialProfileFormValues(undefined));
  const [editingProfileId, setEditingProfileId] = useState<string | undefined>(undefined);
  const [profileFormError, setProfileFormError] = useState<string | null>(null);
  const [connectIndex, setConnectIndex] = useState(0);
  const [connectPathIndex, setConnectPathIndex] = useState(0);
  const [chooserDef, setChooserDef] = useState<FirstClassProviderDef | null>(null);
  const connectDraft = useRef<{ anthropic: boolean; opencodeGo: boolean } | null>(null);

  const selectedProvider = providers[providerIndex];
  const models = selectedProvider?.models ?? [];

  const modelPicks = useMemo(
    () =>
      buildModelsFirstList({
        providers: providers.map((p) => {
          const account =
            p.codexProfile !== undefined
              ? p.codexProfile
              : p.xaiProfile !== undefined
                ? p.xaiProfile
                : undefined;
          return {
            name: p.name,
            models: p.models,
            baseURL: p.baseURL,
            ...(p.defaultModel !== undefined ? { defaultModel: p.defaultModel } : {}),
            ...(p.codexProfile !== undefined ? { codexProfile: p.codexProfile } : {}),
            ...(p.xaiProfile !== undefined ? { xaiProfile: p.xaiProfile } : {}),
            ...(p.opencodeGo === true ? { opencodeGo: true } : {}),
            ...(account !== undefined ? { account } : {}),
          };
        }),
        recent: recentModels,
        favorites: favoriteModels,
        isGoModelOnZenPath: (model, provider) =>
          isGoModelOnZenPath(model, {
            name: provider.name,
            ...(provider.baseURL !== undefined ? { baseURL: provider.baseURL } : {}),
            ...(provider.opencodeGo === true ? { opencodeGo: true } : {}),
          }),
      }),
    [providers, recentModels, favoriteModels],
  );

  const requestUsageForIndex = (idx: number): void => {
    if (onRequestUsage === undefined) return;
    const p = providers[idx];
    if (p === undefined) return;
    if (p.codexProfile !== undefined) onRequestUsage("codex", p.codexProfile, p.baseURL);
    else if (p.xaiProfile !== undefined) onRequestUsage("xai", p.xaiProfile, p.baseURL);
  };
  // Real effort levels the selected model accepts, from supportedEfforts().
  // An empty array means no model is selected or the model has no reasoning capability.
  const isCodexProvider = (name: string | undefined): boolean =>
    providers.find((p) => p.name === name)?.codexProfile !== undefined;
  const efforts: ReasoningEffort[] =
    pendingModel !== undefined ? supportedEfforts(pendingModel, undefined, isCodexProvider(pendingProvider)) : [];
  const activeFormFields = formAuthOnly ? AUTH_ONLY_FIELDS : FORM_FIELDS;
  const currentField = activeFormFields[formIndex] ?? activeFormFields[0] ?? "name";

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
    connectDraft.current = null;
    setFormAuthOnly(false);
    setEditingProvider(undefined);
    setFormValues(initialFormValues(undefined));
    setFormIndex(0);
    setFormError(null);
    setStep("form");
  };

  const enterConnectStep = (): void => {
    setNavReturnStep(step === "provider" ? "provider" : "models");
    setConnectIndex(0);
    setChooserDef(null);
    setConnectPathIndex(0);
    setStep("connect");
  };

  const enterApiKeyConnectForm = (def: FirstClassProviderDef): void => {
    // Upsert: re-Connect on an existing first-class provider re-keys in place.
    const existing = providers.find((p) => p.name === def.id);
    const seed = seedConnectForm(def, existing);
    setEditingProvider(seed.editingProvider);
    setFormValues(seed.formValues);
    connectDraft.current = seed.connectDraft;
    setFormAuthOnly(true);
    setFormIndex(0); // apiKey is the only field in auth-only mode
    setFormError(null);
    setStep("form");
  };

  const enterConnectPath = (path: FirstClassProviderPath, parent: FirstClassProviderDef): void => {
    if (path.auth === "oauth") {
      if (path.oauth !== undefined && onRequestLogin !== undefined) {
        onRequestLogin(path.oauth, "default");
      }
      return;
    }
    const seeded = firstClassPathAsProvider(parent, path.id);
    if (seeded !== undefined) enterApiKeyConnectForm(seeded);
  };

  const enterConnectForm = (def: FirstClassProviderDef): void => {
    if (def.auth === "oauth") {
      if (def.oauth !== undefined && onRequestLogin !== undefined) {
        onRequestLogin(def.oauth, "default");
      }
      return;
    }
    if (def.auth === "custom") {
      enterAddForm();
      return;
    }
    if (def.auth === "chooser") {
      setChooserDef(def);
      setConnectPathIndex(0);
      setStep("connect-path");
      return;
    }
    enterApiKeyConnectForm(def);
  };

  const enterEditForm = (): void => {
    const provider = providers[providerIndex];
    if (provider === undefined) return;
    // Preserve protocol flags across edit/re-key so Go/Anthropic routing survives.
    connectDraft.current = {
      anthropic: provider.anthropic === true,
      opencodeGo: provider.opencodeGo === true,
    };
    setFormAuthOnly(false);
    setEditingProvider(provider.name);
    setFormValues(initialFormValues(provider));
    setFormIndex(0);
    setFormError(null);
    setStep("form");
  };

  const submitForm = (): void => {
    const draft = connectDraft.current;
    const result = validateProviderForm(
      formValues,
      editingProvider,
      draft !== null
        ? {
            ...(draft.anthropic ? { anthropic: true } : {}),
            ...(draft.opencodeGo ? { opencodeGo: true } : {}),
          }
        : undefined,
    );
    if (!result.ok) {
      setFormError(result.error);
      return;
    }
    const saved = onSaveProvider(result.submission);
    if (!saved.ok) {
      setFormError(saved.error);
      return;
    }
    connectDraft.current = null;
    if (pendingTierAssign !== null) {
      setStep("tiers");
    } else {
      setStep("models");
    }
  };

  const enterTierChainStep = (tier: ProviderTier): void => {
    const def = normalizeTierDefinition(tiers[tier]);
    if (def === undefined || def.order.length === 0) return;
    setTierChainFocus(tier);
    setTierLegIndex(0);
    setStep("tier-chain");
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
    if (step === "models") {
      if (key.upArrow) {
        setPickIndex((i) => (modelPicks.length === 0 ? 0 : i > 0 ? i - 1 : modelPicks.length - 1));
        return;
      }
      if (key.downArrow) {
        setPickIndex((i) => (modelPicks.length === 0 ? 0 : i < modelPicks.length - 1 ? i + 1 : 0));
        return;
      }
      if (key.return) {
        const pick = modelPicks[pickIndex];
        if (pick === undefined) return;
        const options = supportedEfforts(pick.model, undefined, isCodexProvider(pick.provider));
        if (options.length === 0) {
          onApply(pick.provider, pick.model, undefined);
          onClose();
          return;
        }
        enterEffortStep(pick.provider, pick.model);
        return;
      }
      // Alt+A connect; some terminals send meta+a
      if ((key.meta && (input === "a" || input === "A")) || (key.ctrl && input === "a")) {
        enterConnectStep();
        return;
      }
      if (input === "c") {
        enterConnectStep();
        return;
      }
      // Alt+F favorite
      if (key.meta && (input === "f" || input === "F")) {
        const pick = modelPicks[pickIndex];
        if (pick !== undefined) {
          onToggleFavorite?.({ provider: pick.provider, model: pick.model });
        }
        return;
      }
      if (input === "a") {
        // Advanced: provider drill-down for edit/delete/tiers
        setStep("provider");
        return;
      }
      if (input === "t") {
        setStep("tiers");
        return;
      }
      if (input === "p") {
        setNavReturnStep("models");
        setProfileIndex(0);
        setStep("profiles");
        return;
      }
      if (key.escape) onClose();
      return;
    }

    if (step === "provider") {
      if (key.upArrow) {
        setProviderIndex((i) => {
          const next = i > 0 ? i - 1 : providers.length - 1;
          requestUsageForIndex(next);
          return next;
        });
        return;
      }
      if (key.downArrow) {
        setProviderIndex((i) => {
          const next = i < providers.length - 1 ? i + 1 : 0;
          requestUsageForIndex(next);
          return next;
        });
        return;
      }
      if (key.return) {
        const p = providers[providerIndex];
        const isUnauthed = p !== undefined && unauthedProviders?.has(p.name) === true;
        if (isUnauthed && onRequestLogin !== undefined && p !== undefined) {
          if (p.codexProfile !== undefined) onRequestLogin("codex", p.codexProfile);
          else if (p.xaiProfile !== undefined) onRequestLogin("xai", p.xaiProfile);
          return;
        }
        enterModelStep();
        return;
      }
      if (input === "a") {
        enterAddForm();
        return;
      }
      if (key.ctrl && input === "a") {
        enterConnectStep();
        return;
      }
      if (input === "c") {
        enterConnectStep();
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
        setNavReturnStep("provider");
        setProfileIndex(0);
        setStep("profiles");
        return;
      }
      if (key.escape) {
        setStep("models");
        return;
      }
      return;
    }

    if (step === "connect") {
      if (key.upArrow) {
        setConnectIndex((i) => (i > 0 ? i - 1 : connectListProviders().length - 1));
        return;
      }
      if (key.downArrow) {
        setConnectIndex((i) => (i < connectListProviders().length - 1 ? i + 1 : 0));
        return;
      }
      if (key.return) {
        const def = connectListProviders()[connectIndex];
        if (def !== undefined) enterConnectForm(def);
        return;
      }
      if (key.escape) {
        setStep(navReturnStep);
        return;
      }
      return;
    }

    if (step === "connect-path") {
      const paths = chooserDef?.paths ?? [];
      if (paths.length === 0) {
        if (key.escape) {
          setChooserDef(null);
          setStep("connect");
        }
        return;
      }
      if (key.upArrow) {
        setConnectPathIndex((i) => (i > 0 ? i - 1 : paths.length - 1));
        return;
      }
      if (key.downArrow) {
        setConnectPathIndex((i) => (i < paths.length - 1 ? i + 1 : 0));
        return;
      }
      if (key.return) {
        const path = paths[connectPathIndex];
        if (path !== undefined && chooserDef !== null) enterConnectPath(path, chooserDef);
        return;
      }
      if (key.escape) {
        setChooserDef(null);
        setStep("connect");
        return;
      }
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
        setStep(navReturnStep);
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
      if (input === "m") {
        const tier = PROVIDER_TIERS[tierIndex];
        if (tier !== undefined) onCycleTierMode?.(tier);
        return;
      }
      if (input === "e") {
        const tier = PROVIDER_TIERS[tierIndex];
        if (tier !== undefined) enterTierChainStep(tier);
        return;
      }
      if (input === "c") {
        const tier = PROVIDER_TIERS[tierIndex];
        if (tier !== undefined) onClearTier?.(tier);
        return;
      }
      if (key.escape) {
        setStep("provider");
        return;
      }
      return;
    }

    if (step === "tier-chain" && tierChainFocus !== null) {
      const def = normalizeTierDefinition(tiers[tierChainFocus]);
      const legs = def?.order ?? [];
      if (key.upArrow) {
        setTierLegIndex((i) => (i > 0 ? i - 1 : Math.max(0, legs.length - 1)));
        return;
      }
      if (key.downArrow) {
        setTierLegIndex((i) => (i < legs.length - 1 ? i + 1 : 0));
        return;
      }
      if (input === "x") {
        onRemoveTierLeg?.(tierChainFocus, tierLegIndex);
        if (legs.length <= 1) {
          setTierChainFocus(null);
          setStep("tiers");
        } else {
          setTierLegIndex((i) => Math.min(i, legs.length - 2));
        }
        return;
      }
      if (input === "u") {
        onMoveTierLeg?.(tierChainFocus, tierLegIndex, -1);
        return;
      }
      if (input === "d") {
        onMoveTierLeg?.(tierChainFocus, tierLegIndex, 1);
        return;
      }
      if (input === "m") {
        onCycleTierMode?.(tierChainFocus);
        return;
      }
      if (input === "a" || key.return) {
        enterTierModelStep(tierChainFocus);
        return;
      }
      if (key.escape) {
        setTierChainFocus(null);
        setStep("tiers");
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
        enterEffortStep(provider.name, model);
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
        if (pendingTierAssign !== null) {
          onSaveTier(pendingTierAssign, pendingProvider, pendingModel, effort);
          setPendingTierAssign(null);
          setPendingProvider(undefined);
          setPendingModel(undefined);
          setStep("tiers");
          return;
        }
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
      setFormIndex((i) => (i > 0 ? i - 1 : activeFormFields.length - 1));
      return;
    }
    if (key.downArrow || key.tab) {
      setFormIndex((i) => {
        // Skip the apiKey field when keyless is enabled — there's nothing to enter.
        if (currentField === "keyless" && formValues.keyless === "yes") {
          const next = i + 1 >= activeFormFields.length ? 0 : i + 2;
          return next >= activeFormFields.length ? 0 : next;
        }
        return i < activeFormFields.length - 1 ? i + 1 : 0;
      });
      return;
    }
    if (key.return) {
      if (formIndex < activeFormFields.length - 1) {
        setFormIndex((i) => {
          // Skip apiKey when keyless.
          if (currentField === "keyless" && formValues.keyless === "yes") {
            return Math.min(i + 2, activeFormFields.length - 1);
          }
          return i + 1;
        });
        return;
      }
      submitForm();
      return;
    }
    if (key.escape) {
      setFormAuthOnly(false);
      setStep("models");
      setFormError(null);
      setPendingTierAssign(null);
      return;
    }
    // keyless field: toggle with left/right or space, no text input.
    if (currentField === "keyless") {
      if (key.leftArrow || key.rightArrow || input === " ") {
        setFormValues((v) => ({ ...v, keyless: v.keyless === "yes" ? "no" : "yes" }));
        setFormError(null);
      }
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

const helpText = ((): string | null => {
    switch (step) {
      case "models":
        return "Up/Down · Enter use · Alt+A connect · Alt+F favorite · a advanced · t tiers · p profiles · Esc close";
      case "provider":
        return "Up/Down navigate · Enter models · c/Alt+A connect · a add custom · e edit · x remove · t tiers · p profiles · Esc back";
      case "connect":
        return "Up/Down navigate · Enter connect · Esc back";
      case "connect-path":
        return "Up/Down navigate · Enter choose path · Esc back";
      case "tiers":
        return "Up/Down navigate · Enter add · e edit chain · m mode · c clear · Esc back";
      case "tier-chain":
        return "Up/Down leg · a/Enter add · x remove · u/d reorder · m mode · Esc back";
      case "profiles":
        return "Up/Down navigate · a add · e edit · x remove · Esc back";
      case "profile-form":
        return "Up/Down fields · Left/Right for tier · Enter next/save · Esc cancel";
      case "profile-delete":
        return "y remove · n cancel · Esc back";
      case "model":
        return "Up/Down navigate · Enter effort · Esc back";
      case "effort":
        return "Up/Down navigate · Enter use now · d set as default · Esc back";
      case "form":
        return formAuthOnly
          ? "Enter save · Esc cancel"
          : "Up/Down fields · Left/Right toggle keyless · Enter next/save · Esc cancel";
      case "delete":
        return "y remove · n cancel · Esc back";
    }
  })();
  const helpLines = helpText !== null ? wrapHelpSegments(helpText.split(" · "), contentWidth) : [];
  const selectedProviderRow = providers[providerIndex];
  const showReauthHint =
    selectedProviderRow !== undefined &&
    (selectedProviderRow.codexProfile !== undefined || selectedProviderRow.xaiProfile !== undefined) &&
    unauthedProviders?.has(selectedProviderRow.name) === true;

  return (
    <Box
      flexDirection="column"
      paddingX={stackFields ? 1 : 2}
      paddingY={1}
      marginX={1}
      marginY={1}
      width={Math.max(1, columns - 2)}
    >
      <Text bold color={color("accent")}>
        Agent Configuration
      </Text>
      {usage !== undefined && (
        <Box marginTop={1} flexDirection="column">
          {usage.split("\n").map((line, i) => (
            <Text key={i} color={color("warning")}>{line}</Text>
          ))}
        </Box>
      )}
      <Box marginTop={1}>
        <Text color={color("muted")}>
          {step === "models" ? "Models" : "Provider / Model"}
        </Text>
      </Box>

      {step === "models" && (
        <Box marginTop={1} flexDirection="column">
          {modelPicks.length === 0 ? (
            <Text color={color("muted")}>
              No models yet — press Alt+A (or c) to connect a provider
            </Text>
          ) : (
            (() => {
              let lastSection: ModelPick["section"] | null = null;
              let lastProvider: string | null = null;
              return modelPicks.map((pick, i) => {
                const isCursor = i === pickIndex;
                const isActive =
                  pick.provider === activeProvider && pick.model === activeModel;
                const headers: ReactNode[] = [];
                if (pick.section !== lastSection) {
                  lastSection = pick.section;
                  lastProvider = null;
                  const title =
                    pick.section === "recent"
                      ? "Recent"
                      : pick.section === "favorites"
                        ? "Favorites"
                        : "Providers";
                  headers.push(
                    <Text key={`sec-${pick.section}-${i}`} color={color("muted")} bold>
                      {title}
                    </Text>,
                  );
                }
                if (
                  pick.section === "provider" &&
                  pick.provider !== lastProvider
                ) {
                  lastProvider = pick.provider;
                  headers.push(
                    <Text key={`prov-${pick.provider}-${i}`} color={color("muted")}>
                      {pick.providerLabel ?? pick.provider}
                    </Text>,
                  );
                }
                const meta = [
                  pick.section !== "provider" ? (pick.providerLabel ?? pick.provider) : null,
                  pick.account,
                  pick.warning,
                ]
                  .filter((x): x is string => x !== undefined && x !== null && x.length > 0)
                  .join(" · ");
                return (
                  <Box key={`${pick.section}-${pick.provider}-${pick.model}-${i}`} flexDirection="column">
                    {headers}
                    <Box flexDirection="row" gap={1}>
                      <Text color={isCursor ? color("accent") : color("muted")} bold={isCursor}>
                        {isCursor ? ">" : " "}
                      </Text>
                      <Text color={isCursor ? color("accent") : color("text")}>
                        {isActive ? "* " : "  "}
                        {pick.model}
                      </Text>
                      {meta.length > 0 && (
                        <Text color={pick.warning !== undefined ? color("warning") : color("muted")}>
                          {meta}
                        </Text>
                      )}
                    </Box>
                  </Box>
                );
              });
            })()
          )}
        </Box>
      )}

      {step === "provider" && (
        <Box marginTop={1} flexDirection="column">
          {providers.map((p, i) => {
            const isActive = p.name === activeProvider;
            const isCursor = i === providerIndex;
            const isOAuth = p.codexProfile !== undefined || p.xaiProfile !== undefined;
            const isUnauthed = isOAuth && unauthedProviders?.has(p.name) === true;
            const productHint = billingProductForProvider(p);
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
                {productHint !== undefined && (
                  <Text color={color("muted")}>[{productHint}]</Text>
                )}
                {isUnauthed && (
                  <Text color="red"> ! not authenticated</Text>
                )}
              </Box>
            );
          })}
          {showReauthHint ? (
            <Box marginTop={1}>
              <Text color="red">Enter to re-authenticate</Text>
            </Box>
          ) : null}
        </Box>
      )}

      {step === "connect" && (
        <Box marginTop={1} flexDirection="column">
          <Text color={color("muted")}>Connect a first-class provider</Text>
          {connectListProviders().map((def, i) => {
            const isCursor = i === connectIndex;
            return (
              <Box key={def.id} flexDirection="column">
                <Box flexDirection="row" gap={1}>
                  <Text color={isCursor ? color("accent") : color("muted")} bold={isCursor}>
                    {isCursor ? ">" : " "}
                  </Text>
                  <Text color={isCursor ? color("accent") : color("text")} bold={isCursor}>
                    {def.label}
                  </Text>
                  <Text color={color("muted")}>({connectAuthLabel(def.auth)})</Text>
                </Box>
                {isCursor && def.authHint !== undefined && (
                  <Box flexDirection="row" gap={1}>
                    <Text>{"  "}</Text>
                    <Text color={color("muted")}>{def.authHint}</Text>
                  </Box>
                )}
              </Box>
            );
          })}
        </Box>
      )}

      {step === "connect-path" && chooserDef !== null && (
        <Box marginTop={1} flexDirection="column">
          <Text color={color("muted")}>Connect {chooserDef.label}</Text>
          {(chooserDef.paths ?? []).map((path, i) => {
            const isCursor = i === connectPathIndex;
            return (
              <Box key={path.id} flexDirection="column">
                <Box flexDirection="row" gap={1}>
                  <Text color={isCursor ? color("accent") : color("muted")} bold={isCursor}>
                    {isCursor ? ">" : " "}
                  </Text>
                  <Text color={isCursor ? color("accent") : color("text")} bold={isCursor}>
                    {path.label}
                  </Text>
                  <Text color={color("muted")}>
                    ({path.auth === "oauth" ? "OAuth" : "API key"})
                  </Text>
                </Box>
                {isCursor && path.authHint !== undefined && (
                  <Box flexDirection="row" gap={1}>
                    <Text>{"  "}</Text>
                    <Text color={color("muted")}>{path.authHint}</Text>
                  </Box>
                )}
              </Box>
            );
          })}
        </Box>
      )}

      {step === "tier-chain" && tierChainFocus !== null && (
        <Box marginTop={1} flexDirection="column">
          <Text color={color("muted")}>
            Chain for tier: {tierChainFocus} ({formatTierChain(tiers[tierChainFocus])})
          </Text>
          {(normalizeTierDefinition(tiers[tierChainFocus])?.order ?? []).map((leg, i) => {
            const isCursor = i === tierLegIndex;
            return (
              <Box key={`${leg.provider}-${leg.model}-${i}`} flexDirection="row" gap={2}>
                <Text color={isCursor ? color("accent") : color("muted")} bold={isCursor}>
                  {isCursor ? ">" : " "}
                </Text>
                <Text color={isCursor ? color("accent") : color("text")}>
                  {leg.provider} · {leg.model}
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
            const assignmentLabel = formatTierChain(assignment);
            const rowDir = stackFields ? "column" : "row";
            return (
              <Box key={tier} flexDirection={rowDir} gap={stackFields ? 0 : 2}>
                <Box flexDirection="row" gap={1}>
                  <Text color={isCursor ? color("accent") : color("muted")} bold={isCursor}>
                    {isCursor ? ">" : " "}
                  </Text>
                  <Text color={isCursor ? color("accent") : color("text")}>{tier}</Text>
                </Box>
                <Text color={assignment !== undefined ? color("text") : color("muted")}>
                  {stackFields ? "  " : ""}
                  {fitTrailingText(assignmentLabel, stackFields ? contentWidth - 2 : Math.max(8, contentWidth - 12))}
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
            const desc = MODEL_DESCRIPTIONS[m];
            const namePart = `${isActive ? "* " : "  "}${m}`;
            const showDescInline = desc !== undefined && !stackFields && namePart.length + desc.length + 4 < contentWidth;
            return (
              <Box key={m} flexDirection="column">
                <Box flexDirection="row" gap={1}>
                  <Text color={isCursor ? color("accent") : color("muted")} bold={isCursor}>
                    {isCursor ? ">" : " "}
                  </Text>
                  <Text color={isCursor ? color("accent") : color("text")}>
                    {fitTrailingText(namePart, contentWidth - 2)}
                  </Text>
                  {showDescInline && (
                    <Text color={color("muted")}>— {desc}</Text>
                  )}
                </Box>
                {desc !== undefined && !showDescInline && (
                  <Text color={color("muted")}>
                    {"  "}
                    {fitTrailingText(desc, contentWidth - 2)}
                  </Text>
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
            const desc = EFFORT_DESCRIPTIONS[e];
            const namePart = `${isActive ? "* " : "  "}${effortLabel(e)}`;
            const showDescInline = desc !== undefined && !stackFields && namePart.length + desc.length + 4 < contentWidth;
            return (
              <Box key={e} flexDirection="column">
                <Box flexDirection="row" gap={1}>
                  <Text color={isCursor ? color("accent") : color("muted")} bold={isCursor}>
                    {isCursor ? ">" : " "}
                  </Text>
                  <Text color={isCursor ? color("accent") : color("text")}>
                    {fitTrailingText(namePart, contentWidth - 2)}
                  </Text>
                  {showDescInline && (
                    <Text color={color("muted")}>— {desc}</Text>
                  )}
                </Box>
                {desc !== undefined && !showDescInline && (
                  <Text color={color("muted")}>
                    {"  "}
                    {fitTrailingText(desc, contentWidth - 2)}
                  </Text>
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
            {formAuthOnly
              ? editingProvider === undefined
                ? "Connect provider"
                : `Connect ${editingProvider}`
              : editingProvider === undefined
                ? "Add provider"
                : `Edit provider ${editingProvider}`}
          </Text>
          {formAuthOnly && formValues.baseURL.length > 0 && (
            <Text color={color("muted")}>{formValues.baseURL}</Text>
          )}
          {activeFormFields.map((field, i) => {
            const isCursor = i === formIndex;
            const value = formValues[field];
            const isKeyless = formValues.keyless === "yes";
// gap only between label and value — never between value and caret,
            // or the caret sits after a phantom space the user did not type.
            const showCaret =
              isCursor &&
              field !== "keyless" &&
              !(field === "apiKey" && isKeyless);
            const rawDisplay =
              field === "keyless"
                ? null
                : field === "apiKey" && isKeyless
                  ? "(disabled — keyless provider)"
                  : value.length > 0
                    ? maskInput(field, value)
                    : field === "apiKey" && editingProvider !== undefined
                      ? "leave blank to keep existing"
                      : FIELD_HINTS[field];
            // Reserve one cell for the caret so long values do not push it off-screen.
            const fitted =
              rawDisplay === null
                ? null
                : fitTrailingText(rawDisplay, showCaret ? Math.max(1, valueWidth - 1) : valueWidth);
            return (
              <Box
                key={field}
                flexDirection={stackFields ? "column" : "row"}
                gap={stackFields ? 0 : 1}
                marginBottom={stackFields ? 1 : 0}
              >
                <Box width={stackFields ? undefined : providerLabelWidth} flexShrink={0}>
                  <Text color={isCursor ? color("accent") : color("muted")} bold={isCursor}>
                    {FIELD_LABELS[field]}
                  </Text>
                </Box>
                <Box flexDirection="row" gap={0}>
                  {field === "keyless" ? (
                    <Text color={value === "yes" ? color("accent") : color("muted")}>
                      {isCursor ? "< " : "  "}
                      {value === "yes" ? "yes" : "no"}
                      {isCursor ? " >" : ""}
                    </Text>
                  ) : (
                    <Text
                      color={
                        field === "apiKey" && isKeyless
                          ? color("muted")
                          : value.length > 0
                            ? color("text")
                            : color("muted")
                      }
                    >
                      {fitted}
                    </Text>
                  )}
                  {showCaret && <Text color={color("accent")}>|</Text>}
                </Box>
              </Box>
            );
          })}
          {formError !== null && (
            <Box marginTop={1}>
              <Text color={color("danger")}>{fitTrailingText(formError, contentWidth)}</Text>
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
            const meta = `${p.tier !== undefined ? `[${p.tier}]` : ""}${p.description !== undefined ? ` ${p.description}` : ""}`.trim();
            return (
              <Box key={p.id} flexDirection={stackFields ? "column" : "row"} gap={stackFields ? 0 : 2}>
                <Box flexDirection="row" gap={1}>
                  <Text color={isCursor ? color("accent") : color("muted")} bold={isCursor}>
                    {isCursor ? ">" : " "}
                  </Text>
                  <Text color={isCursor ? color("accent") : color("text")}>
                    {fitTrailingText(p.id, stackFields ? contentWidth - 2 : 20)}
                  </Text>
                </Box>
                {meta.length > 0 && (
                  <Text color={color("muted")}>
                    {stackFields ? "  " : ""}
                    {fitTrailingText(meta, stackFields ? contentWidth - 2 : Math.max(8, contentWidth - 24))}
                  </Text>
                )}
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
            const showCaret = isCursor && field !== "tier";
            const raw =
              field === "tier"
                ? null
                : profileFormValues[field].length > 0
                  ? profileFormValues[field]
                  : PROFILE_FIELD_HINTS[field];
            const fitted =
              raw === null
                ? null
                : fitTrailingText(raw, showCaret ? Math.max(1, valueWidth - 1) : valueWidth);
            return (
              <Box
                key={field}
                flexDirection={stackFields ? "column" : "row"}
                gap={stackFields ? 0 : 1}
                marginBottom={stackFields ? 1 : 0}
              >
                <Box width={stackFields ? undefined : profileLabelWidth} flexShrink={0}>
                  <Text color={isCursor ? color("accent") : color("muted")} bold={isCursor}>
                    {PROFILE_FIELD_LABELS[field]}
                  </Text>
                </Box>
<Box flexDirection="row" gap={0}>
                  {field === "tier" ? (
                    <Text color={profileFormValues.tier.length > 0 ? color("text") : color("muted")}>
                      {isCursor ? "< " : "  "}
                      {profileFormValues.tier.length > 0 ? profileFormValues.tier : "none"}
                      {isCursor ? " >" : ""}
                    </Text>
                  ) : (
                    <Text
                      color={profileFormValues[field].length > 0 ? color("text") : color("muted")}
                    >
                      {fitted}
                    </Text>
                  )}
                  {showCaret && <Text color={color("accent")}>|</Text>}
                </Box>
              </Box>
            );
          })}
          {profileFormError !== null && (
            <Box marginTop={1}>
              <Text color={color("danger")}>{fitTrailingText(profileFormError, contentWidth)}</Text>
            </Box>
          )}
        </Box>
      )}

      <Box marginTop={1} flexDirection="column">
        {helpLines.map((line, i) => (
          <Text key={i} dimColor>
            {line}
          </Text>
        ))}
      </Box>
    </Box>
  );
}
