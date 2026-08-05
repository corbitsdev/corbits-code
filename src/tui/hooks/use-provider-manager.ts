import type { Agent } from "@intx/agent";
import type { InferenceSource } from "@intx/types/runtime";
import { useState } from "react";
import { providerCatalogToSettings, runtimeSettingsWithCatalog, type ProviderCatalogEntry } from "../../config/index.js";
import {
  loadSettings,
  localSettingsPath,
  saveGlobalSettings,
  saveLocalSettings,
  type LocalSettings,
  type ProviderTier,
  type Settings,
  type TierConfig,
} from "../../config/settings.js";
import {
  appendTierEntry,
  buildMainSessionSources,
  cycleTierMode,
  moveTierLeg,
  removeTierLeg,
} from "../../config/inference-sources.js";
import type { ReasoningEffort } from "../../provider/reasoning-effort.js";
import type { SubAgentProvider } from "../../subagent/index.js";
import {
  buildProviderEntry,
  defaultProviderAfterSave,
  defaultProviderAfterDelete,
  type ProviderSubmission,
} from "../../config/providers.js";

export type UseProviderManagerArgs = {
  initialProvider: string;
  initialModel: string;
  initialReasoningEffort?: ReasoningEffort;
  initialCatalog: ProviderCatalogEntry[];
  initialGlobalDefaultProvider: string | undefined;
  initialTiers?: Partial<Record<ProviderTier, TierConfig>>;
  getSessionId: () => string;
  // The original settings from disk, used to preserve non-provider fields
  // (mcpServers, workflow plugins, etc.) when saving the provider catalog back.
  initialSettings?: Settings;
  cwd: string;
  globalSettingsPath: string;
  agent: Agent & {
    setSources: (sources: InferenceSource[], defaultSource: string) => void;
  };
  onMessage: (msg: string) => void;
  // Fired whenever the active source changes (provider, model, or effort) so the
  // subagent provider can track a live /agent switch, not just the startup value.
  onSelectionChange?: (provider: SubAgentProvider) => void;
  // Fired when the live catalog or tier map changes so task(tier=…) can resolve
  // OAuth providers and mid-session tier edits without a restart.
  onRuntimeResolutionChange?: (args: {
    catalog: readonly ProviderCatalogEntry[];
    settings: Settings;
  }) => void;
};

export type ProviderManagerController = {
  provider: string;
  model: string;
  reasoningEffort: ReasoningEffort | undefined;
  providerCatalog: ProviderCatalogEntry[];
  globalDefaultProvider: string | undefined;
  tiers: Partial<Record<ProviderTier, TierConfig>>;
  applySelection: (providerName: string, nextModel: string, nextEffort: ReasoningEffort | undefined) => void;
  persistSelection: (providerName: string, nextModel: string, nextEffort: ReasoningEffort | undefined) => void;
  upsertProvider: (submission: ProviderSubmission) => { ok: true } | { ok: false; error: string };
  deleteProvider: (providerName: string) => void;
  saveTierAssignment: (
    tier: ProviderTier,
    provider: string,
    model: string,
    effort?: import("../../provider/reasoning-effort.js").ReasoningEffort,
  ) => void;
  cycleTierMode: (tier: ProviderTier) => void;
  clearTier: (tier: ProviderTier) => void;
  removeTierLegAt: (tier: ProviderTier, legIndex: number) => void;
  moveTierLegAt: (tier: ProviderTier, legIndex: number, direction: -1 | 1) => void;
  // Inject (or replace) an OAuth provider in the live catalog and switch to it.
  // OAuth entries are never persisted to settings.json — their credentials live
  // in provider-specific auth stores — so this only mutates in-memory catalog
  // state, unlike upsertProvider.
  registerCodexProvider: (entry: ProviderCatalogEntry) => void;
  registerXaiProvider: (entry: ProviderCatalogEntry) => void;
  // Drop an OAuth provider from the live catalog, falling back to another
  // provider if the removed one was active.
  removeCodexProvider: (providerName: string) => void;
  removeXaiProvider: (providerName: string) => void;
};

// The selection writer omits reasoningEffort when there is no override so the
// project settings file stays minimal and a cleared override leaves no stale key.
function localSelection(
  providerName: string,
  model: string,
  effort: ReasoningEffort | undefined,
): LocalSettings {
  return {
    provider: providerName,
    model,
    ...(effort !== undefined ? { reasoningEffort: effort } : {}),
  };
}

// Runtime settings for source/tier resolution: include OAuth catalog entries so
// tiers can target Codex/xAI. Never write this object to disk.
function runtimeSettingsWithTiers(
  catalog: readonly ProviderCatalogEntry[],
  defaultProvider: string | undefined,
  baseSettings: Settings | undefined,
  nextTiers: Partial<Record<ProviderTier, TierConfig>>,
): Settings {
  return {
    ...runtimeSettingsWithCatalog(baseSettings, catalog),
    ...(defaultProvider !== undefined ? { defaultProvider } : {}),
    tiers: nextTiers,
  };
}

// Disk settings: OAuth entries are stripped so tokens never land in settings.json.
function persistSettingsWithTiers(
  catalog: readonly ProviderCatalogEntry[],
  defaultProvider: string | undefined,
  baseSettings: Settings | undefined,
  nextTiers: Partial<Record<ProviderTier, TierConfig>>,
): Settings {
  return { ...providerCatalogToSettings(catalog, defaultProvider, baseSettings), tiers: nextTiers };
}

// Prefer current on-disk global settings as the merge base so a mid-session
// /plugins write is not clobbered by the session-start initialSettings snapshot.
// Fail closed on load errors — never fall back to a stale snapshot that could
// wipe plugins or other non-provider fields.
async function loadMergeBase(
  globalSettingsPath: string,
  initialSettings: Settings | undefined,
): Promise<Settings | undefined> {
  try {
    const onDisk = await loadSettings(globalSettingsPath);
    if (onDisk !== null) return onDisk;
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err));
  }
  return initialSettings;
}

function persistGlobalSettings(
  globalSettingsPath: string,
  settings: Settings,
  onMessage: (msg: string) => void,
  successMessage: string,
  failPrefix: string,
): void {
  void saveGlobalSettings(globalSettingsPath, settings).then(
    () => onMessage(successMessage),
    (err: unknown) => {
      onMessage(`${failPrefix}: ${err instanceof Error ? err.message : String(err)}`);
    },
  );
}

// Shared disk-first persist path for catalog and tier writes. Loads a fresh
// merge base, builds settings, optionally mutates in-memory state, then saves.
// Fire-and-forget: callers `void` the promise so UI stays non-blocking.
async function persistWithMergeBase(args: {
  globalSettingsPath: string;
  initialSettings: Settings | undefined;
  buildSettings: (base: Settings | undefined) => Settings;
  onMessage: (msg: string) => void;
  successMessage: string;
  failPrefix: string;
  /** Runs only after load+build succeed, before the disk write. */
  onBeforeSave?: () => void;
}): Promise<void> {
  let base: Settings | undefined;
  try {
    base = await loadMergeBase(args.globalSettingsPath, args.initialSettings);
  } catch (err) {
    args.onMessage(`${args.failPrefix}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  let settings: Settings;
  try {
    settings = args.buildSettings(base);
  } catch (err) {
    args.onMessage(`${args.failPrefix}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  args.onBeforeSave?.();
  persistGlobalSettings(
    args.globalSettingsPath,
    settings,
    args.onMessage,
    args.successMessage,
    args.failPrefix,
  );
}

export function useProviderManager({
  initialProvider,
  initialModel,
  initialReasoningEffort,
  initialCatalog,
  initialGlobalDefaultProvider,
  initialTiers,
  initialSettings,
  cwd,
  globalSettingsPath,
  getSessionId,
  agent,
  onMessage,
  onSelectionChange,
  onRuntimeResolutionChange,
}: UseProviderManagerArgs): ProviderManagerController {
  const [provider, setProvider] = useState<string>(initialProvider);
  const [model, setModel] = useState<string>(initialModel);
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort | undefined>(initialReasoningEffort);
  const [providerCatalog, setProviderCatalog] = useState<ProviderCatalogEntry[]>(initialCatalog);
  const [globalDefaultProvider, setGlobalDefaultProvider] = useState<string | undefined>(initialGlobalDefaultProvider);
  const [tiers, setTiers] = useState<Partial<Record<ProviderTier, TierConfig>>>(initialTiers ?? {});

  const publishRuntimeResolution = (
    catalog: readonly ProviderCatalogEntry[],
    tierState: Partial<Record<ProviderTier, TierConfig>>,
    defaultProvider: string | undefined = globalDefaultProvider,
  ): void => {
    onRuntimeResolutionChange?.({
      catalog,
      settings: runtimeSettingsWithTiers(catalog, defaultProvider, initialSettings, tierState),
    });
  };

  const syncMainSessionSources = (args: {
    catalog: readonly ProviderCatalogEntry[];
    activeProvider: string;
    activeModel: string;
    effort: ReasoningEffort | undefined;
    tierState: Partial<Record<ProviderTier, TierConfig>>;
  }): void => {
    const settings = runtimeSettingsWithTiers(args.catalog, globalDefaultProvider, initialSettings, args.tierState);
    const bundle = buildMainSessionSources({
      settings,
      catalog: args.catalog,
      activeProvider: args.activeProvider,
      activeModel: args.activeModel,
      ...(args.effort !== undefined ? { reasoningEffort: args.effort } : {}),
      sessionId: getSessionId(),
    });
    agent.setSources(bundle.sources, bundle.defaultSource);
  };

  const pushLiveSources = (nextTiers: Partial<Record<ProviderTier, TierConfig>>): void => {
    syncMainSessionSources({
      catalog: providerCatalog,
      activeProvider: provider,
      activeModel: model,
      effort: reasoningEffort,
      tierState: nextTiers,
    });
  };

  const applyCatalogSelection = (
    catalog: readonly ProviderCatalogEntry[],
    providerName: string,
    nextModel: string,
    nextEffort: ReasoningEffort | undefined,
  ): boolean => {
    const entry = catalog.find((p) => p.name === providerName);
    if (entry === undefined) {
      onMessage(`Provider "${providerName}" is no longer configured`);
      return false;
    }
    syncMainSessionSources({
      catalog,
      activeProvider: providerName,
      activeModel: nextModel,
      effort: nextEffort,
      tierState: tiers,
    });
    onSelectionChange?.({
      providerName,
      baseURL: entry.baseURL,
      ...(entry.apiKey !== undefined ? { apiKey: entry.apiKey } : {}),
      ...(entry.keyless === true ? { keyless: true } : {}),
      ...(entry.bifrostVirtualKey === true ? { bifrostVirtualKey: true } : {}),
      model: nextModel,
      ...(nextEffort !== undefined ? { reasoningEffort: nextEffort } : {}),
    });
    setProvider(providerName);
    setModel(nextModel);
    setReasoningEffort(nextEffort);
    return true;
  };

  const applySelection = (
    providerName: string,
    nextModel: string,
    nextEffort: ReasoningEffort | undefined,
  ): void => {
    if (applyCatalogSelection(providerCatalog, providerName, nextModel, nextEffort)) {
      onMessage(`Now using ${providerName} · ${nextModel}`);
    }
  };

  const persistLocalSelection = (providerName: string, nextModel: string): void => {
    void saveLocalSettings(localSettingsPath(cwd), localSelection(providerName, nextModel, reasoningEffort)).catch(
      (err: unknown) => {
        onMessage(
          `Provider saved, but saving project selection failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      },
    );
  };

  const persistSelection = (
    providerName: string,
    nextModel: string,
    nextEffort: ReasoningEffort | undefined,
  ): void => {
    applySelection(providerName, nextModel, nextEffort);
    void saveLocalSettings(localSettingsPath(cwd), localSelection(providerName, nextModel, nextEffort)).catch(
      (err: unknown) => {
        onMessage(
          `Switched, but saving default failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      },
    );
  };

  const switchActiveAfterCatalogChange = (
    catalog: ProviderCatalogEntry[],
    removedName: string,
    emptyMessage: string,
  ): void => {
    if (removedName !== provider) return;
    const fallback = catalog.find((p) => p.name === provider) ?? catalog[0];
    const fallbackModel = fallback?.defaultModel ?? fallback?.models[0];
    if (fallback === undefined || fallbackModel === undefined) {
      onMessage(emptyMessage);
      return;
    }
    if (applyCatalogSelection(catalog, fallback.name, fallbackModel, reasoningEffort)) {
      persistLocalSelection(fallback.name, fallbackModel);
    }
  };

  const persistProviderCatalog = (
    catalog: ProviderCatalogEntry[],
    defaultProvider: string | undefined,
    successMessage: string,
  ): void => {
    // Disk-first merge base: mid-session /plugins writes must survive a later
    // provider save. Fail closed if settings cannot be re-read. Catalog state
    // only updates after load+build succeed so a failed re-read never leaves
    // the UI ahead of disk.
    void persistWithMergeBase({
      globalSettingsPath,
      initialSettings,
      buildSettings: (base) => persistSettingsWithTiers(catalog, defaultProvider, base, tiers),
      onMessage,
      successMessage,
      failPrefix: "Provider settings changed locally, but saving failed",
      onBeforeSave: () => {
        setProviderCatalog(catalog);
        setGlobalDefaultProvider(defaultProvider);
        publishRuntimeResolution(catalog, tiers, defaultProvider);
      },
    });
  };

  const upsertProvider = (submission: ProviderSubmission): { ok: true } | { ok: false; error: string } => {
    const result = buildProviderEntry(submission, providerCatalog);
    if (!result.ok) {
      onMessage(result.error);
      return result;
    }
    const { entry, catalog, selectedModel } = result;
    const nextDefaultProvider = defaultProviderAfterSave(submission, catalog, globalDefaultProvider);
    applyCatalogSelection(catalog, entry.name, selectedModel, reasoningEffort);
    persistLocalSelection(entry.name, selectedModel);
    persistProviderCatalog(catalog, nextDefaultProvider, `Saved provider ${entry.name}`);
    return { ok: true };
  };

  const deleteProvider = (providerName: string): void => {
    if (providerCatalog.length <= 1) {
      onMessage("Cannot remove the last provider");
      return;
    }
    const catalog = providerCatalog.filter((p) => p.name !== providerName);
    const fallback = catalog.find((p) => p.name === provider) ?? catalog[0];
    if (fallback === undefined) {
      onMessage("Cannot remove provider because no fallback provider is configured");
      return;
    }
    switchActiveAfterCatalogChange(
      catalog,
      providerName,
      "Cannot remove provider because no fallback provider is configured",
    );
    persistProviderCatalog(
      catalog,
      defaultProviderAfterDelete(providerName, fallback.name, catalog, globalDefaultProvider),
      `Removed provider ${providerName}`,
    );
  };

  const persistTierState = (
    nextTiers: Partial<Record<ProviderTier, TierConfig>>,
    successMessage: string,
    failPrefix: string,
  ): void => {
    // Tiers update optimistically so the modal reflects the edit immediately;
    // disk write is best-effort via the shared merge-base path.
    setTiers(nextTiers);
    pushLiveSources(nextTiers);
    publishRuntimeResolution(providerCatalog, nextTiers);
    void persistWithMergeBase({
      globalSettingsPath,
      initialSettings,
      buildSettings: (base) =>
        persistSettingsWithTiers(providerCatalog, globalDefaultProvider, base, nextTiers),
      onMessage,
      successMessage,
      failPrefix,
    });
  };

  const saveTierAssignment = (
    tier: ProviderTier,
    tierProvider: string,
    tierModel: string,
    effort?: import("../../provider/reasoning-effort.js").ReasoningEffort,
  ): void => {
    const entry: import("../../config/settings.js").TierProviderRef = {
      provider: tierProvider,
      model: tierModel,
      ...(effort !== undefined ? { reasoningEffort: effort } : {}),
    };
    const nextDef = appendTierEntry(tiers[tier], entry);
    const effortLabel = effort !== undefined ? ` · ${effort}` : "";
    persistTierState(
      { ...tiers, [tier]: nextDef },
      `Saved tier ${tier}: ${tierProvider} · ${tierModel}${effortLabel} (chain length ${nextDef.order.length})`,
      "Tier assignment saved locally, but persisting failed",
    );
  };

  const clearTierFor = (tier: ProviderTier): void => {
    const nextTiers = { ...tiers };
    delete nextTiers[tier];
    persistTierState(nextTiers, `Cleared tier ${tier}`, "Tier cleared locally, but persisting failed");
  };

  const removeTierLegAt = (tier: ProviderTier, legIndex: number): void => {
    const nextDef = removeTierLeg(tiers[tier], legIndex);
    const nextTiers = { ...tiers };
    if (nextDef === undefined) delete nextTiers[tier];
    else nextTiers[tier] = nextDef;
    persistTierState(nextTiers, `Removed leg ${legIndex + 1} from tier ${tier}`, "Tier leg removed locally, but persisting failed");
  };

  const moveTierLegAt = (tier: ProviderTier, legIndex: number, direction: -1 | 1): void => {
    const nextDef = moveTierLeg(tiers[tier], legIndex, direction);
    if (nextDef === undefined) return;
    const nextTiers = { ...tiers, [tier]: nextDef };
    persistTierState(nextTiers, `Reordered tier ${tier} chain`, "Tier reorder saved locally, but persisting failed");
  };

  const cycleTierModeFor = (tier: ProviderTier): void => {
    const nextDef = cycleTierMode(tiers[tier]);
    const nextTiers = { ...tiers, [tier]: nextDef };
    persistTierState(nextTiers, `Tier ${tier} mode: ${nextDef.mode}`, "Tier mode updated locally, but persisting failed");
  };

  const registerOAuthProvider = (entry: ProviderCatalogEntry, label: string): void => {
    const targetModel = entry.defaultModel ?? entry.models[0];
    if (targetModel === undefined) {
      onMessage(`${label} profile ${entry.name} has no model to select`);
      return;
    }
    const catalog = providerCatalog.filter((p) => p.name !== entry.name).concat(entry);
    setProviderCatalog(catalog);
    publishRuntimeResolution(catalog, tiers);
    if (applyCatalogSelection(catalog, entry.name, targetModel, reasoningEffort)) {
      persistLocalSelection(entry.name, targetModel);
      onMessage(`Now using ${entry.name} · ${targetModel}`);
    }
  };

  const removeOAuthProvider = (providerName: string, label: string): void => {
    const catalog = providerCatalog.filter((p) => p.name !== providerName);
    setProviderCatalog(catalog);
    publishRuntimeResolution(catalog, tiers);
    switchActiveAfterCatalogChange(

      catalog,
      providerName,
      `Removed the active ${label} profile but no other provider is configured`,
    );
  };

  const registerCodexProvider = (entry: ProviderCatalogEntry): void => registerOAuthProvider(entry, "Codex");
  const registerXaiProvider = (entry: ProviderCatalogEntry): void => registerOAuthProvider(entry, "xAI");
  const removeCodexProvider = (providerName: string): void => removeOAuthProvider(providerName, "Codex");
  const removeXaiProvider = (providerName: string): void => removeOAuthProvider(providerName, "xAI");

  return {
    provider,
    model,
    reasoningEffort,
    providerCatalog,
    globalDefaultProvider,
    tiers,
    applySelection,
    persistSelection,
    upsertProvider,
    deleteProvider,
    saveTierAssignment,
    cycleTierMode: cycleTierModeFor,
    clearTier: clearTierFor,
    removeTierLegAt,
    moveTierLegAt,
    registerCodexProvider,
    registerXaiProvider,
    removeCodexProvider,
    removeXaiProvider,
  };
}
