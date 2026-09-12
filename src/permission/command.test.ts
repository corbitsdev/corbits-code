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
    if (pattern === null || pattern === undefined)
      throw new Error("expected a pattern");
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

  test("scopes a terminated heredoc and its following lines together", () => {
    // Newlines are not chain separators, so the whole multi-line script stays a
    // single approval subject; the point is that it terminates rather than hangs.
    const command = "cat <<EOF > out.txt\nhi\nEOF\necho done";
    expect(splitChainedCommand(command)).toEqual([command]);
  });

  test("still splits ordinary chained commands", () => {
    expect(splitChainedCommand("echo a && echo b")).toEqual([
      "echo a",
      "echo b",
    ]);
  });
});

describe("splitChainedCommand lone-& bypass (CL-7781)", () => {
  // A `&` with no trailing space still backgrounds the preceding command —
  // treating it as a redirect token lets a second command hide behind a
  // standing grant for the benign head. Only a redirect-bound `&` (after
  // `>`/`<`, or opening `&>`/`&>>`) stays attached to its command.
  const cases: { command: string; segments: string[] }[] = [
    { command: "a &b", segments: ["a", "b"] },
    { command: "a & b", segments: ["a", "b"] },
    { command: "a &>f", segments: ["a &>f"] },
    { command: "a 2>&1", segments: ["a 2>&1"] },
    { command: "a >&2", segments: ["a >&2"] },
    { command: "a <&-", segments: ["a <&-"] },
    { command: "a&&b", segments: ["a", "b"] },
    { command: "a &&b", segments: ["a", "b"] },
  ];
  for (const { command, segments } of cases) {
    test(`splits ${JSON.stringify(command)} into ${segments.length} segment(s)`, () => {
      expect(splitChainedCommand(command)).toEqual(segments);
    });
  }
});

describe("splitChainedCommand redirect and background fragments", () => {
  // A bare digit (or "-") after a chain separator is not, by itself, evidence
  // of a stray redirect remnant — it may be a genuine, distinct command. Only
  // fold the following token back in when the segment before the separator
  // actually ends in a dangling redirect operator.
  test("does not fold a bare digit segment across a semicolon", () => {
    expect(splitChainedCommand("sleep 5 ; -1 ; echo end")).toEqual([
      "sleep 5",
      "-1",
      "echo end",
    ]);
  });

  test("does not fold across a subshell boundary", () => {
    expect(splitChainedCommand("echo x && (1 ; echo y)")).toEqual([
      "echo x",
      "1",
      "echo y",
    ]);
  });

  test("does not swallow a pipe operator", () => {
    expect(splitChainedCommand("echo x | 1")).toEqual(["echo x", "1"]);
  });

  test("coalesces a genuine dangling fd-duplication target after a semicolon", () => {
    expect(splitChainedCommand("bun run build 2>&;1")).toEqual([
      "bun run build 2>& 1",
    ]);
  });

  test("coalesces a genuine dangling redirect target after &&", () => {
    expect(splitChainedCommand("bun run build > && out.txt")).toEqual([
      "bun run build >  out.txt",
    ]);
  });

  test("keeps 2>&1 attached to its command, not split into a stray 1", () => {
    expect(splitChainedCommand("bun run build 2>&1")).toEqual([
      "bun run build 2>&1",
    ]);
  });

  test("keeps &>file combined redirects intact", () => {
    expect(splitChainedCommand("bun run build &> out.log")).toEqual([
      "bun run build &> out.log",
    ]);
    expect(splitChainedCommand("bun run build &>out.log")).toEqual([
      "bun run build &>out.log",
    ]);
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

describe("splitChainedCommand heredoc boundaries", () => {
  // A marker glued to `<<` is still an opener, and separators trailing the
  // opener line do not split while the heredoc body is pending.
  test("keeps separators on the opener line inside a glued-marker heredoc", () => {
    const command = "cat <<B && echo done\nbody\nB";
    expect(splitChainedCommand(command)).toEqual([command]);
    const semicolon = "cat <<EOF; echo done\nbody\nEOF";
    expect(splitChainedCommand(semicolon)).toEqual([semicolon]);
  });

  test("opens and closes a heredoc across CRLF line endings", () => {
    const command = "cat <<EOF\r\nbody\r\nEOF";
    expect(splitChainedCommand(command)).toEqual([command]);
    expect(
      splitChainedCommand("cat <<EOF\r\nbody\r\nEOF\r\n&& echo done"),
    ).toEqual(["cat <<EOF\r\nbody\r\nEOF", "echo done"]);
  });

  // Only `<<-` strips leading tabs from the closing line; a space-indented
  // close never terminates a plain `<<` heredoc.
  test("closes <<- on a tab-indented marker but not << on spaces", () => {
    expect(
      splitChainedCommand("cat <<-EOF\nbody\n\tEOF\n&& echo evil"),
    ).toEqual(["cat <<-EOF\nbody\n\tEOF", "echo evil"]);
    const spaces = "cat <<EOF\nbody\n  EOF\n&& echo evil";
    expect(splitChainedCommand(spaces)).toEqual([spaces]);
  });

  test("an unterminated heredoc swallows a later chain separator", () => {
    const command = "cat <<EOF\nbody\n&& echo evil";
    expect(splitChainedCommand(command)).toEqual([command]);
  });

  // Single-slot heredoc state: a second `<<` inside the body is payload, so
  // the outer marker still closes and the following chain still splits.
  test("treats a second << inside the body as payload, not a nested opener", () => {
    expect(
      splitChainedCommand("cat <<OUTER\nfoo <<INNER\nOUTER\n&& echo done"),
    ).toEqual(["cat <<OUTER\nfoo <<INNER\nOUTER", "echo done"]);
  });
});

describe("splitChainedCommand lexical context (arithmetic and comments)", () => {
  // Inside `((` / `$((` the `<<` token is the left-shift operator, never a
  // heredoc opener — the chain after it must still split.
  test("never opens a heredoc inside arithmetic expansion", () => {
    expect(splitChainedCommand("echo $((a<<1))")).toEqual(["echo $((a<<1))"]);
    expect(splitChainedCommand("echo $((a << 1)) && echo done")).toEqual([
      "echo $((a << 1))",
      "echo done",
    ]);
  });

  test("never opens a heredoc inside a (( )) arithmetic command", () => {
    expect(splitChainedCommand("((x = a << 1)) && echo done")).toEqual([
      "x = a << 1",
      "echo done",
    ]);
  });

  // A bare `( ... )` subshell is not arithmetic: a heredoc inside it is real.
  test("still opens a heredoc inside a bare-paren subshell", () => {
    const command = "(cat <<EOF\nbody\nEOF) && echo done";
    expect(splitChainedCommand(command)).toEqual([command]);
  });

  // A top-level `#` starts a comment through end of line: a `<<` down there
  // documents rather than opens, so the next line still splits.
  test("never opens a heredoc from a #-to-EOL comment", () => {
    expect(splitChainedCommand("# example: cat <<EOF\necho hi")).toEqual([
      "# example: cat <<EOF",
      "echo hi",
    ]);
    expect(splitChainedCommand("echo hi # tail <<EOF\n&& echo done")).toEqual([
      "echo hi # tail <<EOF",
      "echo done",
    ]);
  });

  // Comment text never touches arithmetic depth: an unbalanced `((` inside
  // a `#` comment must not poison later lines, so a genuine heredoc after
  // the comment still opens and the following chain still splits.
  test("never counts comment parens toward arithmetic depth", () => {
    const command = "# (( \ncat <<EOF\nbody\nEOF\n&& echo done";
    expect(splitChainedCommand(command)).toEqual([
      "# ((",
      "cat <<EOF\nbody\nEOF",
      "echo done",
    ]);
  });

  // Chain operators after `#` still split, so a dangerous command hiding
  // behind a comment still surfaces as its own approval subject.
  test("still splits chain operators after a # comment", () => {
    expect(splitChainedCommand("# note && rm -rf /")).toEqual([
      "# note",
      "rm -rf /",
    ]);
  });

  // A `#` line inside a genuine heredoc body stays payload: the marker still
  // closes and the following chain still splits.
  test("keeps a # line inside a heredoc body as payload", () => {
    const command = "cat <<EOF\n# payload\nEOF\necho done";
    expect(splitChainedCommand(command)).toEqual([command]);
  });
});
