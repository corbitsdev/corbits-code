/**
 * Settings and config surface for the TUI runner: hook settings, the
 * first-run telemetry/changelog onboarding block, global settings writes,
 * the model-selection handlers, the Alt+A provider connect flow, and the
 * permissions/plugins/hooks/settings host surfaces. (The /mcp surface lives
 * in mcp.ts and is composed into the mount by index.ts.)
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
  setDefaultModel,
  toggleFavoriteModel,
  type LocalSettings,
  type ModelRef,
  type ResolvedProvider,
  type Settings,
} from "../../config/settings.js";
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
import { modelOptionId } from "../model-catalog.js";
import { prefetchGoModels } from "../../provider/opencode-go-models.js";
import { isOpenCodeGoProvider } from "../../../packages/opencode-go/src/index.js";
import { applyLiveModelSwitch } from "../../session/live-model-switch.js";
import { applyFocus } from "../shell/chrome.js";
import { setShellInputSuspended } from "../shell/prompt.js";
import { warningsForPluginEntry } from "../../plugins/diagnostics.js";
import { isPluginEnabledForSurface } from "../plugin-surface.js";
import { resolveWaitForApproval } from "../tool-execution-watchdog.js";
import { hostOf, type RunnerServices, type RunnerState } from "./state.js";
import { LOG_NAMESPACE_ROOT } from "../../branding.js";

const tuiLogger = getLogger([LOG_NAMESPACE_ROOT, "tui"]);

const GRANT_SCOPE_LABEL: Record<GrantScope, string> = {
  session: "This session",
  project: "This project",
  global: "Global",
  "provider-model": "Provider / model",
};

/**
 * Resolve the base for a local-settings read-modify-write.
 * Absent file → empty object; unreadable/invalid → null (caller must skip write).
 */
export async function loadLocalSettingsWriteBase(
  path: string,
  load: (path: string) => Promise<LocalSettings | null> = loadLocalSettings,
): Promise<LocalSettings | null> {
  try {
    return (await load(path)) ?? {};
  } catch {
    return null;
  }
}

/** First-run telemetry disclosure to show before consent-by-proceeding applies. */
export function telemetryStartupNotice(
  globalSettings: Settings | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return telemetryFirstRunPending(globalSettings, env)
    ? TELEMETRY_NOTICE
    : undefined;
}

export interface SettingsWiring {
  telemetryNotice: string | undefined;
  onConnectProvider: (providerName: string) => void;
  onModelSelect: (id: string) => void;
  onFavoriteToggle: (id: string) => void;
  onSetDefault: (id: string) => void;
  surfaces: {
    permissions: ReturnType<typeof createPermissionsSurface>;
    plugins: ReturnType<typeof createPluginsSurface>;
    hooks: ReturnType<typeof createHooksSurface>;
    settings: ReturnType<typeof createSettingsSurface>;
  };
}

/**
 * Wire everything settings-shaped in original runTUI order: the hook
 * classification + enable persistence, the first-run onboarding block, and
 * the host surfaces / model handlers that read it.
 */
export async function wireSettings(
  state: RunnerState,
  services: RunnerServices,
): Promise<SettingsWiring> {
  // Cheap static check, not a real parser: a shell hook always receives the
  // lifecycle name as $1, so it can react to either; a TypeScript hook's
  // exports tell us which of postTurn/postRun it actually implements.
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
  // global settings file, never config.globalSettingsPath (which is the --config
  // file when one was given). This keeps first-run detection consistent and stops
  // a --config launch from stamping project-config contents into the global file.
  const trueGlobalSettingsPath = state.trueGlobalSettingsPath;
  const globalSettingsForOnboarding = await loadSettings(
    trueGlobalSettingsPath,
  );

  // Consent by proceeding (see telemetry/first-run.ts): on a first run the
  // singleton is a held no-op and the passive banner below is the
  // disclosure. The first interactively submitted prompt activates telemetry
  // and fires the held cli_start; a user who never acts keeps the hold for
  // this whole launch, and the render stamp means events start normally on
  // the next one. Keyed off the same TRUE global settings file as
  // `onboarded` above.
  const onChangeTelemetryEnabled = createTelemetryToggleHandler(
    trueGlobalSettingsPath,
    undefined,
    services.globalSettingsWriter.enqueue,
  );
  state.telemetryFirstRun = telemetryFirstRunPending(
    globalSettingsForOnboarding,
  );
  const telemetryNotice = telemetryStartupNotice(globalSettingsForOnboarding);
  // Tracks the user's intent (persisted opt-in, updated live by the settings
  // toggle) rather than the held instance's state, so the settings tab shows
  // On during the hold and an opt-out before the first action suppresses
  // activation entirely.
  state.liveTelemetryIntent = state.telemetryFirstRun || getTelemetry().enabled;
  if (state.telemetryFirstRun) {
    void services.globalSettingsWriter
      .enqueue(() => markTelemetryNoticeShown(trueGlobalSettingsPath))
      .catch(() => {
        // Best-effort: worst case the notice shows again next launch.
      });
  }

  // Post-upgrade release notes watermark policy (CL-5475):
  // - first_install: stamp quietly so later launches do not dump history.
  // - upgrade: stamp only when notes were actually shown. The former Ink
  //   whats-new banner is gone on the OpenTUI path, so notesShown is false
  //   until a surface is restored — never silently consume upgrade notes.
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
      .catch(() => {
        // Best-effort watermark.
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

  const onConnectProvider = (providerName: string): void => {
    void (async () => {
      let result: Awaited<ReturnType<typeof connectProviderInline>>;
      // The setup surface shares the live session's renderer — a second
      // CliRenderer cannot exist on the same stdin. Shell input stays
      // suspended for the surface's lifetime so its keystrokes (including
      // Ctrl+C to cancel the sign-in) never also reach the shell.
      setShellInputSuspended(hostOf(state).shell, true);
      try {
        result = await connectProviderInline({
          providerId: providerName,
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
      if (!result.connected) return;

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
      // Reopen positioned at the account just connected — the picker's
      // default open (top of list) would otherwise leave the operator to
      // hunt for the row they just authorized.
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
    })().catch((err: unknown) => {
      tuiLogger.debug("provider connect failed: {error}", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  };

  const onModelSelect = (id: string): void => {
    const sep = id.indexOf(":");
    if (sep <= 0) return;
    const provider = id.slice(0, sep);
    const model = id.slice(sep + 1);
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
    const sep = id.indexOf(":");
    if (sep <= 0) return;
    const ref: ModelRef = {
      provider: id.slice(0, sep),
      model: id.slice(sep + 1),
    };
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
    const sep = id.indexOf(":");
    if (sep <= 0) return;
    const ref: ModelRef = {
      provider: id.slice(0, sep),
      model: id.slice(sep + 1),
    };
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

  return {
    telemetryNotice,
    onConnectProvider,
    onModelSelect,
    onFavoriteToggle,
    onSetDefault,
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
    }),
    setWaitForApproval: (value: boolean) => {
      services.liveToolWatchdog.waitForApproval = value;
      void persistGlobalSettings("wait-for-approval", (base) => ({
        ...base,
        tools: { ...base.tools, waitForApproval: value },
      }));
    },
    setTelemetryEnabled: (enabled: boolean) => {
      // Only flip the live intent when the toggle is accepted. Env kill
      // switches refuse re-enable; leaving the UI on while capture stays
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
