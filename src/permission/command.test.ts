import { test, expect, describe } from "bun:test";

import { splitChainedCommand, deriveCommandScopes } from "./command.js";
import { matchesPattern } from "./matcher.js";

describe("deriveCommandScopes exact-scope escaping", () => {
  // The "exact command" scope must persist a grant that matches only the
  // literal command the operator saw. A raw glob character in the command
  // (e.g. the shell-expanded `*` in `rm -rf build/*`) must not survive into
  // the stored pattern unescaped, or the grant becomes a wildcard that later
  // matches unrelated commands like `rm -rf build/../../etc`.
  test("escapes glob metacharacters in the exact-command scope", () => {
    const scopes = deriveCommandScopes("rm -rf build/*");
    const exact = scopes.find((s) => s.id === "exact");
    expect(exact).toBeDefined();
    const pattern = exact?.pattern;
    if (pattern === null || pattern === undefined) throw new Error("expected a pattern");
    expect(matchesPattern("rm -rf build/*", pattern)).toBe(true);
    expect(matchesPattern("rm -rf build/../../etc", pattern)).toBe(false);
  });

  test("keeps the intentional prefix-N wildcard unescaped", () => {
    const scopes = deriveCommandScopes("git commit -m foo");
    const prefix = scopes.find((s) => s.id === "prefix-2");
    expect(prefix).toBeDefined();
    expect(prefix?.pattern).toBe("git commit *");
  });
});

describe("splitChainedCommand heredocs", () => {
  // Regression: a heredoc marker followed by trailing text (a redirect) drove
  // an infinite loop in the opening-line scan, hanging the permission gate.
  test("terminates on a quoted marker followed by a redirect", () => {
    const command = "cat << 'EOF' > out.txt\nhello world\nEOF";
    expect(splitChainedCommand(command)).toEqual([command]);
  });

  test("does not treat separators inside the heredoc body as chain breaks", () => {
    const command = "cat <<EOF\na && b; c | d\nEOF";
    expect(splitChainedCommand(command)).toEqual([command]);
  });

  test("splits a command after a terminated heredoc", () => {
    const command = "cat <<EOF > out.txt\nhi\nEOF\necho done";
    expect(splitChainedCommand(command)).toEqual(["cat <<EOF > out.txt\nhi\nEOF", "echo done"]);
  });

  test("still splits ordinary chained commands", () => {
    expect(splitChainedCommand("echo a && echo b")).toEqual(["echo a", "echo b"]);
  });
});

describe("splitChainedCommand redirect and background fragments", () => {
  // A bare digit (or "-") after a chain separator is not, by itself, evidence
  // of a stray redirect remnant — it may be a genuine, distinct command. Only
  // fold the following token back in when the segment before the separator
  // actually ends in a dangling redirect operator.
  test("does not fold a bare digit segment across a semicolon", () => {
    expect(splitChainedCommand("sleep 5 ; -1 ; echo end")).toEqual(["sleep 5", "-1", "echo end"]);
  });

  test("does not fold across a subshell boundary", () => {
    expect(splitChainedCommand("echo x && (1 ; echo y)")).toEqual(["echo x", "1", "echo y"]);
  });

  test("does not swallow a pipe operator", () => {
    expect(splitChainedCommand("echo x | 1")).toEqual(["echo x", "1"]);
  });

  test("coalesces a genuine dangling fd-duplication target after a semicolon", () => {
    expect(splitChainedCommand("bun run build 2>&;1")).toEqual(["bun run build 2>& 1"]);
  });

  test("coalesces a genuine dangling redirect target after &&", () => {
    expect(splitChainedCommand("bun run build > && out.txt")).toEqual(["bun run build >  out.txt"]);
  });

  test("keeps 2>&1 attached to its command, not split into a stray 1", () => {
    expect(splitChainedCommand("bun run build 2>&1")).toEqual(["bun run build 2>&1"]);
  });

  test("keeps &>file combined redirects intact", () => {
    expect(splitChainedCommand("bun run build &> out.log")).toEqual(["bun run build &> out.log"]);
    expect(splitChainedCommand("bun run build &>out.log")).toEqual(["bun run build &>out.log"]);
  });

  test("keeps <&- fd-close redirects intact", () => {
    expect(splitChainedCommand("echo hi <&-")).toEqual(["echo hi <&-"]);
  });

  test("splits on a genuine background operator without stranding a fragment", () => {
    expect(splitChainedCommand("bun run build & echo done")).toEqual([
      "bun run build",
      "echo done",
    ]);
  });

  test("keeps a heredoc body intact rather than fragmenting it", () => {
    const command = "cat <<EOF\nhello\nEOF";
    expect(splitChainedCommand(command)).toEqual([command]);
  });

  test("leaves a non-command prose payload as a single segment", () => {
    const prose = "please run the build and check the output for errors";
    expect(splitChainedCommand(prose)).toEqual([prose]);
  });
});
