import { describe, expect, test } from "bun:test";
import { renderTranscriptLines } from "./subagent-session-view.js";
import type { SubAgentTranscriptEntry } from "../../subagent/session-store.js";

describe("renderTranscriptLines", () => {
  test("formats text, tools, results, and report entries", () => {
    const entries: SubAgentTranscriptEntry[] = [
      { kind: "text", content: "Hello" },
      { kind: "tool", callId: "c1", name: "grep", arguments: '{"pattern":"foo"}' },
      {
        kind: "tool_result",
        callId: "c1",
        name: "grep",
        content: "match",
        isError: false,
      },
      { kind: "report", content: "## Summary\nDone." },
    ];
    const lines = renderTranscriptLines(entries, 80);
    expect(lines.some((l) => l.text === "Hello")).toBe(true);
    expect(lines.some((l) => l.text.startsWith("▸ grep"))).toBe(true);
    expect(lines.some((l) => l.text.includes("match"))).toBe(true);
    expect(lines.some((l) => l.text === "── report ──")).toBe(true);
    expect(lines.some((l) => l.text.includes("## Summary"))).toBe(true);
  });

  test("marks error tool results", () => {
    const lines = renderTranscriptLines(
      [
        {
          kind: "tool_result",
          callId: "c1",
          name: "run_shell",
          content: "boom",
          isError: true,
        },
      ],
      40,
    );
    expect(lines[0]?.text).toContain("boom");
  });
});
