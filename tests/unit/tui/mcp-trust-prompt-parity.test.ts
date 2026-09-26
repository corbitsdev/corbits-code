import { describe, expect, test } from "bun:test";
import type { MCPServerConfig } from "../../../src/config/settings.js";
import { formatExecMcpTrustQuestion } from "../../../src/exec/runner.js";
import { formatTuiMcpTrustQuestion } from "../../../src/tui/runner/session.js";

const parityCases: MCPServerConfig[] = [
  {
    name: "plain-stdio",
    command: "node",
    args: ["server.js", "--port", "3000"],
  },
  { name: "no-args", command: "node" },
  { name: "empty-args", command: "node", args: [] },
  { name: "spaced-path", command: "server", args: ["--dir", "/tmp/my work"] },
  { name: "one-spaced-arg", command: "run", args: ["a b"] },
  { name: "two-plain-args", command: "run", args: ["a", "b"] },
  { name: "tab-arg", command: "run", args: ["a\tb"] },
  { name: "quoted-arg", command: "run", args: ['say "hi"'] },
  { name: "empty-string-arg", command: "run", args: [""] },
  {
    name: "with-secrets",
    command: "private-server",
    args: ["--token", "super secret"],
    env: { API_TOKEN: "super-secret" },
  },
  { name: "http-server", type: "http", url: "https://mcp.example.test/api" },
  { name: "bare-name" },
];

describe("MCP trust prompt TTY/TUI parity", () => {
  for (const server of parityCases) {
    test(`TTY and TUI render "${server.name}" identically`, () => {
      expect(formatTuiMcpTrustQuestion(server)).toBe(
        formatExecMcpTrustQuestion(server),
      );
    });
  }

  test('both surfaces keep ["a b"] distinct from ["a", "b"]', () => {
    const oneArg: MCPServerConfig = {
      name: "s",
      command: "run",
      args: ["a b"],
    };
    const twoArgs: MCPServerConfig = {
      name: "s",
      command: "run",
      args: ["a", "b"],
    };
    for (const format of [
      formatExecMcpTrustQuestion,
      formatTuiMcpTrustQuestion,
    ]) {
      expect(format(oneArg)).toContain('"a b"');
      expect(format(oneArg)).not.toBe(format(twoArgs));
    }
  });

  test("both surfaces render tab/newline args escaped with no raw control characters", () => {
    const server: MCPServerConfig = {
      name: "s",
      command: "run",
      args: ["a\tb", "x\ny"],
    };
    for (const format of [
      formatExecMcpTrustQuestion,
      formatTuiMcpTrustQuestion,
    ]) {
      const rendered = format(server);
      expect(rendered).toContain('"a\\tb"');
      expect(rendered).toContain('"x\\ny"');
      expect(rendered).not.toContain("\t");
      expect(rendered.split("\n")).toHaveLength(2);
    }
  });
});
