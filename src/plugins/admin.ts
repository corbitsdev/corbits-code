import type { PluginConfig } from "../config/settings.js";
import type { PluginCredentialField, PluginKind } from "./manifest.js";

export interface PluginDescriptor {
  id: string;
  name: string;
  kind?: PluginKind;
  description?: string;
  credentials: PluginCredentialField[];
  // For kind:"agent" plugins — the profiles contributed, shown so the user can
  // see which sub-agents a plugin provides before enabling it.
  agentProfiles?: { id: string; description?: string }[];
  /**
   * True when discovery found the plugin but code is not imported yet (project
   * or path origin still untrusted). Enabling records trust and full-loads.
   */
  needsTrust?: boolean;
  /** True for a trusted path-origin plugin, whose global grant can be withdrawn. */
  canRevokeTrust?: boolean;
}

export interface VerifyResult { ok: boolean; message: string }
export interface AddPathResult { ok: boolean; message: string; id?: string }

export interface PluginsAdmin {
  list: () => PluginDescriptor[];
  getConfig: () => Record<string, PluginConfig>;
  getWebOverride: () => string | undefined;
  // A trust-grant load (enabling a metadata-only plugin) can surface skill-miss
  // and similar warnings; the optional message lets the caller show them
  // instead of dropping them on the floor.
  saveConfig: (id: string, cfg: PluginConfig) => Promise<{ message?: string } | void> | void;
  setWebOverride: (id: string | undefined) => Promise<void> | void;
  verify: (id: string, credentials: Record<string, string>) => Promise<VerifyResult>;
  // Register a plugin from an arbitrary file/dir path, persisting it so it loads
  // on future startups. Returns the new plugin id on success.
  addPath: (path: string) => Promise<AddPathResult>;
  // Withdraw the global trust grant for a path-origin plugin and disable it.
  revokeTrust: (id: string) => Promise<VerifyResult>;
}
