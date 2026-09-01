import { type } from "arktype";
import { relative, isAbsolute } from "node:path";
import type { SemanticRole } from "./semantic-theme.js";
import { isMcpToolName, humanizeMcpTool } from "../mcp/tool-name.js";
import { formatMcpResult } from "./mcp-result-format.js";

export interface ToolArgSummary {
  summary: string;
  full: string;
}

export interface ToolCallDescriptor {
  // Human-facing tool name — never the raw snake_case identifier.
  display: string;
  // Semantic colour role for the action (writes read as additions, deletions
  // as danger, and so on).
  role: SemanticRole;
  summary: string;
  full: string;
  // run_shell is rendered leanly: the command is the headline, not a loud tag.
  isShell: boolean;
}

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
  manage_tasks: "Manage tasks",
  submit_output: "Submit",
  ask_operator: "Ask operator",
};

// run_shell prefixes a failed result with "exit code N\n<output>" (see
// summarizeToolResult's run_shell case); other tool errors, and shell errors
// raised outside that envelope (e.g. a rejected permission), carry no such
// prefix and should render as plain errors instead of a parsed exit summary.
const SHELL_EXIT_ENVELOPE = /^exit code \d+\n/;

export function isShellExitEnvelope(toolName: string, content: string): boolean {
  return toolName === "run_shell" && SHELL_EXIT_ENVELOPE.test(content);
}

// Brand of the active web plugin (e.g. "Exa"), set at startup when a web plugin
// overrides the built-in provider. Renders web_search/web_fetch as branded
// actions so it is clear which backend served the call.
let activeWebProviderBrand: string | undefined;

export function setActiveWebProviderBrand(brand: string | undefined): void {
  activeWebProviderBrand = brand !== undefined && brand.length > 0 ? brand : undefined;
}

export function humanizeToolName(toolName: string): string {
  if (activeWebProviderBrand !== undefined) {
    if (toolName === "web_search") return `${activeWebProviderBrand} Search`;
    if (toolName === "web_fetch") return `${activeWebProviderBrand} Fetch`;
  }
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
      return "success";
    case "read_file":
    case "search_files":
    case "grep":
    case "list_dir":
    case "web_search":
    case "web_fetch":
      return "warning";
    case "run_shell":
      return "danger";
    default:
      return "accent";
  }
}

// One source of truth for how a tool call presents: its human name, its action
// colour, and its argument summary. run_shell is special-cased so the command
// itself is the headline.
export function describeToolCall(toolName: string, rawArgs: string): ToolCallDescriptor {
  // `present` carries a large view spec as its arguments; never dump that JSON.
  // On success the rendered view block stands in for this line; on failure
  // turns-to-blocks.ts leaves the tool_call in place, so this line is all the
  // user sees alongside the separate error tool_result — keep it labeled.
  if (toolName === "present") {
    return {
      display: "Render view",
      role: "accent",
      summary: "(invalid spec)",
      full: "",
      isShell: false,
    };
  }
  if (toolName === "run_shell") {
    const shellParsed = ShellArgSchema(tryParseObject(rawArgs));
    const command = !(shellParsed instanceof type.errors) ? shellParsed.command : rawArgs.trim();
    return {
      display: "Shell",
      role: shellRole(command),
      summary: command,
      full: command,
      isShell: true,
    };
  }
  if (toolName === "spawn_agent" || toolName === "task") {
    const taskParsed = TaskArgSchema(tryParseObject(rawArgs));
    if (!(taskParsed instanceof type.errors)) {
      const agentName = taskParsed.agent?.trim();
      const description = (taskParsed.description ?? "").trim();
      // description is optional on spawn; the brief's prompt is the next best
      // subject so the row never falls through to raw argument JSON.
      const prompt = (taskParsed.prompt ?? "").trim();
      const subject = description.length > 0 ? description : prompt;
      const display =
        agentName !== undefined && agentName.length > 0
          ? agentName[0]!.toUpperCase() + agentName.slice(1)
          : "Worker";
      // Collapsed row uses the abbreviated subject; Alt+E expands to the full text.
      return {
        display,
        role: "accent",
        summary: subject.length > 0 ? abbreviate(subject, ARG_VALUE_MAX) : "",
        full: subject,
        isShell: false,
      };
    }
  }
  const { summary, full } = summarizeToolArgs(toolName, rawArgs);
  return {
    display: humanizeToolName(toolName),
    role: toolRole(toolName),
    summary,
    full,
    isShell: false,
  };
}

export interface ToolResultSummary {
  preview: string;
  full: string;
  isJSONDocument: boolean;
}

const ARG_VALUE_MAX = 48;

// Rendering JSON as a document runs it through the markdown parser, whose cost is
// roughly quadratic in content length (a 320KB API dump takes ~half a second and
// blocks every frame while it runs). Past this size the document is shown as plain
// text instead, which wraps in about a millisecond. Markdown styling on a raw JSON
// blob adds nothing anyway — it only misreads JSON punctuation as emphasis.
const MAX_JSON_DOCUMENT_CHARS = 32 * 1024;

function shortenPath(p: string): string {
  if (!isAbsolute(p)) return p;
  const rel = relative(process.cwd(), p);
  return rel.startsWith("..") ? p : rel;
}

const PathArgSchema = type({ path: "string" });
const GrepArgSchema = type({ pattern: "string", "path?": "string", "glob?": "string" });
const SearchFilesArgSchema = type({ pattern: "string", "path?": "string" });
const WebSearchArgSchema = type({ query: "string" });
const WebFetchArgSchema = type({ url: "string" });
const ShellArgSchema = type({ command: "string" });
const TaskArgSchema = type({
  "agent?": "string",
  "description?": "string",
  "prompt?": "string",
});
const WebSearchResultSchema = type({ results: "unknown[]" });
const WebFetchResultSchema = type({ content: "string" });

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
 * JSON. The full form keeps every pair on its own line for the Alt+E reveal.
 */
export function summarizeToolArgs(toolName: string, rawArgs: string): ToolArgSummary {
  const obj = tryParseObject(rawArgs);

  // Known file tools read cleanly as just their path, mirroring the result row
  // (call "Write donut_anim.py" alongside result "Wrote donut_anim.py").
  switch (toolName) {
    case "write_file":
    case "edit_file":
    case "read_file": {
      const parsed = PathArgSchema(obj);
      if (!(parsed instanceof type.errors)) {
        const p = shortenPath(parsed.path);
        return { summary: p, full: p };
      }
      break;
    }
    case "spawn_agent":
    case "task": {
      // Spawns carry a large structured brief (prompt, intent, criteria). The
      // transcript only needs a short subject — prefer description, then prompt —
      // so the row never dumps the whole JSON payload.
      const parsed = TaskArgSchema(obj);
      if (!(parsed instanceof type.errors)) {
        const desc = (parsed.description ?? "").trim();
        if (desc.length > 0) {
          return { summary: abbreviate(desc, ARG_VALUE_MAX), full: desc };
        }
        const prompt = (parsed.prompt ?? "").trim();
        if (prompt.length > 0) {
          return { summary: abbreviate(prompt, ARG_VALUE_MAX), full: prompt };
        }
      }
      return { summary: "", full: "" };
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
  const full = entries.map(([key, value]) => `${key}: ${scalarToString(value)}`).join("\n");
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

function lineCountLabel(n: number): string {
  return n === 1 ? "1 line" : `${n} lines`;
}

function pathFromArgs(rawArgs: string): string | null {
  const parsed = PathArgSchema(tryParseObject(rawArgs));
  if (parsed instanceof type.errors) return null;
  return shortenPath(parsed.path);
}

function grepMatchCount(content: string): number | null {
  if (/^no matches for/.test(content)) return 0;
  return countLines(content.replace(/\n\.\.\. \(.*shown\)$/, ""));
}

function searchFileCount(content: string): number | null {
  if (/^no files matching/.test(content)) return 0;
  return countLines(content.replace(/\n\.\.\. \(.*shown\)$/, ""));
}

/**
 * One collapsed log line merging the tool action (args) and outcome (result).
 */
export function mergedToolCollapsedPreview(
  toolName: string,
  rawArgs: string,
  rawResult: string,
  isError: boolean,
): string {
  const argSummary = summarizeToolArgs(toolName, rawArgs).summary;
  const { preview: outcomePreview } = summarizeToolResult(toolName, rawResult);

  if (isError) {
    const err = abbreviate(
      rawResult
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .join(" "),
      72,
    );
    if (argSummary.length > 0) return `${humanizeToolName(toolName)} ${argSummary} — ${err}`;
    return err.length > 0 ? err : "error";
  }

  if (toolName === "run_shell") {
    const command = describeToolCall(toolName, rawArgs).summary;
    if (outcomePreview === "(no output)") return command;
    return `${command} → ${outcomePreview}`;
  }

  if (toolName === "read_file") {
    const path = pathFromArgs(rawArgs);
    const n = countLines(rawResult);
    if (path) return `Read ${lineCountLabel(n)} of ${path}`;
    return outcomePreview;
  }

  if (toolName === "write_file") {
    const path = pathFromArgs(rawArgs) ?? pathFromResult(toolName, rawResult);
    const bytes = rawResult.match(/wrote (\d+) bytes/);
    if (path && bytes) return `Wrote ${bytes[1]} bytes to ${shortenPath(path)}`;
    if (path) return `Wrote ${path}`;
    return outcomePreview;
  }

  if (toolName === "edit_file") {
    const path = pathFromArgs(rawArgs) ?? pathFromResult(toolName, rawResult);
    const occ = rawResult.match(/replaced (\d+) occurrence/);
    if (path && occ) return `Edited ${path} (${occ[1]} replacement${occ[1] === "1" ? "" : "s"})`;
    if (path) return `Edited ${path}`;
    return outcomePreview;
  }

  if (toolName === "grep") {
    const parsed = GrepArgSchema(tryParseObject(rawArgs));
    const scope =
      !(parsed instanceof type.errors) && parsed.path !== undefined && parsed.path.length > 0
        ? ` in ${shortenPath(parsed.path)}`
        : argSummary.length > 0 && !argSummary.includes("pattern:")
          ? ` in ${argSummary}`
          : "";
    const count = grepMatchCount(rawResult);
    if (count === 0) return `Grep found no matches${scope}`;
    if (count !== null) return `Found ${count} matches with Grep${scope}`;
    return outcomePreview;
  }

  if (toolName === "search_files") {
    const parsed = SearchFilesArgSchema(tryParseObject(rawArgs));
    const pattern = !(parsed instanceof type.errors) ? parsed.pattern : null;
    const count = searchFileCount(rawResult);
    if (count === 0) return pattern ? `No files matched ${pattern}` : "No files matched";
    if (count !== null && pattern) return `Found ${count} files matching ${pattern}`;
    return outcomePreview;
  }

  if (toolName === "list_dir") {
    const path = pathFromArgs(rawArgs);
    const entries = countLines(rawResult.replace(/\n\.\.\. \(.*shown\)$/, ""));
    if (path && entries > 0) return `Listed ${entries} entries in ${path}`;
    if (path) return `Listed ${path}`;
    return outcomePreview;
  }

  if (toolName === "web_search") {
    const parsed = WebSearchArgSchema(tryParseObject(rawArgs));
    const query = !(parsed instanceof type.errors) ? abbreviate(parsed.query, ARG_VALUE_MAX) : "";
    if (query.length > 0 && outcomePreview.length > 0) return `${outcomePreview} for "${query}"`;
    return outcomePreview;
  }

  if (toolName === "web_fetch") {
    const parsed = WebFetchArgSchema(tryParseObject(rawArgs));
    if (!(parsed instanceof type.errors)) {
      const host = abbreviate(parsed.url.replace(/^https?:\/\//, ""), ARG_VALUE_MAX);
      return `${outcomePreview} from ${host}`;
    }
    return outcomePreview;
  }

  if (toolName === "spawn_agent" || toolName === "task") {
    // describeToolCall already curates the spawn brief to a short description;
    // reusing it here keeps the collapsed row free of prompt/intent/criteria dumps.
    const { display, summary } = describeToolCall(toolName, rawArgs);
    if (summary.length > 0) return `${display} ${summary} — ${outcomePreview}`;
    return `${display} — ${outcomePreview}`;
  }

  if (isMcpToolName(toolName)) {
    const label = humanizeToolName(toolName);
    if (argSummary.length > 0) return `${label} ${argSummary} — ${outcomePreview}`;
    return `${label} — ${outcomePreview}`;
  }

  if (argSummary.length > 0) {
    const label = humanizeToolName(toolName);
    if (outcomePreview === argSummary || outcomePreview.includes(argSummary)) return outcomePreview;
    return `${label} ${argSummary} — ${outcomePreview}`;
  }

  return outcomePreview;
}

function pathFromResult(_toolName: string, content: string): string | null {
  // write_file -> "wrote N bytes to <path>", edit_file -> "replaced N occurrence(s) in <path>"
  const wrote = content.match(/wrote \d+ bytes to (.+)$/m);
  if (wrote) return wrote[1] ?? null;
  const edited = content.match(/replaced \d+ occurrence\(s\) in (.+)$/m);
  if (edited) return edited[1] ?? null;
  return null;
}

// Worker reports are either "Sub-agent \"desc\" reported:\n\n## Summary\n..."
// or a cancel notice. Pull a one-line human preview without leaking markdown headers.
function summarizeTaskResultPreview(content: string): string {
  const trimmed = content.trim();
  if (/^Sub-agent ".+" cancelled/i.test(trimmed)) {
    return "cancelled";
  }
  const reported = trimmed.match(/^Sub-agent "([^"]*)" reported:\s*([\s\S]*)$/i);
  const body = (reported?.[2] ?? trimmed).trim();
  const summarySection = body.match(/^##\s+Summary\s*\n([\s\S]*?)(?=\n##\s|\s*$)/im);
  if (summarySection) {
    const first = summarySection[1]!
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    if (first !== undefined && first.length > 0) return abbreviate(first, 64);
  }
  const withoutHeadings = body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^##\s+/.test(l));
  const first = withoutHeadings[0] ?? "";
  return first.length > 0 ? abbreviate(first, 64) : "(no output)";
}

function summarizeSpawnAgentResultPreview(content: string): string {
  const obj = tryParseObject(content);
  if (obj !== null && typeof obj.status === "string") {
    const id = typeof obj.agent_id === "string" ? obj.agent_id.trim() : "";
    return id.length > 0 ? `${obj.status} ${id}` : obj.status;
  }
  return summarizeTaskResultPreview(content);
}

function summarizeWaitAgentsResultPreview(content: string): string {
  const obj = tryParseObject(content);
  if (obj === null) return summarizeTaskResultPreview(content);
  const results = Array.isArray(obj.results) ? obj.results : [];
  for (const item of results) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.report === "string" && rec.report.trim().length > 0) {
      return summarizeTaskResultPreview(rec.report);
    }
  }
  if (obj.timed_out === true) return "timed out";
  const statuses = results.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const rec = item as Record<string, unknown>;
    return typeof rec.status === "string" ? [rec.status] : [];
  });
  if (statuses.length > 0) return statuses.join(", ");
  return abbreviate(content, 64) || "(no output)";
}

const WebSearchItemSchema = type({ "title?": "string", "url?": "string", "snippet?": "string" });

const SEARCH_DISPLAY_LIMIT = 5;

function webSearchSummary(raw: string): ToolResultSummary | null {
  const parsed = WebSearchResultSchema(tryParseObject(raw));
  if (parsed instanceof type.errors) return null;
  const { results } = parsed;
  if (results.length === 0) {
    return { preview: "No web results", full: "No web results", isJSONDocument: false };
  }
  const displayed = results.slice(0, SEARCH_DISPLAY_LIMIT);
  const lines = displayed.flatMap((item, index) => {
    const rec = WebSearchItemSchema(item);
    if (rec instanceof type.errors) return [`${index + 1}. ${scalarToString(item)}`];
    const title = rec.title ?? "Untitled";
    const url = rec.url ?? "";
    const snippet = rec.snippet ?? "";
    return [
      `${index + 1}. ${title}`,
      ...(url.length > 0 ? [`   ${url}`] : []),
      ...(snippet.length > 0 ? [`   ${snippet}`] : []),
    ];
  });
  if (results.length > SEARCH_DISPLAY_LIMIT) {
    lines.push(`\n... ${results.length - SEARCH_DISPLAY_LIMIT} more results`);
  }
  const noun = results.length === 1 ? "result" : "results";
  return {
    preview: `Found ${results.length} web ${noun}`,
    full: lines.join("\n"),
    isJSONDocument: false,
  };
}

const FETCH_DISPLAY_LINE_LIMIT = 200;

function webFetchSummary(raw: string): ToolResultSummary | null {
  const parsed = WebFetchResultSchema(tryParseObject(raw));
  if (parsed instanceof type.errors) return null;
  const lines = parsed.content.split("\n");
  const totalLines = lines.length;
  const visible = lines.slice(0, FETCH_DISPLAY_LINE_LIMIT).join("\n");
  const full =
    totalLines > FETCH_DISPLAY_LINE_LIMIT
      ? `${visible}\n\n[... ${totalLines - FETCH_DISPLAY_LINE_LIMIT} more lines]`
      : visible;
  return {
    preview: `Fetched ${totalLines} lines`,
    full,
    isJSONDocument: false,
  };
}

/**
 * Collapse a tool result to a single human-readable preview line. The raw
 * content is preserved in `full` for the Alt+E reveal. `isJSONDocument` is
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
      preview = `Read ${lineCountLabel(countLines(content))}`;
      break;
    }
    case "write_file": {
      const path = pathFromResult(toolName, content);
      preview = path ? `Wrote ${shortenPath(path)}` : content.trim() || "Wrote file";
      break;
    }
    case "edit_file": {
      const path = pathFromResult(toolName, content);
      preview = path ? `Edited ${shortenPath(path)}` : content.trim() || "Edited file";
      break;
    }
    case "run_shell": {
      // Success returns raw output; failure is prefixed "exit code N\n<output>".
      const fail = content.match(/^exit code (\d+)\n([\s\S]*)$/);
      const output = fail ? (fail[2] ?? "") : content;
      const firstLine = output.split("\n").find((line) => line.trim().length > 0) ?? "";
      const lineCount = countLines(output);
      const more = lineCount > 1 ? ` (+${lineCount - 1} more lines)` : "";
      if (fail) {
        preview = firstLine.length > 0 ? `exit ${fail[1]}: ${firstLine}${more}` : `exit ${fail[1]}`;
      } else {
        preview = firstLine.length > 0 ? `${firstLine}${more}` : "(no output)";
      }
      break;
    }
    case "spawn_agent": {
      // Live payload is `{"agent_id","status":"running"}`. Historical fused
      // spawn+wait bodies still peel the report envelope.
      preview = summarizeSpawnAgentResultPreview(content);
      break;
    }
    case "wait_agents": {
      // Collect returns `{results:[{report}], timed_out}`. Peel ## Summary from
      // the first report so raw markdown headings never leak into the transcript.
      preview = summarizeWaitAgentsResultPreview(content);
      break;
    }
    case "task": {
      // Resume of a retired fused spawn: format the old report envelope without
      // remounting a callable `task` tool.
      preview = summarizeTaskResultPreview(content);
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
 * Documents above MAX_JSON_DOCUMENT_CHARS are excluded so the markdown renderer
 * never chokes on a huge blob (see the constant for why).
 */
export function isUserFacingJSON(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_JSON_DOCUMENT_CHARS) return false;
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
