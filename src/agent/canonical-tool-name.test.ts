import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { isSameTool } from "./canonical-tool-name.js";

describe("isSameTool", () => {
  test.each([
    // Engine id against itself.
    ["read_file", "read_file"],
    ["manage_tasks", "manage_tasks"],
    // Default-profile wire names the model actually emits.
    ["read", "read_file"],
    ["read_file", "read"],
    ["edit", "edit_file"],
    ["bash", "run_shell"],
    ["run_shell", "bash"],
    ["todowrite", "manage_tasks"],
    ["manage_tasks", "todowrite"],
    // Hidden gpt-profile aliases dispatch onto the same engine.
    ["shell", "run_shell"],
    ["shell", "bash"],
    ["update_plan", "manage_tasks"],
    ["wait", "wait_agents"],
    // Muse Spark default./doubled prefixes collapse first.
    ["default.read", "read_file"],
    ["default.read_file", "read"],
    ["read.read", "read_file"],
    ["default.bash", "run_shell"],
    // Alias lookup falls back to lowercase, matching engineToolName.
    ["READ", "read_file"],
    ["Bash", "run_shell"],
    ["WAIT", "wait_agents"],
  ])("isSameTool(%j, %j) is true", (a, b) => {
    expect(isSameTool(a, b)).toBe(true);
    expect(isSameTool(b, a)).toBe(true);
  });

  test.each([
    ["read", "edit"],
    ["read_file", "write_file"],
    ["bash", "read"],
    ["todowrite", "wait_agents"],
    ["update_plan", "read_file"],
    ["wait", "run_shell"],
    ["submit_plan", "manage_tasks"],
    ["present", "manage_tasks"],
    ["submit_output", "manage_tasks"],
    ["mcp__acme__read", "read_file"],
  ])("isSameTool(%j, %j) is false", (a, b) => {
    expect(isSameTool(a, b)).toBe(false);
    expect(isSameTool(b, a)).toBe(false);
  });
});

// Callsites that compare incoming wire names must go through isSameTool (or
// the canonical modules themselves). A new raw `name === "<tool>"` compare in
// one of these files reintroduces the #1252 breakage on the next wire rename,
// so this test fails until the callsite is converted.
describe("tool-name comparison regression guard", () => {
  const CALLSITES = [
    "src/agent/director.ts",
    "src/subagent/poll-exempt.ts",
    "src/tui/mcp-view.ts",
    "src/tui/runtime-bridge.ts",
    "src/tui/stall-watchdog.ts",
    "src/agent/tool-execution-watchdog.ts",
    "src/tui/turns-to-blocks.ts",
  ];

  const TOOL_LITERALS = new Set([
    "read_file",
    "write_file",
    "edit_file",
    "delete_file",
    "run_shell",
    "search_files",
    "manage_tasks",
    "use_skill",
    "web_fetch",
    "web_search",
    "ask_operator",
    "ask_director",
    "wait_agents",
    "spawn_agent",
    "submit_output",
    "submit_plan",
    "present",
    "list_agents",
    "read",
    "write",
    "edit",
    "delete",
    "bash",
    "shell",
    "glob",
    "todowrite",
    "skill",
    "webfetch",
    "websearch",
    "question",
    "update_plan",
    "wait",
  ]);

  test("no raw tool-name ===/!== compares outside the canonical modules", async () => {
    const root = join(import.meta.dirname, "..", "..");
    const violations: string[] = [];
    for (const file of CALLSITES) {
      const text = await Bun.file(join(root, file)).text();
      for (const [index, line] of text.split("\n").entries()) {
        const match = /(?:\?\.name|\.name)\s*(===|!==)\s*(["'])([^"']+)\2/.exec(
          line,
        );
        if (match?.[3] !== undefined && TOOL_LITERALS.has(match[3])) {
          violations.push(`${file}:${index + 1}: ${line.trim()}`);
        }
        const canonical =
          /canonicalToolName\(([^)]+)\)\s*(===|!==)\s*["']/.exec(line);
        if (canonical !== null) {
          violations.push(`${file}:${index + 1}: ${line.trim()}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
