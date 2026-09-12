import type { EnvironmentInfo } from "./environment.js";
import { DIRECTOR_REGISTRY } from "./directors/registry.js";
import { formatDirectorSystemPrompt } from "./directors/identity.js";
import {
  DIRECTOR_IDS,
  type DirectorId,
  type DirectorPackage,
} from "./directors/types.js";
import { buildSubAgentSystemPrompt } from "./prompts.js";
import { shouldApplyGrokAntiThrash } from "../subagent/provider-family.js";

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
 * Canonical tool names per director, mirroring the run.ts mount order:
 * package allowlist, then always-mounted manage_tasks, then leaf-only
 * submit_result + ask_director, then orchestrator fleet tools
 * (search_agents is Tier-1 skywalker only).
 */
export function canonicalToolNamesForDirector(
  pkg: DirectorPackage,
): readonly string[] {
  const names = [...(pkg.tools?.allow ?? [])];
  names.push("manage_tasks");
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
      toolNames: canonicalToolNamesForDirector(pkg),
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
