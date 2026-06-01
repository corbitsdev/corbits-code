const defaultAgentTools = [
  "read_file",
  "write_file",
  "edit_file",
  "run_shell",
  "search_files",
  "grep",
  "list_dir",
  "submit_plan",
  "submit_output",
];

const defaultChatTools = [
  "read_file",
  "write_file",
  "edit_file",
  "run_shell",
  "search_files",
  "grep",
  "list_dir",
];

const joinSections = (sections: string[]) => sections.join("\n\n");

export function buildAgentRole(): string {
  return "You are an autonomous coding agent operating inside an event-driven loop.";
}

export function buildToolCallDiscipline(): string {
  return [
    "Tool-call discipline:",
    "1. Every turn must produce at least one tool_call. Conversational text without tool_calls is not progress.",
    "2. Do not explain what you will do before doing it. Just call the tool.",
  ].join("\n");
}

export function buildSubmitRules(): string {
  return [
    "Submit and completion rules:",
    "1. You MUST call submit_output when the task is fully complete. No other action signals completion.",
    "2. If tests are failing, you MUST NOT submit. Fix the tests first.",
    "3. When calling submit_output, include a brief summary of what was done.",
  ].join("\n");
}

export function buildBudgetRules(): string {
  return [
    "Budget and read limits:",
    "1. Do not re-read a file you already read. The tool will return an error if you try.",
    "2. Never write large files in a single write_file call. If a file exceeds ~200 lines, write it in sections using run_shell (printf or cat heredoc) or break the work into edit_file calls on an existing scaffold.",
  ].join("\n");
}

export function buildPlanRules(): string {
  return [
    "Plan requirements:",
    "1. If you submit a plan, keep work aligned with it and update it if the approach changes.",
  ].join("\n");
}

export function buildPlanDecisionRules(): string {
  return [
    "Planning decision (apply on turn 1):",
    "EXECUTE DIRECTLY — only if ALL of the following are true:",
    "- Task touches 3 or fewer files",
    "- Only modifies existing code (no new modules, types, or files from scratch)",
    "- Reversible (no deletions, schema changes, or breaking interface changes)",
    "- Risk is low",
    "SUBMIT PLAN FIRST — if ANY of the following are true:",
    "- Task touches 4 or more files",
    "- Adds new modules, types, or architectural structures",
    "- Touches migrations, schemas, config files, or breaking interfaces",
    "- Solution path is non-obvious or requires exploration first",
  ].join("\n");
}

export function buildAvailableTools(tools = defaultAgentTools): string {
  return `Available tools: ${tools.join(", ")}.`;
}

export function buildSystemPrompt(tools = defaultAgentTools): string {
  return joinSections([
    buildAgentRole(),
    buildToolCallDiscipline(),
    buildSubmitRules(),
    buildBudgetRules(),
    buildPlanRules(),
    buildPlanDecisionRules(),
    buildAvailableTools(tools),
  ]);
}

export function buildChatSystemPrompt(): string {
  return joinSections([
    "You are a helpful coding assistant.",
    "Use tools to accomplish work: read files, write files, edit files, run commands, search code. Respond naturally for questions and conversation.",
    buildBudgetRules(),
    buildPlanRules(),
    buildAvailableTools(defaultChatTools),
  ]);
}
