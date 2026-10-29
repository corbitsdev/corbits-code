import { getLogger } from "@intx/log";
import { LOG_NAMESPACE_ROOT } from "../../branding.js";
import { refreshLiveProviderCatalog } from "../../config/index.js";
import {
  listFavoriteModels,
  listRecentModels,
  loadSettings,
  type ResolvedProvider,
} from "../../config/settings.js";
import { caughtDebug } from "../../logging/caught.js";
import type { RunnerServices, RunnerState } from "./state.js";

const tuiLogger = getLogger([LOG_NAMESPACE_ROOT, "tui"]);

/**
 * Once a live model catalog prefetch settles, rebuild the provider catalog
 * from disk and hand it to the model picker. The resolved provider is read
 * when the prefetch settles, not when it starts, so a model switched in the
 * meantime is the one the catalog keeps.
 */
export function refreshCatalogAfterPrefetch(
  state: RunnerState,
  services: RunnerServices,
  catalogName: string,
  prefetch: () => Promise<unknown>,
): void {
  void prefetch()
    .then(async () => {
      const host = services.hostHolder.instance;
      if (host === undefined) return;
      const onDisk = await loadSettings(state.trueGlobalSettingsPath);
      const resolvedForCatalog: ResolvedProvider = {
        apiKey: state.config.apiKey,
        baseURL: state.config.baseURL,
        model: state.config.model,
        providerName: state.config.providerName,
        ...(state.config.keyless !== undefined
          ? { keyless: state.config.keyless }
          : {}),
      };
      const providers = await refreshLiveProviderCatalog(
        onDisk,
        resolvedForCatalog,
        () => state.config,
      );
      state.config = {
        ...state.config,
        providers,
        ...(onDisk !== null ? { settings: onDisk } : {}),
      };
      host.refreshModels(
        listRecentModels(state.config.settings ?? { providers: {} }),
        listFavoriteModels(state.config.settings ?? { providers: {} }),
        providers,
      );
    })
    .catch(caughtDebug(tuiLogger, `${catalogName} model prefetch failed`));
}
