import { TOOL_NAMES } from "@intx/tools-posix";
import { LSP_TOOL_DEFINITION } from "@intx/tools-lsp";
import type { EnvironmentInfo } from "./environment.js";
import {
  DIRECTOR_REGISTRY,
  packageToCapabilities,
} from "./directors/registry.js";
import { formatDirectorSystemPrompt } from "./directors/identity.js";
import {
  DIRECTOR_IDS,
  type DirectorId,
  type DirectorPackage,
} from "./directors/types.js";
import { buildSubAgentSystemPrompt } from "./prompts.js";
import { resolveModelFamilyPolicy } from "./model-family-policy.js";
import { shouldApplyGrokAntiThrash } from "../subagent/provider-family.js";
import { advertisedToolName } from "./tool-aliases.js";
import { canonicalToolName } from "./canonical-tool-name.js";
import { manageTasksDefinition } from "./tasks.js";
import { DELETE_FILE_DEFINITION } from "../plugins/delete-file-plugin.js";
import { webFetchDefinition } from "../tools/web-fetch.js";
import { webSearchDefinition } from "../tools/web-search.js";

/**
 * Canonical prompt-size fixture.
 *
 * Assembles each director prompt exactly as src/subagent/run.ts does:
 * extensions=[director systemPromptRole] + environment + tools + appendix,
 * with the Grok finish-bias note gated by shouldApplyGrokAntiThrash (leaves
 * on Grok-family providers only) and the family promptResidual resolved from
 * the model family policy. Residual texts are single-sourced from the
 * versioned prompt-variance package.
 *
 * The env and provider inputs are pinned here so sizes never drift with the
 * machine, date, or checkout — only real prompt changes move the numbers.
 */
export const CANONICAL_PROMPT_ENV: EnvironmentInfo = {
  cwd: "/repo",
  platform: "Darwin 25.0.0",
  arch: "arm64",
  runtime: "Bun 1.2.0",
  date: new Date("2026-01-15T12:00:00Z"),
  isGitRepo: true,
  gitBranch: "main",
  gitDirtyCount: 0,
  topLevel: "AGENTS.md  CONTRIBUTING.md  src/  e2e/  docs/  plugins/",
};

const GROK_PROVIDER = { providerName: "xai/default", model: "grok-4.6" };
// Default-family probe: an unrecognized provider still resolves to the
// default family (no residual).
const MUSE_PROVIDER = {
  providerName: "opencode-go",
  model: "muse-spark-1.3-contributor",
};
const DEFAULT_PROVIDER = {
  providerName: "unknown-provider",
  model: "unknown-model",
};
const CLAUDE_PROVIDER = {
  providerName: "anthropic",
  model: "claude-sonnet-4",
};
const GPT_PROVIDER = { providerName: "openai", model: "gpt-5.6" };

/** Families in the size table: default (no residual), muse, grok, claude, gpt. */
export type PromptSizeFamily = "default" | "muse" | "grok" | "claude" | "gpt";

/**
 * Pre-filter mount names in run.ts install order: posix base (TOOL_NAMES,
 * shared with createPosixTools) + delete_file / lsp plugin tools
 * (buildCorePosixToolPlugins) + core web tools (coreSubAgentWebTools).
 * Codex natives are not mounted.
 */
function preFilterMountNames(): readonly string[] {
  return [
    ...Object.values(TOOL_NAMES),
    DELETE_FILE_DEFINITION.name,
    LSP_TOOL_DEFINITION.name,
    webFetchDefinition.name,
    webSearchDefinition.name,
  ];
}

/**
 * Canonical tool names per director, assembled exactly as run.ts mounts them:
 * the pre-filter set narrowed by the package capability filter (allow keeps
 * only mounted names, exclude drops denials), then manage_tasks, leaf-only
 * submit_result + ask_director, then orchestrator fleet tools with
 * Tier-1-only search_agents. Allowlist entries that name no mounted tool
 * (list_dir, fleet verbs, off-family Codex proxies) fall out at the filter
 * instead of inflating the prompt.
 */
export function canonicalToolNamesForDirector(
  pkg: DirectorPackage,
  _family: PromptSizeFamily,
): readonly string[] {
  const filtered = [...preFilterMountNames()];
  const capabilities = packageToCapabilities(pkg);
  const names =
    capabilities === undefined
      ? filtered
      : capabilities.mode === "allow"
        ? filtered.filter((name) =>
            capabilities.tools.some(
              (allowed) =>
                canonicalToolName(allowed) === canonicalToolName(name),
            ),
          )
        : filtered.filter(
            (name) =>
              !capabilities.tools.some(
                (denied) =>
                  canonicalToolName(denied) === canonicalToolName(name),
              ),
          );
  names.push(manageTasksDefinition.name);
  if (pkg.tier === "leaf") {
    names.push("submit_result", "ask_director");
  }
  if (pkg.spawn.maySpawn) {
    if (pkg.tier === "orchestrator") names.push("search_agents");
    names.push(
      "read_agent_trace",
      "spawn_agent",
      "wait_agents",
      "list_agents",
      "close_agent",
      "resume_agent",
      "interrupt_agent",
      "send_input",
    );
  }
  const dupe = names.find((name, index) => names.indexOf(name) !== index);
  if (dupe !== undefined) {
    throw new Error(
      `canonicalToolNamesForDirector(${pkg.id}): "${dupe}" mounted twice — the assembly drifted from src/subagent/run.ts`,
    );
  }
  return names.map((name) => advertisedToolName(name));
}

/** Assemble one director prompt exactly as run.ts does. */
export function assembleDirectorPrompt(
  directorId: DirectorId,
  family: PromptSizeFamily,
): string {
  const pkg = DIRECTOR_REGISTRY[directorId];
  const orchestrator = pkg.spawn.maySpawn;
  const provider =
    family === "grok"
      ? GROK_PROVIDER
      : family === "muse"
        ? MUSE_PROVIDER
        : family === "claude"
          ? CLAUDE_PROVIDER
          : family === "gpt"
            ? GPT_PROVIDER
            : DEFAULT_PROVIDER;
  const policy = resolveModelFamilyPolicy({ ...provider, orchestrator });
  const prompt = buildSubAgentSystemPrompt(
    [formatDirectorSystemPrompt(pkg)],
    CANONICAL_PROMPT_ENV,
    undefined,
    {
      orchestrator,
      toolNames: canonicalToolNamesForDirector(pkg, family),
      grokAntiThrash: shouldApplyGrokAntiThrash({ ...provider, orchestrator }),
      promptResidual: policy.promptResidual,
    },
  );
  // Mirror the SubAgentDirector constructor (nudge-director.ts): family
  // tool-discipline rules go at the tail of the prompt on the wire.
  return policy.toolDisciplineRules !== undefined &&
    policy.toolDisciplineRules.length > 0
    ? `${prompt}\n\n${policy.toolDisciplineRules}`
    : prompt;
}

export interface DirectorPromptSize {
  directorId: DirectorId;
  family: PromptSizeFamily;
  chars: number;
  bytes: number;
}

export function measureDirectorPrompt(
  directorId: DirectorId,
  family: PromptSizeFamily,
): DirectorPromptSize {
  const prompt = assembleDirectorPrompt(directorId, family);
  return {
    directorId,
    family,
    chars: prompt.length,
    bytes: Buffer.byteLength(prompt, "utf8"),
  };
}

/** Full per-director x per-family size table. */
export function directorPromptSizeTable(): DirectorPromptSize[] {
  const rows: DirectorPromptSize[] = [];
  for (const directorId of DIRECTOR_IDS) {
    for (const family of [
      "default",
      "muse",
      "grok",
      "claude",
      "gpt",
    ] as const) {
      rows.push(measureDirectorPrompt(directorId, family));
    }
  }
  return rows;
}
