// Shared "reload settings, re-resolve the live provider catalog, repaint the
// model surfaces" step for the TUI runner. The Alt+A provider connect handler
// and the post-startup / post-connect OpenCode Go model prefetch each carried
// their own copy of this block; both now resolve through this module so a
// live connect and a startup prefetch cannot drift apart.

import { getLogger } from "@intx/log";

import { LOG_NAMESPACE_ROOT } from "../../branding.js";
import {
  listFavoriteModels,
  listRecentModels,
  loadSettings,
  type ResolvedProvider,
} from "../../config/settings.js";
import { refreshLiveProviderCatalog } from "../../config/index.js";
import { prefetchGoModels } from "../../provider/opencode-go-models.js";
import type { ModelCatalogProvidersInput, ModelCatalogRef } from "../model-catalog.js";
import type { RunnerState } from "./state.js";

const tuiLogger = getLogger([LOG_NAMESPACE_ROOT, "tui"]);

/** Model-surface repaint target for a refreshed catalog (host or holder). */
export type RefreshModels = (
  recentModels: readonly ModelCatalogRef[],
  favoriteModels: readonly ModelCatalogRef[],
  providers?: ModelCatalogProvidersInput,
) => void;

// Reload the on-disk settings and re-resolve the live provider catalog
// (including OAuth profiles) against the current config, then repaint the
// model surfaces. Shared by the provider connect handler and the Go-model
// prefetch so a newly authorized provider's models appear the same way in
// every path.
export async function refreshProviderCatalogAndSurfaces(
  state: RunnerState,
  refreshModels: RefreshModels,
): Promise<void> {
  const onDisk = await loadSettings(state.trueGlobalSettingsPath);
  const resolvedForCatalog: ResolvedProvider = {
    apiKey: state.config.apiKey,
    baseURL: state.config.baseURL,
    model: state.config.model,
    providerName: state.config.providerName,
    ...(state.config.keyless !== undefined ? { keyless: state.config.keyless } : {}),
  };
  const providers = await refreshLiveProviderCatalog(onDisk, resolvedForCatalog);
  state.config = {
    ...state.config,
    providers,
    ...(onDisk !== null ? { settings: onDisk } : {}),
  };
  refreshModels(
    listRecentModels(state.config.settings ?? { providers: {} }),
    listFavoriteModels(state.config.settings ?? { providers: {} }),
    providers,
  );
}

// Prefetch the OpenCode Go model catalog, then re-resolve settings and
// repaint. Shared by wirePostStartup and the connect handler's post-connect
// refresh. `getRefreshModels` is a callback so the host-availability guard is
// re-checked when the prefetch settles, not when it was started.
export function prefetchGoModelsAndRefresh(
  state: RunnerState,
  getRefreshModels: () => RefreshModels | undefined,
): void {
  void prefetchGoModels()
    .then(async () => {
      const refreshModels = getRefreshModels();
      if (refreshModels === undefined) return;
      await refreshProviderCatalogAndSurfaces(state, refreshModels);
    })
    .catch((err: unknown) => {
      tuiLogger.debug("go model prefetch failed: {error}", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
}
