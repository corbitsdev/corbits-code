import type { PluginConfig } from "../config/settings.js";
import type { PluginCredentialField, PluginKind } from "./manifest.js";

export type PluginDescriptor = {
  id: string;
  name: string;
  kind?: PluginKind;
  description?: string;
  credentials: PluginCredentialField[];
  // For kind:"agent" plugins — the profiles contributed, shown so the user can
  // see which sub-agents and tiers a plugin provides before enabling it.
  agentProfiles?: { id: string; tier?: string; description?: string }[];
  /**
   * True when discovery found the plugin but code is not imported yet (project
   * or path origin still untrusted). Enabling records trust and full-loads.
   */
  needsTrust?: boolean;
  /** True for a trusted path-origin plugin, whose global grant can be withdrawn. */
  canRevokeTrust?: boolean;
};

export type VerifyResult = { ok: boolean; message: string };
export type AddPathResult = { ok: boolean; message: string; id?: string };

export type PluginsAdmin = {
  list: () => PluginDescriptor[];
  getConfig: () => Record<string, PluginConfig>;
  getWebOverride: () => string | undefined;
  saveConfig: (id: string, cfg: PluginConfig) => Promise<void> | void;
  setWebOverride: (id: string | undefined) => Promise<void> | void;
  verify: (id: string, credentials: Record<string, string>) => Promise<VerifyResult>;
  // Register a plugin from an arbitrary file/dir path, persisting it so it loads
  // on future startups. Returns the new plugin id on success.
  addPath: (path: string) => Promise<AddPathResult>;
  // Withdraw the global trust grant for a path-origin plugin and disable it.
  revokeTrust: (id: string) => Promise<VerifyResult>;
};
