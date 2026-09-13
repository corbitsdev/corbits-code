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
// (tests, ad-hoc prompt previews) — except wait_agents, which is mount-gated:
// the default preview shows the unmounted (TUI/nested) surface. Real sessions
// always pass their detected availability — see tui/runner.ts and exec/runner.ts.
const DEFAULT_TOOL_AVAILABILITY: ToolAvailability = {
  languageServerAvailable: true,
};
import { PRODUCT_NAME, SETTINGS_DIR_NAME } from "../branding.js";

// Fallback tool list for worker prompts when the caller does not pass the
// installed set. Matches the worker install (posix + manage_tasks + ask_director).
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
  "ask_director",
];

const joinSections = (sections: string[]) => sections.join("\n\n");

function formatDateDDMMYYYY(date: Date): string {
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = String(date.getFullYear());
  return `${day}/${month}/${year}`;
}

export function buildChatRole(
  _sessionMode: SessionMode = "orchestrator",
): string {
  // Primary session identity is the closed Skywalker director package (CL-5817).
  // Harness facts / guidelines still append after this role in baseSection.
  return createSkywalkerSystemPrompt();
}

// Facts the model cannot derive from its training: what the permission layer
// blocks, what loads on demand, and the harness-specific tools. Everything a
// frontier model already knows about being a coding agent is deliberately omitted.
// `dynamicTools` controls the tool-loading fact: the main chat agent starts with
// core tools plus the advertised catalog (including skill_search) and loads MCP
// and other unadvertised tools via tool_search, whereas a sub-agent is
// handed its full toolset upfront and has no tool_search — telling it otherwise
// wastes turns on a tool that does not exist.
export function buildHarnessFacts(
  opts: {
    dynamicTools?: boolean;
    subAgent?: boolean;
    sessionMode?: SessionMode;
    askDirector?: boolean;
  } = {},
): string {
  const dynamicTools = opts.dynamicTools ?? true;
  const subAgent = opts.subAgent ?? false;
  const askDirector = opts.askDirector === true;
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
    "- read_file accepts a filesystem path or a tool-output:///{callId} URI from a prior tool result when the harness exposes one. Only read_file a tool-output:// URI if the truncation notice on that result named one; do not re-read a complete inline result.",
    "- run_shell has no default timeout; pass timeout for builds, tests, and other long commands. Prefer background:true for builds, test suites, and dev servers: it returns a shell_id at once, the result is delivered when the process finishes (foreground runs hold steers; background runs do not), and shell_collect collects or cancels later. background does not change the retained shell cwd.",
    "- Shell find, rg, and grep -r are blocked — they can walk huge trees and OOM the host. Prefer the bounded grep/search_files tools, and do not substitute another unbounded walk (fd, ls -R, scripted os.walk).",
    ...(subAgent
      ? [
          "- You share the parent session's permission gate: matching persisted grants and auto mode proceed without a new prompt; other consequential actions may require operator approval (interactive) or are denied (headless).",
          "- There is no turn budget. A tool-less reply without the structured report gets one incomplete-report nudge; if the next tool-less reply still omits the envelope, the harness salvages it. Otherwise, the run continues until completion, cancellation, an opt-in deadline, or a stall.",
        ]
      : [
          "- Dependency installs, shell that targets a path outside the workspace, and in-workspace session-state writes need operator approval. Path-arg tools that escape the workspace are denied.",
        ]),
    "- Attached images are native multimodal input; inspect them directly unless file-level forensics are requested.",
    ...(dynamicTools
      ? [
          "- Core tools plus the advertised catalog (including skill_search) are resident. Use tool_search to load extra capabilities from plugins or integrations when needed.",
          "- Use search_agents before dispatching named specialists or teams (ids and descriptions by default; include_body=true for the loaded system prompt). Do not read_file plugin paths outside the workspace.",
          "- The user may send follow-up messages while workers run; they are queued. Enter delivers at the next parent tool.boundary; Alt+Enter on session-idle. A long parent tool holds that boundary. Update your plan, spawn or adjust workers, and keep the operator informed.",
        ]
      : ["- The tools below are your full toolset."]),
    "- Workflows run only from slash-command steps; never invent or auto-start one.",
    `- Session memory lives at ${SETTINGS_DIR_NAME}/MEMORY.md; store durable preferences only, never secrets.`,
    subAgent
      ? askDirector
        ? "- If permission denies an action, make a best-effort call, finish what you can, and record assumptions under Blockers. If the brief is genuinely ambiguous, ask_director — you cannot reach the operator."
        : "- If permission denies an action or the brief is unclear, make a best-effort call, finish what you can, and record assumptions under Blockers — you cannot ask the parent mid-run."
      : "- If an action is blocked or the request is genuinely ambiguous, ask_operator.",
  ].join("\n");
}

// Guideline sub-block ids — the policy surface for `promptSectionOmit`.
// Omit drops whole named blocks; prose inside a kept block is untouched.
export const GUIDELINE_SUB_BLOCK_IDS = [
  "responseStyle",
  "toolChoice",
  "askVsProceed",
  "scopeConventions",
  "orchestration",
] as const;

export type GuidelineSubBlockId = (typeof GUIDELINE_SUB_BLOCK_IDS)[number];

/** Id-based guideline policy: which sub-blocks to drop. */
export interface GuidelineConfig {
  readonly omit?: readonly GuidelineSubBlockId[];
}

interface GuidelineBlockContext {
  readonly subAgent: boolean;
  readonly askDirector: boolean;
  readonly waitAgentsMounted: boolean;
}

const GUIDELINE_SUB_BLOCKS: Record<
  GuidelineSubBlockId,
  (ctx: GuidelineBlockContext) => string[]
> = {
  responseStyle: () => [
    "Response style:",
    "- Default to short, direct answers; skip preamble and filler.",
    "- For substantial work, lead with the outcome, then what changed and why; use bullets or short headers only when they help scanning.",
    "- Cite paths instead of pasting large files; fenced snippets only when essential.",
    "- No emojis in code or docs unless the user uses them.",
  ],
  toolChoice: (ctx) => [
    "Tool choice:",
    ...(ctx.subAgent
      ? []
      : [
          "- Prefer spawn_agent(agent=…) then idle for substantial product implementation, exploration, review, and docs — " +
            (ctx.waitAgentsMounted
              ? "collect with wait_agents; do not poll list_agents."
              : "mailbox mail arrives as inbound; do not poll.") +
            " Spawn remains default for substantial work, not a tool ban.",
        ]),
    "- read_file for file contents; grep or search_files to locate code; lsp for symbols, types, references, or call flow before opening large files.",
    ctx.subAgent
      ? "- edit_file for targeted changes; write_file for new files or full rewrites; delete_file to remove files — never echo, heredoc, sed, or rm in the shell for those jobs."
      : "- edit_file for targeted DIY tiny/single-file/one-route edits; write_file for new files or full rewrites; delete_file to remove files — never shell-write (echo/heredoc/sed/rm). Spawn builder (or a docs director) for substantial/multi-file/parallel/specialist work.",
    "- run_shell for builds, tests, git, and one-off commands — not for shell find, head-position rg, or recursive grep -r (OOM risk), cat, or messaging the user.",
    ...(ctx.subAgent
      ? []
      : [
          "- tool_search before assuming a plugin or MCP tool exists; skill_search when choosing among listed skills, use_skill to load a body.",
        ]),
  ],
  askVsProceed: (ctx) => [
    ctx.subAgent ? "Proceed vs pause:" : "Ask vs proceed:",
    ...(ctx.subAgent
      ? [
          "- Stick to the dispatch brief; proceed autonomously on bounded work.",
          ctx.askDirector
            ? "- If permission denies an action, make a best-effort call and record assumptions under Blockers. If the brief is genuinely ambiguous, ask_director — you cannot reach the operator."
            : "- If permission denies an action or the brief is unclear, make a best-effort call and record assumptions under Blockers — you cannot ask the parent mid-run.",
          "- Preserve unrelated user edits; never revert changes you did not make unless the brief requires it.",
        ]
      : [
          "- Clear, bounded coding requests: proceed autonomously; use ask_operator only when permission blocks you or the request is genuinely ambiguous (missing repro, conflicting instructions, destructive choice).",
          "- Before ask_operator: put long rationale in a normal transcript reply first, then call ask_operator with a short question and short option labels only.",
          "- Questions, reviews, and product/visual feedback: answer or diagnose first; do not edit until the user wants a change.",
          "- Preserve unrelated user edits; never revert changes you did not make unless asked.",
          "- Unexpected changes in files you did not touch: stop and ask_operator.",
        ]),
  ],
  scopeConventions: (ctx) => [
    "Scope and conventions:",
    "- Touch only code required for the task; no drive-by refactors, formatting sweeps, or unrelated fixes.",
    ctx.subAgent
      ? "- Follow AGENTS.md and /docs for architecture."
      : "- Follow AGENTS.md and /docs for architecture; use_skill style and philosophy when starting repo work.",
    "- Match existing project patterns (functional style, arktype at boundaries, small focused diffs).",
    "- Before finishing implementation work, run the repository-defined typecheck command, relevant tests, and every defined full verification command; these checks are mandatory.",
    "- If the repository defines no typecheck command, do not invent a typecheck command: report its absence as an explicit Blocker with evidence from AGENTS.md and package scripts (or equivalent project configuration).",
    "- In Findings, report every exact verification command and its outcome, including exit status. A bare `pass` without command evidence is an incomplete report.",
    "- If a required check genuinely cannot run because of a missing runtime or dependency, sandbox restriction, or permissions, record the exact inability under Blockers; never silently skip a required check.",
  ],
  orchestration: (ctx) => {
    if (ctx.subAgent) return [];
    return [
      "Orchestration:",
      "- Break multi-step or parallel work into focused worker dispatches with distinct lenses; prefer `spawn_agent` (fire several in one turn when jobs are independent), then reply with who is running and end the turn — workers keep running while you are idle. " +
        (ctx.waitAgentsMounted
          ? "This surface has no mailbox delivery: collect with `wait_agents`; do not poll `list_agents`."
          : "Mailbox mail arrives as inbound when a worker finishes; read it and do not poll.") +
        " `list_agents` shows the fleet without blocking; after a parked ask is surfaced, answer with `send_input` and do not poll `list_agents`.",
      "- Pass the typed spawn contract: `intent`, `success_criteria` (done-when; required for implement/review and their default directors), `do_not` (scope fence), and `report_focus`. Free-form `prompt` without `success_criteria` fail-closes for implement/review and their default directors.",
      "- After workers return, classify fail / incomplete-report vs parent-initiated interrupt vs operator-cancel vs clean complete. Fail-path (`status: failed` or salvage `incomplete-report`): diagnose from the report or error and MAY spawn one successor with a changed brief. Parent-initiated interrupt (`interrupt_agent` / `send_input` with `interrupt:true` unblocks wait with `stop_reason: interrupted`): the worker is often still running and often has no report — `resume_agent`" +
        (ctx.waitAgentsMounted
          ? " or re-wait"
          : ", or idle for its mailbox mail") +
        "; do not `spawn_agent` a successor against a still-live worker. Successor only if that session is no longer resumable. Operator-cancel (`stop_reason` cancelled): wait for the operator; do not auto-retry. Identical brief: refuse. Merge Summary/Findings into a coherent answer for the operator; do not paste raw fleet-agent dumps.",
      "- Use manage_tasks for your own coordination checklist; spawning workers is `spawn_agent`, not manage_tasks.",
      "- If context is compacted automatically, do not stop tasks early due to token fear; persist progress via manage_tasks and worker reports.",
    ];
  },
};

export function buildGuidelines(
  opts: {
    subAgent?: boolean;
    sessionMode?: SessionMode;
    askDirector?: boolean;
    // True where createAgentToolset mounted wait_agents (exec primary).
    // Picks the collection-path copy: wait_agents vs mailbox mail.
    waitAgentsMounted?: boolean;
    // Id-based policy: drop the named sub-blocks (see GUIDELINE_SUB_BLOCKS).
    // Empty (default) keeps the full guidelines.
    omit?: readonly GuidelineSubBlockId[];
  } = {},
): string {
  const ctx: GuidelineBlockContext = {
    subAgent: opts.subAgent ?? false,
    askDirector: opts.askDirector === true,
    waitAgentsMounted: opts.waitAgentsMounted === true,
  };
  const omitted = new Set(opts.omit ?? []);
  const blocks = GUIDELINE_SUB_BLOCK_IDS.filter((id) => !omitted.has(id))
    .map((id) => GUIDELINE_SUB_BLOCKS[id](ctx))
    // The orchestration block is empty for workers; dropping it (rather than
    // its separator) keeps default output byte-identical to before the split.
    .filter((lines) => lines.length > 0);
  return ["Guidelines:", ...blocks.flatMap((lines) => ["", ...lines])].join(
    "\n",
  );
}

// Shared across every provider family and both chat/sub-agent entry points —
// appended exactly once per built prompt. Prohibition form throughout: these
// are the failure modes observed across shipped agents (OpenCode, Codex CLI,
// Gemini CLI, Claude Code, Warp, Aider, Cline), not general advice.
export function buildPromptDisciplineBlock(
  opts: { subAgent?: boolean } = {},
): string {
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
    "read a file or tool-output:///{callId} from a prior tool result (prefer over cat/head/tail in the shell). Only read_file a tool-output:// URI if the truncation notice named one",
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
  wait_agents:
    "collect spawned workers by agent_id; mounted on exec-primary runs only — elsewhere mailbox mail arrives as inbound, so do not poll; returns awaiting_director when a worker asks, without collecting that session",
  list_agents:
    "list this session's spawn_agent workers without blocking; after a parked ask_director is surfaced, returns an error until send_input answers or the ask is dropped — do not poll",
  search_agents:
    "find agent profiles by role or team before spawning with spawn_agent(agent=...); default results are id, description, and spawn metadata — pass include_body=true for the loaded system prompt / body",
  manage_tasks:
    "maintain your work checklist — create/replace, update status, append, cancel",
  ask_director:
    "pause and ask the spawning parent (not the human) a short clarifying question with short option labels; parent answers via send_input; after the cap, proceed with best judgment or put remaining questions in Blockers",
  submit_output:
    "signal the task is complete, or complete a workflow step by passing its step id",
  ask_operator:
    "pause and ask the user when blocked or genuinely ambiguous; put long rationale in a transcript reply first, then call with a short question and short option labels only",
  present:
    "dynamically render aligned/structured output using the layout primitives (stack/row/grid/text etc)",
  tool_search: "load more tools by capability when you need them",
  use_skill:
    "load a listed skill's full instructions before doing work it covers",
  skill_search:
    "look up skill descriptions by capability (catalog — call directly, do not tool_search for this)",
};

const ARCHIVE_TOOL_SUMMARIES: Partial<Record<string, string>> = {
  read_file:
    "read a file, tool-output:///{callId} from a prior tool result, or archive:///{occurrenceId} (prefer over cat/head/tail in the shell). Only read_file a tool-output:// URI if the truncation notice named one",
  search_files:
    "find files by name or pattern (bounded; timeout + output caps — safer than open-ended shell find); path archive:/// lists evidence-archive refs",
  grep: "search file contents (bounded; timeout + output caps — safer than open-ended shell grep -r/rg); path archive:/// searches this session's evidence archive",
};

export function buildAvailableTools(
  tools: readonly string[] = CORE_TOOL_NAMES,
  opts: { advertiseArchive?: boolean } = {},
): string {
  const summaries =
    opts.advertiseArchive === true
      ? { ...TOOL_SUMMARIES, ...ARCHIVE_TOOL_SUMMARIES }
      : TOOL_SUMMARIES;
  const lines = tools.map(
    (tool) => `- ${tool}: ${summaries[tool] ?? "available"}`,
  );
  return ["Tools:", ...lines].join("\n");
}

export function buildActiveContext(
  date = new Date(),
  cwd = process.cwd(),
): string {
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
    lines.push(
      `Git: on ${env.gitBranch ?? "(detached HEAD)"}, working tree clean`,
    );
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
function baseSection(
  baseOverride: string | undefined,
  sessionMode: SessionMode,
  waitAgentsMounted?: boolean,
  guidelineConfig?: GuidelineConfig,
): string {
  if (baseOverride !== undefined && baseOverride.trim().length > 0) {
    const custom = baseOverride.trim();
    // SYSTEM.md can describe the role; orchestrator harness rules always apply on the wire.
    return joinSections([
      custom,
      "## Session mode",
      buildHarnessFacts({ sessionMode: "orchestrator" }),
      buildGuidelines({
        sessionMode: "orchestrator",
        ...(waitAgentsMounted !== undefined ? { waitAgentsMounted } : {}),
        ...(guidelineConfig?.omit !== undefined
          ? { omit: guidelineConfig.omit }
          : {}),
      }),
      buildPromptDisciplineBlock(),
    ]);
  }
  return joinSections([
    buildChatRole(sessionMode),
    buildHarnessFacts({ sessionMode }),
    buildGuidelines({
      sessionMode,
      ...(waitAgentsMounted !== undefined ? { waitAgentsMounted } : {}),
      ...(guidelineConfig?.omit !== undefined
        ? { omit: guidelineConfig.omit }
        : {}),
    }),
    buildPromptDisciplineBlock(),
  ]);
}

// Name-only skill listing: the model sees what exists without paying for
// descriptions or bodies. Details come from skill_search; bodies from use_skill.
export function buildSkillsSection(skills: readonly SkillSummary[]): string {
  return [
    "Skills (names only — call skill_search for details, then use_skill to load a body):",
    skills.map((s) => s.name).join(", "),
  ].join("\n");
}

export function buildChatSystemPrompt(
  extensions?: string[],
  env?: EnvironmentInfo,
  baseOverride?: string,
  skills: readonly SkillSummary[] = [],
  sessionMode: SessionMode = "orchestrator",
  toolAvailability: ToolAvailability = DEFAULT_TOOL_AVAILABILITY,
  guidelineConfig?: GuidelineConfig,
): string {
  const sections = [
    baseSection(
      baseOverride,
      sessionMode,
      toolAvailability.waitAgentsMounted,
      guidelineConfig,
    ),
    buildAvailableTools(
      coreToolNamesForSessionMode(sessionMode, toolAvailability),
      { advertiseArchive: true },
    ),
  ];
  if (skills.length > 0) sections.push(buildSkillsSection(skills));
  sections.push(contextSection(env));
  if (extensions !== undefined && extensions.length > 0) {
    sections.push(...extensions);
  }
  return joinSections(sections);
}

// Notes appended to every worker's system prompt so corbitsdev-format
// agent definitions translate cleanly to Corbits Code: `spawn_agent` is the
// spawn surface, tool names are Corbits Code-native, and the upstream
// `mode: primary` distinction collapses.
//
// Vocabulary: an *agent* is a runtime entity; a *task* is a checklist item
// owned via manage_tasks; a *fleet agent* / worker is a short-lived spawned
// specialist. Do not conflate spawn with checklist.
//
// `orchestrator` flips the recursion rule: by default a worker must NOT
// call `spawn_agent` (no recursion past depth 1). A built-in orchestrator
// director is the documented exception — its purpose IS to fan work out to
// other agents — so the appendix grants permission and links the syntax.
export function buildSubAgentAppendix(
  opts: { orchestrator?: boolean; toolNames?: readonly string[] } = {},
): string {
  // Workers must not be told both "you may spawn" and "do not spawn".
  // Orchestrators get the spawn instruction; everyone else gets the no-recursion
  // rule only.
  const askDirector = opts.toolNames?.includes("ask_director") === true;
  // wait_agents is mounted on exec-primary runs only; nested orchestrators
  // get the live toolNames from runSubAgent, so the mount flag doubles as
  // the collection-path copy switch with no call-site changes.
  const waitAgentsMounted = opts.toolNames?.includes("wait_agents") === true;
  const recursionRule =
    opts.orchestrator === true
      ? '- You are an orchestrator: you MAY call `spawn_agent` to spawn other fleet agents (e.g. spawn_agent(agent="greybeard", description="Review approach", prompt="...")). This is an explicit exception to the no-recursion rule that applies to workers — use it to delegate specialist work, then ' +
        (waitAgentsMounted
          ? "synthesize their reports into your own after `wait_agents`."
          : "reply and idle — their reports arrive as mailbox mail; do not poll.") +
        " `spawn_agent` spawns an agent; it is not a checklist item (use manage_tasks for your own checklist)."
      : `- Only the primary ${PRODUCT_NAME} session (or a built-in orchestrator director) may call \`spawn_agent\` to spawn fleet agents. You are a worker: return a concrete report to the caller instead of spawning further agents. Use manage_tasks for your own work checklist if the job is multi-step.`;
  return [
    `## ${PRODUCT_NAME} notes`,
    "",
    recursionRule,
    `- Tools use ${PRODUCT_NAME} names: read_file, write_file, edit_file, run_shell, search_files, grep, list_dir, lsp, manage_tasks${askDirector ? ", ask_director" : ""}.`,
    ...(askDirector
      ? [
          "- If the brief is genuinely ambiguous, ask_director. You cannot reach the operator; the spawning director answers with send_input.",
        ]
      : []),
    "- Upstream `mode: primary` is not encoded — every profile here is a spawnable fleet-agent definition.",
  ].join("\n");
}

// Final-reply envelope the parent can parse. Free-form prose is allowed inside
// each field; the headings are the structure. When the brief carries Success
// criteria / Do not, those are the completion gate and scope fence.
export function buildSubAgentReportContract(
  opts: { askDirector?: boolean } = {},
): string {
  const askDirector = opts.askDirector === true;
  return [
    "Reporting back:",
    "- Stick to the dispatch brief. Do not invent scope or wander into unrelated work.",
    "- If the brief lists Success criteria, treat them as the done-definition: when all are met (or you are blocked), stop calling tools and emit the report envelope. Do not keep tooling past done.",
    "- If the brief lists Do not, respect those constraints; do not invent scope outside Intent / Do not.",
    '- When done, stop calling tools and reply with ONLY this markdown envelope (prose inside each section is fine; emit all four headings every time in this order, writing "None." under a heading with nothing to report rather than dropping it):',
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
    askDirector
      ? "- This message is the only thing returned to the parent. You cannot reach the operator. If the brief is ambiguous, ask_director before finishing; otherwise make the best-judgment call and note assumptions under Blockers."
      : "- This message is the only thing returned to the parent. Do not ask the parent questions; you cannot receive answers. Make the best-judgment call, act, and note assumptions under Blockers.",
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
    "- When the dispatch brief's done-definition is met, write the report envelope instead of making one more search or micro-edit.",
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
  const toolListForPrompt =
    opts.toolNames && opts.toolNames.length > 0
      ? opts.toolNames
      : defaultChatTools;
  const askDirector = toolListForPrompt.includes("ask_director");
  const base =
    baseOverride !== undefined && baseOverride.trim().length > 0
      ? baseOverride.trim()
      : joinSections([
          `You are a fleet agent — a worker dispatched by ${PRODUCT_NAME} to carry out one self-contained job autonomously. You have the full file, search, and shell toolset under the same permission policy as the parent session (saved grants and auto mode when eligible; operator approval otherwise). Finish the job and report back. Your manage_tasks checklist (if you use it) is yours alone; it is not shared with the parent.`,
          buildHarnessFacts({
            dynamicTools: false,
            subAgent: true,
            askDirector,
          }),
          buildGuidelines({ subAgent: true, askDirector }),
          buildPromptDisciplineBlock({ subAgent: true }),
          buildSubAgentReportContract({ askDirector }),
        ]);
  const sections = [
    base,
    buildAvailableTools(toolListForPrompt),
    contextSection(env),
  ];
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
