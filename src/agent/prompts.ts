import type { EnvironmentInfo } from "./environment.js";
import type { SkillSummary } from "../extensions/skills.js";
import { CORE_TOOL_NAMES } from "./tool-search.js";

// Fallback tool list for sub-agent prompts when the caller does not pass the
// installed set. Matches the leaf sub-agent install (posix + manage_tasks).
const defaultChatTools = [
  "read_file",
  "write_file",
  "edit_file",
  "run_shell",
  "search_files",
  "grep",
  "list_dir",
  "lsp",
  "manage_tasks",
];

const joinSections = (sections: string[]) => sections.join("\n\n");

function formatDateDDMMYYYY(date: Date): string {
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = String(date.getFullYear());
  return `${day}/${month}/${year}`;
}

export function buildChatRole(): string {
  return "You are Intercode, a senior coding assistant running in a terminal harness. Help the user understand, edit, and verify code.";
}

// Facts the model cannot derive from its training: what the permission layer
// blocks, what loads on demand, and the harness-specific tools. Everything a
// frontier model already knows about being a coding agent is deliberately omitted.
// `dynamicTools` controls the tool-loading fact: the main chat agent starts with
// only core tools and loads the rest via tool_search, whereas a sub-agent is
// handed its full toolset upfront and has no tool_search — telling it otherwise
// wastes turns on a tool that does not exist.
export function buildHarnessFacts(opts: { dynamicTools?: boolean; subAgent?: boolean } = {}): string {
  const dynamicTools = opts.dynamicTools ?? true;
  const subAgent = opts.subAgent ?? false;
  return [
    "Harness facts:",
    "- Change files with write_file/edit_file and remove files with delete_file; shell file-writes and deletions are blocked.",
    "- Use the provided tools for file reads/searches instead of shelling out as a substitute.",
    "- run_shell defaults to a 10s timeout; pass timeout for builds, tests, and other long commands.",
    "- Shell find, rg, and grep -r are blocked — they OOM the host. Use grep, search_files, and list_dir.",
    ...(subAgent
      ? [
          "- You share the parent session's permission gate: matching persisted grants and auto mode proceed without a new prompt; other consequential actions may require operator approval (interactive) or are denied (headless).",
        ]
      : ["- Dependency installs, paths outside the workspace, and session-state writes need operator approval."]),
    "- Attached images are native multimodal input; inspect them directly unless file-level forensics are requested.",
    ...(dynamicTools
      ? [
          "- Only the core tools below are loaded. Use tool_search to load extra capabilities from plugins or integrations when needed.",
          "- Use search_agents before dispatching named specialists or teams.",
        ]
      : ["- The tools below are your full toolset."]),
    "- Workflows run only from slash-command steps; never invent or auto-start one.",
    "- Session memory lives at .intercode/MEMORY.md; store durable preferences only, never secrets.",
    subAgent
      ? "- If permission denies an action or the brief is unclear, make a best-effort call, finish what you can, and record assumptions under Blockers — you cannot ask the parent mid-run."
      : "- If an action is blocked or the request is genuinely ambiguous, ask_operator.",
  ].join("\n");
}

export function buildGuidelines(): string {
  return [
    "Guidelines:",
    "- Be concise.",
    "- Answer questions and diagnose product or visual feedback before editing code.",
    "- For explicit coding tasks, work autonomously, stay in scope, and preserve unrelated user changes.",
    "- Use lsp for symbols, types, references, or call flow before opening large files.",
    "- Verify code changes with relevant checks before finishing when practical.",
  ].join("\n");
}

const TOOL_SUMMARIES: Record<string, string> = {
  read_file: "read a file",
  write_file: "create or overwrite a file",
  edit_file:
    "make a surgical edit (exact old_string match, or start_line/end_line line-range mode; never include read_file's NNNNNN\\t line prefix; substring failures include nearby file text)",
  run_shell: "run a shell command (builds, tests, git; 10s default timeout — pass timeout ms to override; never to read/write files, search trees, or talk to the user)",
  search_files: "find files by name or pattern (bounded; prefer over shell find)",
  grep: "search file contents (bounded; prefer over shell grep -r/rg)",
  list_dir: "list a directory's entries (use instead of ls or find)",
  lsp: "resolve symbols — goToDefinition, findReferences, hover",
  web_search: "search the web (use instead of curl or wget)",
  web_fetch: "fetch the content of a URL",
  task: "spawn a sub-agent for a self-contained job (not a checklist item)",
  search_agents: "find agent profiles by role or team before spawning with task(agent=...)",
  manage_tasks: "maintain your own work checklist (create/update status) — separate from spawning sub-agents",
  submit_output: "signal the task is complete — the only way to finish",
  ask_operator: "pause and ask the user when blocked or genuinely ambiguous",
  present: "dynamically render aligned/structured output using the layout primitives (stack/row/grid/text etc)",
  tool_search: "load more tools by capability when you need them",
  use_skill: "load a listed skill's full instructions before doing work it covers",
};

export function buildAvailableTools(tools: readonly string[] = CORE_TOOL_NAMES): string {
  const lines = tools.map((tool) => `- ${tool}: ${TOOL_SUMMARIES[tool] ?? "available"}`);
  return ["Tools:", ...lines].join("\n");
}

export function buildActiveContext(date = new Date(), cwd = process.cwd()): string {
  return [
    "Active context:",
    `Current Date: ${formatDateDDMMYYYY(date)} (prompt cache survives for <=24hr)`,
    `Working Directory: ${cwd} — this is the project root and your shell already runs here.`,
    `Memory file: ${cwd}/.intercode/MEMORY.md`,
  ].join("\n");
}

// The live environment, computed per run. This is what lets a weaker model act
// without burning turns rediscovering its own situation: where it is, what git
// looks like right now, and what sits at the top level.
export function buildEnvironmentContext(env: EnvironmentInfo): string {
  const lines = [
    "<env>",
    `Working directory: ${env.cwd} — your shell already runs here; never run pwd, ls, or find just to orient.`,
    `Platform: ${env.platform}`,
    `Current Date: ${formatDateDDMMYYYY(env.date)} (prompt cache survives for <=24hr)`,
  ];
  if (!env.isGitRepo) {
    lines.push("Git: not a git repository");
  } else if ((env.gitDirtyCount ?? 0) === 0) {
    lines.push(`Git: on ${env.gitBranch ?? "(detached HEAD)"}, working tree clean`);
  } else {
    lines.push(`Git: on ${env.gitBranch ?? "(detached HEAD)"}, ${env.gitDirtyCount} uncommitted change(s):`);
    if (env.gitStatusSummary) lines.push(env.gitStatusSummary);
  }
  if (env.topLevel) lines.push(`Top level: ${env.topLevel}`);
  lines.push(`Memory file: ${env.cwd}/.intercode/MEMORY.md`);
  lines.push("</env>");
  return lines.join("\n");
}

function contextSection(env?: EnvironmentInfo): string {
  return env ? buildEnvironmentContext(env) : buildActiveContext();
}

// The static base — role, harness facts, guidelines. A SYSTEM.md override
// (baseOverride) replaces this block wholesale while tools, env, and appended
// extensions still attach.
function baseSection(baseOverride?: string): string {
  if (baseOverride !== undefined && baseOverride.trim().length > 0) {
    return baseOverride.trim();
  }
  return joinSections([buildChatRole(), buildHarnessFacts(), buildGuidelines()]);
}

// Lazy skill listing: only names + descriptions, so the model knows what exists
// without paying for full instructions until it loads one with use_skill.
export function buildSkillsSection(skills: readonly SkillSummary[]): string {
  return [
    "Skills (call use_skill with the name to load the full instructions before doing work it covers):",
    ...skills.map((s) => `- ${s.name}: ${s.description}`),
  ].join("\n");
}

export function buildChatSystemPrompt(
  extensions?: string[],
  env?: EnvironmentInfo,
  baseOverride?: string,
  skills: readonly SkillSummary[] = [],
): string {
  const sections = [
    baseSection(baseOverride),
    buildAvailableTools(CORE_TOOL_NAMES),
  ];
  if (skills.length > 0) sections.push(buildSkillsSection(skills));
  sections.push(contextSection(env));
  if (extensions !== undefined && extensions.length > 0) {
    sections.push(...extensions);
  }
  return joinSections(sections);
}

// Notes appended to every sub-agent's system prompt so corbitsdev-format
// agent definitions translate cleanly to Intercode: the `task` tool is the
// *spawn* surface (wire name kept for compatibility), tool names are
// Intercode-native, and the upstream `mode: primary` distinction collapses.
//
// Vocabulary: an *agent* is a runtime entity; a *task* is a checklist item
// owned via manage_tasks; a *sub-agent* is a short-lived child agent. Do not
// conflate spawn with checklist.
//
// `orchestrator` flips the recursion rule: by default a sub-agent must NOT
// call `task` (no recursion past depth 1). An orchestrator profile is the
// documented exception — its purpose IS to fan work out to other agents —
// so the appendix grants permission and links the syntax.
export function buildSubAgentAppendix(opts: { orchestrator?: boolean } = {}): string {
  // Leaf agents must not be told both "spawn with task" and "do not call task".
  // Orchestrators get the spawn instruction; everyone else gets the no-recursion
  // rule only.
  const recursionRule =
    opts.orchestrator === true
      ? "- You are an orchestrator: you MAY call `task` to spawn other sub-agents (e.g. task(agent=\"greybeard\", prompt=\"...\")). This is an explicit exception to the no-recursion rule that applies to leaf sub-agents — use it to delegate specialist work, then synthesize their reports into your own. Prefer search_agents before naming a specialist. `task` spawns an agent; it is not a checklist item (use manage_tasks for your own checklist)."
      : "- Only the primary Intercode session (or an orchestrator profile) may call `task` to spawn sub-agents. You are a leaf sub-agent: return a concrete report to the caller instead of spawning further agents. Use manage_tasks for your own work checklist if the job is multi-step.";
  return [
    "## Intercode notes",
    "",
    recursionRule,
    "- Tools use Intercode names: read_file, write_file, edit_file, run_shell, search_files, grep, list_dir, lsp, manage_tasks.",
    "- Upstream `mode: primary` is not encoded — every profile here is a spawnable sub-agent definition.",
  ].join("\n");
}

// Final-reply envelope the parent can parse. Free-form prose is allowed inside
// each field; the headings are the structure.
export function buildSubAgentReportContract(): string {
  return [
    "Reporting back:",
    "- Stick to the dispatch brief. Do not invent scope or wander into unrelated work.",
    "- When done, stop calling tools and reply with ONLY this markdown envelope (prose inside each section is fine; omit empty sections rather than inventing content):",
    "",
    "## Summary",
    "One or two sentences: what you accomplished or concluded.",
    "",
    "## Findings",
    "The substance the parent needs — results, decisions, evidence.",
    "",
    "## Blockers",
    "Open questions, assumptions, or blockers. Write \"None.\" if clear.",
    "",
    "## Paths",
    "Key file paths you read or changed (one per line). Write \"None.\" if none.",
    "",
    "- This message is the only thing returned to the parent. Do not ask the parent questions; you cannot receive answers. Make the best-judgment call, act, and note assumptions under Blockers.",
  ].join("\n");
}

export function buildSubAgentSystemPrompt(
  extensions?: string[],
  env?: EnvironmentInfo,
  baseOverride?: string,
  opts: { orchestrator?: boolean; toolNames?: readonly string[] } = {},
): string {
  const base =
    baseOverride !== undefined && baseOverride.trim().length > 0
      ? baseOverride.trim()
      : joinSections([
          "You are a sub-agent — a short-lived child agent dispatched by Intercode to carry out one self-contained job autonomously. You have the full file, search, and shell toolset under the same permission policy as the parent session (saved grants and auto mode when eligible; operator approval otherwise). Finish the job and report back. Your manage_tasks checklist (if you use it) is yours alone; it is not shared with the parent.",
          buildHarnessFacts({ dynamicTools: false, subAgent: true }),
          buildGuidelines(),
          buildSubAgentReportContract(),
        ]);
  const toolListForPrompt =
    opts.toolNames && opts.toolNames.length > 0 ? opts.toolNames : defaultChatTools;
  const sections = [base, buildAvailableTools(toolListForPrompt), contextSection(env)];
  if (extensions !== undefined && extensions.length > 0) {
    sections.push(...extensions);
  }
  // Always-last: the Intercode translation notes apply to every dispatched
  // agent, regardless of whether its definition came from a JS plugin or a
  // corbitsdev-format markdown file. The orchestrator flag rewrites the
  // recursion rule for profiles whose purpose is to dispatch other agents.
  sections.push(buildSubAgentAppendix(opts));
  return joinSections(sections);
}
