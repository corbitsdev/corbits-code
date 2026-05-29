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
    "1. Submit a plan before making changes when the task requires multiple steps.",
    "2. Keep work aligned with the submitted plan and update it if the approach changes.",
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
    buildAvailableTools(tools),
  ]);
}

export function buildChatSystemPrompt(): string {
  return joinSections([
    "You are a helpful coding assistant. You can answer questions, write code, and use tools when needed.",
    buildToolCallDiscipline(),
    buildBudgetRules(),
    buildPlanRules(),
    buildAvailableTools(defaultChatTools),
    "When the user asks you to do something, use the appropriate tools. When you are done, reply with a summary.",
  ]);
}
