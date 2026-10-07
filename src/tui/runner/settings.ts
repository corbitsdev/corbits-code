/**
 * Settings and config surface for the TUI runner: hook settings, first-run
 * onboarding, global settings writes, model handlers, the Alt+A connect
 * flow, and the permissions/plugins/hooks/settings surfaces. (The /mcp
 * surface lives in mcp.ts and is composed into the mount by index.ts.)
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { getLogger } from "@intx/log";
import {
  listFavoriteModels,
  listRecentModels,
  loadLocalSettings,
  loadSettings,
  markLastChangelogVersion,
  markTelemetryNoticeShown,
  pushRecentModel,
  removeProviderFromSettings,
  saveLocalSettings,
  setDefaultModel,
  toggleFavoriteModel,
  type ModelRef,
  type ProviderRemovalRepair,
  type ResolvedProvider,
  type Settings,
} from "../../config/settings.js";
import { oauthStoreForProvider } from "../../auth/remove-provider.js";
import { getTelemetry } from "../../telemetry/singleton.js";
import { refreshLiveProviderCatalog } from "../../config/index.js";
import { createTelemetryToggleHandler } from "../../telemetry/toggle.js";
import { telemetryFirstRunPending } from "../../telemetry/first-run.js";
import { TELEMETRY_NOTICE } from "../../telemetry/index.js";
import {
  loadStartupChangelogMarkdown,
  stampVersionAfterStartup,
} from "../../changelog/index.js";
import pkg from "../../../package.json" with { type: "json" };
import type { GrantScope } from "../../permission/types.js";
import { connectProviderInline } from "../provider/connect.js";
import { persistConnectedSelection } from "../provider/submit.js";
import { modelOptionId, modelOptionRef } from "../model-catalog.js";
import {
  prefetchGoModels,
  prefetchZenModels,
} from "../../provider/model-catalogs.js";
import { isOpenCodeGoProvider } from "../../../packages/opencode-go/src/index.js";
import { isZenProvider } from "../../../packages/zen/src/index.js";
import { applyLiveModelSwitch } from "../../session/live-model-switch.js";
import type { ThemeSetting } from "../theme-detect.js";
import { applyStartupTheme } from "../theme-startup.js";
import type { ThemeName } from "../theme.js";
import {
  applyFocus,
  paintChrome,
  paintPromptBorder,
  repaintTranscriptWindow,
} from "../shell/chrome.js";
import type { AppShell } from "../shell/internals.js";
import { setShellInputSuspended } from "../shell/prompt.js";
import { warningsForPluginEntry } from "../../plugins/diagnostics.js";
import { isPluginEnabledForSurface } from "../plugin-surface.js";
import { resolveWaitForApproval } from "../../agent/tool-execution-watchdog.js";
import { hostOf, type RunnerServices, type RunnerState } from "./state.js";
import type { ProductHostConnectRequest } from "../product-host.js";
import { LOG_NAMESPACE_ROOT } from "../../branding.js";

const tuiLogger = getLogger([LOG_NAMESPACE_ROOT, "tui"]);

const GRANT_SCOPE_LABEL: Record<GrantScope, string> = {
  session: "This session",
  project: "This project",
  global: "Global",
  "provider-model": "Provider / model",
};

/** First-run telemetry disclosure, shown before consent-by-proceeding applies. */
export function telemetryStartupNotice(
  globalSettings: Settings | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return telemetryFirstRunPending(globalSettings, env)
    ? TELEMETRY_NOTICE
    : undefined;
}

/**
 * Post-delete summary: what was forgotten, which refs were dropped, where
 * the default went, and what still needs attention. Names and counts only
 * — never key material.
 */
function removeNotice(
  provider: string,
  credentialBit: string,
  repair: ProviderRemovalRepair,
  orphanedProfile: string | null,
  survivorCount: number,
): string {
  const parts = [`Removed ${provider} (${credentialBit} forgotten).`];
  const drops: string[] = [];
  if (repair.droppedRecents > 0) drops.push(`${repair.droppedRecents} recent`);
  if (repair.droppedFavorites > 0)
    drops.push(`${repair.droppedFavorites} favorite`);
  if (drops.length > 0) parts.push(`Dropped ${drops.join(" + ")} refs.`);
  if (repair.removedDefault) {
    parts.push(
      repair.newDefaultProvider !== undefined
        ? `Default moved to ${repair.newDefaultProvider}.`
        : `No default provider set.`,
    );
  }
  if (survivorCount === 0)
    parts.push(`No providers left — /connect to add one.`);
  if (orphanedProfile !== null)
    parts.push(
      `Auth profile '${orphanedProfile}' may remain — retry removal to clear it.`,
    );
  return parts.join(" ");
}

export interface SettingsWiring {
  telemetryNotice: string | undefined;
  onConnectProvider: (
    providerName: string,
    req?: ProductHostConnectRequest,
  ) => void;
  onModelSelect: (id: string) => void;
  onFavoriteToggle: (id: string) => void;
  onSetDefault: (id: string) => void;
  onRemoveProvider: (id: string) => void;
  /**
   * Blast-radius line for the Alt+R arm step, or null when the row is not
   * removable. Never prints key material.
   */
  describeRemoveProvider: (id: string) => string | null;
  surfaces: {
    permissions: ReturnType<typeof createPermissionsSurface>;
    plugins: ReturnType<typeof createPluginsSurface>;
    hooks: ReturnType<typeof createHooksSurface>;
    settings: ReturnType<typeof createSettingsSurface>;
  };
}

/**
 * Wire everything settings-shaped in original runTUI order: hook
 * classification + persistence, first-run onboarding, and the host
 * surfaces / model handlers that read it.
 */
export async function wireSettings(
  state: RunnerState,
  services: RunnerServices,
): Promise<SettingsWiring> {
  // Cheap static check, not a parser: a shell hook always receives the
  // lifecycle name as $1; a TypeScript hook's exports tell which of
  // postTurn/postRun it implements.
  const hookRunsOn = new Map<string, string>();
  for (const status of services.hookManager.getStatuses()) {
    if (status.type === "shell") {
      hookRunsOn.set(
        status.id,
        "runs postTurn and postRun (receives the lifecycle name as $1)",
      );
      continue;
    }
    try {
      const source = await readFile(status.path, "utf8");
      const hasPostTurn = /export\s+(async\s+)?function\s+postTurn\b/.test(
        source,
      );
      const hasPostRun = /export\s+(async\s+)?function\s+postRun\b/.test(
        source,
      );
      hookRunsOn.set(
        status.id,
        hasPostTurn && hasPostRun
          ? "runs postTurn and postRun"
          : hasPostTurn
            ? "runs postTurn"
            : hasPostRun
              ? "runs postRun"
              : "no postTurn/postRun export found — see file",
      );
    } catch {
      hookRunsOn.set(status.id, "could not read hook file — see file");
    }
  }
  const persistHookSettings = async (): Promise<void> => {
    const result = await services.globalSettingsWriter.mutate((base) => ({
      ...base,
      hooks: state.liveHookConfig,
    }));
    if (result === "skipped") {
      tuiLogger.warn(
        "Skipping hook settings write: unreadable global settings at {path}",
        {
          path: state.config.globalSettingsPath,
        },
      );
    }
  };
  const setHookEnabled = async (
    id: string,
    enabled: boolean,
  ): Promise<void> => {
    services.hookManager.setEnabled(id, enabled);
    state.liveHookConfig = { ...state.liveHookConfig, [id]: { enabled } };
    await persistHookSettings();
  };

  // The `onboarded` flag is global user state: read and written against the TRUE
  // global settings file, never config.globalSettingsPath (the --config file
  // when one was given), so a --config launch never stamps project-config
  // contents into the global file.
  const trueGlobalSettingsPath = state.trueGlobalSettingsPath;
  const globalSettingsForOnboarding = await loadSettings(
    trueGlobalSettingsPath,
  );

  // Consent by proceeding (see telemetry/first-run.ts): on a first run the
  // singleton is a held no-op and the banner below is the disclosure. The
  // first submitted prompt activates telemetry and fires the held cli_start;
  // a user who never acts keeps the hold for this launch. Keyed off the
  // same TRUE global settings file as `onboarded` above.
  const onChangeTelemetryEnabled = createTelemetryToggleHandler(
    trueGlobalSettingsPath,
    undefined,
    services.globalSettingsWriter.enqueue,
  );
  state.telemetryFirstRun = telemetryFirstRunPending(
    globalSettingsForOnboarding,
  );
  const telemetryNotice = telemetryStartupNotice(globalSettingsForOnboarding);
  // Tracks the user's intent (persisted opt-in, updated live by the toggle)
  // rather than the held instance's state: the tab shows On during the hold,
  // and an opt-out before the first action suppresses activation entirely.
  state.liveTelemetryIntent = state.telemetryFirstRun || getTelemetry().enabled;
  if (state.telemetryFirstRun) {
    void services.globalSettingsWriter
      .enqueue(() => markTelemetryNoticeShown(trueGlobalSettingsPath))
      .catch((err: unknown) => {
        tuiLogger.debug("telemetry notice watermark persist failed: {error}", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  // Post-upgrade release notes watermark policy:
  // - first_install: stamp quietly so later launches do not dump history.
  // - upgrade: stamp only when notes were actually shown. The OpenTUI path
  //   never shows them at startup, so notesShown stays false — never
  //   silently consume upgrade notes.
  // - resume / current: leave the watermark alone.
  const changelogDecision = loadStartupChangelogMarkdown({
    lastChangelogVersion: globalSettingsForOnboarding?.lastChangelogVersion,
    packageVersion: typeof pkg.version === "string" ? pkg.version : "0.0.0",
  });
  const notesShown = false;
  const stampVersion = stampVersionAfterStartup(changelogDecision, notesShown);
  if (stampVersion !== null) {
    void services.globalSettingsWriter
      .enqueue(() =>
        markLastChangelogVersion(trueGlobalSettingsPath, stampVersion),
      )
      .catch((err: unknown) => {
        tuiLogger.debug("changelog watermark persist failed: {error}", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  // Every settings RMW in this runner shares this tail, including writes to
  // the true global path during a --config session.
  const persistGlobalSettings = async (
    what: string,
    apply: (base: Settings) => Settings,
  ): Promise<boolean> => {
    const result = await services.globalSettingsWriter.mutate(apply);
    if (result === "ok") return true;
    tuiLogger.warn(
      "Skipping {what} write: unreadable global settings at {path}",
      {
        what,
        path: state.config.globalSettingsPath,
      },
    );
    return false;
  };

  const onConnectProvider = (
    providerName: string,
    req?: ProductHostConnectRequest,
  ): void => {
    void (async () => {
      let completionReported = false;
      const reportCompletion = (connected: boolean): void => {
        if (completionReported) return;
        completionReported = true;
        req?.onComplete?.(connected);
      };
      let result: Awaited<ReturnType<typeof connectProviderInline>>;
      // The setup surface shares the live session's renderer — a second
      // CliRenderer cannot exist on the same stdin. Shell input stays
      // suspended so its keystrokes (including Ctrl+C to cancel) never also
      // reach the shell.
      setShellInputSuspended(hostOf(state).shell, true);
      try {
        result = await connectProviderInline({
          providerId: providerName,
          // A pre-scoped reconnect (`/connect <kind> <profile>` or the idle
          // one-action offer) prefills the account-name step; the
          // confirm-to-re-key still runs unchanged.
          ...(req?.profile !== undefined
            ? { initialOAuthProfile: req.profile }
            : {}),
          settingsPath: trueGlobalSettingsPath,
          localSettingsPath: state.localSettingsFile,
          existing: state.config.settings ?? null,
          persistSettings: async (apply) => {
            const next = await services.globalSettingsWriter.updateAt(
              trueGlobalSettingsPath,
              apply,
            );
            if (next === null)
              throw new Error("global settings are unreadable");
            state.config = { ...state.config, settings: next };
            return next;
          },
          createRenderer: () => Promise.resolve(hostOf(state).renderer),
        });
      } catch (err) {
        reportCompletion(false);
        state.systemNotice?.(
          `Connecting ${providerName} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      } finally {
        setShellInputSuspended(hostOf(state).shell, false);
        // The setup surface focused its own input; hand focus back to
        // whatever shell zone owned it before the surface mounted.
        applyFocus(hostOf(state).shell);
      }
      if (!result.connected) {
        reportCompletion(false);
        return;
      }
      reportCompletion(true);

      const onDisk = await loadSettings(trueGlobalSettingsPath);
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
      hostOf(state).refreshModels(
        listRecentModels(state.config.settings ?? { providers: {} }),
        listFavoriteModels(state.config.settings ?? { providers: {} }),
        providers,
      );
      // Reopen at the account just connected — the picker's default open
      // (top of list) would otherwise leave the operator hunting for the row
      // they just authorized.
      const connectedName = result.providerName ?? providerName;
      hostOf(state).openModels?.(
        result.model !== undefined
          ? modelOptionId(connectedName, result.model)
          : undefined,
      );
      state.systemNotice?.(
        `Connected ${connectedName}. Open /model to pick a model.`,
      );
      if (isOpenCodeGoProvider({ name: providerName })) {
        void prefetchGoModels()
          .then(async () => {
            if (services.hostHolder.instance === undefined) return;
            const nextDisk = await loadSettings(trueGlobalSettingsPath);
            const nextProviders = await refreshLiveProviderCatalog(
              nextDisk,
              resolvedForCatalog,
              () => state.config,
            );
            state.config = {
              ...state.config,
              providers: nextProviders,
              ...(nextDisk !== null ? { settings: nextDisk } : {}),
            };
            services.hostHolder.instance.refreshModels(
              listRecentModels(state.config.settings ?? { providers: {} }),
              listFavoriteModels(state.config.settings ?? { providers: {} }),
              nextProviders,
            );
          })
          .catch((err: unknown) => {
            tuiLogger.debug("go model prefetch failed: {error}", {
              error: err instanceof Error ? err.message : String(err),
            });
          });
      }
      if (isZenProvider({ name: providerName })) {
        void prefetchZenModels()
          .then(async () => {
            if (services.hostHolder.instance === undefined) return;
            const nextDisk = await loadSettings(trueGlobalSettingsPath);
            const nextProviders = await refreshLiveProviderCatalog(
              nextDisk,
              resolvedForCatalog,
              () => state.config,
            );
            state.config = {
              ...state.config,
              providers: nextProviders,
              ...(nextDisk !== null ? { settings: nextDisk } : {}),
            };
            services.hostHolder.instance.refreshModels(
              listRecentModels(state.config.settings ?? { providers: {} }),
              listFavoriteModels(state.config.settings ?? { providers: {} }),
              nextProviders,
            );
          })
          .catch((err: unknown) => {
            tuiLogger.debug("zen model prefetch failed: {error}", {
              error: err instanceof Error ? err.message : String(err),
            });
          });
      }
    })().catch((err: unknown) => {
      tuiLogger.debug("provider connect failed: {error}", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  };

  const pendingProviderRemovals = new Set<string>();

  const onModelSelect = (id: string): void => {
    const identity = modelOptionRef(id);
    if (identity === null) return;
    const { provider, model } = identity;
    if (pendingProviderRemovals.has(provider)) return;
    applyLiveModelSwitch(
      { providerName: provider, model },
      {
        applyIdentity: (next) => {
          state.config = {
            ...state.config,
            providerName: next.providerName,
            model: next.model,
          };
        },
        setPermissionIdentity: (providerName, modelName) => {
          services.permissionGate.setProviderIdentity(providerName, modelName);
        },
        rebuildInference: (next) => {
          hostOf(state).bridge.setInferenceProviderId(
            next.providerName,
            state.config.settings?.providers[next.providerName]?.name,
          );
          const bundle = services.buildSessionSources();
          state.agentProxy?.setSources(bundle.sources, bundle.defaultSource);
        },
        refreshAdvertisedSchemas: () => {
          services.directorHolder.instance?.updateToolDefinitions(
            services.computeAdvertised(
              services.toolset.dynamicRunner.currentDefinitions(),
            ),
          );
        },
      },
    );

    const ref: ModelRef = { provider, model };
    void (async () => {
      let next: Settings | undefined;
      const result = await services.globalSettingsWriter.mutateAt(
        trueGlobalSettingsPath,
        (onDisk) => {
          next = pushRecentModel(onDisk, ref);
          return next;
        },
      );
      if (result === "skipped" || next === undefined) {
        throw new Error("global settings are unreadable");
      }
      state.config = { ...state.config, settings: next };
      hostOf(state).refreshModels(
        listRecentModels(next),
        listFavoriteModels(next),
      );
    })().catch((err: unknown) => {
      tuiLogger.debug("model selection persist failed: {error}", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  };

  const onFavoriteToggle = (id: string): void => {
    const ref = modelOptionRef(id);
    if (ref === null) return;
    void (async () => {
      let next: Settings | undefined;
      const result = await services.globalSettingsWriter.mutateAt(
        trueGlobalSettingsPath,
        (onDisk) => {
          next = toggleFavoriteModel(onDisk, ref);
          return next;
        },
      );
      if (result === "skipped" || next === undefined) {
        throw new Error("global settings are unreadable");
      }
      state.config = { ...state.config, settings: next };
      hostOf(state).refreshModels(
        listRecentModels(next),
        listFavoriteModels(next),
      );
    })().catch((err: unknown) => {
      tuiLogger.debug("favorite toggle persist failed: {error}", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  };

  const onSetDefault = (id: string): void => {
    const ref = modelOptionRef(id);
    if (ref === null) return;
    void (async () => {
      let next: Settings | undefined;
      const result = await services.globalSettingsWriter.mutateAt(
        trueGlobalSettingsPath,
        (onDisk) => {
          next = setDefaultModel(
            onDisk,
            ref,
            state.config.providers.find(
              (provider) => provider.name === ref.provider,
            ),
          );
          return next;
        },
      );
      if (result === "skipped" || next === undefined) {
        throw new Error("global settings are unreadable");
      }
      await persistConnectedSelection(
        state.localSettingsFile,
        ref.provider,
        ref.model,
      );
      state.config = { ...state.config, settings: next };
      state.systemNotice?.(`Default set to ${ref.model} (${ref.provider})`);
    })().catch((err: unknown) => {
      tuiLogger.debug("set default persist failed: {error}", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  };

  // Credential bit shared by the arm line and the post-delete notice: names
  // what will be (or was) forgotten. Names and counts only, never secrets.
  const oauthStoreTarget = (provider: string) =>
    oauthStoreForProvider(
      state.config.providers.find((entry) => entry.name === provider) ?? null,
    );

  const removeCredentialBit = (
    provider: string,
    entry: { keyless?: boolean; apiKey?: string },
  ): string => {
    const target = oauthStoreTarget(provider);
    if (target !== null)
      return `auth profile '${target.profile}' + catalog entry`;
    if (entry.keyless === true) return `catalog entry (no stored secret)`;
    if (entry.apiKey !== undefined && entry.apiKey.length > 0)
      return `catalog entry + stored key`;
    return `catalog entry`;
  };

  const describeRemoveProvider = (id: string): string | null => {
    const ref = modelOptionRef(id);
    if (ref === null) return null;
    const settings = state.config.settings;
    const entry = settings?.providers[ref.provider];
    if (entry === undefined) {
      const target = oauthStoreTarget(ref.provider);
      return target === null
        ? null
        : `Remove ${ref.provider} residual? Forgets auth profile '${target.profile}'. Alt+R again to confirm, Esc cancels.`;
    }
    const modelCount = entry.models.length;
    const modelsBit = modelCount === 1 ? "1 model" : `${modelCount} models`;
    let repairPreview = "";
    if (settings?.defaultProvider === ref.provider) {
      const preview = removeProviderFromSettings(
        settings,
        ref.provider,
        state.config.providerName,
      ).repair;
      repairPreview =
        preview.newDefaultProvider !== undefined
          ? ` Default moves to ${preview.newDefaultProvider}.`
          : ` Default will be unset.`;
    }
    return `Remove ${ref.provider} (${modelsBit})? Forgets ${removeCredentialBit(ref.provider, entry)}.${repairPreview} Alt+R again to confirm, Esc cancels.`;
  };

  const onRemoveProvider = (id: string): void => {
    const ref = modelOptionRef(id);
    if (ref === null) return;
    const provider = ref.provider;
    if (pendingProviderRemovals.has(provider)) return;
    pendingProviderRemovals.add(provider);
    void (async () => {
      const entry = state.config.settings?.providers[provider];
      if (entry === undefined) {
        // Orphan retry: the catalog row is gone but an OAuth profile may
        // linger (after a failed removeProfile). Clear it so the "retry
        // removal" promise stays truthful; "already gone" only when nothing
        // remains anywhere.
        const orphanTarget = oauthStoreTarget(provider);
        if (orphanTarget !== null) {
          try {
            const removed = await orphanTarget.removeProfile(
              orphanTarget.profile,
            );
            if (removed.includes(orphanTarget.profile)) {
              state.systemNotice?.(
                `Removed ${provider} (auth profile '${orphanTarget.profile}' forgotten).`,
              );
              return;
            }
          } catch (err) {
            tuiLogger.warn("provider removal auth cleanup failed: {error}", {
              error: err instanceof Error ? err.message : String(err),
            });
            state.systemNotice?.(
              `Auth profile '${orphanTarget.profile}' may remain — retry removal to clear it.`,
            );
            return;
          }
        }
        state.systemNotice?.(`${provider} is already gone.`);
        return;
      }
      // Live-session guard: never orphan the running session mid-run.
      if (provider === state.config.providerName) {
        state.systemNotice?.(
          `${provider} is running this session — switch with /model first.`,
        );
        return;
      }
      const credentialBit = removeCredentialBit(provider, entry);
      const liveProvider = state.config.providerName;
      let removal:
        | { settings: Settings; repair: ProviderRemovalRepair }
        | undefined;
      const result = await services.globalSettingsWriter.mutateAt(
        trueGlobalSettingsPath,
        (base) => {
          const out = removeProviderFromSettings(base, provider, liveProvider);
          if (!out.removed) return null;
          removal = { settings: out.settings, repair: out.repair };
          return out.settings;
        },
      );
      if (result === "skipped") {
        tuiLogger.warn(
          "Skipping provider removal write: unreadable global settings at {path}",
          { path: state.config.globalSettingsPath },
        );
        state.systemNotice?.(
          `Could not remove ${provider}: settings are unreadable.`,
        );
        return;
      }
      if (removal === undefined) {
        state.systemNotice?.(`${provider} is already gone.`);
        return;
      }
      // OAuth credential, after the settings row is gone: retry-safe — an
      // unknown settings name is a notice + no-op on the next attempt.
      const target = oauthStoreTarget(provider);
      let orphanedProfile: string | null = null;
      if (target !== null) {
        try {
          await target.removeProfile(target.profile);
        } catch (err) {
          tuiLogger.warn("provider removal auth cleanup failed: {error}", {
            error: err instanceof Error ? err.message : String(err),
          });
          orphanedProfile = target.profile;
        }
      }
      // Per-repo local selection: clear a dangling pick so the next launch
      // falls back to the global default. Selection only, never secrets.
      if (state.localSettingsFile !== null) {
        try {
          const local = await loadLocalSettings(state.localSettingsFile);
          if (local?.provider === provider) {
            const {
              provider: _droppedProvider,
              model: _droppedModel,
              ...rest
            } = local;
            await saveLocalSettings(state.localSettingsFile, rest);
          }
        } catch (err) {
          tuiLogger.warn(
            "provider removal local selection clear failed: {error}",
            { error: err instanceof Error ? err.message : String(err) },
          );
        }
      }
      // Post-delete refresh tail, mirroring onConnectProvider.
      const onDisk = await loadSettings(trueGlobalSettingsPath);
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
      hostOf(state).refreshModels(
        listRecentModels(state.config.settings ?? { providers: {} }),
        listFavoriteModels(state.config.settings ?? { providers: {} }),
        providers,
      );
      // Reopen at the repaired default's model, else the first surviving
      // row — never the top of the list by accident when avoidable.
      const survivors = onDisk?.providers ?? {};
      const focusProvider =
        removal.repair.newDefaultProvider ?? Object.keys(survivors)[0];
      let focusId: string | undefined;
      if (focusProvider !== undefined) {
        const survivorModels = survivors[focusProvider]?.models ?? [];
        const survivorDefault = survivors[focusProvider]?.defaultModel;
        const focusModel =
          survivorDefault !== undefined &&
          survivorModels.includes(survivorDefault)
            ? survivorDefault
            : survivorModels[0];
        if (focusModel !== undefined) {
          focusId = modelOptionId(focusProvider, focusModel);
        }
      }
      hostOf(state).openModels?.(focusId);
      state.systemNotice?.(
        removeNotice(
          provider,
          credentialBit,
          removal.repair,
          orphanedProfile,
          Object.keys(survivors).length,
        ),
      );
    })()
      .catch((err: unknown) => {
        tuiLogger.debug("provider removal failed: {error}", {
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        pendingProviderRemovals.delete(provider);
      });
  };

  return {
    telemetryNotice,
    onConnectProvider,
    onModelSelect,
    onFavoriteToggle,
    onSetDefault,
    onRemoveProvider,
    describeRemoveProvider,
    surfaces: {
      permissions: createPermissionsSurface(state, services),
      plugins: createPluginsSurface(state, services),
      hooks: createHooksSurface(state, services, hookRunsOn, setHookEnabled),
      settings: createSettingsSurface(
        state,
        services,
        onChangeTelemetryEnabled,
        persistGlobalSettings,
      ),
    },
  };
}

function createPermissionsSurface(
  state: RunnerState,
  _services: RunnerServices,
) {
  return {
    list: async () => {
      state.listedGrants = await _services.permissionsAdmin.list();
      return state.listedGrants.map((entry, index) => ({
        id: String(index),
        scopeLabel: GRANT_SCOPE_LABEL[entry.scope],
        tool: entry.tool,
        pattern: entry.pattern,
        ...(entry.providerModel !== undefined
          ? { providerModel: entry.providerModel }
          : {}),
      }));
    },
    revoke: async (id: string) => {
      const entry = state.listedGrants[Number(id)];
      if (entry !== undefined) await _services.permissionsAdmin.revoke(entry);
    },
  };
}

function createPluginsSurface(state: RunnerState, services: RunnerServices) {
  return {
    cwd: state.config.cwd,
    home: homedir(),
    list: () => {
      const cfg = services.pluginsAdmin.getConfig();
      return services.pluginsAdmin.list().map((p) => {
        const mod = services.pluginState.modules.find(
          (m) => m.manifest?.id === p.id,
        );
        const attributed = warningsForPluginEntry(
          state.standingPluginWarnings,
          {
            id: p.id,
            ...(p.agentProfiles !== undefined
              ? { agentProfiles: p.agentProfiles }
              : {}),
          },
        );
        return {
          id: p.id,
          name: p.name,
          origin: p.origin,
          enabled: isPluginEnabledForSurface(mod, cfg),
          credentials: p.credentials,
          credentialValues: cfg[p.id]?.credentials ?? {},
          ...(p.kind !== undefined ? { kind: p.kind } : {}),
          ...(p.description !== undefined
            ? { description: p.description }
            : {}),
          ...(p.needsTrust === true ? { needsTrust: true } : {}),
          ...(p.canRevokeTrust === true ? { canRevokeTrust: true } : {}),
          ...(p.agentProfiles !== undefined
            ? { agentProfiles: p.agentProfiles }
            : {}),
          ...(p.pluginPath !== undefined
            ? { pluginPath: p.pluginPath, originPath: p.pluginPath }
            : mod?.pluginPath !== undefined
              ? { pluginPath: mod.pluginPath, originPath: mod.pluginPath }
              : {}),
          ...(p.source !== undefined
            ? { source: p.source }
            : mod?.source !== undefined
              ? { source: mod.source }
              : {}),
          ...(attributed.length > 0 ? { warnings: attributed } : {}),
        };
      });
    },
    setEnabled: async (id: string, enabled: boolean) => {
      const existing = services.pluginsAdmin.getConfig()[id] ?? {};
      return (
        (await services.pluginsAdmin.saveConfig(id, {
          ...existing,
          enabled,
        })) ?? undefined
      );
    },
    saveCredentials: async (
      id: string,
      credentials: Record<string, string>,
    ) => {
      const existing = services.pluginsAdmin.getConfig()[id] ?? {};
      await services.pluginsAdmin.saveConfig(id, { ...existing, credentials });
    },
    verify: (id: string, credentials: Record<string, string>) =>
      services.pluginsAdmin.verify(id, credentials),
    addPath: (path: string) => services.pluginsAdmin.addPath(path),
    remove: (id: string) => services.pluginsAdmin.remove(id),
    webProviders: () =>
      services.pluginState.webCandidates.map((c) => ({
        id: c.id,
        name: c.name,
      })),
    currentWebProvider: () => services.pluginsAdmin.getWebOverride(),
    setWebProvider: (id: string | undefined) =>
      services.pluginsAdmin.setWebOverride(id),
    loadWarnings: () => state.standingPluginWarnings,
  };
}

function createHooksSurface(
  _state: RunnerState,
  services: RunnerServices,
  hookRunsOn: Map<string, string>,
  setHookEnabled: (id: string, enabled: boolean) => Promise<void>,
) {
  return {
    list: () =>
      services.hookManager.getStatuses().map((status) => ({
        id: status.id,
        name: status.name,
        type: status.type,
        path: status.path,
        enabled: status.enabled,
        runsOn: hookRunsOn.get(status.id) ?? "see file",
      })),
    setEnabled: (id: string, enabled: boolean) => setHookEnabled(id, enabled),
  };
}

/**
 * Live-apply a theme pin: resolve it exactly as startup does (explicit pins
 * win, `auto` re-detects) and swap the shared `UI` binding, then repaint.
 * The swap is synchronous — an instant rebinding, never an animated
 * transition. Returns the resolved palette name. Exported for tests; the
 * settings surface is the only caller.
 */
export function applyThemePinLive(
  value: ThemeSetting,
  repaint: () => void,
): ThemeName {
  const applied = applyStartupTheme(value);
  repaint();
  return applied;
}

/**
 * Unconditional post-pin repaint for the settings surface. The cost/context
 * meter path skips painting when the meter did not move — the common
 * pin-cycle case — so cycling pins repainted nothing behind the overlay.
 * Force the chrome, repaint the border, and rebuild the transcript rows so
 * markdown bodies pick up the fresh SyntaxStyle registry. Synchronous, like
 * the swap.
 */
export function repaintShellForTheme(shell: AppShell): void {
  paintChrome(shell, { force: true });
  paintPromptBorder(shell);
  repaintTranscriptWindow(shell);
}

function createSettingsSurface(
  state: RunnerState,
  services: RunnerServices,
  onChangeTelemetryEnabled: (enabled: boolean) => boolean,
  persistGlobalSettings: (
    what: string,
    apply: (base: Settings) => Settings,
  ) => Promise<boolean>,
) {
  return {
    read: () => ({
      waitForApproval: resolveWaitForApproval(services.liveToolWatchdog),
      telemetryEnabled: state.liveTelemetryIntent,
      showPromptCost: state.liveShowPromptCost,
      theme: state.liveTheme,
    }),
    setWaitForApproval: (value: boolean) => {
      services.liveToolWatchdog.waitForApproval = value;
      void persistGlobalSettings("wait-for-approval", (base) => ({
        ...base,
        tools: { ...base.tools, waitForApproval: value },
      }));
    },
    setTelemetryEnabled: (enabled: boolean) => {
      // Only flip the live intent when the toggle is accepted: env kill
      // switches refuse re-enable, and leaving the UI on while capture stays
      // off is a silent lie.
      if (!onChangeTelemetryEnabled(enabled)) {
        state.systemNotice?.(
          "Telemetry stays off — disabled by DO_NOT_TRACK or CORBITS_TELEMETRY.",
        );
        return;
      }
      state.liveTelemetryIntent = enabled;
    },
    setShowPromptCost: (value: boolean) => {
      state.liveShowPromptCost = value;
      hostOf(state).refreshCostContext();
      void persistGlobalSettings("show prompt cost", (base) => ({
        ...base,
        showPromptCost: value,
      }));
    },
    setTheme: (value: ThemeSetting) => {
      state.liveTheme = value;
      // The pin used to record-and-persist only, leaving the old palette
      // until relaunch. Resolve it as startup does and paint now — an
      // instant rebinding of the shared UI object, never an animated
      // transition. The repaint is unconditional; the meter path would skip
      // it whenever the cost context did not move.
      applyThemePinLive(value, () => repaintShellForTheme(hostOf(state).shell));
      void persistGlobalSettings("theme", (base) => ({
        ...base,
        theme: value,
      }));
    },
    hooksSummary: () => {
      const statuses = services.hookManager.getStatuses();
      return {
        discovered: statuses.length,
        off: statuses.filter((s) => !s.enabled).length,
      };
    },
    openHooks: () => state.dispatchCommand?.("hooks", ""),
  };
}
