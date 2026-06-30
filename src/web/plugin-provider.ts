import type { WebProvider } from "./types.js";
import { scrubSecrets } from "./secret-scrub.js";
import type { PluginModule } from "../plugins/loader.js";
import type { PluginConfig } from "../config/settings.js";
import type { PluginCredentialField } from "../plugins/manifest.js";

// A discovered plugin that can back the web tools: a "web"-kind manifest plus
// the factory the loader captured. Kept separate from the raw PluginModule so
// callers (runner, /plugins UI) work with a flat, validated shape.
export type WebPluginCandidate = {
  id: string;
  name: string;
  description?: string;
  credentials: PluginCredentialField[];
  factory: (options: unknown) => WebProvider | Promise<WebProvider>;
};

export function collectWebPlugins(modules: PluginModule[]): WebPluginCandidate[] {
  const out: WebPluginCandidate[] = [];
  for (const mod of modules) {
    if (mod.manifest?.kind !== "web") continue;
    if (typeof mod.createWebProvider !== "function") continue;
    out.push({
      id: mod.manifest.id,
      name: mod.manifest.name,
      ...(mod.manifest.description !== undefined ? { description: mod.manifest.description } : {}),
      credentials: mod.manifest.credentials ?? [],
      factory: mod.createWebProvider as WebPluginCandidate["factory"],
    });
  }
  return out;
}

// Pick the active web plugin: an explicit `web` override wins; otherwise the
// single enabled web plugin is used. Returns undefined when none applies, in
// which case web_search/web_fetch are not registered (web is plugin-only).
export function selectWebPlugin(
  candidates: WebPluginCandidate[],
  pluginConfig: Record<string, PluginConfig>,
  webOverride: string | undefined,
): WebPluginCandidate | undefined {
  if (webOverride !== undefined && webOverride.length > 0) {
    return candidates.find((c) => c.id === webOverride);
  }
  const enabled = candidates.filter((c) => pluginConfig[c.id]?.enabled === true);
  return enabled.length === 1 ? enabled[0] : undefined;
}

// The short brand for tool display: "Exa Search" -> "Exa", so web_search and
// web_fetch render as "Exa Search" / "Exa Fetch".
export function webBrand(name: string): string {
  return name.replace(/\s+(search|fetch)$/i, "").trim();
}

export type ActiveWebProvider = { provider: WebProvider; name: string };

// Build the active web provider from the discovered candidates and stored
// config. On failure logs to stderr and returns undefined so the run proceeds
// with web tools disabled rather than crashing.
export async function resolveWebProviderFromPlugins(args: {
  candidates: WebPluginCandidate[];
  pluginConfig: Record<string, PluginConfig>;
  webOverride: string | undefined;
}): Promise<ActiveWebProvider | undefined> {
  const selected = selectWebPlugin(args.candidates, args.pluginConfig, args.webOverride);
  if (selected === undefined) {
    // A configured override that matches no discovered plugin is almost always a
    // typo or a removed plugin — surface it instead of silently using local.
    if (
      args.webOverride !== undefined &&
      args.webOverride.length > 0 &&
      !args.candidates.some((c) => c.id === args.webOverride)
    ) {
      process.stderr.write(
        `web-provider: settings.web "${args.webOverride}" matches no discovered web plugin; web tools disabled.\n`,
      );
    }
    return undefined;
  }
  const credentials = args.pluginConfig[selected.id]?.credentials ?? {};
  try {
    const provider = await selected.factory(credentials);
    return { provider, name: selected.name };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `web-provider: failed to start plugin "${selected.id}", web tools disabled: ${scrubSecrets(message)}\n`,
    );
    return undefined;
  }
}
