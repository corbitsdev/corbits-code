import { describe, test, expect } from "bun:test";
import type { AgentTool } from "@intx/agent";
import { createDynamicToolRunner } from "./dynamic-tool-runner.js";
import { advertisedTools } from "../agent/tool-search.js";

const stringTool = (name: string, reply: string): AgentTool => ({
  kind: "string",
  definition: { name, description: name, inputSchema: { type: "object", properties: {}, required: [] } },
  handler: async () => reply,
});

describe("blind tool dispatch", () => {
  test("a registered-but-unadvertised tool is still callable", async () => {
    const runner = createDynamicToolRunner([
      stringTool("read_file", "core"),
      stringTool("mcp__acme__do", "blind-result"),
    ]);

    // The on-demand tool is intentionally absent from the advertised wire set,
    // yet dispatch resolves it — this is how tool_search discovery stays usable
    // without growing the cached tools prefix.
    const advertised = advertisedTools(runner.currentDefinitions()).map((d) => d.name);
    expect(advertised).not.toContain("mcp__acme__do");

    const result = await runner.run(
      { id: "1", name: "mcp__acme__do", arguments: {} },
      new AbortController().signal,
    );
    expect(result.content).toBe("blind-result");
    expect(result.isError).toBeUndefined();
  });
});

describe("terminal control stripping", () => {
  test("strips escape sequences from any tool's result, including MCP", async () => {
    const payload = "before\x1b]52;c;ZXZpbA==\x07\x1b[31mred\x1b[0m\x07after";
    const runner = createDynamicToolRunner([stringTool("mcp__acme__do", payload)]);

    const result = await runner.run(
      { id: "1", name: "mcp__acme__do", arguments: {} },
      new AbortController().signal,
    );

    expect(result.content).toBe("beforeredafter");
  });
});
