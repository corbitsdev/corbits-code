import { test, expect, describe } from "bun:test";
import type { ToolCall } from "@intx/types/runtime";
import { splitChainedCommand } from "./command.js";
import { buildRequests } from "./classify.js";
import { isRequestCoveredByGrant } from "./gate.js";
import { groupChainSegmentsForDisplay } from "../tui/command-display.js";

// Corpus of chained commands exercising quotes, heredocs, subshells, and
// various operators.  Each entry is [description, command, agreement].
//
// `agreement` is true when both splitters are expected to produce the same
// segments (modulo pipe merging), and false for cases where they intentionally
// diverge (subshell unwrap and dangling-redirect coalescing).
const CORPUS: [string, string, boolean][] = [
  ["simple &&", "echo a && echo b", true],
  ["simple ||", "echo a || echo b", true],
  ["simple ;", "echo a ; echo b", true],
  ["quoted operator", 'echo "a && b"', true],
  ["single-quoted operator", "echo 'c || d'", true],
  ["heredoc body", "cat <<EOF\na; b\nc && d\nEOF", true],
  ["heredoc + chain", "cat <<EOF\nbody\nEOF && echo after", true],
  ["subshell chain", "(echo a && echo b) && echo c", false],
  ["pipe + &&", "echo a | cat && echo b", true],
  ["pipe only", "echo a | cat", true],
  ["mixed", 'echo "x && y" | cat && echo done', true],
  ["backslash continuation", "echo a \\\n&& echo b", true],
  ["heredoc with single-quoted marker", "cat <<'EOF'\nline; and && stuff\nEOF", true],
  ["nested parens", "((echo a) && echo b) && echo c", false],
  ["here-string (not heredoc)", "cat <<< hello", true],
  ["here-string newline boundary", "cat <<< payload\nrm -rf /", true],
  ["dangling redirect across &&", "bun run build > && echo done", false],
];

describe("shared tokenizer: display is a coarse merge of authz", () => {
  for (const [desc, cmd, expectedAgreement] of CORPUS) {
    test(desc, () => {
      const authz = splitChainedCommand(cmd);
      const display = groupChainSegmentsForDisplay(cmd);

      if (expectedAgreement) {
        // For commands where we expect agreement, the display segments should
        // be formable by merging consecutive authz segments joined by " | "
        // (the only intentional difference: display keeps pipes inline).
        let authzIdx = 0;

        for (const dseg of display) {
          let found = false;
          const current = authz[authzIdx];
          if (current !== undefined && current.trim() === dseg.trim()) {
            authzIdx++;
            found = true;
          } else {
            for (let end = authzIdx + 1; end < authz.length; end++) {
              const candidate = authz
                .slice(authzIdx, end + 1)
                .map((s) => s.trim())
                .join(" | ");
              if (candidate.trim() === dseg.trim()) {
                authzIdx = end + 1;
                found = true;
                break;
              }
            }
          }
          expect(found).toBe(true);
        }

        expect(authzIdx).toBe(authz.length);
      } else {
        // For known-divergent cases (subshell unwrap and dangling-redirect
        // coalescing), both splitters should still
        // produce non-empty, non-blank segments.  We don't compare content
        // because unwrapGroup strips parens/operators that display preserves.
        expect(authz.length).toBeGreaterThanOrEqual(1);
        expect(display.length).toBeGreaterThanOrEqual(1);

        for (const seg of authz) {
          expect(seg.trim().length).toBeGreaterThanOrEqual(1);
        }
        for (const seg of display) {
          expect(seg.trim().length).toBeGreaterThanOrEqual(1);
        }
      }
    });
  }
});

describe("heredoc boundaries", () => {
  test("keeps a following command outside the heredoc approval scope", () => {
    const command = "cat <<EOF\nsafe\nEOF\nrm -rf build";
    const expected = ["cat <<EOF\nsafe\nEOF", "rm -rf build"];

    expect(splitChainedCommand(command)).toEqual(expected);
    expect(groupChainSegmentsForDisplay(command)).toEqual(expected);

    const call: ToolCall = { id: "c", name: "run_shell", arguments: { command } };
    const request = buildRequests(call)[0];
    if (request === undefined) throw new Error("expected an approval request");
    expect(request.scopes.map((scope) => scope.pattern)).toEqual([command]);
    expect(
      isRequestCoveredByGrant(
        request,
        { tool: "run_shell", pattern: "cat *" },
        undefined,
        () => false,
        { resolvedCwd: "/repo", roots: ["/repo"] },
      ),
    ).toBe(false);
  });

  const heredocCases = [
    {
      name: "CRLF terminator",
      command: "cat <<EOF\r\nsafe\r\nEOF\r\nrm -rf /",
      expected: ["cat <<EOF\r\nsafe\r\nEOF", "rm -rf /"],
    },
    {
      name: "multiple queued heredocs",
      command:
        "cat <<FIRST <<SECOND\none; still body\nFIRST\ntwo && still body\nSECOND\ntouch PWNED",
      expected: [
        "cat <<FIRST <<SECOND\none; still body\nFIRST\ntwo && still body\nSECOND",
        "touch PWNED",
      ],
    },
    {
      name: "exact plain terminator",
      command: "cat <<EOF\nEOF \nrm -rf /\nEOF\ntouch PWNED",
      expected: ["cat <<EOF\nEOF \nrm -rf /\nEOF", "touch PWNED"],
    },
    {
      name: "tab-stripping terminator",
      command: "cat <<-EOF\n\tinside; body\n \tEOF\nrm -rf /\n\tEOF\ntouch PWNED",
      expected: ["cat <<-EOF\n\tinside; body\n \tEOF\nrm -rf /\n\tEOF", "touch PWNED"],
    },
    {
      name: "opaque body control characters",
      command: "cat <<EOF\nrm -rf / && touch PWNED | sh; echo hidden &\nEOF\necho visible",
      expected: ["cat <<EOF\nrm -rf / && touch PWNED | sh; echo hidden &\nEOF", "echo visible"],
    },
    {
      name: "malformed quoted opener",
      command: "cat <<'EOF\ntouch PWNED",
      expected: ["cat <<'EOF", "touch PWNED"],
    },
  ];

  for (const { name, command, expected } of heredocCases) {
    test(`${name} has exact authorization and display boundaries`, () => {
      expect(splitChainedCommand(command)).toEqual(expected);
      expect(groupChainSegmentsForDisplay(command)).toEqual(expected);

      const call: ToolCall = { id: "c", name: "run_shell", arguments: { command } };
      const request = buildRequests(call)[0];
      if (request === undefined) throw new Error("expected an approval request");
      expect(request.scopes.map((scope) => scope.pattern)).toEqual([command]);
      expect(
        isRequestCoveredByGrant(
          request,
          { tool: "run_shell", pattern: "cat *" },
          undefined,
          () => false,
          { resolvedCwd: "/repo", roots: ["/repo"] },
        ),
      ).toBe(false);
    });
  }
});

describe("here-string boundaries", () => {
  test("keeps a following command outside the here-string approval scope", () => {
    const command = "cat <<< payload\nrm -rf /";
    const expected = ["cat <<< payload", "rm -rf /"];

    expect(splitChainedCommand(command)).toEqual(expected);
    expect(groupChainSegmentsForDisplay(command)).toEqual(expected);

    const call: ToolCall = { id: "c", name: "run_shell", arguments: { command } };
    const request = buildRequests(call)[0];
    if (request === undefined) throw new Error("expected an approval request");
    expect(request.scopes.map((scope) => scope.pattern)).toEqual([command]);
    expect(
      isRequestCoveredByGrant(
        request,
        { tool: "run_shell", pattern: "cat *" },
        undefined,
        () => false,
        { resolvedCwd: "/repo", roots: ["/repo"] },
      ),
    ).toBe(false);
  });
});

describe("non-heredoc left shifts", () => {
  const cases: [string, string, string[]][] = [
    ["arithmetic", "echo $((1 << 2))\ntouch PWNED", ["echo $((1 << 2))", "touch PWNED"]],
    ["comment", "echo safe # <<EOF\ntouch PWNED", ["echo safe # <<EOF", "touch PWNED"]],
  ];

  for (const [name, command, expected] of cases) {
    test(`${name} syntax preserves exact newline boundaries and grant rejection`, () => {
      expect(splitChainedCommand(command)).toEqual(expected);
      expect(groupChainSegmentsForDisplay(command)).toEqual(expected);

      const call: ToolCall = { id: "c", name: "run_shell", arguments: { command } };
      const request = buildRequests(call)[0];
      if (request === undefined) throw new Error("expected an approval request");
      expect(request.scopes.map((scope) => scope.pattern)).toEqual([command]);
      expect(
        isRequestCoveredByGrant(
          request,
          { tool: "run_shell", pattern: "echo *" },
          undefined,
          () => false,
          { resolvedCwd: "/repo", roots: ["/repo"] },
        ),
      ).toBe(false);
    });
  }
});

describe("shared primitives produce consistent results", () => {
  const sharedCorpus = [
    'echo "hello && world"',
    "echo 'c || d'",
    "cat <<EOF\nbody\nEOF",
    "echo x && (echo y || echo z)",
    "(echo a)",
    'cat <<EOF\n"quoted && chain"\nEOF',
  ];

  for (const cmd of sharedCorpus) {
    test(`non-empty segments for: ${cmd.slice(0, 40)}`, () => {
      const authz = splitChainedCommand(cmd);
      const display = groupChainSegmentsForDisplay(cmd);

      expect(authz.length).toBeGreaterThanOrEqual(1);
      expect(display.length).toBeGreaterThanOrEqual(1);

      // Every segment from both splitters should be non-empty after trim.
      for (const seg of authz) {
        expect(seg.trim().length).toBeGreaterThanOrEqual(1);
      }
      for (const seg of display) {
        expect(seg.trim().length).toBeGreaterThanOrEqual(1);
      }
    });
  }
});
