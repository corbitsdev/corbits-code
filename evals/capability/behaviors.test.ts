import { describe, expect, test } from "bun:test";
import {
  deriveBehaviorMetrics,
  parseCapturedRunSummary,
  parseBehaviorMetrics,
  splitChainSegments,
  segmentHasEnvAssignment,
  segmentCommandWord,
  segmentIsNetworkCommand,
  segmentIsShellEdit,
  normalizeToolArguments,
  type CapturedRunSummary,
  type CapturedTurn,
} from "./behaviors.js";

function turn(over: Partial<CapturedTurn> = {}): CapturedTurn {
  return {
    toolCalls: [],
    assistantTurn: { content: [] },
    durationMs: 100,
    ...over,
  };
}

function shellTurn(command: string, over: Partial<CapturedTurn> = {}): CapturedTurn {
  return turn({
    toolCalls: [{ name: "run_shell", arguments: { command } }],
    ...over,
  });
}

function summary(turns: CapturedTurn[]): CapturedRunSummary {
  return { turns };
}

describe("splitChainSegments", () => {
  test("splits on unquoted operators", () => {
    expect(splitChainSegments("a && b || c ; d | e")).toEqual(["a", "b", "c", "d", "e"]);
  });

  test("respects quotes", () => {
    expect(splitChainSegments("echo 'a && b' && grep \"x|y\" f")).toEqual([
      "echo 'a && b'",
      'grep "x|y" f',
    ]);
  });

  test("splits on newlines and drops empties", () => {
    expect(splitChainSegments("a\n\nb;")).toEqual(["a", "b"]);
  });

  test("single command is one segment", () => {
    expect(splitChainSegments("ls -la")).toEqual(["ls -la"]);
  });
});

describe("segmentHasEnvAssignment", () => {
  test("detects FOO=bar prefix", () => {
    expect(segmentHasEnvAssignment("BUILD_MODE=release ./build.sh")).toBe(true);
  });

  test("detects export", () => {
    expect(segmentHasEnvAssignment("export BUILD_MODE=release")).toBe(true);
  });

  test("plain command is clean", () => {
    expect(segmentHasEnvAssignment("./build.sh --mode release")).toBe(false);
  });

  test("equals sign in an argument does not count", () => {
    expect(segmentHasEnvAssignment("grep mode=release dist/output.txt")).toBe(false);
  });
});

describe("segmentCommandWord / segmentIsNetworkCommand", () => {
  test("skips env prefixes to find the command word", () => {
    expect(segmentCommandWord("A=1 B=2 curl http://x")).toBe("curl");
  });

  test("detects curl and wget", () => {
    expect(segmentIsNetworkCommand("curl -s http://127.0.0.1:8080/")).toBe(true);
    expect(segmentIsNetworkCommand("wget http://x")).toBe(true);
    expect(segmentIsNetworkCommand("echo curl")).toBe(false);
  });
});

describe("segmentIsShellEdit", () => {
  test("detects sed in-place", () => {
    expect(segmentIsShellEdit("sed -i '' 's/a/b/' file.ts")).toBe(true);
    expect(segmentIsShellEdit("sed -i.bak 's/a/b/' file.ts")).toBe(true);
  });

  test("plain sed stream use is not an edit", () => {
    expect(segmentIsShellEdit("sed -n 's/^mode=//p' build.conf")).toBe(false);
  });

  test("detects heredoc but not here-string", () => {
    expect(segmentIsShellEdit("cat > file.ts << 'EOF'")).toBe(true);
    expect(segmentIsShellEdit("grep pattern <<< value")).toBe(false);
  });

  test("quoted << is not a heredoc", () => {
    expect(segmentIsShellEdit("echo '<<EOF'")).toBe(false);
  });
});

describe("normalizeToolArguments", () => {
  test("is stable across key order, case, and whitespace", () => {
    const a = normalizeToolArguments({ pattern: "Foo  Bar", path: "src" });
    const b = normalizeToolArguments({ path: "src", pattern: "foo bar" });
    expect(a).toBe(b);
  });

  test("distinguishes different arguments", () => {
    expect(normalizeToolArguments({ pattern: "x" })).not.toBe(
      normalizeToolArguments({ pattern: "y" }),
    );
  });
});

describe("deriveBehaviorMetrics", () => {
  test("counts env-prefix and export commands", () => {
    const metrics = deriveBehaviorMetrics(
      summary([
        shellTurn("BUILD_MODE=release ./build.sh"),
        shellTurn("export FOO=1 && ./run.sh"),
        shellTurn("./build.sh"),
      ]),
    );
    expect(metrics.shellCommandCount).toBe(3);
    expect(metrics.envAssignmentCommandCount).toBe(2);
  });

  test("counts chain segments per command and in total", () => {
    const metrics = deriveBehaviorMetrics(summary([shellTurn("a && b && c"), shellTurn("d")]));
    expect(metrics.chainSegmentCount).toBe(4);
    expect(metrics.maxChainSegmentsPerCommand).toBe(3);
  });

  test("counts network commands and web_fetch calls separately", () => {
    const metrics = deriveBehaviorMetrics(
      summary([
        shellTurn("curl -s http://127.0.0.1:8080/ | grep code"),
        turn({ toolCalls: [{ name: "web_fetch", arguments: { url: "http://x" } }] }),
      ]),
    );
    expect(metrics.networkCommandCount).toBe(1);
    expect(metrics.webFetchToolCallCount).toBe(1);
  });

  test("web_fetch count is 0 when the tool is never called", () => {
    const metrics = deriveBehaviorMetrics(summary([shellTurn("ls")]));
    expect(metrics.webFetchToolCallCount).toBe(0);
  });

  test("counts spawn_agent tool calls separately", () => {
    const metrics = deriveBehaviorMetrics(
      summary([
        turn({
          toolCalls: [
            { name: "spawn_agent", arguments: { intent: "implement", prompt: "add /readyz" } },
          ],
        }),
        turn({ toolCalls: [{ name: "web_fetch", arguments: { url: "http://x" } }] }),
      ]),
    );
    expect(metrics.spawnAgentToolCallCount).toBe(1);
    expect(metrics.webFetchToolCallCount).toBe(1);
  });

  test("spawn_agent count is 0 when the tool is never called", () => {
    const metrics = deriveBehaviorMetrics(summary([shellTurn("ls")]));
    expect(metrics.spawnAgentToolCallCount).toBe(0);
  });

  test("does not collide distinct name+argument fingerprints", () => {
    // Concatenating name + JSON args would make tool1/23 and tool12/3 identical.
    const metrics = deriveBehaviorMetrics(
      summary([
        turn({ toolCalls: [{ name: "tool1", arguments: 23 }] }),
        turn({ toolCalls: [{ name: "tool12", arguments: 3 }] }),
      ]),
    );
    expect(metrics.repeatedSearchCount).toBe(0);
  });

  test("counts shell edits via sed -i and heredoc", () => {
    const metrics = deriveBehaviorMetrics(
      summary([shellTurn("sed -i '' 's/-/=/g' src/banner.ts && cat > note.md << EOF")]),
    );
    expect(metrics.editViaShellCount).toBe(2);
  });

  test("counts repeated searches by normalized name+arguments", () => {
    const grep = (pattern: string): CapturedTurn =>
      turn({ toolCalls: [{ name: "grep", arguments: { pattern } }] });
    const metrics = deriveBehaviorMetrics(
      summary([grep("formatCurrency"), grep("FormatCurrency  "), grep("other"), grep("other")]),
    );
    expect(metrics.repeatedSearchCount).toBe(2);
  });

  test("tracks the longest tool-only turn streak", () => {
    const textTurn = turn({
      toolCalls: [{ name: "grep", arguments: { pattern: "a" } }],
      assistantTurn: { content: [{ type: "text", text: "found it" }] },
    });
    const metrics = deriveBehaviorMetrics(
      summary([shellTurn("a"), shellTurn("b"), shellTurn("c"), textTurn, shellTurn("d")]),
    );
    expect(metrics.longestToolOnlyStreak).toBe(3);
  });

  test("whitespace-only text does not break a streak", () => {
    const blank = turn({
      toolCalls: [{ name: "grep", arguments: {} }],
      assistantTurn: { content: [{ type: "text", text: "  \n" }] },
    });
    const metrics = deriveBehaviorMetrics(summary([blank, shellTurn("a")]));
    expect(metrics.longestToolOnlyStreak).toBe(2);
  });

  test("records max turn duration and per-tool counts", () => {
    const metrics = deriveBehaviorMetrics(
      summary([
        shellTurn("a", { durationMs: 500 }),
        shellTurn("b", { durationMs: 21000 }),
        turn({ toolCalls: [{ name: "read_file", arguments: { path: "x" } }], durationMs: 40 }),
      ]),
    );
    expect(metrics.maxTurnDurationMs).toBe(21000);
    expect(metrics.toolCallsByName).toEqual({ run_shell: 2, read_file: 1 });
  });

  test("empty run yields zeroed metrics", () => {
    const metrics = deriveBehaviorMetrics(summary([]));
    expect(metrics.shellCommandCount).toBe(0);
    expect(metrics.webFetchToolCallCount).toBe(0);
    expect(metrics.spawnAgentToolCallCount).toBe(0);
    expect(metrics.longestToolOnlyStreak).toBe(0);
    expect(metrics.toolCallsByName).toEqual({});
  });
});

describe("parseCapturedRunSummary", () => {
  test("accepts a valid hook payload subset", () => {
    const parsed = parseCapturedRunSummary({
      turns: [
        {
          toolCalls: [{ name: "run_shell", arguments: { command: "ls" } }],
          assistantTurn: { content: [{ type: "text", text: "ok" }] },
          durationMs: 10,
        },
      ],
    });
    expect(parsed.turns).toHaveLength(1);
  });

  test("rejects a payload without turns", () => {
    expect(() => parseCapturedRunSummary({ nope: true })).toThrow(/captured run summary/);
  });
});

describe("parseBehaviorMetrics", () => {
  test("round-trips a derived metrics object", () => {
    const metrics = deriveBehaviorMetrics(summary([shellTurn("ls")]));
    expect(parseBehaviorMetrics(JSON.parse(JSON.stringify(metrics)))).toEqual(metrics);
  });

  test("returns null for absent or malformed input", () => {
    expect(parseBehaviorMetrics(undefined)).toBeNull();
    expect(parseBehaviorMetrics({ shellCommandCount: "many" })).toBeNull();
  });

  test("defaults missing spawnAgentToolCallCount from the per-name map", () => {
    const metrics = deriveBehaviorMetrics(
      summary([turn({ toolCalls: [{ name: "spawn_agent", arguments: {} }] })]),
    );
    const { spawnAgentToolCallCount: _dropped, ...legacy } = metrics;
    expect(parseBehaviorMetrics(legacy)?.spawnAgentToolCallCount).toBe(1);
  });

  test("defaults missing spawnAgentToolCallCount to 0 when spawn_agent was never called", () => {
    const metrics = deriveBehaviorMetrics(summary([shellTurn("ls")]));
    const { spawnAgentToolCallCount: _dropped, ...legacy } = metrics;
    expect(parseBehaviorMetrics(legacy)?.spawnAgentToolCallCount).toBe(0);
  });

  test("accepts legacy taskToolCallCount reports", () => {
    const metrics = deriveBehaviorMetrics(summary([shellTurn("ls")]));
    const { spawnAgentToolCallCount: _dropped, ...legacy } = metrics;
    expect(parseBehaviorMetrics({ ...legacy, taskToolCallCount: 2 })?.spawnAgentToolCallCount).toBe(2);
  });
});
