import { director as shakespeareDirector } from "@corbits/code-agent-shakespeare";
import { proberPackage } from "@corbits/agent-prober";
import type { AgentProfile, CapabilityFilter } from "../profile-types.js";
import { director as artistDirector } from "@corbits/code-agent-artist";
import { coderPackage } from "./coder/package.js";
import { designerPackage } from "./designer/package.js";
import { dispatchPackage } from "./dispatch/package.js";
import { explorerPackage } from "./explorer/package.js";
import { plannerPackage } from "./planner/package.js";
import { qaLeadPackage } from "./qa-lead/package.js";
import { reviewerPackage } from "./reviewer/package.js";
import { wardenPackage } from "./warden/package.js";
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

/** Intent -> default director when `spawn_agent(agent=...)` is omitted. No general director. */
export const INTENT_DEFAULT_DIRECTOR: Readonly<
  Record<Exclude<TaskIntent, "general">, DirectorId>
> = {
  implement: "coder",
  explore: "explorer",
  plan: "planner",
  review: "reviewer",
};

/**
 * Closed v1 registry — full packages (prompts, envelopes, spawn, nudge, modelRole).
 * Worker modules own package bodies; this file only fans them in.
 */
export const DIRECTOR_REGISTRY: Readonly<Record<DirectorId, DirectorPackage>> =
  {
    dispatch: dispatchPackage,
    explorer: explorerPackage,
    planner: plannerPackage,
    coder: coderPackage,
    reviewer: reviewerPackage,
    designer: designerPackage,
    artist: artistDirector,
    warden: wardenPackage,
    shakespeare: shakespeareDirector,
    prober: proberPackage,
    "qa-lead": qaLeadPackage,
  };

export function isDirectorId(value: unknown): value is DirectorId {
  return (
    typeof value === "string" &&
    (DIRECTOR_IDS as readonly string[]).includes(value)
  );
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
export function resolveDirector(
  input: ResolveDirectorInput,
): ResolveDirectorResult {
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
      hint: "Pass spawn_agent(agent=...) for a named director, or spawn_agent(intent=implement|explore|plan|review).",
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
export function packageToCapabilities(
  pkg: DirectorPackage,
): CapabilityFilter | undefined {
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
    // Nested spawn is still gated by allowOrchestrator on the parent fleet tools.
    // Dispatch maySpawn marks intent; leaves stay non-orchestrator.
    orchestrator: pkg.spawn.maySpawn,
    ...(capabilities !== undefined ? { capabilities } : {}),
  };
}

/** Spawnable director profiles (closed set minus primary dispatch). */
export function directorProfiles(): AgentProfile[] {
  return listDirectors()
    .filter((pkg) => pkg.id !== "dispatch")
    .map(packageToProfile);
}
