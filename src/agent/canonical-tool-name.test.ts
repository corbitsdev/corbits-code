import { describe, expect, test } from "bun:test";
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
