import { describe, test, expect } from "bun:test";
import { createIncrementalMarkdown } from "./streaming-markdown.js";
import { parseMarkdown } from "./markdown-parser.js";
import type { StyledLine } from "./view/lines.js";

function render(content: string, width: number): StyledLine[] {
  return parseMarkdown(content, width) as unknown as StyledLine[];
}

function streamedEqualsWhole(chunks: string[], width = 80): void {
  const incremental = createIncrementalMarkdown(render);
  let content = "";
  for (const chunk of chunks) {
    content += chunk;
    expect(incremental(content, width)).toEqual(render(content, width));
  }
}

describe("createIncrementalMarkdown", () => {
  test("matches a whole parse across paragraph-by-paragraph streaming", () => {
    streamedEqualsWhole([
      "First paragraph grows",
      " and grows.\n\nSecond ",
      "paragraph.\n\n## Heading\n\nThird paragraph",
      " continues.",
    ]);
  });

  test("never splits inside a fenced code block", () => {
    streamedEqualsWhole([
      "Intro.\n\n```ts\nconst a = 1;\n\nconst b",
      " = 2;\n```\n\nAfter the fence.",
    ]);
  });

  test("handles consecutive blank lines and leading newlines", () => {
    streamedEqualsWhole(["\nA\n\n", "\nB\n\n\n", "C"]);
  });

  test("resets when content is replaced rather than appended", () => {
    const incremental = createIncrementalMarkdown(render);
    incremental("old paragraph.\n\ntail", 80);
    const replaced = "entirely new content.\n\nnew tail";
    expect(incremental(replaced, 80)).toEqual(render(replaced, 80));
  });

  test("resets when the width changes", () => {
    const incremental = createIncrementalMarkdown(render);
    const content = "some words that wrap differently at other widths\n\ntail";
    incremental(content, 80);
    expect(incremental(content, 20)).toEqual(render(content, 20));
  });

  test("re-renders only the tail once a boundary is behind it", () => {
    const calls: string[] = [];
    const counting = (content: string, width: number): StyledLine[] => {
      calls.push(content);
      return render(content, width);
    };
    const incremental = createIncrementalMarkdown(counting);
    incremental("stable paragraph.\n\ntail one", 80);
    calls.length = 0;
    incremental("stable paragraph.\n\ntail one grows", 80);
    expect(calls).toEqual(["tail one grows"]);
  });
});
