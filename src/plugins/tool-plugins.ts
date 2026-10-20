import type { AuthorizeFn } from "@intx/agent";
import { getLogger } from "@intx/log";
import type { AuthzCallResult } from "@intx/inference";
import type { ToolPlugin } from "@intx/tools-posix";
import { collectPluginCandidates, type PluginModule } from "./loader.js";
import type { PluginConfig } from "../config/settings.js";
import type { PluginCredentialField } from "./manifest.js";
import { scrubSecrets } from "../web/secret-scrub.js";
import { LOG_NAMESPACE_ROOT } from "../branding.js";
import {
  safePluginDiagnostic,
  validatePluginAuthorizeResult,
} from "../permission/plugin-authorize-result.js";
import {
  resolvePluginWarningHandler,
  stderrPluginWarning,
  type PluginLoadDiagnostics,
} from "./diagnostics.js";

const logger = getLogger([LOG_NAMESPACE_ROOT, "plugins", "tool-authz"]);

// A discovered plugin that contributes agent tools: a "tool"-kind manifest plus
// the factory the loader captured.
export interface ToolPluginCandidate {
  id: string;
  name: string;
  description?: string;
  credentials: PluginCredentialField[];
  factory: (options: unknown) => ToolPlugin | Promise<ToolPlugin>;
}

export interface ResolvedToolPlugins {
  plugins: ToolPlugin[];
  authorize?: AuthorizeFn;
}

interface PluginAuthorizer {
  id: string;
  authorize: AuthorizeFn;
}

function syntheticDeny(): AuthzCallResult {
  return { effect: "deny", matchingGrants: [], resolvedBy: null };
}

function effectStrength(effect: AuthzCallResult["effect"]): number {
  switch (effect) {
    case "deny":
    case null:
      return 2;
    case "ask":
      return 1;
    case "allow":
      return 0;
  }
}

function composePluginAuthorizers(
  authorizers: readonly PluginAuthorizer[],
): AuthorizeFn {
  return async (resource, action, context) => {
    let strongest: AuthzCallResult | undefined;
    for (const plugin of authorizers) {
      let result: AuthzCallResult;
      try {
        const rawResult: unknown = await plugin.authorize(
          resource,
          action,
          context,
        );
        const validated = validatePluginAuthorizeResult(rawResult);
        if (!validated.ok) {
          logger.warn`tool-plugin ${plugin.id} authorization returned a malformed result: ${scrubSecrets(validated.diagnostic)}`;
          return syntheticDeny();
        }
        result = validated.result;
      } catch (err) {
        logger.warn`tool-plugin ${plugin.id} authorization failed: ${scrubSecrets(safePluginDiagnostic(err))}`;
        return syntheticDeny();
      }
      if (result.effect === "deny" || result.effect === null) return result;
      if (
        strongest === undefined ||
        effectStrength(result.effect) > effectStrength(strongest.effect)
      ) {
        strongest = result;
      }
    }
    return (
      strongest ?? {
        effect: "allow",
        matchingGrants: [],
        resolvedBy: null,
      }
    );
  };
}

export function collectToolPlugins(
  modules: PluginModule[],
): ToolPluginCandidate[] {
  return collectPluginCandidates<ToolPlugin>(modules, {
    kind: "tool",
    factoryKey: "createToolPlugin",
  });
}

// A tool plugin adds in-process agent capabilities, so it is wired in only
// when the user has both enabled it AND given one-time consent. Unlike skills
// (isPluginModuleEnabled) and agent profiles (resolveAgentPluginProfiles),
// repo manifest.defaultEnabled never activates a tool plugin on its own —
// this is intentional, not an oversight, until product intent changes.
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
}): Promise<ResolvedToolPlugins> {
  const onWarning = resolvePluginWarningHandler(
    args.diagnostics !== undefined
      ? { diagnostics: args.diagnostics }
      : { onWarning: stderrPluginWarning },
  );
  const plugins: ToolPlugin[] = [];
  const authorizers: PluginAuthorizer[] = [];
  for (const cand of args.candidates) {
    if (!isToolPluginActive(args.pluginConfig, cand.id)) continue;
    let rejectedPlugin: ToolPlugin | undefined;
    try {
      const plugin = await cand.factory(
        args.pluginConfig[cand.id]?.credentials ?? {},
      );
      rejectedPlugin = plugin;
      const authorize = plugin.authorize;
      plugins.push(plugin);
      if (authorize !== undefined) {
        authorizers.push({ id: cand.id, authorize });
      }
      rejectedPlugin = undefined;
    } catch (err) {
      onWarning(
        `tool-plugin: failed to start "${cand.id}": ${scrubSecrets(safePluginDiagnostic(err))}`,
      );
      if (rejectedPlugin !== undefined) {
        try {
          await rejectedPlugin.dispose?.();
        } catch (disposeErr) {
          onWarning(
            `tool-plugin: failed to clean up "${cand.id}" after startup failure: ${scrubSecrets(safePluginDiagnostic(disposeErr))}`,
          );
        }
      }
    }
  }
  return authorizers.length === 0
    ? { plugins }
    : { plugins, authorize: composePluginAuthorizers(authorizers) };
}
