import type { Agent } from "@intx/agent";
import { useState } from "react";
import { buildOpenAISource, providerCatalogToSettings, type ProviderCatalogEntry } from "../../config/index.js";
import { localSettingsPath, saveGlobalSettings, saveLocalSettings } from "../../config/settings.js";
import {
  buildProviderEntry,
  defaultProviderAfterSave,
  defaultProviderAfterDelete,
  type ProviderSubmission,
} from "../../config/providers.js";

export type UseProviderManagerArgs = {
  initialProvider: string;
  initialModel: string;
  initialCatalog: ProviderCatalogEntry[];
  initialGlobalDefaultProvider: string | undefined;
  cwd: string;
  globalSettingsPath: string;
  agent: Agent;
  onMessage: (msg: string) => void;
};

export type ProviderManagerController = {
  provider: string;
  model: string;
  providerCatalog: ProviderCatalogEntry[];
  globalDefaultProvider: string | undefined;
  applySelection: (providerName: string, nextModel: string) => void;
  persistSelection: (providerName: string, nextModel: string) => void;
  upsertProvider: (submission: ProviderSubmission) => { ok: true } | { ok: false; error: string };
  deleteProvider: (providerName: string) => void;
};

export function useProviderManager({
  initialProvider,
  initialModel,
  initialCatalog,
  initialGlobalDefaultProvider,
  cwd,
  globalSettingsPath,
  agent,
  onMessage,
}: UseProviderManagerArgs): ProviderManagerController {
  const [provider, setProvider] = useState<string>(initialProvider);
  const [model, setModel] = useState<string>(initialModel);
  const [providerCatalog, setProviderCatalog] = useState<ProviderCatalogEntry[]>(initialCatalog);
  const [globalDefaultProvider, setGlobalDefaultProvider] = useState<string | undefined>(initialGlobalDefaultProvider);

  const applyCatalogSelection = (
    catalog: readonly ProviderCatalogEntry[],
    providerName: string,
    nextModel: string,
  ): boolean => {
    const entry = catalog.find((p) => p.name === providerName);
    if (entry === undefined) {
      onMessage(`Provider "${providerName}" is no longer configured`);
      return false;
    }
    agent.setSource(buildOpenAISource({ id: entry.name, baseURL: entry.baseURL, apiKey: entry.apiKey, model: nextModel }));
    setProvider(providerName);
    setModel(nextModel);
    return true;
  };

  const applySelection = (providerName: string, nextModel: string): void => {
    if (applyCatalogSelection(providerCatalog, providerName, nextModel)) {
      onMessage(`Now using ${providerName} · ${nextModel}`);
    }
  };

  const persistLocalSelection = (providerName: string, nextModel: string): void => {
    void saveLocalSettings(localSettingsPath(cwd), { provider: providerName, model: nextModel }).catch(
      (err: unknown) => {
        onMessage(
          `Provider saved, but saving project selection failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      },
    );
  };

  const persistSelection = (providerName: string, nextModel: string): void => {
    applySelection(providerName, nextModel);
    void saveLocalSettings(localSettingsPath(cwd), { provider: providerName, model: nextModel }).catch(
      (err: unknown) => {
        onMessage(
          `Switched, but saving default failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      },
    );
  };

  const persistProviderCatalog = (
    catalog: ProviderCatalogEntry[],
    defaultProvider: string | undefined,
    successMessage: string,
  ): void => {
    let settings: ReturnType<typeof providerCatalogToSettings>;
    try {
      settings = providerCatalogToSettings(catalog, defaultProvider);
    } catch (err) {
      onMessage(
        `Provider settings changed locally, but saving failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    setProviderCatalog(catalog);
    setGlobalDefaultProvider(defaultProvider);
    void saveGlobalSettings(globalSettingsPath, settings).then(
      () => onMessage(successMessage),
      (err: unknown) => {
        onMessage(
          `Provider settings changed locally, but saving failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      },
    );
  };

  const upsertProvider = (submission: ProviderSubmission): { ok: true } | { ok: false; error: string } => {
    const result = buildProviderEntry(submission, providerCatalog);
    if (!result.ok) {
      onMessage(result.error);
      return result;
    }
    const { entry, catalog, selectedModel } = result;
    const nextDefaultProvider = defaultProviderAfterSave(submission, catalog, globalDefaultProvider);
    applyCatalogSelection(catalog, entry.name, selectedModel);
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
    const fallbackModel = fallback?.defaultModel ?? fallback?.models[0];
    if (fallback === undefined || fallbackModel === undefined) {
      onMessage("Cannot remove provider because no fallback provider is configured");
      return;
    }
    if (providerName === provider) {
      applyCatalogSelection(catalog, fallback.name, fallbackModel);
      persistLocalSelection(fallback.name, fallbackModel);
    }
    persistProviderCatalog(
      catalog,
      defaultProviderAfterDelete(providerName, fallback.name, catalog, globalDefaultProvider),
      `Removed provider ${providerName}`,
    );
  };

  return {
    provider,
    model,
    providerCatalog,
    globalDefaultProvider,
    applySelection,
    persistSelection,
    upsertProvider,
    deleteProvider,
  };
}
