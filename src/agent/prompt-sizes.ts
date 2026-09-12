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
import { shouldApplyGrokAntiThrash } from "../subagent/provider-family.js";
import { isCodexProviderName } from "../config/codex-providers.js";
import { shellCollectDefinition } from "./background-shell-tool.js";
import {
  applyPatchDefinition,
  shellDefinition,
  updatePlanDefinition,
} from "./codex-tool-proxies.js";
import { manageTasksDefinition } from "./tasks.js";
import { DELETE_FILE_DEFINITION } from "../plugins/delete-file-plugin.js";
import { webFetchDefinition } from "../tools/web-fetch.js";
import { webSearchDefinition } from "../tools/web-search.js";

/**
 * Canonical prompt-size fixture (CL-7664).
 *
 * Assembles each director prompt exactly as src/subagent/run.ts does:
 * extensions=[director systemPromptRole] + environment + tools +
 * appendix, with the Grok finish-bias note gated by
 * shouldApplyGrokAntiThrash (leaves on Grok-family providers only).
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
  topLevel: "AGENTS.md  CONTRIBUTING.md  src/  tests/  docs/  plugins/",
};

const GROK_PROVIDER = { providerName: "xai/default", model: "grok-4.6" };
const DEFAULT_PROVIDER = {
  providerName: "anthropic",
  model: "claude-sonnet-4",
};

/** Families in the size table: default assembly vs Grok (+finish-bias note). */
export type PromptSizeFamily = "default" | "grok";

/**
 * Pre-filter mount names in run.ts install order: posix base (TOOL_NAMES,
 * shared with createPosixTools) + delete_file / lsp plugin tools
 * (buildCorePosixToolPlugins) + core web tools (coreSubAgentWebTools) +
 * shell_collect (run.ts:678-694). Codex proxies (apply_patch, shell,
 * update_plan) join only when isCodex — createCodexToolProxies returns []
 * otherwise (run.ts:708-718, codex-tool-proxies.ts:163-166).
 */
function preFilterMountNames(isCodex: boolean): readonly string[] {
  return [
    ...Object.values(TOOL_NAMES),
    DELETE_FILE_DEFINITION.name,
    LSP_TOOL_DEFINITION.name,
    webFetchDefinition.name,
    webSearchDefinition.name,
    shellCollectDefinition.name,
    ...(isCodex
      ? [
          applyPatchDefinition.name,
          shellDefinition.name,
          updatePlanDefinition.name,
        ]
      : []),
  ];
}

/**
 * Canonical tool names per director, assembled exactly as run.ts mounts them:
 * the pre-filter set above narrowed by the package capability filter (the
 * same packageToCapabilities agent-fleet dispatches with; allow keeps only
 * mounted names, exclude drops denials — run.ts:720-722), then manage_tasks
 * (run.ts:727-736), leaf-only submit_result + ask_director (run.ts:740-785),
 * then orchestrator fleet tools with Tier-1-only search_agents
 * (run.ts:791-918, tier gate at 796-797). Allowlist entries that name no
 * mounted tool (list_dir, fleet verbs, off-family Codex proxies) fall out at
 * the filter instead of inflating the prompt.
 */
export function canonicalToolNamesForDirector(
  pkg: DirectorPackage,
  family: PromptSizeFamily,
): readonly string[] {
  const providerName =
    family === "grok"
      ? GROK_PROVIDER.providerName
      : DEFAULT_PROVIDER.providerName;
  const filtered = [...preFilterMountNames(isCodexProviderName(providerName))];
  const capabilities = packageToCapabilities(pkg);
  const names =
    capabilities === undefined
      ? filtered
      : capabilities.mode === "allow"
        ? filtered.filter((name) => capabilities.tools.includes(name))
        : filtered.filter((name) => !capabilities.tools.includes(name));
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
  return names;
}

/** Assemble one director prompt exactly as run.ts does. */
export function assembleDirectorPrompt(
  directorId: DirectorId,
  family: PromptSizeFamily,
): string {
  const pkg = DIRECTOR_REGISTRY[directorId];
  const orchestrator = pkg.spawn.maySpawn;
  const provider = family === "grok" ? GROK_PROVIDER : DEFAULT_PROVIDER;
  return buildSubAgentSystemPrompt(
    [formatDirectorSystemPrompt(pkg)],
    CANONICAL_PROMPT_ENV,
    undefined,
    {
      orchestrator,
      toolNames: canonicalToolNamesForDirector(pkg, family),
      grokAntiThrash: shouldApplyGrokAntiThrash({ ...provider, orchestrator }),
    },
  );
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
    for (const family of ["default", "grok"] as const) {
      rows.push(measureDirectorPrompt(directorId, family));
    }
  }
  return rows;
}

/** Render the size table as markdown (for PR bodies and budget updates). */
export function formatPromptSizeTable(rows: DirectorPromptSize[]): string {
  const lines = [
    "| director | default chars (bytes) | grok chars (bytes) |",
    "| --- | --- | --- |",
  ];
  for (const directorId of DIRECTOR_IDS) {
    const base = rows.find(
      (r) => r.directorId === directorId && r.family === "default",
    );
    const grok = rows.find(
      (r) => r.directorId === directorId && r.family === "grok",
    );
    lines.push(
      `| ${directorId} | ${base?.chars} (${base?.bytes}) | ${grok?.chars} (${grok?.bytes}) |`,
    );
  }
  return lines.join("\n");
}
