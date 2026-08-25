import type { AgentProfile, CapabilityFilter } from "../profile-types.js";
import { randPackage } from "./rand/index.js";
import { bruckheimerPackage } from "./bruckheimer/index.js";
import { criticPackage } from "./critic/index.js";
import { draperPackage } from "./draper/index.js";
import { emilPackage } from "./emil/index.js";
import { explorerPackage } from "./explorer/index.js";
import { gaasbotPackage } from "./gaasbot/index.js";
import { greybeardPackage } from "./greybeard/index.js";
import { builderPackage } from "./builder/index.js";
import { internPackage } from "./intern/index.js";
import { neckbeardPackage } from "./neckbeard/index.js";
import { counselPackage } from "./counsel/index.js";
import { shakespearePackage } from "./shakespeare/index.js";
import { skywalkerPackage } from "./skywalker/index.js";
import { testerPackage } from "./tester/index.js";
import { testsmithPackage } from "./testsmith/index.js";
import { formatDirectorSystemPrompt } from "./identity.js";
import {
  DIRECTOR_IDS,
  type DirectorId,
  type DirectorPackage,
  type ResolveDirectorInput,
  type ResolveDirectorResult,
  type SubagentTier,
  type TaskIntent,
} from "./types.js";

/** Intent → default director when `task(agent=…)` is omitted. No general director. */
export const INTENT_DEFAULT_DIRECTOR: Readonly<Record<Exclude<TaskIntent, "general">, DirectorId>> =
  {
    implement: "builder",
    explore: "explorer",
    plan: "counsel",
    review: "critic",
  };

/**
 * Closed v1 registry — full packages (prompts, envelopes, spawn, nudge, modelRole).
 * Leaf modules own package bodies; this file only fans them in.
 */
export const DIRECTOR_REGISTRY: Readonly<Record<DirectorId, DirectorPackage>> = {
  skywalker: skywalkerPackage,
  builder: builderPackage,
  explorer: explorerPackage,
  counsel: counselPackage,
  intern: internPackage,
  critic: criticPackage,
  greybeard: greybeardPackage,
  neckbeard: neckbeardPackage,
  bruckheimer: bruckheimerPackage,
  gaasbot: gaasbotPackage,
  draper: draperPackage,
  emil: emilPackage,
  rand: randPackage,
  shakespeare: shakespearePackage,
  testsmith: testsmithPackage,
  tester: testerPackage,
};

export function isDirectorId(value: unknown): value is DirectorId {
  return typeof value === "string" && (DIRECTOR_IDS as readonly string[]).includes(value);
}

/** Fleet authority tier for a closed director id, or undefined for non-director profiles. */
export function tierForDirectorId(id: string): SubagentTier | undefined {
  return isDirectorId(id) ? DIRECTOR_REGISTRY[id].tier : undefined;
}

export function listDirectors(): readonly DirectorPackage[] {
  return DIRECTOR_IDS.map((id) => DIRECTOR_REGISTRY[id]);
}

/**
 * Resolve a director package for dispatch.
 * Explicit `agentId` wins; otherwise intent maps to a default.
 * `general` never maps to a director — reclassify only.
 */
export function resolveDirector(input: ResolveDirectorInput): ResolveDirectorResult {
  if (input.agentId !== undefined && input.agentId !== "") {
    if (!isDirectorId(input.agentId)) {
      const known = DIRECTOR_IDS.join(", ");
      return {
        ok: false,
        error: `Unknown director "${input.agentId}".`,
        hint: `Use one of: ${known}. Or omit agent and pass intent (implement|explore|plan|review).`,
      };
    }
    return { ok: true, package: DIRECTOR_REGISTRY[input.agentId] };
  }

  const intent = input.intent;
  if (intent === undefined) {
    return {
      ok: false,
      error: "No director selected.",
      hint: "Pass task(agent=…) for a named director, or task(intent=implement|explore|plan|review).",
    };
  }
  if (intent === "general") {
    return {
      ok: false,
      error: 'Intent "general" is not a director — reclassify.',
      hint: "Pick implement, explore, plan, or review (or a named director via agent=).",
    };
  }
  const id = INTENT_DEFAULT_DIRECTOR[intent];
  return { ok: true, package: DIRECTOR_REGISTRY[id] };
}

/** Map package tool envelope → profile capability filter. Prefer allow (small mount). */
export function packageToCapabilities(pkg: DirectorPackage): CapabilityFilter | undefined {
  const allow = pkg.tools?.allow;
  if (allow !== undefined && allow.length > 0) {
    return { mode: "allow", tools: [...allow] };
  }
  const deny = pkg.tools?.deny;
  if (deny !== undefined && deny.length > 0) {
    return { mode: "exclude", tools: [...deny] };
  }
  return undefined;
}

/** Map a director package to a spawnable agent profile (defaults / search_agents). */
export function packageToProfile(pkg: DirectorPackage): AgentProfile {
  const capabilities = packageToCapabilities(pkg);
  return {
    id: pkg.id,
    description: `${pkg.description} (agent id: ${pkg.id})`,
    systemPromptRole: formatDirectorSystemPrompt(pkg),
    // Nested spawn is still gated by allowOrchestrator on the parent task tool.
    // Greybeard/skywalker maySpawn marks intent; leaves stay non-orchestrator.
    orchestrator: pkg.spawn.maySpawn,
    ...(capabilities !== undefined ? { capabilities } : {}),
  };
}

/** Spawnable director profiles (closed set minus primary skywalker). */
export function directorProfiles(): AgentProfile[] {
  return listDirectors()
    .filter((pkg) => pkg.id !== "skywalker")
    .map(packageToProfile);
}
