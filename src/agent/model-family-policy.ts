import {
  detectModelFamily,
  type ModelFamily,
} from "../subagent/provider-family.js";
import {
  astraResidual,
  claudeRow,
  gptRow,
  grokRow,
  grokToolBudgetResidual,
  museRow,
} from "../../packages/prompt-variance/src/index.js";

/**
 * Per-model-family tuning for the shared directors (main chat director and
 * SubAgentDirector). One policy object, resolved once per session from the
 * provider/model — directors stay generic and branch on data, never on
 * per-family subclasses.
 */
export interface ModelFamilyPolicy {
  family: ModelFamily;
  /**
   * Consecutive tool-only assistant turns (tool calls, no text) before the
   * main chat director injects a one-shot wrap-up nudge. A long tool-only
   * streak is normal orchestration and must not stop the session on its own —
   * this is a soft check-in, never a pause.
   */
  toolOnlyTurnNudgeAt: number;
  /** Ephemeral nudge text injected at toolOnlyTurnNudgeAt. */
  wrapUpNudgeText: string;
  /** Wall-clock inactivity, in ms, before a silent sub-agent is nudged. */
  subAgentStallTimeoutMs: number;
  /** Grok's finish-bias residual (withhold from orchestrators; see provider-family.ts). */
  applyGrokFinishBias: boolean;
  /**
   * Tool names to drop from the advertised wire prefix and the dispatch gate.
   * Empty by default. Orchestrators and leaves share the same skill surface:
   * both mount skill_search and use_skill; use_skill is never denied.
   */
  advertisedToolDeny: readonly string[];
  /**
   * Tool-discipline rules appended to the system prompt for families that do
   * not self-terminate a tool loop. Empty for families that need none. Appended
   * at the tail so it cannot disturb the cached prompt prefix.
   */
  toolDisciplineRules?: string;
  /**
   * Provider-family residual appended once to the assembled leaf system
   * prompt: tool-budget text for grok, the XML task_guidance block for
   * claude, the narrate-before-tools note for gpt. Withheld from
   * orchestrators and appended at the tail so it cannot disturb the cached
   * prompt prefix. Undefined for families that need none.
   */
  promptResidual?: string | undefined;
  /**
   * Replaces the director body (formatDirectorSystemPrompt) on a leaf worker
   * for families with a tuned slim body for that role. Undefined keeps the
   * shared director body. run.ts feeds it into the extensions list in place
   * of the stock director body.
   */
  leafRoleBody?: string | undefined;
}

const DEFAULT_WRAP_UP_NUDGE_TEXT =
  "You have made several consecutive tool calls without any explanation. " +
  "Stop and summarize what you have done so far and what remains, or continue " +
  "if genuinely mid-task — but say so.";

const GROK_WRAP_UP_NUDGE_TEXT =
  "You are running long stretches of tool calls with no narration. Stop and " +
  "report progress now: what you have done, what is left, and whether you are " +
  "actually still making progress.";

// Real-session forensics (scripts/tool-fingerprint-forensics.ts) found
// healthy tool-only streaks topping out at 28 consecutive turns, so 25 sits
// comfortably above that ceiling. The nudge is a check-in, not a stop, so
// erring high costs nothing.
/** Default policy: permissive, no finish bias, no prompt residual. */
const DEFAULT_POLICY: Omit<ModelFamilyPolicy, "family"> = {
  toolOnlyTurnNudgeAt: 25,
  wrapUpNudgeText: DEFAULT_WRAP_UP_NUDGE_TEXT,
  subAgentStallTimeoutMs: 5 * 60_000,
  applyGrokFinishBias: false,
  advertisedToolDeny: [],
};

// Generic tool-budget residual for grok leaves. Pure tool-loop budget, no
// ceremony lines or family-specific routing. Single-sourced from the
// versioned prompt-variance package; the name stays for existing importers.
export const GROK_TOOL_BUDGET_RESIDUAL = grokToolBudgetResidual;

// Grok keeps its own nudge copy, but shares the default sub-agent stall
// timeout: live workbench fleets show routine 60–180s gaps between tool
// cycles while the model thinks, so a shorter kill was false-positive
// salvage mid-inference. The hard-pause thrash check is not family-tuned;
// it runs the same period detection for every family.
const GROK_POLICY: Omit<ModelFamilyPolicy, "family"> = {
  toolOnlyTurnNudgeAt: DEFAULT_POLICY.toolOnlyTurnNudgeAt,
  wrapUpNudgeText: GROK_WRAP_UP_NUDGE_TEXT,
  subAgentStallTimeoutMs: DEFAULT_POLICY.subAgentStallTimeoutMs,
  applyGrokFinishBias: true,
  advertisedToolDeny: [],
  // Sub-agent value; the resolver clears it for orchestrators below.
  promptResidual: GROK_TOOL_BUDGET_RESIDUAL,
};

// Kimi thresholds are provisional: no eval characterization yet for how it
// behaves under tool-only stretches or background-run stalls. Ship the
// permissive default rather than guessing; revisit once eval data exists.
const KIMI_POLICY: Omit<ModelFamilyPolicy, "family"> = { ...DEFAULT_POLICY };

// Muse Spark does not reliably stop a tool loop at medium reasoning effort:
// it re-read files and ran out the 8-turn ceiling without finishing; with
// these three rules appended the same run finished in 3 turns on 4.3x fewer
// input tokens. At minimal effort it terminates either way, so the rules
// earn their keep exactly where each wasted turn is most expensive.
// Single-sourced from the versioned prompt-variance package.
const MUSE_TOOL_DISCIPLINE_RULES = museRow.residual;

const MUSE_POLICY: Omit<ModelFamilyPolicy, "family"> = {
  ...DEFAULT_POLICY,
  toolDisciplineRules: MUSE_TOOL_DISCIPLINE_RULES,
};

// Grok finish-bias + ceremony residual, one block with no line twice. The
// text lives here once; buildGrokLeafAntiThrashNote (prompts.ts) returns it
// verbatim so the prompt carries exactly one copy. Distinct from the
// tool-budget residual (GROK_TOOL_BUDGET_RESIDUAL): grok leaves carry both,
// each once. Single-sourced from the versioned prompt-variance package; the
// name stays for existing importers.
export const GROK_PROMPT_RESIDUAL = grokRow.residual;
// Claude ships one XML residual, not prose: a prose residual did nothing, but
// a single <task_guidance> block cut Sonnet tokens. The block is the whole
// residual — never a full-prompt XML renderer. buildClaudeTaskGuidanceNote
// (prompts.ts) returns it verbatim so the prompt carries exactly one copy.
// Single-sourced from the versioned prompt-variance package; the name stays
// for existing importers.
export const CLAUDE_TASK_GUIDANCE_NOTE = claudeRow.residual;

const CLAUDE_POLICY: Omit<ModelFamilyPolicy, "family"> = {
  ...DEFAULT_POLICY,
  promptResidual: CLAUDE_TASK_GUIDANCE_NOTE,
};

// Narrate-before-tools residual for GPT workers: GPT-5.5 runs showed 6–13
// silent tool-only turns. Shared thrash harness + spawn contracts do the
// structural work; this is only a nudge, deliberately not manage_tasks
// ceremony. buildGptNarrateBeforeToolsNote (prompts.ts) returns it verbatim
// so the prompt carries exactly one copy. Astra is the one exception:
// forensics showed the gpt-6-astra cell evading the shared threshold guard
// via trivial argument deltas, so it carries its own residual below.
// Single-sourced from the versioned prompt-variance package; the name stays
// for existing importers.
export const GPT_NARRATE_BEFORE_TOOLS_NOTE = gptRow.residual;

// GPT thresholds are provisional: no eval characterization yet for how it
// behaves under tool-only stretches or background-run stalls. Ship the
// permissive default; the narrate-before-tools residual is prompt-level (see
// GPT_NARRATE_BEFORE_TOOLS_NOTE above), not a threshold.
const GPT_POLICY: Omit<ModelFamilyPolicy, "family"> = {
  ...DEFAULT_POLICY,
  // Primary and leaf alike: no orchestrator carve-out.
  promptResidual: GPT_NARRATE_BEFORE_TOOLS_NOTE,
};

// Astra (served gpt-6-astra cell) is GPT plus an evasion residual: forensics
// on the repro trace classified the loop as evasion — near-identical
// re-issued calls whose trivial argument deltas keep every exact fingerprint
// under the shared threshold — so the residual forbids that specific
// variation instead of tightening thresholds: toolOnlyTurnNudgeAt stays at
// the permissive default.
export const ASTRA_PROMPT_RESIDUAL = `${GPT_NARRATE_BEFORE_TOOLS_NOTE}\n${astraResidual}`;

const ASTRA_POLICY: Omit<ModelFamilyPolicy, "family"> = {
  ...GPT_POLICY,
  // Like gpt, primary and sub-agent alike: no orchestrator carve-out.
  promptResidual: ASTRA_PROMPT_RESIDUAL,
};

// DeepSeek V4 d1+slim residuals kept inline here rather than in the
// prompt-variance package. The model-family-policy switch routes them; the
// orchestration/leaf carve-outs mirror the grok branch.
export const DSV4_D1_PRIMARY_RESIDUAL = `
Operating notes (DeepSeek V4 Flash):
- Your context is the expensive one: workers do the reading, building, and checking. Read only what you need to route and to name files in a brief (one glob or grep, or one or two reads); do not read code to plan the fix yourself.
- Route: any code change (fix, feature, refactor, even one line) goes to coder; verification of that change goes to reviewer after the coder reports; codebase questions that need more than two reads go to explorer; a question answerable from one or two reads you answer directly. Set \`agent\` to the id directly; do not call search_agents.
- Write each brief so the worker can start without rediscovering anything: goal (copy the user's requirements verbatim, including exact formats, names, and messages), files (repo-relative paths to change and to leave alone), constraints in do_not (no edits to tests or locked files, no new deps, no extra tests or files unless asked), success_criteria (observable checks, one per requirement), and the exact test command.
- After the coder reports, spawn reviewer with the same success_criteria, the test command, and the coder's changed paths. If the reviewer reports a defect, send it back to the same coder with send_input, then have the reviewer re-check once.
- Always call wait_agents on a worker you spawned before ending your turn; never end the turn with a worker still running.
- Do not edit files yourself and do not re-read changed files or re-run tests after a report: the reviewer's verdict is the verification.
- Files go through the file tools, not the shell: read, grep, glob. glob refuses ** unless \`path\` is a subdirectory: use {"path": "src", "pattern": "**/*.ts"}, never {"pattern": "src/**/*.ts"}.
- Final reply: what changed (files), who verified it and how, anything left open, in five lines or fewer. Do not restate the request.
`.trim();

export const DSV4_BODY_CODER = `
Identity: agent id \`coder\`. You are Coder, the builder for Corbits Code, running on DeepSeek V4 Flash. You implement one brief, then report. A separate reviewer verifies your work.

- Start from the brief: it names the goal, the files, the constraints, the success criteria, and the test command. Read those files, make the change, run the test command once, report.
- Read a file before editing it, unless you just created or edited it. Use edit for targeted changes and write for new files.
- Use read, not cat/head/tail in bash; read with no offset/limit returns the whole file, so read each file once. Use grep, not shell grep or rg. Use glob, not find or ls.
- glob refuses ** unless \`path\` is a subdirectory: {"path": "src", "pattern": "**/*.ts"} works; {"pattern": "src/**/*.ts"} is refused.
- Use bash for tests, builds, and programs. A bash result that starts with \`exit code N\` failed: read it and fix the cause before moving on.
- Make the smallest change at the root cause. Keep public signatures and existing behavior the brief does not mention. Add no tests, files, refactors, or docs the brief did not ask for.
- Build structured output (JSON, CSV, YAML) with the language's serializer (JSON.stringify, json.dumps), never by string interpolation.
- Do not re-verify beyond the brief's test command and one direct check per success criterion; the reviewer does the rest.
- Report with the Report envelope (Summary / Findings / Blockers / Paths). In Findings, give each success criterion as pass/fail with the command and its exit status. Paths lists every file you changed.
`.trim();

export const DSV4_BODY_REVIEWER = `
Identity: agent id \`reviewer\`. You are Reviewer, the verifier for Corbits Code, running on DeepSeek V4 Flash. You check a change against the brief's success criteria. You never edit product code.

- Run the brief's test command once. Then check each success criterion with the smallest direct evidence: read the changed lines, and run one targeted command (call the function or CLI with python3 -c / node -e) for behavior the tests do not cover, including exact output formats.
- Report a defect only with evidence: path:line, the input, expected vs actual.
- Do not add files to the repo; use inline commands and leave the working tree as you found it.
- Use read, grep, and glob for files, not shell cat/grep/find. glob refuses ** unless \`path\` is a subdirectory: {"path": "src", "pattern": "**/*.ts"}.
- A bash result that starts with \`exit code N\` failed: say what failed.
- Report with the Report envelope (Summary / Findings / Blockers / Paths). Summary: PASS or FAIL in one line. Findings: one line per success criterion (pass/fail + evidence), then any defects. Keep the whole report under 15 lines.
`.trim();

export const DSV4_G2_LEAF_RESIDUAL = `
Operating notes (DeepSeek V4 Flash):
- Files go through the file tools, not the shell: read to view a file, grep to search contents, glob to find files. bash is for running tests, builds, and programs only.
- glob refuses ** unless \`path\` is a subdirectory. Put the directory in \`path\`, never at the front of the pattern: {"path": "src", "pattern": "**/*.ts"} works; {"pattern": "src/**/*.ts"}, {"pattern": "tests/**/*"} and {"pattern": "**/*"} are refused. At the root, survey with {"pattern": "*.*"} and {"pattern": "*/*"}.
- read takes a file path, never a directory; list a directory with glob ({"path": "src", "pattern": "*"}). Do not guess file names: glob or grep first.
- read with no offset/limit returns the whole file; read each file once and do not page past its end.
- Do exactly what the brief asks. No extra tests, files, refactors, or docs unless the brief requires them; when the brief or the operator says no tests, write none.
- Produce structured output (JSON, CSV, YAML) with the language's serializer (JSON.stringify, json.dumps), never by string interpolation.
- Stay proportional: a few targeted checks cover a small change. Once the success criteria are verified, stop; do not build harnesses for exotic inputs the brief never mentions.
- Run the project's own test command once after your last edit, then write the report.
`.trim();

export function resolveModelFamilyPolicy(input: {
  providerName: string;
  model?: string;
  orchestrator?: boolean;
  /** Leaf director id (coder, reviewer, explorer, …) for role-tuned families. */
  directorId?: string;
}): ModelFamilyPolicy {
  const family = detectModelFamily(input);
  const orchestrator = input.orchestrator === true;
  switch (family) {
    case "grok": {
      const policy = { family, ...GROK_POLICY };
      // The finish-bias residual only makes sense on sub-agents, mirroring
      // shouldApplyGrokAntiThrash: orchestrators dispatch other agents rather
      // than doing the work directly.
      return {
        ...policy,
        applyGrokFinishBias: policy.applyGrokFinishBias && !orchestrator,
        promptResidual: orchestrator ? undefined : policy.promptResidual,
      };
    }
    case "kimi":
      return {
        family,
        ...KIMI_POLICY,
      };
    case "muse":
      return { family, ...MUSE_POLICY };
    case "claude":
      // Like the grok finish-bias residual, the task_guidance block only makes
      // sense on leaf workers — orchestrators resolve to the permissive
      // default (no residual).
      return orchestrator
        ? { family, ...DEFAULT_POLICY }
        : { family, ...CLAUDE_POLICY };
    case "gpt":
      // Primary and sub-agent alike: no orchestrator carve-out.
      return { family, ...GPT_POLICY };
    case "astra":
      // Primary and leaf alike, like gpt: no orchestrator carve-out. Only
      // astra carries the residual.
      return { family, ...ASTRA_POLICY };
    case "deepseek": {
      // Winning d1+slim config: d1 primary residual on orchestrators, g2 leaf
      // residual on explorer leaves, tuned slim coder/reviewer bodies.
      const directorId = input.directorId;
      return {
        family,
        ...DEFAULT_POLICY,
        promptResidual: orchestrator
          ? DSV4_D1_PRIMARY_RESIDUAL
          : directorId === "explorer"
            ? DSV4_G2_LEAF_RESIDUAL
            : undefined,
        leafRoleBody:
          !orchestrator && directorId === "coder"
            ? DSV4_BODY_CODER
            : !orchestrator && directorId === "reviewer"
              ? DSV4_BODY_REVIEWER
              : undefined,
      };
    }
    default:
      return { family: "default", ...DEFAULT_POLICY };
  }
}
