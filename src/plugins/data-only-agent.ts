import { readFile, readdir } from "node:fs/promises";
import { join, basename, dirname } from "node:path";
import type {
  AgentProfile,
  CapabilityFilter,
  InferenceLeg,
  InferenceSpec,
  ReasoningEffort,
} from "../agent/profiles.js";
import { AgentProfileSchema } from "../agent/profiles.js";
import { REASONING_EFFORTS } from "../agent/profile-types.js";
import { splitFrontmatter } from "./frontmatter.js";
import { type } from "arktype";

// Reasoning-effort schema derived from the canonical array, mirroring the
// pattern in ../agent/profiles.ts (arktype's `type()` needs a literal union
// string, so a computed one is threaded through `unknown`).
const reasoningEffortLiteral = REASONING_EFFORTS.map((e) => `'${e}'`).join(" | ");
const ReasoningEffortSchema = type(reasoningEffortLiteral as unknown as "'none'");

// Shared shape for one inference leg across the two frontmatter dialects that
// carry them (native `inference.order[]` and the `model` field). Each call
// site still owns how it resolves `reasoningEffort` (own value vs. a
// top-level fallback), so that stays outside the schema.
const InferenceLegBaseSchema = type({
  provider: "string>0",
  model: "string>0",
});

// Native `capabilities: { mode, tools[] }` block. Only `mode` is
// schema-validated here; `tools` elements are filtered rather than
// whole-array-validated, so one malformed entry narrows the tool set instead
// of invalidating the entire capabilities block and falling through to
// undefined (unrestricted) access — a rejected block must never widen access.
const NativeCapabilitiesModeSchema = type("'allow' | 'exclude'");

// A data-only agent plugin is a directory containing either:
//   • an `agents/` subfolder holding `*.md` files (standard layout), or
//   • the `*.md` files directly (e.g. you point the plugin path at an `agents/`
//     folder itself).
// Optional `skills/<name>/SKILL.md` live beside the chosen agents container
// (or inside it for a flat layout). The loader recognizes it without an
// index.ts by walking the markdown files and synthesizing the same
// `agentPlugin.agents[]` shape a JS plugin would export. Validation is
// identical: every synthesized profile passes through AgentProfileSchema.
//
// Frontmatter is accepted from any of three live dialects, normalized to a
// single AgentProfile:
//
//   - Claude Code:   name, description, tools[], disallowedTools[], model, effort
//   - OpenCode:      name, description, mode, permission: { tool: "*": deny, read: allow }
//                    (legacy: tools: { read: true, bash: false })
//   - corbitsdev:    name, description, mode, color, permission: { read: "allow", bash: "deny" }
//
// Native Corbits Code keys also work and win ties: inference, capabilities,
// skills (frontmatter list, in addition to body `Load the X skill` lines).

// Upstream tool-name aliases mapped to Corbits Code tool ids. Case-insensitive.
const TOOL_ALIASES: Record<string, readonly string[]> = {
  read: ["read_file"],
  write: ["write_file"],
  edit: ["edit_file"],
  bash: ["run_shell"],
  shell: ["run_shell"],
  glob: ["search_files"],
  find: ["search_files"],
  grep: ["grep"],
  ls: ["list_dir"],
  task: ["spawn_agent", "wait_agents"],
  subagent: ["spawn_agent", "wait_agents"],
  websearch: ["web_search"],
  webfetch: ["web_fetch"],
  fetch: ["web_fetch"],
  lsp: ["lsp"],
};

function aliasTools(raw: string): string[] {
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();
  if (lower.length === 0) return [raw];
  return [...(TOOL_ALIASES[lower] ?? [trimmed])];
}

function isReasoningEffort(v: unknown): v is ReasoningEffort {
  return !(ReasoningEffortSchema(v) instanceof type.errors);
}

// Resolve the agent id: frontmatter `id` wins, then `name`, then the file stem.
function pickId(fm: Record<string, unknown> | null, filename: string): string | undefined {
  if (fm !== null) {
    const fromId = typeof fm.id === "string" ? fm.id.trim() : "";
    if (fromId.length > 0) return fromId;
    const fromName = typeof fm.name === "string" ? fm.name.trim() : "";
    if (fromName.length > 0) return fromName;
  }
  // Filename stem (karen.md -> karen).
  const base = filename.replace(/\.md$/i, "");
  return base.length > 0 ? base : undefined;
}

// Normalize the union of `tools` / `disallowedTools` / `permission` shapes from
// the three dialects into a single CapabilityFilter. Returns undefined when no
// restriction was declared (agent inherits all tools).
function normalizeCapabilities(fm: Record<string, unknown> | null): CapabilityFilter | undefined {
  if (fm === null) return undefined;

  // Native: capabilities: { mode, tools[] } — mode must validate, but tools
  // elements are filtered individually so a stray non-string entry restricts
  // rather than rejecting the whole block (see NativeCapabilitiesModeSchema).
  if (
    fm.capabilities !== undefined &&
    typeof fm.capabilities === "object" &&
    fm.capabilities !== null
  ) {
    const cap = fm.capabilities as { mode?: unknown; tools?: unknown };
    const mode = NativeCapabilitiesModeSchema(cap.mode);
    if (!(mode instanceof type.errors) && Array.isArray(cap.tools)) {
      return {
        mode,
        tools: cap.tools.filter((t): t is string => typeof t === "string").flatMap(aliasTools),
      };
    }
  }

  // Claude Code: tools: [Read, Grep]  (allowlist)
  if (Array.isArray(fm.tools) && fm.tools.length > 0 && fm.disallowedTools === undefined) {
    const tools = fm.tools.filter((t): t is string => typeof t === "string").flatMap(aliasTools);
    if (tools.length > 0) return { mode: "allow", tools };
  }

  // Claude Code: disallowedTools: [...]  (denylist → exclude mode)
  if (Array.isArray(fm.disallowedTools) && fm.disallowedTools.length > 0) {
    const tools = fm.disallowedTools
      .filter((t): t is string => typeof t === "string")
      .flatMap(aliasTools);
    if (tools.length > 0) return { mode: "exclude", tools };
  }

  // OpenCode legacy: tools: { read: true, bash: false }
  // Pick the smaller set: if false-list is shorter, use exclude; else allow.
  if (
    fm.tools !== undefined &&
    typeof fm.tools === "object" &&
    fm.tools !== null &&
    !Array.isArray(fm.tools)
  ) {
    const map = fm.tools as Record<string, unknown>;
    const allowed: string[] = [];
    const excluded: string[] = [];
    for (const [k, v] of Object.entries(map)) {
      if (v === true) allowed.push(...aliasTools(k));
      else if (v === false) excluded.push(...aliasTools(k));
    }
    if (allowed.length > 0 && excluded.length === 0) return { mode: "allow", tools: allowed };
    if (excluded.length > 0 && allowed.length === 0) return { mode: "exclude", tools: excluded };
    if (allowed.length > 0 && excluded.length > 0) {
      // Mixed: pick whichever is shorter to minimize the filter size.
      return excluded.length <= allowed.length
        ? { mode: "exclude", tools: excluded }
        : { mode: "allow", tools: allowed };
    }
  }

  // corbitsdev / OpenCode permission: flat or nested map of allow/deny values.
  // `mode: primary` upstream means "the host granted the agent its full set of
  // tools" — so allow entries are descriptive, not restrictive, and would
  // wrongly narrow the agent to only the listed tools. Deny entries are real
  // restrictions and stay. (Subagents' allow entries are real allowlists
  // because there's no inheritance intent.)
  if (fm.permission !== undefined && typeof fm.permission === "object" && fm.permission !== null) {
    const isPrimary = fm.mode === "primary" || fm.mode === "all";
    if (!isPrimary) {
      return normalizePermission(fm.permission as Record<string, unknown>);
    }
    const fromPermission = normalizePermission(fm.permission as Record<string, unknown>);
    if (fromPermission === undefined) return undefined;
    if (fromPermission.mode === "exclude") return fromPermission; // deny list — keep
    // primary + allow list → agent inherits all tools (no restriction).
    return undefined;
  }

  return undefined;
}

// Permission accepts two shapes:
//   flat (corbitsdev):     { read: "allow", bash: "deny", write: "allow" }
//   nested (OpenCode):     { tool: { "*": "deny", read: "allow" } }
// Resource types other than "tool" (skill, mcp) are ignored in v1.
function normalizePermission(perm: Record<string, unknown>): CapabilityFilter | undefined {
  let flat: Record<string, unknown> | undefined;

  if (perm.tool !== undefined && typeof perm.tool === "object" && perm.tool !== null) {
    flat = perm.tool as Record<string, unknown>;
  } else {
    // flat shape — every value should be "allow" / "deny" / "ask".
    const values = Object.values(perm);
    const looksFlat = values.every((v) => typeof v === "string");
    if (looksFlat) flat = perm;
  }
  if (flat === undefined) return undefined;

  const hasWildcardDeny = flat["*"] === "deny" || flat["**"] === "deny";
  const allowed: string[] = [];
  const denied: string[] = [];
  for (const [k, v] of Object.entries(flat)) {
    if (k === "*" || k === "**") continue;
    if (v === "allow") allowed.push(...aliasTools(k));
    else if (v === "deny") denied.push(...aliasTools(k));
    // "ask" is treated as allowed for v1 — the ask-vs-allow distinction needs
    // a permission UI that doesn't exist for sub-agents yet.
    else if (v === "ask") allowed.push(...aliasTools(k));
  }

  if (hasWildcardDeny && allowed.length > 0) {
    return { mode: "allow", tools: allowed };
  }
  if (denied.length > 0) return { mode: "exclude", tools: denied };
  if (allowed.length > 0) return { mode: "allow", tools: allowed };
  return undefined;
}

// Normalize the union of `model` / `effort` / `inference` shapes into an
// explicit InferenceSpec. Native `inference` wins; then `model` (object or
// array) with optional `effort` applied to legs that don't declare their own.
//
// A bare Claude Code `effort: high` with no `model` has nothing to attach the
// effort to now that tiers (which used to map effort to a model swap) are
// gone, so it is ignored — set `model` alongside `effort` to pin both.
function normalizeInference(fm: Record<string, unknown> | null): { inference?: InferenceSpec } {
  if (fm === null) return {};

  // Native explicit inference spec.
  if (fm.inference !== undefined && typeof fm.inference === "object" && fm.inference !== null) {
    const spec = normalizeInferenceSpec(fm.inference as Record<string, unknown>);
    if (spec !== undefined) return { inference: spec };
  }

  // `model` block: object, array, or (rejected in v1) string.
  if (fm.model !== undefined) {
    const spec = normalizeModelField(fm.model, fm.effort);
    if (spec !== undefined) return { inference: spec };
  }

  return {};
}

function normalizeInferenceSpec(raw: Record<string, unknown>): InferenceSpec | undefined {
  const orderRaw = raw.order;
  if (!Array.isArray(orderRaw)) return undefined;
  const order: InferenceLeg[] = [];
  for (const leg of orderRaw) {
    const base = InferenceLegBaseSchema(leg);
    if (base instanceof type.errors) continue;
    const entry: InferenceLeg = { provider: base.provider, model: base.model };
    const reasoningEffort = (leg as { reasoningEffort?: unknown }).reasoningEffort;
    if (isReasoningEffort(reasoningEffort)) entry.reasoningEffort = reasoningEffort;
    order.push(entry);
  }
  if (order.length === 0) return undefined;
  const mode = raw.mode === "pin" ? "pin" : "prefer";
  return { mode, order };
}

// Accept either a single leg object or an array of legs. An optional top-level
// `effort` is applied to legs that don't declare their own.
function normalizeModelField(model: unknown, effort: unknown): InferenceSpec | undefined {
  const legs: InferenceLeg[] = [];

  const asLeg = (raw: unknown): InferenceLeg | undefined => {
    const base = InferenceLegBaseSchema(raw);
    if (base instanceof type.errors) return undefined;
    const leg: InferenceLeg = { provider: base.provider, model: base.model };
    const effortForLeg = (raw as { reasoningEffort?: unknown }).reasoningEffort ?? effort;
    if (isReasoningEffort(effortForLeg)) leg.reasoningEffort = effortForLeg;
    return leg;
  };

  if (Array.isArray(model)) {
    for (const m of model) {
      const leg = asLeg(m);
      if (leg !== undefined) legs.push(leg);
    }
  } else {
    const leg = asLeg(model);
    if (leg !== undefined) legs.push(leg);
  }

  if (legs.length === 0) return undefined;
  return { mode: "prefer", order: legs };
}

// Appendix injected into every data-only agent's system prompt so the upstream
// markdown does not need to know Corbits Code-specific tool names or task rules.
// Resolve a skill body via the shared skill resolver so data-only plugins and
// the main session's `use_skill` tool agree on what a skill name means. The
// plugin's own skills/ directory is prepended to the search path so it shadows
// same-named skills from project-local directories.
import { resolveSkillBody } from "../extensions/skills.js";

async function loadSkillText(
  cwd: string,
  skillName: string,
  pluginDir: string,
  extraPluginDirs: readonly string[],
): Promise<string | undefined> {
  // resolveSkillBody prepends `<pluginDir>/skills` for each entry in pluginDirs.
  // Prepend the data-only plugin's own directory so its skills/ wins.
  // Path-like refs (`./skills/style`) resolve under pluginDir only.
  return resolveSkillBody(cwd, skillName, [pluginDir, ...extraPluginDirs], {
    pluginRoot: pluginDir,
  });
}

// Parse "Load the `style` skill" lines from the body. corbitsdev agents declare
// skills in prose rather than frontmatter; this recognizes that convention so
// those files can load co-located or project-provided skills without modification.
function parseSkillReferencesFromBody(body: string): string[] {
  const out: string[] = [];
  // Match: load the `style` skill  /  Load the \`philosophy\` skill
  const re = /\bload\s+the\s+`([a-z0-9_-]+)`\s+skill\b/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    out.push(match[1]!);
  }
  return out;
}

export interface DataOnlyAgentPlugin {
  manifest: { id: string; name: string; kind: "agent"; description?: string };
  agentPlugin: { agents: unknown[] };
}

// Build a data-only agent plugin module from a directory containing agents/*.md.
// Returns null if the directory has no usable agent files.
//
// `pluginId` defaults to the directory basename; an explicit id can be supplied
// by the caller (e.g. read from a sibling plugin.yaml in the future).
export async function loadDataOnlyAgentPlugin(
  pluginDir: string,
  options?: {
    pluginId?: string;
    cwd?: string;
    skillSearchDirs?: readonly string[];
    onWarning?: (msg: string) => void;
  },
): Promise<DataOnlyAgentPlugin | null> {
  // Support two layouts:
  // 1. pluginDir/agents/*.md  (typical)
  // 2. pluginDir/*.md directly (when the given path points at agents/ itself)
  // Pick the skills root so skills/ is found sibling to the agents container.
  let agentsContainer = join(pluginDir, "agents");
  let pluginRoot = pluginDir;
  let entries: string[];
  try {
    entries = await readdir(agentsContainer);
  } catch {
    agentsContainer = pluginDir;
    try {
      entries = await readdir(agentsContainer);
    } catch {
      return null;
    }
    if (basename(agentsContainer) === "agents") {
      pluginRoot = dirname(agentsContainer);
    }
  }
  const mdFiles = entries.filter((f) => /\.md$/i.test(f));
  if (mdFiles.length === 0) return null;

  const cwd = options?.cwd ?? process.cwd();
  const extraPluginDirs = options?.skillSearchDirs ?? [];

  const agents: unknown[] = [];
  for (const filename of mdFiles) {
    const fullPath = join(agentsContainer, filename);
    const warning = options?.onWarning;
    let raw: string;
    try {
      raw = await readFile(fullPath, "utf8");
    } catch (err) {
      warning?.(`failed to read ${filename}: ${String(err)}`);
      continue;
    }
    const { frontmatter, body } = splitFrontmatter(raw);
    if (frontmatter === null) {
      warning?.(`skipping ${filename}: malformed frontmatter`);
      continue;
    }
    const id = pickId(frontmatter, filename);
    if (id === undefined) {
      warning?.(`skipping ${filename}: no id and unrecognizable filename`);
      continue;
    }
    const description =
      typeof frontmatter.description === "string" ? frontmatter.description : undefined;

    // Skill names: frontmatter list wins; fall back to body references.
    const fmSkillsRaw = frontmatter.skills;
    let skillNames: string[] = [];
    if (Array.isArray(fmSkillsRaw)) {
      skillNames = fmSkillsRaw.filter((s): s is string => typeof s === "string");
    } else if (typeof fmSkillsRaw === "string") {
      skillNames = [fmSkillsRaw];
    }
    if (skillNames.length === 0) {
      skillNames = parseSkillReferencesFromBody(body);
    }

    // Bundle skills as text prepended to the prompt body.
    const skillBlocks: string[] = [];
    for (const name of skillNames) {
      const text = await loadSkillText(cwd, name, pluginRoot, extraPluginDirs);
      if (text === undefined) {
        warning?.(`agent ${id}: skill "${name}" referenced but not found in skill search path`);
        continue;
      }
      skillBlocks.push(`# Bundled skill: ${name}\n\n${text}`);
    }

    const promptBody =
      skillBlocks.length > 0 ? `${skillBlocks.join("\n\n---\n\n")}\n\n---\n\n${body}` : body;
    // The Corbits Code translation appendix is appended at prompt-build time by
    // buildSubAgentSystemPrompt, so the systemPromptRole stays focused on the
    // agent's own definition (skills + body) and the appendix applies uniformly
    // to JS-plugin agents too.
    const systemPromptRole = promptBody;

    const { inference } = normalizeInference(frontmatter);
    const capabilities = normalizeCapabilities(frontmatter);

    const profile: Record<string, unknown> = { id };
    if (description !== undefined) profile.description = description;
    if (inference !== undefined) profile.inference = inference;
    if (capabilities !== undefined) profile.capabilities = capabilities;
    // Preserve the declaration for schema/search visibility. Dispatch rejects
    // profile orchestrators until profile-sourced tiers have authority semantics.
    // Do not infer this from `mode: primary`; primary also means inherit tools.
    if (frontmatter.orchestrator === true) profile.orchestrator = true;
    profile.systemPromptRole = systemPromptRole;

    // Schema-validate the synthesized profile. Same path as JS plugins, so a
    // malformed entry is skipped instead of reaching the dispatcher.
    const result = AgentProfileSchema(profile);
    if (result instanceof type.errors) {
      warning?.(`skipping ${id}: profile failed schema validation: ${result.summary}`);
      continue;
    }
    agents.push(result as AgentProfile);
  }

  if (agents.length === 0) return null;

  const pluginId = options?.pluginId ?? basename(pluginRoot);
  return {
    manifest: {
      id: pluginId,
      name: pluginId,
      kind: "agent",
    },
    agentPlugin: { agents },
  };
}
