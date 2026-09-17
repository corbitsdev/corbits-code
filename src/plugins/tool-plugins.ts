import type { ToolPlugin } from "@intx/tools-posix";
import { collectPluginCandidates, type PluginModule } from "./loader.js";
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
export interface ToolPluginCandidate {
  id: string;
  name: string;
  description?: string;
  credentials: PluginCredentialField[];
  factory: (options: unknown) => ToolPlugin | Promise<ToolPlugin>;
}

export function collectToolPlugins(
  modules: PluginModule[],
): ToolPluginCandidate[] {
  return collectPluginCandidates<ToolPlugin>(modules, {
    kind: "tool",
    factoryKey: "createToolPlugin",
  });
}

// A tool plugin adds in-process agent capabilities, so it is wired in only when
// the user has both enabled it AND given one-time consent. Unlike skills
// (isPluginModuleEnabled) and agent profiles (resolveAgentPluginProfiles),
// repo manifest.defaultEnabled never activates a tool plugin on its own — this
// is intentional, not an oversight, until product intent changes.
export function isToolPluginActive(
  config: Record<string, PluginConfig>,
  id: string,
): boolean {
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
      out.push(
        await cand.factory(args.pluginConfig[cand.id]?.credentials ?? {}),
      );
    } catch (err) {
      onWarning(
        `tool-plugin: failed to start "${cand.id}": ${scrubSecrets(err instanceof Error ? err.message : String(err))}`,
      );
    }
  }
  return out;
}
