// /plugins UI backend: live plugin state plus the admin surface that mutates
// it. Extracted from runTUI's closure scope as named functions over one
// explicit state object — trusting a project/path plugin, adding by path, or
// revoking trust replaces metadata-only stubs with full modules (and back)
// without restarting the process.

import { isAbsolute, resolve as resolvePath } from "node:path";
import { homedir } from "node:os";
import { getLogger } from "@intx/log";

import { LOG_NAMESPACE_ROOT } from "../branding.js";
import type { PluginConfig, Settings } from "../config/settings.js";
import type { GlobalSettingsWriter } from "../mcp/add-server.js";
import type { PluginsAdmin, PluginDescriptor } from "../plugins/admin.js";
import type { PluginManifest } from "../plugins/manifest.js";
import {
  expandPluginPath,
  expandSkipDiagnosticsHandler,
  loadPluginEntry,
  type PluginModule,
  type PluginOrigin,
} from "../plugins/loader.js";
import {
  createPluginLoadDiagnostics,
  formatPluginWarningsSummary,
} from "../plugins/diagnostics.js";
import { resolveAgentPluginProfiles } from "../plugins/agent-plugins.js";
import { enablePluginConfig, registerCommandPluginModule } from "../plugins/register.js";
import { executePluginRemove } from "../plugins/uninstall.js";
import { collectWebPlugins, type WebPluginCandidate } from "../web/plugin-provider.js";
import { collectToolPlugins, type ToolPluginCandidate } from "../plugins/tool-plugins.js";
import { scrubSecrets } from "../web/secret-scrub.js";
import { trustPlugin, type ProjectTrustStore } from "../trust/project-trust.js";
import {
  revokePathPlugin,
  trustPathPlugin,
  trustPathPlugins,
  type PathTrustStore,
} from "../trust/path-trust.js";

const pluginsAdminLogger = getLogger([LOG_NAMESPACE_ROOT, "tui"]);

export interface PluginsAdminState {
  cwd: string;
  /** Mutable module list; trust grants swap metadata-only stubs for full loads. */
  modules: PluginModule[];
  pluginConfig: Record<string, PluginConfig>;
  pluginPaths: string[];
  webOverride: string | undefined;
  pathTrust: PathTrustStore;
  projectTrust: ProjectTrustStore;
  webCandidates: WebPluginCandidate[];
  toolCandidates: ToolPluginCandidate[];
  descriptors: PluginDescriptor[];
}

/** Seed mutable admin state from boot-time discovery plus settings. */
export function createPluginsAdminState(args: {
  cwd: string;
  settings: Settings | undefined;
  modules: PluginModule[];
  pathTrust: PathTrustStore;
  projectTrust: ProjectTrustStore;
}): PluginsAdminState {
  return {
    cwd: args.cwd,
    modules: args.modules,
    pluginConfig: { ...(args.settings?.plugins ?? {}) },
    pluginPaths: [...(args.settings?.pluginPaths ?? [])],
    webOverride: args.settings?.web,
    pathTrust: args.pathTrust,
    projectTrust: args.projectTrust,
    webCandidates: [],
    toolCandidates: [],
    descriptors: [],
  };
}

export function buildPluginDescriptor(mod: {
  manifest?: PluginManifest;
  metadataOnly?: boolean;
  origin?: PluginOrigin;
  pluginPath?: string;
  source?: string;
}): PluginDescriptor | undefined {
  return mod.manifest === undefined || mod.origin === undefined
    ? undefined
    : {
        id: mod.manifest.id,
        name: mod.manifest.name,
        origin: mod.origin,
        ...(mod.manifest.kind !== undefined ? { kind: mod.manifest.kind } : {}),
        ...(mod.manifest.description !== undefined
          ? { description: mod.manifest.description }
          : {}),
        credentials: mod.manifest.credentials ?? [],
        ...(mod.metadataOnly === true ? { needsTrust: true } : {}),
        ...(mod.origin === "path" && mod.metadataOnly !== true ? { canRevokeTrust: true } : {}),
        ...(mod.pluginPath !== undefined ? { pluginPath: mod.pluginPath } : {}),
        ...(mod.source !== undefined ? { source: mod.source } : {}),
      };
}

/**
 * The admin surface over live state: discovered plugin descriptors plus live,
 * persisted config (enabled flag, credentials, web override, extra paths)
 * written to the global settings file. Verify runs a real trial search
 * through the web candidate. The descriptor/candidate lists are mutable so
 * plugins added by path mid-session appear without a restart.
 */
export function createPluginsAdmin(args: {
  state: PluginsAdminState;
  globalSettingsPath: string;
  globalSettingsWriter: GlobalSettingsWriter;
  noteWarnings: (warnings: readonly string[]) => void;
}): PluginsAdmin {
  const { state } = args;
  const persistPluginSettings = async (): Promise<void> => {
    // Absent file → fresh base; unreadable/invalid → skip write so we never
    // clobber a corrupt settings file by rewriting from a minimal shell.
    const result = await args.globalSettingsWriter.mutate((base) => {
      const next: Settings = { ...base, plugins: state.pluginConfig };
      if (state.pluginPaths.length > 0) next.pluginPaths = state.pluginPaths;
      else delete next.pluginPaths;
      if (state.webOverride !== undefined) next.web = state.webOverride;
      else delete next.web;
      return next;
    });
    if (result === "skipped") {
      pluginsAdminLogger.warn(
        "Skipping plugin settings write: unreadable global settings at {path}",
        { path: args.globalSettingsPath },
      );
    }
  };

  return {
    list: () => state.descriptors,
    getConfig: () => state.pluginConfig,
    getWebOverride: () => state.webOverride,
    saveConfig: async (id, cfg) => {
      state.pluginConfig = { ...state.pluginConfig, [id]: cfg };
      // Warnings from the trust-grant load below are collected, not logged:
      // like `addPath`, the caller has a result channel back to the operator
      // (the command surface's `deps.notify`), so fold them into the returned
      // message instead of a log line nobody watches.
      let trustGrantMessage: string | undefined;
      // Enabling a project/path plugin records trust and full-loads code.
      if (cfg.enabled === true) {
        const stub = state.modules.find((m) => m.manifest?.id === id);
        // Trust routing must use the origin stamped at discovery — a fallback
        // here could turn one store's gate into the other's grant.
        if (
          stub?.metadataOnly === true &&
          stub.pluginPath !== undefined &&
          stub.origin !== undefined
        ) {
          if (stub.origin === "path") {
            state.pathTrust = await trustPathPlugin(stub.pluginPath);
          } else {
            state.projectTrust = await trustPlugin(state.cwd, stub.pluginPath);
          }
          const trustDiag = createPluginLoadDiagnostics();
          const full = await loadPluginEntry(stub.pluginPath, {
            cwd: state.cwd,
            origin: stub.origin,
            diagnostics: trustDiag,
          });
          trustGrantMessage = formatPluginWarningsSummary(trustDiag.warnings);
          args.noteWarnings(trustDiag.warnings);
          if (full !== null) {
            state.modules = state.modules.map((m) => (m.manifest?.id === id ? full : m));
            const di = state.descriptors.findIndex((d) => d.id === id);
            const fullDesc = buildPluginDescriptor(full);
            if (di >= 0 && fullDesc !== undefined) state.descriptors.splice(di, 1, fullDesc);
            // Refresh web/tool candidate lists from the newly loaded module.
            for (const cand of collectWebPlugins([full])) {
              const ci = state.webCandidates.findIndex((c) => c.id === cand.id);
              if (ci >= 0) state.webCandidates.splice(ci, 1, cand);
              else state.webCandidates.push(cand);
            }
            for (const cand of collectToolPlugins([full])) {
              const ci = state.toolCandidates.findIndex((c) => c.id === cand.id);
              if (ci >= 0) state.toolCandidates.splice(ci, 1, cand);
              else state.toolCandidates.push(cand);
            }
            registerCommandPluginModule(full, () => state.pluginConfig);
          }
        }
      }
      await persistPluginSettings();
      return trustGrantMessage === undefined ? undefined : { message: trustGrantMessage };
    },
    setWebOverride: async (id) => {
      state.webOverride = id;
      await persistPluginSettings();
    },
    verify: async (id, credentials) => {
      // Agent plugins verify by checking they contribute valid profiles.
      const agentMod = state.modules.find(
        (m) => m.manifest?.id === id && m.manifest?.kind === "agent",
      );
      if (agentMod !== undefined) {
        const verifyDiag = createPluginLoadDiagnostics();
        const profiles = await resolveAgentPluginProfiles(
          [agentMod],
          { [id]: { enabled: true } },
          { diagnostics: verifyDiag },
        );
        if (profiles.length === 0) return { ok: false, message: "No valid agent profiles found" };
        // Fold warnings into the message (same pattern as `addPath`) instead of
        // logging them: "loaded — N profiles" must not read identically whether
        // or not a profile's skill ref actually resolved.
        const warnings = formatPluginWarningsSummary(verifyDiag.warnings);
        args.noteWarnings(verifyDiag.warnings);
        const base = `loaded — ${profiles.length} profile${profiles.length === 1 ? "" : "s"}`;
        return { ok: true, message: warnings === undefined ? base : `${base} (${warnings})` };
      }
      // Tool plugins verify by loading (the factory must construct without
      // error and yield at least one tool).
      const toolCand = state.toolCandidates.find((c) => c.id === id);
      if (toolCand !== undefined) {
        try {
          const plugin = await toolCand.factory(credentials);
          const count = plugin.tools?.length ?? 0;
          return { ok: true, message: `loaded — ${count} tool${count === 1 ? "" : "s"}` };
        } catch (err) {
          return {
            ok: false,
            message: scrubSecrets(err instanceof Error ? err.message : String(err)),
          };
        }
      }
      const candidate = state.webCandidates.find((c) => c.id === id);
      if (candidate === undefined)
        return { ok: false, message: "Nothing to verify for this plugin" };
      try {
        const provider = await candidate.factory(credentials);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15_000);
        try {
          const results = await provider.search("corbits connectivity test", controller.signal);
          return { ok: true, message: `connected — ${results.length} results` };
        } finally {
          clearTimeout(timer);
        }
      } catch (err) {
        return {
          ok: false,
          message: scrubSecrets(err instanceof Error ? err.message : String(err)),
        };
      }
    },
    addPath: async (rawPath) => {
      const path = rawPath.trim();
      if (path.length === 0) return { ok: false, message: "Enter a path" };
      const abs = isAbsolute(path) ? path : resolvePath(state.cwd, path);
      // Explicit add-by-path is user consent to load that absolute path.
      const addDiag = createPluginLoadDiagnostics();
      const mod = await loadPluginEntry(abs, {
        cwd: state.cwd,
        origin: "path",
        diagnostics: addDiag,
      });
      // Collected, not emitted: `emitPluginWarningSummary` writes to stderr, and
      // a raw write lands mid-frame and corrupts the rendered transcript. The
      // warnings are folded into the result message below instead.
      if (mod === null) return { ok: false, message: `Could not load a plugin at ${path}` };
      if (mod.manifest === undefined) {
        return { ok: false, message: "Plugin has no manifest (needs id/name/kind)" };
      }
      const descriptor = buildPluginDescriptor(mod);
      if (descriptor === undefined) return { ok: false, message: "Invalid plugin manifest" };
      // Persist global path trust only once it resolves to a real plugin, so a
      // bogus path never leaves a dangling entry. Expand marketplaces so each
      // member is trusted (exact-path match on reload). `onSkip` collects into
      // `addDiag` instead of a raw stderr write — same reasoning as
      // `loadPluginEntry` above.
      const members = await expandPluginPath(abs, {
        onSkip: expandSkipDiagnosticsHandler(addDiag),
      });
      state.pathTrust = await trustPathPlugins(members.length > 0 ? members : [abs]);
      // Replace any existing descriptor/candidate with the same id so re-adding
      // refreshes rather than duplicates.
      const existingIdx = state.descriptors.findIndex((d) => d.id === descriptor.id);
      if (existingIdx >= 0) state.descriptors.splice(existingIdx, 1, descriptor);
      else state.descriptors.push(descriptor);
      const existingModIdx = state.modules.findIndex((m) => m.manifest?.id === descriptor.id);
      if (existingModIdx >= 0) state.modules[existingModIdx] = mod;
      else state.modules.push(mod);
      for (const cand of collectWebPlugins([mod])) {
        const ci = state.webCandidates.findIndex((c) => c.id === cand.id);
        if (ci >= 0) state.webCandidates.splice(ci, 1, cand);
        else state.webCandidates.push(cand);
      }
      for (const cand of collectToolPlugins([mod])) {
        const ci = state.toolCandidates.findIndex((c) => c.id === cand.id);
        if (ci >= 0) state.toolCandidates.splice(ci, 1, cand);
        else state.toolCandidates.push(cand);
      }
      // Path-add is consent to use the plugin, so persist activation and make
      // its commands available from the registry without requiring a restart.
      state.pluginConfig = enablePluginConfig(state.pluginConfig, descriptor.id);
      registerCommandPluginModule(mod, () => state.pluginConfig);
      // Persist the resolved absolute path so it reloads regardless of the cwd
      // the next session starts from.
      if (!state.pluginPaths.includes(abs)) state.pluginPaths.push(abs);
      await persistPluginSettings();
      const warnings = formatPluginWarningsSummary(addDiag.warnings);
      args.noteWarnings(addDiag.warnings);
      return {
        ok: true,
        message:
          warnings === undefined
            ? `Added ${descriptor.name}`
            : `Added ${descriptor.name} (${warnings})`,
        id: descriptor.id,
      };
    },
    revokeTrust: async (id) => {
      const mod = state.modules.find((m) => m.manifest?.id === id);
      if (mod === undefined || mod.origin !== "path" || mod.pluginPath === undefined) {
        return { ok: false, message: "Only path-added plugins carry revocable global trust" };
      }
      state.pathTrust = await revokePathPlugin(mod.pluginPath);
      // Drop back to the metadata-only stub and disable: the module stays
      // registered in pluginPaths, but its code no longer loads. Anything
      // already imported this session unloads on the next launch.
      const stub = {
        ...(mod.dir !== undefined ? { dir: mod.dir } : {}),
        ...(mod.manifest !== undefined ? { manifest: mod.manifest } : {}),
        origin: mod.origin,
        pluginPath: mod.pluginPath,
        metadataOnly: true,
      };
      state.modules = state.modules.map((m) => (m.manifest?.id === id ? stub : m));
      const di = state.descriptors.findIndex((d) => d.id === id);
      const stubDesc = buildPluginDescriptor(stub);
      if (di >= 0 && stubDesc !== undefined) state.descriptors.splice(di, 1, stubDesc);
      const wi = state.webCandidates.findIndex((c) => c.id === id);
      if (wi >= 0) state.webCandidates.splice(wi, 1);
      const ti = state.toolCandidates.findIndex((c) => c.id === id);
      if (ti >= 0) state.toolCandidates.splice(ti, 1);
      state.pluginConfig = {
        ...state.pluginConfig,
        [id]: { ...(state.pluginConfig[id] ?? {}), enabled: false },
      };
      await persistPluginSettings();
      return { ok: true, message: "Trust revoked — code stays unloaded from next launch" };
    },
    remove: async (id) => {
      if (id.length === 0) return { ok: false, message: "Unknown plugin" };
      const desc = state.descriptors.find((d) => d.id === id);
      const mod = state.modules.find((m) => m.manifest?.id === id);
      if (desc === undefined) return { ok: false, message: "Unknown plugin" };
      const origin = desc.origin;
      const pluginPath = desc.pluginPath ?? mod?.pluginPath;
      const hadTools = mod?.createToolPlugin !== undefined;

      const spliceLive = (): void => {
        const di = state.descriptors.findIndex((d) => d.id === id);
        if (di >= 0) state.descriptors.splice(di, 1);
        state.modules = state.modules.filter((m) => m.manifest?.id !== id);
        const wi = state.webCandidates.findIndex((c) => c.id === id);
        if (wi >= 0) state.webCandidates.splice(wi, 1);
        const ti = state.toolCandidates.findIndex((c) => c.id === id);
        if (ti >= 0) state.toolCandidates.splice(ti, 1);
      };

      const result = await executePluginRemove({
        id,
        name: desc.name,
        origin,
        ...(pluginPath !== undefined ? { pluginPath } : {}),
        hadTools,
        home: homedir(),
        cwd: state.cwd,
        plugins: state.pluginConfig,
        pluginPaths: state.pluginPaths,
        ...(state.webOverride !== undefined ? { webOverride: state.webOverride } : {}),
        otherLivePluginPaths: state.modules.flatMap((m) =>
          m.manifest?.id !== id && m.pluginPath !== undefined ? [m.pluginPath] : [],
        ),
        expandMembers: (abs) => expandPluginPath(abs, { onSkip: () => {} }),
        revokePathPlugin: async (path) => {
          state.pathTrust = await revokePathPlugin(path);
        },
      });
      if (!result.ok) return result;
      if (result.spliceLive) spliceLive();
      state.pluginConfig = result.plugins;
      state.pluginPaths.length = 0;
      state.pluginPaths.push(...result.pluginPaths);
      state.webOverride = result.webOverride;
      await persistPluginSettings();
      return { ok: true, message: result.message };
    },
  };
}
