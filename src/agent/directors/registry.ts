import {
  DIRECTOR_IDS,
  type DirectorId,
  type DirectorPackage,
  type ResolveDirectorInput,
  type ResolveDirectorResult,
  type TaskIntent,
} from "./types.js";

/**
 * Closed v1 registry. Packages are filled in by later director tickets;
 * Level 1 only owns the closed id set + resolve rules (CL-5818).
 */
const PLACEHOLDER_REPORT = {
  requiredSections: ["Summary", "Findings", "Blockers", "Paths"],
} as const;

function placeholder(pkg: Omit<DirectorPackage, "report"> & { report?: DirectorPackage["report"] }): DirectorPackage {
  return {
    ...pkg,
    report: pkg.report ?? PLACEHOLDER_REPORT,
  };
}

/** Intent → default director when `task(agent=…)` is omitted. No general director. */
export const INTENT_DEFAULT_DIRECTOR: Readonly<Record<Exclude<TaskIntent, "general">, DirectorId>> = {
  implement: "implement",
  explore: "explore",
  plan: "plan",
  review: "critique",
};

/**
 * Placeholder packages so the closed set typechecks and resolve works before
 * leaf tickets land full prompts. Leaf PRs replace entries in place.
 */
export const DIRECTOR_REGISTRY: Readonly<Record<DirectorId, DirectorPackage>> = {
  skywalker: placeholder({
    id: "skywalker",
    primaryIntent: "Orchestrate only — triage and dispatch; do not implement product code",
    outOfLane: ["product edits", "deep repo walks when dispatch is available"],
    description: "Primary orchestration director (Karen-shaped)",
    systemPrompt: "Placeholder — CL-5817 fills Skywalker from karen.md.",
    spawn: { maySpawn: true },
    modelRole: "orchestrator",
  }),
  implement: placeholder({
    id: "implement",
    primaryIntent: "Ship product code with tests",
    outOfLane: ["architecture gates", "docs-only work"],
    description: "Implementation leaf",
    systemPrompt: "Placeholder — CL-5825 fills Implement.",
    spawn: { maySpawn: false },
    modelRole: "implement",
  }),
  explore: placeholder({
    id: "explore",
    primaryIntent: "Map and read the codebase; no product edits",
    outOfLane: ["product write paths", "drive-by fixes"],
    description: "Read-only exploration leaf",
    systemPrompt: "Placeholder — CL-5823 fills Explore.",
    tools: { deny: ["write_file", "edit_file", "delete_file"] },
    spawn: { maySpawn: false },
    modelRole: "explore",
  }),
  plan: placeholder({
    id: "plan",
    primaryIntent: "Author eng change plans; do not implement",
    outOfLane: ["shipping code", "architecture gate sign-off"],
    description: "Planning leaf",
    systemPrompt: "Placeholder — CL-5838 fills Plan.",
    spawn: { maySpawn: false },
    modelRole: "plan",
  }),
  intern: placeholder({
    id: "intern",
    primaryIntent: "Mechanical shell/commands only",
    outOfLane: ["design judgment", "product edits without explicit brief"],
    description: "Mechanical intern leaf",
    systemPrompt: "Placeholder — CL-5822 fills Intern.",
    spawn: { maySpawn: false },
    modelRole: "implement",
  }),
  critique: placeholder({
    id: "critique",
    primaryIntent: "Evidence-based code review; never fix product code",
    outOfLane: ["applying fixes", "architecture ownership"],
    description: "Code quality review leaf",
    systemPrompt: "Placeholder — CL-5819 fills Critique.",
    tools: { deny: ["write_file", "edit_file", "delete_file"] },
    spawn: { maySpawn: false },
    modelRole: "review",
  }),
  greybeard: placeholder({
    id: "greybeard",
    primaryIntent: "Architecture review; limited spawn",
    outOfLane: ["shipping product code", "pedantic style-only nitpicking"],
    description: "Architecture review leaf",
    systemPrompt: "Placeholder — CL-5821 fills Greybeard.",
    spawn: { maySpawn: true, allowlist: ["intern", "explore", "critique"] },
    modelRole: "review",
  }),
  neckbeard: placeholder({
    id: "neckbeard",
    primaryIntent: "Adversarial pedantic review; never fix",
    outOfLane: ["applying fixes", "product implementation"],
    description: "Adversarial review leaf",
    systemPrompt: "Placeholder — CL-5820 fills Neckbeard.",
    tools: { deny: ["write_file", "edit_file", "delete_file"] },
    spawn: { maySpawn: false },
    modelRole: "review",
  }),
  bruckheimer: placeholder({
    id: "bruckheimer",
    primaryIntent: "Product discovery docs",
    outOfLane: ["shipping product code", "architecture gates"],
    description: "Product discovery leaf",
    systemPrompt: "Placeholder — CL-5824 fills Bruckheimer.",
    spawn: { maySpawn: false },
    modelRole: "docs",
  }),
  gaasbot: placeholder({
    id: "gaasbot",
    primaryIntent: "CTO advice; not a gate",
    outOfLane: ["blocking merges", "shipping product code as implementer"],
    description: "CTO advice leaf",
    systemPrompt: "Placeholder — CL-5826 fills Gaasbot.",
    spawn: { maySpawn: false },
    modelRole: "plan",
  }),
  draper: placeholder({
    id: "draper",
    primaryIntent: "Product visual/CBS critique from a development perspective",
    outOfLane: ["shipping product code", "marketing copy pipeline"],
    description: "Visual/CBS critique leaf (dev-scoped)",
    systemPrompt: "Placeholder — CL-5830 fills Draper.",
    tools: { deny: ["write_file", "edit_file", "delete_file"] },
    spawn: { maySpawn: false },
    modelRole: "review",
  }),
  emil: placeholder({
    id: "emil",
    primaryIntent: "Design-engineering + laws from a development perspective",
    outOfLane: ["shipping product code without design brief", "marketing content"],
    description: "Design-engineering leaf (dev-scoped)",
    systemPrompt: "Placeholder — CL-5827 fills Emil.",
    tools: { deny: ["write_file", "edit_file", "delete_file"] },
    spawn: { maySpawn: false },
    modelRole: "review",
  }),
  "brand-reviewer": placeholder({
    id: "brand-reviewer",
    primaryIntent: "Own DESIGN.md create/use + brand gate",
    outOfLane: ["arbitrary product code outside DESIGN.md"],
    description: "DESIGN.md brand gate leaf",
    systemPrompt: "Placeholder — CL-5829 fills Brand Reviewer.",
    spawn: { maySpawn: false },
    modelRole: "docs",
  }),
  shakespeare: placeholder({
    id: "shakespeare",
    primaryIntent: "Maintain product/architecture/implementation docs; scribe baked in",
    outOfLane: ["shipping product code", "architecture gates"],
    description: "Docs scribe leaf",
    systemPrompt: "Placeholder — CL-5845 fills Shakespeare (scribe core).",
    spawn: { maySpawn: false },
    modelRole: "docs",
  }),
  testsmith: placeholder({
    id: "testsmith",
    primaryIntent: "Test design only; do not run or fix product",
    outOfLane: ["runtime verification", "product implementation"],
    description: "Test design leaf",
    systemPrompt: "Placeholder — CL-5842 fills Testsmith.",
    spawn: { maySpawn: false },
    modelRole: "test",
  }),
  tester: placeholder({
    id: "tester",
    primaryIntent: "Runtime verify; never fix product code",
    outOfLane: ["applying product fixes", "test design authorship"],
    description: "Runtime verification leaf",
    systemPrompt: "Placeholder — CL-5844 fills Tester.",
    tools: { deny: ["write_file", "edit_file", "delete_file"] },
    spawn: { maySpawn: false },
    modelRole: "test",
  }),
};

export function isDirectorId(value: unknown): value is DirectorId {
  return typeof value === "string" && (DIRECTOR_IDS as readonly string[]).includes(value);
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
      error: "intent=general has no director.",
      hint: "Reclassify the work to implement, explore, plan, or review (or pass agent=…).",
    };
  }
  const id = INTENT_DEFAULT_DIRECTOR[intent];
  return { ok: true, package: DIRECTOR_REGISTRY[id] };
}
