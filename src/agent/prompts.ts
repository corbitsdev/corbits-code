import type { EnvironmentInfo } from "./environment.js";
import type { SkillSummary } from "../extensions/skills.js";
import type { SessionMode } from "../config/session-mode.js";
import {
  coreToolNamesForSessionMode,
  CORE_TOOL_NAMES,
  type ToolAvailability,
} from "./tool-search.js";
import { createSkywalkerSystemPrompt } from "./directors/skywalker/package.js";

// Advertise every gated core tool when the caller has no session-start facts
// (tests, ad-hoc prompt previews). Real sessions always pass their detected
// availability — see tui/runner.ts and exec/runner.ts.
const DEFAULT_TOOL_AVAILABILITY: ToolAvailability = {
  languageServerAvailable: true,
};
import { PRODUCT_NAME, SETTINGS_DIR_NAME } from "../branding.js";

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

export function buildChatRole(_sessionMode: SessionMode = "orchestrator"): string {
  // Primary session identity is the closed Skywalker director package (CL-5817).
  // Harness facts / guidelines still append after this role in baseSection.
  return createSkywalkerSystemPrompt();
}

// Facts the model cannot derive from its training: what the permission layer
// blocks, what loads on demand, and the harness-specific tools. Everything a
// frontier model already knows about being a coding agent is deliberately omitted.
// `dynamicTools` controls the tool-loading fact: the main chat agent starts with
// only core tools and loads the rest via tool_search, whereas a sub-agent is
// handed its full toolset upfront and has no tool_search — telling it otherwise
// wastes turns on a tool that does not exist.
export function buildHarnessFacts(
  opts: { dynamicTools?: boolean; subAgent?: boolean; sessionMode?: SessionMode } = {},
): string {
  const dynamicTools = opts.dynamicTools ?? true;
  const subAgent = opts.subAgent ?? false;
  return [
    "Harness facts:",
    ...(subAgent
      ? [
          "- Change files with write_file/edit_file and remove files with delete_file; shell file-writes and deletions are blocked.",
        ]
      : [
          "- Change files with write_file/edit_file and remove files with delete_file for tiny/single-file/one-route bounded edits. Spawn builder for substantial/multi-file/parallel/specialist work. Docs/design still spawn shakespeare/bruckheimer/rand except one-line fixes.",
          "- Shell file-writes and deletions are blocked; never use echo/heredoc/sed/rm as a substitute for product tools. Path tools are the DIY surface.",
        ]),
    "- Use the provided tools for file reads/searches instead of shelling out as a substitute.",
    "- read_file accepts a filesystem path or a tool-output:///{callId} URI from a prior tool result when the harness exposes one; prefer the URI over re-reading huge blobs.",
    "- run_shell has no default timeout; pass timeout for builds, tests, and other long commands.",
    "- Shell find, rg, and grep -r are blocked — they can walk huge trees and OOM the host. Prefer the bounded grep/search_files tools, and do not substitute another unbounded walk (fd, ls -R, scripted os.walk).",
    ...(subAgent
      ? [
          "- You share the parent session's permission gate: matching persisted grants and auto mode proceed without a new prompt; other consequential actions may require operator approval (interactive) or are denied (headless).",
          "- Turn budget is real; near the end a wrap-up nudge may fire — stop tooling and write the structured report (Summary/Findings/Blockers/Paths). Do not thrash re-reads as the budget ends.",
        ]
      : [
          "- Dependency installs, paths outside the workspace, and session-state writes need operator approval.",
        ]),
    "- Attached images are native multimodal input; inspect them directly unless file-level forensics are requested.",
    ...(dynamicTools
      ? [
          "- Only the core tools below are loaded. Use tool_search to load extra capabilities from plugins or integrations when needed.",
          "- Use search_agents before dispatching named specialists or teams (results include full profile bodies; do not read_file plugin paths outside the workspace).",
          "- The user may send follow-up messages while workers run; they are queued. Enter delivers at the next parent tool.boundary; Alt+Enter on session-idle. A long parent tool holds that boundary. Update your plan, spawn or adjust workers, and keep the operator informed.",
        ]
      : ["- The tools below are your full toolset."]),
    "- Workflows run only from slash-command steps; never invent or auto-start one.",
    `- Session memory lives at ${SETTINGS_DIR_NAME}/MEMORY.md; store durable preferences only, never secrets.`,
    subAgent
      ? "- If permission denies an action or the brief is unclear, make a best-effort call, finish what you can, and record assumptions under Blockers — you cannot ask the parent mid-run."
      : "- If an action is blocked or the request is genuinely ambiguous, ask_operator.",
  ].join("\n");
}

export function buildGuidelines(
  opts: { subAgent?: boolean; sessionMode?: SessionMode } = {},
): string {
  const subAgent = opts.subAgent ?? false;
  return [
    "Guidelines:",
    "",
    "Response style:",
    "- Default to short, direct answers; skip preamble and filler.",
    "- For substantial work, lead with the outcome, then what changed and why; use bullets or short headers only when they help scanning.",
    "- Cite paths instead of pasting large files; fenced snippets only when essential.",
    "- No emojis in code or docs unless the user uses them.",
    "",
    "Tool choice:",
    ...(subAgent
      ? []
      : [
          "- Prefer spawn_agent(agent=…) / wait_agents for substantial product implementation, exploration, review, and docs — spawn remains default for substantial work, not a tool ban.",
        ]),
    "- read_file for file contents; grep or search_files to locate code; lsp for symbols, types, references, or call flow before opening large files.",
    subAgent
      ? "- edit_file for targeted changes; write_file for new files or full rewrites; delete_file to remove files — never echo, heredoc, sed, or rm in the shell for those jobs."
      : "- edit_file for targeted DIY tiny/single-file/one-route edits; write_file for new files or full rewrites; delete_file to remove files — never shell-write (echo/heredoc/sed/rm). Spawn builder (or a docs director) for substantial/multi-file/parallel/specialist work.",
    "- run_shell for builds, tests, git, and one-off commands — not for shell find, head-position rg, or recursive grep -r (OOM risk), cat, or messaging the user.",
    ...(subAgent
      ? []
      : [
          "- tool_search before assuming a plugin or MCP tool exists; use_skill before work covered by a listed skill.",
        ]),
    "",
    subAgent ? "Proceed vs pause:" : "Ask vs proceed:",
    ...(subAgent
      ? [
          "- Stick to the dispatch brief; proceed autonomously on bounded work.",
          "- If permission denies an action or the brief is unclear, make a best-effort call and record assumptions under Blockers — you cannot ask the parent mid-run.",
          "- Preserve unrelated user edits; never revert changes you did not make unless the brief requires it.",
        ]
      : [
          "- Clear, bounded coding requests: proceed autonomously; use ask_operator only when permission blocks you or the request is genuinely ambiguous (missing repro, conflicting instructions, destructive choice).",
          "- Before ask_operator: put long rationale in a normal transcript reply first, then call ask_operator with a short question and short option labels only.",
          "- Questions, reviews, and product/visual feedback: answer or diagnose first; do not edit until the user wants a change.",
          "- Preserve unrelated user edits; never revert changes you did not make unless asked.",
          "- Unexpected changes in files you did not touch: stop and ask_operator.",
        ]),
    "",
    "Scope and conventions:",
    "- Touch only code required for the task; no drive-by refactors, formatting sweeps, or unrelated fixes.",
    "- Follow AGENTS.md and /docs for architecture; load the style and philosophy skills when starting repo work.",
    "- Match existing project patterns (functional style, arktype at boundaries, small focused diffs).",
    "- Before finishing a code change, run relevant checks (typecheck, tests) when practical.",
    ...(subAgent
      ? []
      : [
          "",
          "Orchestration:",
          "- Break multi-step or parallel work into focused worker dispatches with distinct lenses; prefer `spawn_agent` (fire several in one turn when jobs are independent), then reply with who is running and end the turn — workers keep running while you are idle, and `wait_agents` / `list_agents` on a later turn collect their reports without holding this conversation blocked.",
          "- Prefer the typed spawn contract on every worker: `intent`, `success_criteria` (done-when), `do_not` (scope fence), and `report_focus` so workers finish instead of thrashing. Free-form `prompt` alone is weaker.",
          "- After workers return, merge their Summary/Findings into a coherent answer for the operator; do not paste raw sub-agent dumps.",
          "- If a worker comes back without finishing, change the brief rather than repeating it: narrow the scope, name the files, or state the done-when more sharply.",
          "- Use manage_tasks for your own coordination checklist; spawning workers is `spawn_agent` / `wait_agents`, not manage_tasks.",
          "- If context is compacted automatically, do not stop tasks early due to token fear; persist progress via manage_tasks and worker reports.",
        ]),
  ].join("\n");
}

// Shared across every provider family and both chat/sub-agent entry points —
// appended exactly once per built prompt. Prohibition form throughout: these
// are the failure modes observed across shipped agents (OpenCode, Codex CLI,
// Gemini CLI, Claude Code, Warp, Aider, Cline), not general advice.
export function buildPromptDisciplineBlock(opts: { subAgent?: boolean } = {}): string {
  const subAgent = opts.subAgent ?? false;
  const toolsOverShell = subAgent
    ? "- Never use run_shell to read, edit, or write files — use read_file, edit_file, write_file; cat/head/tail, sed/awk/perl -i, and heredoc/echo redirection are prohibited substitutes."
    : "- Never use run_shell to read, edit, or write files — use read_file, edit_file, write_file for tiny/bounded DIY; spawn builder/docs directors for substantial work; cat/head/tail, sed/awk/perl -i, and heredoc/echo redirection are prohibited substitutes.";
  return [
    "Prompt discipline:",
    "",
    "Tools over shell:",
    toolsOverShell,
    "- Never use echo or shell output to talk to the user — that is what your reply is for.",
    "",
    "Environment:",
    "- Never set, export, or prefix environment variables in a command — the harness owns the environment; recurring needs belong in project settings, one-off needs are a stated blocker, not a workaround.",
    "",
    "Web:",
    "- Never use curl or wget for a URL — use web_fetch.",
    "- Never hand-roll a web query — use web_search.",
    "",
    "Command shape:",
    "- Never chain unrelated operations into one run_shell call — one logical operation per call, no multi-line scripts; a pipeline that performs one job is one operation.",
    "- Every command must be legible to the operator reviewing it before it runs.",
    "",
    "Turn semantics:",
    "- A reply with no tool calls is the final answer — never leave work implied and unstated.",
    "- Never repeat a search or read whose results you already have.",
    "- Never retry a failed approach a fourth time — after three failures, stop, restate the task, list assumptions, and change approach.",
    "- Never issue independent reads or searches one at a time when they can run in parallel — batch them.",
    "",
    "TTY output:",
    "- Never format terminal output as a wide table — use ordered bullets instead.",
    "- Keep headers short and bold, bullets to one line, and wrap paths, commands, and identifiers in backticks.",
  ].join("\n");
}

const TOOL_SUMMARIES: Record<string, string> = {
  read_file:
    "read a file or tool-output:///{callId} from a prior tool result (prefer over cat/head/tail in the shell)",
  write_file: "create or overwrite a file (never shell redirects or heredocs)",
  edit_file:
    "make a surgical edit (exact old_string match, or start_line/end_line line-range mode; never include read_file's NNNNNN\\t line prefix; substring failures include nearby file text; prefer over sed/awk in the shell)",
  delete_file: "delete one file with an explicit outcome (never shell rm)",
  run_shell:
    "run a shell command (builds, tests, git; pass timeout ms to bound long commands; never to read/write/delete files, search trees, or talk to the user)",
  search_files:
    "find files by name or pattern (bounded; timeout + output caps — safer than open-ended shell find)",
  grep: "search file contents (bounded; timeout + output caps — safer than open-ended shell grep -r/rg)",
  list_dir: "list a directory's entries (bounded listing)",
  lsp: "resolve symbols — goToDefinition, findReferences, hover (prefer before reading huge files)",
  web_search: "search the web (use instead of curl or wget)",
  web_fetch: "fetch the content of a URL",
  spawn_agent:
    "start a worker agent and return immediately with agent_id; pass returned ids from search_agents as agent=...",
  wait_agents: "wait for spawned workers by agent_id and collect their reports",
  search_agents:
    "find agent profiles by role or team before spawning with spawn_agent(agent=...); results include full system prompt / body so you need not read_file plugin roots outside the workspace",
  manage_tasks: "maintain your work checklist — create/replace, update status, append, cancel",
  submit_output: "signal the task is complete, or complete a workflow step by passing its step id",
  ask_operator:
    "pause and ask the user when blocked or genuinely ambiguous; put long rationale in a transcript reply first, then call with a short question and short option labels only",
  present:
    "dynamically render aligned/structured output using the layout primitives (stack/row/grid/text etc)",
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
    `Memory file: ${cwd}/${SETTINGS_DIR_NAME}/MEMORY.md`,
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
    `Arch: ${env.arch}`,
    `Runtime: ${env.runtime}`,
    `Current Date: ${formatDateDDMMYYYY(env.date)} (prompt cache survives for <=24hr)`,
  ];
  if (!env.isGitRepo) {
    lines.push("Git: not a git repository");
  } else if ((env.gitDirtyCount ?? 0) === 0) {
    lines.push(`Git: on ${env.gitBranch ?? "(detached HEAD)"}, working tree clean`);
  } else {
    lines.push(
      `Git: on ${env.gitBranch ?? "(detached HEAD)"}, ${env.gitDirtyCount} uncommitted change(s):`,
    );
    if (env.gitStatusSummary) lines.push(env.gitStatusSummary);
  }
  if (env.topLevel) lines.push(`Top level: ${env.topLevel}`);
  lines.push(`Memory file: ${env.cwd}/${SETTINGS_DIR_NAME}/MEMORY.md`);
  lines.push("</env>");
  return lines.join("\n");
}

function contextSection(env?: EnvironmentInfo): string {
  return env ? buildEnvironmentContext(env) : buildActiveContext();
}

// The static base — role, harness facts, guidelines. A SYSTEM.md override
// keeps custom text but still appends mode-specific harness + guidelines; tools,
// env, and appended extensions attach after that.
function baseSection(baseOverride: string | undefined, sessionMode: SessionMode): string {
  if (baseOverride !== undefined && baseOverride.trim().length > 0) {
    const custom = baseOverride.trim();
    // SYSTEM.md can describe the role; orchestrator harness rules always apply on the wire.
    return joinSections([
      custom,
      "## Session mode",
      buildHarnessFacts({ sessionMode: "orchestrator" }),
      buildGuidelines({ sessionMode: "orchestrator" }),
      buildPromptDisciplineBlock(),
    ]);
  }
  return joinSections([
    buildChatRole(sessionMode),
    buildHarnessFacts({ sessionMode }),
    buildGuidelines({ sessionMode }),
    buildPromptDisciplineBlock(),
  ]);
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
  sessionMode: SessionMode = "orchestrator",
  toolAvailability: ToolAvailability = DEFAULT_TOOL_AVAILABILITY,
): string {
  const sections = [
    baseSection(baseOverride, sessionMode),
    buildAvailableTools(coreToolNamesForSessionMode(sessionMode, toolAvailability)),
  ];
  if (skills.length > 0) sections.push(buildSkillsSection(skills));
  sections.push(contextSection(env));
  if (extensions !== undefined && extensions.length > 0) {
    sections.push(...extensions);
  }
  return joinSections(sections);
}

// Notes appended to every sub-agent's system prompt so corbitsdev-format
// agent definitions translate cleanly to Corbits Code: `spawn_agent` is the
// spawn surface, tool names are Corbits Code-native, and the upstream
// `mode: primary` distinction collapses.
//
// Vocabulary: an *agent* is a runtime entity; a *task* is a checklist item
// owned via manage_tasks; a *sub-agent* is a short-lived child agent. Do not
// conflate spawn with checklist.
//
// `orchestrator` flips the recursion rule: by default a sub-agent must NOT
// call `spawn_agent` (no recursion past depth 1). A built-in orchestrator
// director is the documented exception — its purpose IS to fan work out to
// other agents — so the appendix grants permission and links the syntax.
export function buildSubAgentAppendix(opts: { orchestrator?: boolean } = {}): string {
  // Workers must not be told both "you may spawn" and "do not spawn".
  // Orchestrators get the spawn instruction; everyone else gets the no-recursion
  // rule only.
  const recursionRule =
    opts.orchestrator === true
      ? '- You are an orchestrator: you MAY call `spawn_agent` to spawn other sub-agents (e.g. spawn_agent(agent="greybeard", description="Review approach", prompt="...")). This is an explicit exception to the no-recursion rule that applies to workers — use it to delegate specialist work, then synthesize their reports into your own after `wait_agents`. `spawn_agent` spawns an agent; it is not a checklist item (use manage_tasks for your own checklist).'
      : `- Only the primary ${PRODUCT_NAME} session (or a built-in orchestrator director) may call \`spawn_agent\` to spawn sub-agents. You are a worker: return a concrete report to the caller instead of spawning further agents. Use manage_tasks for your own work checklist if the job is multi-step.`;
  return [
    `## ${PRODUCT_NAME} notes`,
    "",
    recursionRule,
    `- Tools use ${PRODUCT_NAME} names: read_file, write_file, edit_file, run_shell, search_files, grep, list_dir, lsp, manage_tasks.`,
    "- Upstream `mode: primary` is not encoded — every profile here is a spawnable sub-agent definition.",
  ].join("\n");
}

// Final-reply envelope the parent can parse. Free-form prose is allowed inside
// each field; the headings are the structure. When the brief carries Success
// criteria / Do not, those are the completion gate and scope fence.
export function buildSubAgentReportContract(): string {
  return [
    "Reporting back:",
    "- Stick to the dispatch brief. Do not invent scope or wander into unrelated work.",
    "- If the brief lists Success criteria, treat them as the done-definition: when all are met (or you are blocked), stop calling tools and emit the report envelope. Do not keep tooling past done.",
    "- If the brief lists Do not, respect those constraints; do not invent scope outside Intent / Do not.",
    "- When done, stop calling tools and reply with ONLY this markdown envelope (prose inside each section is fine; omit empty sections rather than inventing content):",
    "",
    "## Summary",
    "One or two sentences: what you accomplished or concluded.",
    "",
    "## Findings",
    "The substance the parent needs — results, decisions, evidence.",
    "",
    "## Blockers",
    'Open questions, assumptions, or blockers. Write "None." if clear.',
    "",
    "## Paths",
    'Key file paths you read or changed (one per line). Write "None." if none.',
    "",
    "- This message is the only thing returned to the parent. Do not ask the parent questions; you cannot receive answers. Make the best-judgment call, act, and note assumptions under Blockers.",
  ].join("\n");
}

// Tiny residual for Grok/xAI workers: mining showed higher tools-only thrash
// than Codex on the same harness. Shared thrash harness + spawn contracts do
// the structural work; this is only a finish-bias nudge, not a full rewrite.
export function buildGrokLeafAntiThrashNote(): string {
  return [
    "Finish bias (xAI / Grok worker):",
    "- Once you can answer the dispatch brief, prefer the structured report over another speculative tool call.",
    "- If the next call would only re-open paths you already read, write the report instead.",
    "- Leave the last turn for the report envelope; do not spend the budget on one more search or micro-edit.",
    "- Route file and web work through the dedicated tools, never run_shell — mining showed grok reaching for shell first when a typed tool already covered the job.",
  ].join("\n");
}

export function buildSubAgentSystemPrompt(
  extensions?: string[],
  env?: EnvironmentInfo,
  baseOverride?: string,
  opts: {
    orchestrator?: boolean;
    toolNames?: readonly string[];
    /** When true, append the tiny Grok/xAI finish-bias note (provider residual). */
    grokAntiThrash?: boolean;
  } = {},
): string {
  const base =
    baseOverride !== undefined && baseOverride.trim().length > 0
      ? baseOverride.trim()
      : joinSections([
          `You are a sub-agent — a short-lived child agent dispatched by ${PRODUCT_NAME} to carry out one self-contained job autonomously. You have the full file, search, and shell toolset under the same permission policy as the parent session (saved grants and auto mode when eligible; operator approval otherwise). Finish the job and report back. Your manage_tasks checklist (if you use it) is yours alone; it is not shared with the parent.`,
          buildHarnessFacts({ dynamicTools: false, subAgent: true }),
          buildGuidelines({ subAgent: true }),
          buildPromptDisciplineBlock({ subAgent: true }),
          buildSubAgentReportContract(),
        ]);
  const toolListForPrompt =
    opts.toolNames && opts.toolNames.length > 0 ? opts.toolNames : defaultChatTools;
  const sections = [base, buildAvailableTools(toolListForPrompt), contextSection(env)];
  if (extensions !== undefined && extensions.length > 0) {
    sections.push(...extensions);
  }
  if (opts.grokAntiThrash === true) {
    sections.push(buildGrokLeafAntiThrashNote());
  }
  // Always-last: the Corbits Code translation notes apply to every dispatched
  // agent, regardless of whether its definition came from a JS plugin or a
  // corbitsdev-format markdown file. The orchestrator flag rewrites the
  // recursion rule for profiles whose purpose is to dispatch other agents.
  sections.push(buildSubAgentAppendix(opts));
  return joinSections(sections);
}
