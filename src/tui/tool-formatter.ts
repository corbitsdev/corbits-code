import type { SemanticRole } from "./theme.js";
import { isMcpToolName, humanizeMcpTool } from "../mcp/tool-name.js";
import { formatMcpResult } from "./mcp-result-format.js";

export type ToolArgSummary = {
  summary: string;
  full: string;
};

export type ToolCallDescriptor = {
  // Human-facing tool name — never the raw snake_case identifier.
  display: string;
  // Semantic colour role for the action (writes read as additions, deletions
  // as danger, and so on).
  role: SemanticRole;
  summary: string;
  full: string;
  // run_shell is rendered leanly: the command is the headline, not a loud tag.
  isShell: boolean;
};

const TOOL_DISPLAY_NAMES: Record<string, string> = {
  read_file: "Read",
  write_file: "Write",
  edit_file: "Edit",
  run_shell: "Shell",
  search_files: "Search",
  grep: "Grep",
  list_dir: "List",
  web_search: "Web Search",
  web_fetch: "Web Fetch",
  submit_plan: "Plan",
  submit_output: "Submit",
  ask_operator: "Ask operator",
};

export function humanizeToolName(toolName: string): string {
  const known = TOOL_DISPLAY_NAMES[toolName];
  if (known !== undefined) return known;
  // MCP tools read as "Server: tool name" rather than the raw mcp__ identifier.
  if (isMcpToolName(toolName)) return humanizeMcpTool(toolName);
  // Other unknown tools must still never leak as snake_case: title-case them.
  return toolName
    .split(/[_\s]+/)
    .filter((word) => word.length > 0)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(" ");
}

function shellRole(command: string): SemanticRole {
  const first = command.trim().split(/\s+/)[0] ?? "";
  if (/^rm$|^rmdir$/.test(first)) return "danger";
  if (first === "git" && /\brm\b/.test(command)) return "danger";
  return "muted";
}

function toolRole(toolName: string): SemanticRole {
  switch (toolName) {
    case "write_file":
      return "success";
    case "edit_file":
      return "accent";
    case "read_file":
    case "search_files":
    case "grep":
    case "list_dir":
      return "muted";
    case "web_search":
    case "web_fetch":
      return "accent";
    default:
      return "accent";
  }
}

// One source of truth for how a tool call presents: its human name, its action
// colour, and its argument summary. run_shell is special-cased so the command
// itself is the headline.
export function describeToolCall(toolName: string, rawArgs: string): ToolCallDescriptor {
  if (toolName === "run_shell") {
    const obj = tryParseObject(rawArgs);
    const command = obj !== null && typeof obj.command === "string" ? obj.command : rawArgs.trim();
    return { display: "Shell", role: shellRole(command), summary: command, full: command, isShell: true };
  }
  const { summary, full } = summarizeToolArgs(toolName, rawArgs);
  return { display: humanizeToolName(toolName), role: toolRole(toolName), summary, full, isShell: false };
}

export type ToolResultSummary = {
  preview: string;
  full: string;
  isJSONDocument: boolean;
};

const ARG_VALUE_MAX = 48;

function tryParseObject(raw: string): Record<string, unknown> | null {
  if (raw.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

function scalarToString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  // Nested object/array: keep it compact rather than dumping pretty JSON inline.
  return Array.isArray(value) ? `[${value.length} items]` : "{…}";
}

function abbreviate(value: string, max: number): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : oneLine.slice(0, max - 1) + "…";
}

/**
 * Render tool arguments as a human-readable "key: value" line rather than raw
 * JSON. The full form keeps every pair on its own line for the /verbose reveal.
 */
export function summarizeToolArgs(toolName: string, rawArgs: string): ToolArgSummary {
  const obj = tryParseObject(rawArgs);

  // Known file tools read cleanly as just their path, mirroring the result row
  // (call "Write donut_anim.py" alongside result "Wrote donut_anim.py").
  switch (toolName) {
    case "write_file":
    case "edit_file":
    case "read_file": {
      if (obj !== null && typeof obj.path === "string") {
        return { summary: obj.path, full: obj.path };
      }
      break;
    }
  }

  if (obj === null) {
    // Not a JSON object: show whatever we got, abbreviated, never as a blob.
    const fallback = rawArgs.trim();
    return { summary: abbreviate(fallback, ARG_VALUE_MAX * 2), full: fallback };
  }

  const entries = Object.entries(obj);
  if (entries.length === 0) return { summary: "", full: "" };

  const summary = entries
    .map(([key, value]) => `${key}: ${abbreviate(scalarToString(value), ARG_VALUE_MAX)}`)
    .join(", ");
  const full = entries
    .map(([key, value]) => `${key}: ${scalarToString(value)}`)
    .join("\n");
  return { summary, full };
}

function stripLineNumbers(content: string): string {
  return content
    .split("\n")
    .map((line) => line.replace(/^\s*\d+\t/, ""))
    .join("\n");
}

function countLines(content: string): number {
  if (content.length === 0) return 0;
  const trimmed = content.endsWith("\n") ? content.slice(0, -1) : content;
  return trimmed.split("\n").length;
}

function pathFromResult(toolName: string, content: string): string | null {
  // write_file -> "wrote N bytes to <path>", edit_file -> "replaced N occurrence(s) in <path>"
  const wrote = content.match(/wrote \d+ bytes to (.+)$/m);
  if (wrote) return wrote[1] ?? null;
  const edited = content.match(/replaced \d+ occurrence\(s\) in (.+)$/m);
  if (edited) return edited[1] ?? null;
  return null;
}

function webSearchSummary(raw: string): ToolResultSummary | null {
  const obj = tryParseObject(raw);
  const results = obj?.results;
  if (!Array.isArray(results)) return null;
  if (results.length === 0) {
    return { preview: "No web results", full: "No web results", isJSONDocument: false };
  }
  const lines = results.flatMap((item, index) => {
    if (typeof item !== "object" || item === null) {
      return [`${index + 1}. ${scalarToString(item)}`];
    }
    const record = item as Record<string, unknown>;
    const title = typeof record.title === "string" ? record.title : "Untitled";
    const url = typeof record.url === "string" ? record.url : "";
    const snippet = typeof record.snippet === "string" ? record.snippet : "";
    return [
      `${index + 1}. ${title}`,
      ...(url.length > 0 ? [`   ${url}`] : []),
      ...(snippet.length > 0 ? [`   ${snippet}`] : []),
    ];
  });
  const noun = results.length === 1 ? "result" : "results";
  return {
    preview: `Found ${results.length} web ${noun}`,
    full: lines.join("\n"),
    isJSONDocument: false,
  };
}

function webFetchSummary(raw: string): ToolResultSummary | null {
  const obj = tryParseObject(raw);
  if (obj === null || typeof obj.content !== "string") return null;
  return {
    preview: `Fetched ${countLines(obj.content)} lines`,
    full: obj.content,
    isJSONDocument: false,
  };
}

/**
 * Collapse a tool result to a single human-readable preview line. The raw
 * content is preserved in `full` for the /verbose reveal. `isJSONDocument` is
 * true ONLY when the content is genuinely a JSON document the user would want
 * to read as JSON — never for tool envelopes or status strings.
 */
export function summarizeToolResult(toolName: string, rawResult: string): ToolResultSummary {
  const content = rawResult;
  const full = content;

  // MCP results are arbitrary, often enormous JSON. Render a compact, bounded
  // summary instead of the raw document — dumping it verbatim freezes the TUI
  // and is unreadable. Never flagged as a JSON document for that reason.
  if (isMcpToolName(toolName)) {
    const summary = formatMcpResult(content);
    return { preview: summary.preview, full: summary.full, isJSONDocument: false };
  }

  if (toolName === "web_search") {
    const webSummary = webSearchSummary(content);
    if (webSummary !== null) return webSummary;
  }
  if (toolName === "web_fetch") {
    const fetchSummary = webFetchSummary(content);
    if (fetchSummary !== null) return fetchSummary;
  }

  // read_file line-numbers its output ("     1\t<line>"), so strip those prefixes
  // before testing for a JSON document — otherwise a real .json file never matches.
  const contentForDetection = toolName === "read_file" ? stripLineNumbers(content) : content;
  const isJSONDocument = isUserFacingJSON(contentForDetection);

  let preview: string;
  switch (toolName) {
    case "read_file": {
      // read_file returns line-numbered content ("     1\t<line>").
      preview = `Read ${countLines(content)} lines`;
      break;
    }
    case "write_file": {
      const path = pathFromResult(toolName, content);
      preview = path ? `Wrote ${path}` : content.trim() || "Wrote file";
      break;
    }
    case "edit_file": {
      const path = pathFromResult(toolName, content);
      preview = path ? `Edited ${path}` : content.trim() || "Edited file";
      break;
    }
    case "run_shell": {
      // Success returns raw output; failure is prefixed "exit code N\n<output>".
      const fail = content.match(/^exit code (\d+)\n([\s\S]*)$/);
      if (fail) {
        preview = `Shell: exit ${fail[1]} — ${countLines(fail[2] ?? "")} lines of output`;
      } else {
        preview = `Shell: exit 0 — ${countLines(content)} lines of output`;
      }
      break;
    }
    case "search_files": {
      if (/^no files matching/.test(content)) {
        preview = "No files matched";
      } else {
        preview = `Found ${countLines(content.replace(/\n\.\.\. \(.*shown\)$/, ""))} files`;
      }
      break;
    }
    case "grep": {
      if (/^no matches for/.test(content)) {
        preview = "No matches";
      } else {
        preview = `Found ${countLines(content.replace(/\n\.\.\. \(.*shown\)$/, ""))} matches`;
      }
      break;
    }
    default: {
      preview = abbreviate(content, 64) || "(no output)";
      break;
    }
  }

  return { preview, full, isJSONDocument };
}

/**
 * Decide whether raw content is a JSON document worth showing AS JSON.
 *
 * Why a heuristic: tool results are plain strings. Many tools never return JSON
 * (line-numbered file content, "wrote N bytes", shell output). A few legitimately
 * do — e.g. reading a .json file. We must not treat internal status strings or
 * accidental brace-shaped text as documents, and we must not hide genuine JSON.
 *
 * Rule: the content must parse as JSON AND be a non-trivial object or array
 * (the shapes a real document takes). Bare scalars ("null", "42", quoted
 * strings) and empty containers are not documents — they are almost always
 * status values, not something the user authored or wants pretty-printed.
 */
export function isUserFacingJSON(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return false;
  const first = trimmed[0];
  if (first !== "{" && first !== "[") return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return false;
  }
  if (Array.isArray(parsed)) return parsed.length > 0;
  if (typeof parsed === "object" && parsed !== null) {
    return Object.keys(parsed).length > 0;
  }
  return false;
}
