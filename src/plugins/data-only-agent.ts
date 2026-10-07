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
import { WIRE_TO_ENGINE, HIDDEN_TO_ENGINE } from "../agent/tool-aliases.js";

// Literal union built from REASONING_EFFORTS, same pattern as
// ../agent/profiles.ts (arktype needs a literal union string, so the computed
// one is threaded through `unknown`).
const reasoningEffortLiteral = REASONING_EFFORTS.map((e) => `'${e}'`).join(
  " | ",
);
const ReasoningEffortSchema = type(
  reasoningEffortLiteral as unknown as "'none'",
);

// Shared shape of one inference leg for the `inference.order[]` and `model`
// dialects. `reasoningEffort` resolution differs per call site (own value vs.
// top-level fallback), so it stays outside the schema.
const InferenceLegBaseSchema = type({
  provider: "string>0",
  model: "string>0",
});

// Native `capabilities: { mode, tools[] }` block. Only `mode` is
// schema-validated; `tools` elements are filtered individually, so one
// malformed entry narrows the tool set instead of invalidating the block and
// falling through to unrestricted access.
const NativeCapabilitiesModeSchema = type("'allow' | 'exclude'");

// A data-only agent plugin is a directory of `*.md` agent files under an
// `agents/` subfolder (standard) or directly (the plugin path can point at an
// agents/ folder itself). No index.ts: the loader walks the markdown,
// synthesizes the same `agentPlugin.agents[]` shape a JS plugin exports, and
// validates every profile through AgentProfileSchema. Optional
// `skills/<name>/SKILL.md` live beside the agents container (or inside it for
// a flat layout).
//
// Frontmatter from any of three live dialects is normalized to one AgentProfile:
//
//   - Claude Code:   name, description, tools[], disallowedTools[], model, effort
//   - OpenCode:      name, description, mode, permission: { tool: { "*": "deny", read: "allow" } }
//                    (legacy: tools: { read: true, bash: false })
//   - corbitsdev:    name, description, mode, color, permission: { read: "allow", bash: "deny" }
//
// Native Corbits Code keys (inference, capabilities, skills) also work and win
// ties; skills additionally come from body `Load the X skill` lines.

// Upstream tool-name aliases -> Corbits Code engine ids, case-insensitive.
// Posix wire/hidden names come from the shared alias table.
const TOOL_ALIASES: Record<string, readonly string[]> = {
  ...Object.fromEntries(
    Object.entries({ ...WIRE_TO_ENGINE, ...HIDDEN_TO_ENGINE }).map(
      ([alias, engine]) => [alias, [engine]],
    ),
  ),
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
function pickId(
  fm: Record<string, unknown> | null,
  filename: string,
): string | undefined {
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

// Normalize the dialects' `tools` / `disallowedTools` / `permission` shapes
// into one CapabilityFilter; undefined means no restriction declared (the
// agent inherits all tools).
function normalizeCapabilities(
  fm: Record<string, unknown> | null,
): CapabilityFilter | undefined {
  if (fm === null) return undefined;

  // Native: mode must validate, tools elements filtered individually so a
  // stray non-string entry restricts rather than rejecting the block (see
  // NativeCapabilitiesModeSchema).
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
        tools: cap.tools
          .filter((t): t is string => typeof t === "string")
          .flatMap(aliasTools),
      };
    }
  }

  // Claude Code: tools: [Read, Grep]  (allowlist)
  if (
    Array.isArray(fm.tools) &&
    fm.tools.length > 0 &&
    fm.disallowedTools === undefined
  ) {
    const tools = fm.tools
      .filter((t): t is string => typeof t === "string")
      .flatMap(aliasTools);
    if (tools.length > 0) return { mode: "allow", tools };
  }

  // Claude Code: disallowedTools: [...]  (denylist → exclude mode)
  if (Array.isArray(fm.disallowedTools) && fm.disallowedTools.length > 0) {
    const tools = fm.disallowedTools
      .filter((t): t is string => typeof t === "string")
      .flatMap(aliasTools);
    if (tools.length > 0) return { mode: "exclude", tools };
  }

  // OpenCode legacy tools map: pick the smaller set — exclude when the
  // false-list is shorter, else allow.
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
    if (allowed.length > 0 && excluded.length === 0)
      return { mode: "allow", tools: allowed };
    if (excluded.length > 0 && allowed.length === 0)
      return { mode: "exclude", tools: excluded };
    if (allowed.length > 0 && excluded.length > 0) {
      return excluded.length <= allowed.length
        ? { mode: "exclude", tools: excluded }
        : { mode: "allow", tools: allowed };
    }
  }

  // corbitsdev / OpenCode permission map. `mode: primary` means the host
  // granted the full tool set, so allow entries are descriptive and would
  // wrongly narrow the agent to the listed tools; deny entries are real
  // restrictions and stay. (Subagent allow entries are real allowlists — no
  // inheritance intent.)
  if (
    fm.permission !== undefined &&
    typeof fm.permission === "object" &&
    fm.permission !== null
  ) {
    const isPrimary = fm.mode === "primary" || fm.mode === "all";
    if (!isPrimary) {
      return normalizePermission(fm.permission as Record<string, unknown>);
    }
    const fromPermission = normalizePermission(
      fm.permission as Record<string, unknown>,
    );
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
// Non-tool resource types (skill, mcp) are ignored in v1.
function normalizePermission(
  perm: Record<string, unknown>,
): CapabilityFilter | undefined {
  let flat: Record<string, unknown> | undefined;

  if (
    perm.tool !== undefined &&
    typeof perm.tool === "object" &&
    perm.tool !== null
  ) {
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
    // "ask" counts as allowed for v1: telling them apart needs a permission
    // UI that sub-agents don't have yet.
    else if (v === "ask") allowed.push(...aliasTools(k));
  }

  if (hasWildcardDeny && allowed.length > 0) {
    return { mode: "allow", tools: allowed };
  }
  if (denied.length > 0) return { mode: "exclude", tools: denied };
  if (allowed.length > 0) return { mode: "allow", tools: allowed };
  return undefined;
}

// Normalize `model` / `effort` / `inference` into an explicit InferenceSpec.
// Native `inference` wins; else `model` (object or array), with `effort`
// applied to legs that don't declare their own. A bare `effort` with no
// `model` has nothing to attach to, so it is ignored.
function normalizeInference(fm: Record<string, unknown> | null): {
  inference?: InferenceSpec;
} {
  if (fm === null) return {};

  // Native explicit inference spec.
  if (
    fm.inference !== undefined &&
    typeof fm.inference === "object" &&
    fm.inference !== null
  ) {
    const spec = normalizeInferenceSpec(
      fm.inference as Record<string, unknown>,
    );
    if (spec !== undefined) return { inference: spec };
  }

  // `model` block: object, array, or (rejected in v1) string.
  if (fm.model !== undefined) {
    const spec = normalizeModelField(fm.model, fm.effort);
    if (spec !== undefined) return { inference: spec };
  }

  return {};
}

function normalizeInferenceSpec(
  raw: Record<string, unknown>,
): InferenceSpec | undefined {
  const orderRaw = raw.order;
  if (!Array.isArray(orderRaw)) return undefined;
  const order: InferenceLeg[] = [];
  for (const leg of orderRaw) {
    const base = InferenceLegBaseSchema(leg);
    if (base instanceof type.errors) continue;
    const entry: InferenceLeg = { provider: base.provider, model: base.model };
    const reasoningEffort = (leg as { reasoningEffort?: unknown })
      .reasoningEffort;
    if (isReasoningEffort(reasoningEffort))
      entry.reasoningEffort = reasoningEffort;
    order.push(entry);
  }
  if (order.length === 0) return undefined;
  const mode = raw.mode === "pin" ? "pin" : "prefer";
  return { mode, order };
}

// Single leg object or array; top-level `effort` applies to legs that don't
// declare their own.
function normalizeModelField(
  model: unknown,
  effort: unknown,
): InferenceSpec | undefined {
  const legs: InferenceLeg[] = [];

  const asLeg = (raw: unknown): InferenceLeg | undefined => {
    const base = InferenceLegBaseSchema(raw);
    if (base instanceof type.errors) return undefined;
    const leg: InferenceLeg = { provider: base.provider, model: base.model };
    const effortForLeg =
      (raw as { reasoningEffort?: unknown }).reasoningEffort ?? effort;
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

// Appendix injected into every data-only agent's prompt so upstream markdown
// need not know Corbits-specific tool names or task rules. Skill bodies go
// through the shared skill resolver so data-only plugins and the session's
// `use_skill` agree on skill names; the plugin's own skills/ is prepended to
// the search path so it shadows same-named project-local skills.
import { resolveSkillBody } from "../extensions/skills.js";

async function loadSkillText(
  cwd: string,
  skillName: string,
  pluginDir: string,
  extraPluginDirs: readonly string[],
): Promise<string | undefined> {
  // resolveSkillBody prepends `<pluginDir>/skills` for each pluginDirs entry;
  // the data-only plugin's own directory goes first so its skills/ wins.
  // Path-like refs (`./skills/style`) resolve under pluginDir only.
  return resolveSkillBody(cwd, skillName, [pluginDir, ...extraPluginDirs], {
    pluginRoot: pluginDir,
  });
}

// Parse "Load the `style` skill" lines from the body — corbitsdev agents
// declare skills in prose, not frontmatter.
function parseSkillReferencesFromBody(body: string): string[] {
  const out: string[] = [];
  // Match: load the `style` skill  /  Load the \`philosophy\` skill
  const re = /\bload\s+the\s+`([a-z0-9_-]+)`\s+skill\b/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    const name = match[1];
    if (name !== undefined) out.push(name);
  }
  return out;
}

export interface DataOnlyAgentPlugin {
  manifest: { id: string; name: string; kind: "agent"; description?: string };
  agentPlugin: { agents: unknown[] };
}

// Build a data-only agent plugin from a directory of agents/*.md; null when
// there are no usable agent files. pluginId defaults to the directory
// basename; callers may pass an explicit one.
export async function loadDataOnlyAgentPlugin(
  pluginDir: string,
  options?: {
    pluginId?: string;
    cwd?: string;
    skillSearchDirs?: readonly string[];
    onWarning?: (msg: string) => void;
  },
): Promise<DataOnlyAgentPlugin | null> {
  // Two layouts: pluginDir/agents/*.md (typical) or pluginDir/*.md directly
  // (the path can point at agents/ itself). pluginRoot is the parent of the
  // agents container so skills/ is found sibling to it.
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
      typeof frontmatter.description === "string"
        ? frontmatter.description
        : undefined;

    // Skill names: frontmatter list wins; fall back to body references.
    const fmSkillsRaw = frontmatter.skills;
    let skillNames: string[] = [];
    if (Array.isArray(fmSkillsRaw)) {
      skillNames = fmSkillsRaw.filter(
        (s): s is string => typeof s === "string",
      );
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
        warning?.(
          `agent ${id}: skill "${name}" referenced but not found in skill search path`,
        );
        continue;
      }
      skillBlocks.push(`# Bundled skill: ${name}\n\n${text}`);
    }

    const promptBody =
      skillBlocks.length > 0
        ? `${skillBlocks.join("\n\n---\n\n")}\n\n---\n\n${body}`
        : body;
    // The translation appendix is appended at prompt-build time by
    // buildSubAgentSystemPrompt, so systemPromptRole stays the agent's own
    // definition (skills + body) and JS-plugin agents get the same appendix.
    const systemPromptRole = promptBody;

    const { inference } = normalizeInference(frontmatter);
    const capabilities = normalizeCapabilities(frontmatter);

    const profile: Record<string, unknown> = { id };
    if (description !== undefined) profile.description = description;
    if (inference !== undefined) profile.inference = inference;
    if (capabilities !== undefined) profile.capabilities = capabilities;
    // Preserve the declaration for schema/search visibility; dispatch rejects
    // profile orchestrators until profile-sourced tiers get authority
    // semantics. Not inferred from `mode: primary` — primary also means
    // inherit tools.
    if (frontmatter.orchestrator === true) profile.orchestrator = true;
    profile.systemPromptRole = systemPromptRole;

    // Same validation path as JS plugins: a malformed entry is skipped, not
    // dispatched.
    const result = AgentProfileSchema(profile);
    if (result instanceof type.errors) {
      warning?.(
        `skipping ${id}: profile failed schema validation: ${result.summary}`,
      );
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
