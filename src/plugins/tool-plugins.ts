import type { ToolPlugin } from "@intx/tools-posix";
import type { PluginModule } from "./loader.js";
import type { PluginConfig } from "../config/settings.js";
import type { PluginCredentialField } from "./manifest.js";
import { scrubSecrets } from "../web/secret-scrub.js";
import {
  resolvePluginWarningHandler,
  stderrPluginWarning,
  type PluginLoadDiagnostics,
} from "./diagnostics.js";

// A discovered plugin that contributes agent tools: a "tool"-kind manifest plus
// the factory the loader captured.
export type ToolPluginCandidate = {
  id: string;
  name: string;
  description?: string;
  credentials: PluginCredentialField[];
  factory: (options: unknown) => ToolPlugin | Promise<ToolPlugin>;
};

export function collectToolPlugins(modules: PluginModule[]): ToolPluginCandidate[] {
  const out: ToolPluginCandidate[] = [];
  for (const mod of modules) {
    if (mod.manifest?.kind !== "tool") continue;
    if (typeof mod.createToolPlugin !== "function") continue;
    out.push({
      id: mod.manifest.id,
      name: mod.manifest.name,
      ...(mod.manifest.description !== undefined ? { description: mod.manifest.description } : {}),
      credentials: mod.manifest.credentials ?? [],
      factory: mod.createToolPlugin as ToolPluginCandidate["factory"],
    });
  }
  return out;
}

// A tool plugin adds in-process agent capabilities, so it is wired in only when
// the user has both enabled it AND given one-time consent.
export function isToolPluginActive(config: Record<string, PluginConfig>, id: string): boolean {
  return config[id]?.enabled === true && config[id]?.consented === true;
}

// Instantiate every enabled+consented tool plugin. A factory that throws is
// reported and skipped rather than aborting the run. Pass `diagnostics` from
// an interactive caller (the TUI holds the alternate screen for the whole
// session — a bare stderr write mid-frame corrupts it); without it this falls
// back to one stderr line per failure, same as `resolvePluginWarningHandler`
// elsewhere in the plugin loader.
export async function resolveToolPlugins(args: {
  candidates: ToolPluginCandidate[];
  pluginConfig: Record<string, PluginConfig>;
  diagnostics?: PluginLoadDiagnostics;
}): Promise<ToolPlugin[]> {
  const onWarning = resolvePluginWarningHandler(
    args.diagnostics !== undefined
      ? { diagnostics: args.diagnostics }
      : { onWarning: stderrPluginWarning },
  );
  const out: ToolPlugin[] = [];
  for (const cand of args.candidates) {
    if (!isToolPluginActive(args.pluginConfig, cand.id)) continue;
    try {
      out.push(await cand.factory(args.pluginConfig[cand.id]?.credentials ?? {}));
    } catch (err) {
      onWarning(
        `tool-plugin: failed to start "${cand.id}": ${scrubSecrets(err instanceof Error ? err.message : String(err))}`,
      );
    }
  }
  return out;
}
