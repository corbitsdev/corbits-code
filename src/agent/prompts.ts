import type { EnvironmentInfo } from "./environment.js";
import type { SkillSummary } from "../extensions/skills.js";
import { CORE_TOOL_NAMES } from "./tool-search.js";

const defaultChatTools = [
  "read_file",
  "write_file",
  "edit_file",
  "run_shell",
  "search_files",
  "grep",
  "list_dir",
  "lsp",
];

const joinSections = (sections: string[]) => sections.join("\n\n");

function formatDateDDMMYYYY(date: Date): string {
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = String(date.getFullYear());
  return `${day}/${month}/${year}`;
}

export function buildChatRole(): string {
  return "You are Intercode, a senior engineer pairing with a teammate on this repo. Work autonomously with tools; answer briefly in prose when no action is needed. Leave the tree working — changes a senior teammate would approve without rework.";
}

// Facts the model cannot derive from its training: what the permission layer
// blocks, what loads on demand, and the harness-specific tools. Everything a
// frontier model already knows about being a coding agent is deliberately omitted.
// `dynamicTools` controls the tool-loading fact: the main chat agent starts with
// only core tools and loads the rest via tool_search, whereas a sub-agent is
// handed its full toolset upfront and has no tool_search — telling it otherwise
// wastes turns on a tool that does not exist.
export function buildHarnessFacts(opts: { dynamicTools?: boolean } = {}): string {
  const dynamicTools = opts.dynamicTools ?? true;
  return [
    "Harness facts:",
    "- Change files with write_file/edit_file. Shell file-writes (redirects, tee, sed -i, interpreter scripts) are blocked and will not run.",
    "- Use read_file/list_dir/search_files/grep, not cat/ls/find.",
    "- Attached images are native multimodal input. Do not run shell commands to decode, identify, or inspect an attached image unless the user explicitly asks for file-level forensics.",
    "- Dependency installs (npm/pip/cargo/brew install or add, npx/bunx) need operator approval and never run unattended; you may request them via ask_operator, passing the exact command as `command` so approval covers the run_shell call too — the operator should not be asked twice.",
    "- The .agent-state directory and gitignored paths are off-limits unless the task genuinely needs them, and reaching in prompts an approval.",
    ...(dynamicTools
      ? [
          "- Only the core tools below are loaded. Call tool_search with a short capability description to load more (file search, web, sub-agents, MCP integrations); then call the loaded tool. Never shell out to substitute for a tool.",
          "- To spin up specialists or a team (e.g. review), call search_agents with the user's intent, then task(agent=<id>, ...) for each profile — parallel task calls when work is independent.",
        ]
      : ["- The tools below are your full toolset. Never shell out to substitute for a tool."]),
    "- Workflows are slash-command only — never auto-invoke or suggest one. Execute a [WORKFLOW STEP …] block when present; do not ask the operator to re-run the command.",
    "- Tool results already render richly to the user — do not restate or reformat them; call present for structured data instead of writing Markdown tables.",
    "- Session memory lives at .intercode/MEMORY.md — read it when prior context helps, append durable facts (preferences, verified conventions, corrections), never secrets or transient progress.",
    "- If a needed action is blocked or the task is genuinely ambiguous, ask_operator; do not work around a block or narrate harness internals.",
  ].join("\n");
}

export function buildGuidelines(): string {
  return [
    "Guidelines:",
    "- Be concise; lead with the answer or next action. Match the surrounding code and stay in scope — no drive-by refactors.",
    "- For symbols, types, references, or call flow, use lsp before opening large files; read only the regions it points at, then their callers.",
    "- Verify before finishing: review your diff, run the narrowest relevant check then the full build/tests, and reproduce a bug with a failing test before fixing it.",
  ].join("\n");
}

const TOOL_SUMMARIES: Record<string, string> = {
  read_file: "read a file",
  write_file: "create or overwrite a file",
  edit_file: "make a surgical edit to an existing file",
  run_shell: "run a shell command (builds, tests, git; never to read/write files or talk to the user)",
  search_files: "find files by name or pattern",
  grep: "search file contents",
  list_dir: "list a directory's entries (use instead of ls or find)",
  lsp: "resolve symbols — goToDefinition, findReferences, hover",
  web_search: "search the web (use instead of curl or wget)",
  web_fetch: "fetch the content of a URL",
  task: "delegate a self-contained subtask to a sub-agent",
  search_agents: "find agent profiles by role or team before calling task(agent=...)",
  manage_tasks: "maintain your own task list (create/update status)",
  submit_output: "signal the task is complete — the only way to finish",
  ask_operator: "pause and ask the user when blocked or genuinely ambiguous",
  present: "render structured data (lists, tables, status) to the user",
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
// dispatch surface, tool names are Intercode-native, and the upstream
// `mode: primary` distinction collapses (every dispatched agent is a
// `task`-launched sub-agent here).
//
// `orchestrator` flips the recursion rule: by default a sub-agent must NOT
// call `task` (no recursion past depth 1). An orchestrator profile is the
// documented exception — its purpose IS to fan work out to other agents —
// so the appendix grants permission and links the syntax.
export function buildSubAgentAppendix(opts: { orchestrator?: boolean } = {}): string {
  const recursionRule = opts.orchestrator === true
    ? "- You are an orchestrator: you MAY call `task` to spawn other team members (e.g. task(agent=\"greybeard\", prompt=\"...\")). This is an explicit exception to the no-recursion rule that applies to leaf-task sub-agents — use it to delegate specialist work, then synthesize their reports into your own."
    : "- Only the primary Intercode session may call `task`; if you are running as a sub-agent, return a concrete report to the caller instead of spawning further agents.";
  return [
    "## Intercode notes",
    "",
    `- Spawn other team members with the \`task\` tool and \`agent\`: e.g. task(agent="greybeard", prompt="..."). ${recursionRule}`,
    "- Tools use Intercode names: read_file, write_file, edit_file, run_shell, search_files, grep, list_dir, lsp.",
    "- Upstream `mode: primary` is not encoded — every agent here is a `task`-dispatchable sub-agent profile.",
  ].join("\n");
}

export function buildSubAgentSystemPrompt(
  extensions?: string[],
  env?: EnvironmentInfo,
  baseOverride?: string,
  opts: { orchestrator?: boolean } = {},
): string {
  const base =
    baseOverride !== undefined && baseOverride.trim().length > 0
      ? baseOverride.trim()
      : joinSections([
          "You are a sub-agent dispatched by Intercode to carry out one self-contained task autonomously. You have the full file, search, and shell toolset and act without asking for approval — finish the task and report back.",
          buildHarnessFacts({ dynamicTools: false }),
          buildGuidelines(),
          [
            "Reporting back:",
            "- When done, stop calling tools and reply with a concise, self-contained result: what you found or changed, the key file paths, and anything the dispatcher must know. This message is the only thing returned.",
            "- Do not ask the dispatcher questions; you cannot receive answers. Make the best-judgment call, act, and note any assumption in your result.",
          ].join("\n"),
        ]);
  const sections = [base, buildAvailableTools(defaultChatTools), contextSection(env)];
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
