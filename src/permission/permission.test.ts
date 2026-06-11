import { describe, test, expect } from "bun:test";
import type { ToolCall } from "@intx/types/runtime";
import { splitChainedCommand, tokenize, deriveCommandScopes } from "./command.js";
import { globToRegExp, matchesPattern, isApproved } from "./matcher.js";
import { classifyTool, buildRequests } from "./classify.js";
import { createPermissionGate } from "./gate.js";
import type { Approval, PermissionRequest } from "./types.js";

const shellCall = (command: string): ToolCall => ({ id: "c", name: "run_shell", arguments: { command } });

describe("splitChainedCommand", () => {
  test("splits on &&, ||, |, ; and newlines", () => {
    expect(splitChainedCommand("npm install && npm test")).toEqual(["npm install", "npm test"]);
    expect(splitChainedCommand("ls | grep foo")).toEqual(["ls", "grep foo"]);
    expect(splitChainedCommand("a; b || c")).toEqual(["a", "b", "c"]);
  });

  test("does not split inside quotes", () => {
    expect(splitChainedCommand(`echo "a && b" | cat`)).toEqual([`echo "a && b"`, "cat"]);
    expect(splitChainedCommand(`grep 'x;y' file`)).toEqual([`grep 'x;y' file`]);
  });

  test("drops empty segments", () => {
    expect(splitChainedCommand("  ;  ; ls ")).toEqual(["ls"]);
  });

  test("treats heredoc body as atomic — does not split on internal newlines", () => {
    const cmd = "cat > /tmp/out.md << 'EOF'\nline one\nline two\nEOF";
    expect(splitChainedCommand(cmd)).toHaveLength(1);
  });

  test("treats unquoted heredoc body as atomic", () => {
    const cmd = "cat > /tmp/out.md << EOF\nline one\nline two\nEOF";
    expect(splitChainedCommand(cmd)).toHaveLength(1);
  });

  test("still splits chained commands before heredoc", () => {
    const cmd = "mkdir -p /tmp && cat > /tmp/out.md << 'EOF'\nhello\nEOF";
    expect(splitChainedCommand(cmd)).toHaveLength(2);
  });
});

describe("tokenize", () => {
  test("treats a quoted run as one token", () => {
    expect(tokenize(`curl -s "https://a.com/x?y=1"`)).toEqual(["curl", "-s", "https://a.com/x?y=1"]);
  });
});

describe("deriveCommandScopes", () => {
  test("a multiplexer command starts the ladder at two tokens, never the bare program", () => {
    const scopes = deriveCommandScopes("npm exec --vite build");
    const patterns = scopes.map((s) => s.pattern);
    expect(patterns).toEqual(["npm exec *", "npm exec --vite *", "npm exec --vite build"]);
    expect(patterns).not.toContain("npm *");
  });

  test("a non-multiplexer command may be approved at the program level", () => {
    const patterns = deriveCommandScopes("curl https://a.com/x").map((s) => s.pattern);
    expect(patterns[0]).toBe("curl *");
  });

  test("a one-token command yields just the exact scope", () => {
    expect(deriveCommandScopes("ls").map((s) => s.pattern)).toEqual(["ls"]);
  });
});

describe("globToRegExp / matchesPattern", () => {
  test("* matches zero or more, ? matches exactly one", () => {
    expect(matchesPattern("npm exec vite", "npm *")).toBe(true);
    expect(matchesPattern("npm", "npm *")).toBe(false);
    expect(matchesPattern("ab", "a?")).toBe(true);
    expect(matchesPattern("abc", "a?")).toBe(false);
  });

  test("escapes regex metacharacters in literals", () => {
    expect(globToRegExp("a.b").test("axb")).toBe(false);
    expect(matchesPattern("a.b", "a.b")).toBe(true);
  });
});

describe("isApproved", () => {
  const approvals: Approval[] = [
    { tool: "run_shell", pattern: "npm *" },
    { tool: "write_file", pattern: "src/*" },
  ];
  test("matches by tool and pattern", () => {
    expect(isApproved("run_shell", "npm test", approvals)).toBe(true);
    expect(isApproved("run_shell", "curl x", approvals)).toBe(false);
    expect(isApproved("write_file", "src/a.ts", approvals)).toBe(true);
    expect(isApproved("write_file", "lib/a.ts", approvals)).toBe(false);
  });
});

describe("classifyTool", () => {
  test("read-only tools allow, side-effecting tools ask", () => {
    expect(classifyTool("read_file")).toBe("allow");
    expect(classifyTool("grep")).toBe("allow");
    expect(classifyTool("run_shell")).toBe("ask");
    expect(classifyTool("write_file")).toBe("ask");
    expect(classifyTool("edit_file")).toBe("ask");
  });
});

describe("buildRequests", () => {
  test("a chained shell command becomes one request per segment", () => {
    const reqs = buildRequests(shellCall("npm i && curl x"));
    expect(reqs.map((r) => r.subject)).toEqual(["npm i", "curl x"]);
    expect(reqs.every((r) => r.tool === "run_shell")).toBe(true);
  });

  test("write_file yields one path-keyed request with file scopes", () => {
    const reqs = buildRequests({ id: "c", name: "write_file", arguments: { path: "src/a.ts" } });
    expect(reqs).toHaveLength(1);
    expect(reqs[0]?.subject).toBe("src/a.ts");
    expect(reqs[0]?.scopes.map((s) => s.pattern)).toEqual(["src/a.ts", "src/*"]);
  });

  test("unknown ask-tier tools preserve arguments for approval display", () => {
    const reqs = buildRequests({ id: "c", name: "web_search", arguments: { query: "hono.dev web framework" } });
    expect(reqs).toHaveLength(1);
    expect(reqs[0]?.subject).toBe("web_search");
    expect(reqs[0]?.arguments).toEqual({ query: "hono.dev web framework" });
  });

  test("MCP tools are presented by a human label, not the raw identifier", () => {
    const reqs = buildRequests({ id: "c", name: "mcp__acme__list_projects", arguments: {} });
    expect(reqs).toHaveLength(1);
    const req = reqs[0]!;
    expect(req.action).not.toContain("mcp__");
    expect(req.scopes[0]?.label).toBe("Always allow Acme: list projects");
    expect(req.scopes[0]?.hint).toBe("Acme: list projects");
    // The raw identifier stays as the subject/pattern so approval matching is unaffected.
    expect(req.subject).toBe("mcp__acme__list_projects");
    expect(req.scopes[0]?.pattern).toBe("mcp__acme__list_projects");
  });
});

describe("createPermissionGate", () => {
  test("allow-tier tools pass without asking", async () => {
    let asked = 0;
    const gate = createPermissionGate({
      approvals: [],
      requestApproval: async () => { asked++; return { allow: true }; },
      interactive: true,
      skipPermissions: false,
    });
    const verdict = await gate.evaluate({ id: "c", name: "read_file", arguments: { path: "a" } });
    expect(verdict.allowed).toBe(true);
    expect(asked).toBe(0);
  });

  test("skipPermissions auto-allows consequential tools", async () => {
    const gate = createPermissionGate({ approvals: [], interactive: false, skipPermissions: true });
    expect((await gate.evaluate(shellCall("curl x"))).allowed).toBe(true);
  });

  test("non-interactive denies an unapproved consequential call", async () => {
    const gate = createPermissionGate({ approvals: [], interactive: false, skipPermissions: false });
    const verdict = await gate.evaluate(shellCall("curl x"));
    expect(verdict.allowed).toBe(false);
  });

  test("pre-approved patterns pass without asking", async () => {
    let asked = 0;
    const gate = createPermissionGate({
      approvals: [{ tool: "run_shell", pattern: "npm *" }],
      requestApproval: async () => { asked++; return { allow: true }; },
      interactive: true,
      skipPermissions: false,
    });
    expect((await gate.evaluate(shellCall("npm test"))).allowed).toBe(true);
    expect(asked).toBe(0);
  });

  test("asks once and persists an approved scope, then stops asking", async () => {
    const approvals: Approval[] = [];
    const persisted: Approval[] = [];
    let asked = 0;
    const persistScope: PermissionRequest["scopes"][number] = { id: "prefix-1", label: "", pattern: "npm *" };
    const gate = createPermissionGate({
      approvals,
      requestApproval: async () => { asked++; return { allow: true, persist: persistScope }; },
      persist: (a) => persisted.push(a),
      interactive: true,
      skipPermissions: false,
    });
    expect((await gate.evaluate(shellCall("npm test"))).allowed).toBe(true);
    expect((await gate.evaluate(shellCall("npm run build"))).allowed).toBe(true);
    expect(asked).toBe(1);
    expect(persisted).toEqual([{ tool: "run_shell", pattern: "npm *" }]);
  });

  test("a declined request blocks the call", async () => {
    const gate = createPermissionGate({
      approvals: [],
      requestApproval: async () => ({ allow: false }),
      interactive: true,
      skipPermissions: false,
    });
    const verdict = await gate.evaluate(shellCall("curl x"));
    expect(verdict.allowed).toBe(false);
  });

  test("every segment of a chain must be approved", async () => {
    const seen: string[] = [];
    const gate = createPermissionGate({
      approvals: [],
      requestApproval: async (req) => { seen.push(req.subject); return { allow: req.subject.startsWith("npm") }; },
      interactive: true,
      skipPermissions: false,
    });
    const verdict = await gate.evaluate(shellCall("npm i && curl evil"));
    expect(verdict.allowed).toBe(false);
    expect(seen).toEqual(["npm i", "curl evil"]);
  });

  test("auto mode auto-allows non-shell ask-tier tools", async () => {
    let asked = 0;
    const gate = createPermissionGate({
      approvals: [],
      requestApproval: async () => { asked++; return { allow: true }; },
      interactive: true,
      skipPermissions: false,
      auto: true,
    });
    const writeVerdict = await gate.evaluate({ id: "c", name: "write_file", arguments: { path: "src/a.ts" } });
    expect(writeVerdict.allowed).toBe(true);
    expect(asked).toBe(0);
  });

  test("auto mode still asks for shell commands", async () => {
    let asked = 0;
    const gate = createPermissionGate({
      approvals: [],
      requestApproval: async () => { asked++; return { allow: true }; },
      interactive: true,
      skipPermissions: false,
      auto: true,
    });
    const verdict = await gate.evaluate(shellCall("npm test"));
    expect(verdict.allowed).toBe(true);
    expect(asked).toBe(1);
  });
});
