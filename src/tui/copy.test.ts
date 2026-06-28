import { describe, expect, test } from "bun:test";
import { copyTargets, transcriptMarkdown } from "./copy.js";
import type { ContentBlock } from "./use-stream.js";

const blocks: ContentBlock[] = [
  { type: "user", id: "u1", content: "fix the bug" },
  { type: "text", id: "t1", content: "Looking into it." },
  { type: "tool_call", id: "tc1", name: "edit_file", arguments: JSON.stringify({ path: "a.ts", old_string: "x", new_string: "y" }) },
  { type: "tool_result", id: "tr1", callId: "c1", name: "edit_file", content: "Edited a.ts", isError: false },
  { type: "tool_result", id: "tr2", callId: "c2", name: "run_shell", content: "boom", isError: true },
];

describe("copyTargets", () => {
  test("surfaces user, assistant, diff, and successful tool output in order", () => {
    const targets = copyTargets(blocks);
    expect(targets.map((t) => t.label)).toEqual(["your message", "assistant message", "edit diff", "edit_file output"]);
  });

  test("the diff target carries the rendered +/- text", () => {
    const diff = copyTargets(blocks).find((t) => t.label === "edit diff");
    expect(diff?.text).toContain("- x");
    expect(diff?.text).toContain("+ y");
  });

  test("skips errored tool results", () => {
    expect(copyTargets(blocks).some((t) => t.text === "boom")).toBe(false);
  });
});

describe("transcriptMarkdown", () => {
  test("renders roles and fences", () => {
    const md = transcriptMarkdown(blocks);
    expect(md).toContain("## You");
    expect(md).toContain("## Assistant");
    expect(md).toContain("```diff");
    expect(md).toContain("```error");
  });
});
