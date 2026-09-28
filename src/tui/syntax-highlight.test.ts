/**
 * Fenced-code highlighting after the highlight.js → tree-sitter swap.
 *
 * Colour lives in the native renderer: a fenced block paints through
 * MarkdownRenderable with transcriptSyntaxStyle() over the bundled
 * tree-sitter grammars (javascript, typescript, markdown, zig). The
 * synchronous StyledSegment model keeps geometry only — plain code segments
 * cached by width. These tests pin both halves: the plain sync fallback and
 * the supported/unsupported language parity the native renderer applies.
 */

import { describe, expect, test } from "bun:test";
import { MarkdownRenderable, RGBA, type CapturedSpan } from "@opentui/core";
import { withTestRenderer, type Harness } from "./harness";
import { transcriptSyntaxStyle } from "./stream";
import { highlightCode } from "./syntax-highlight.js";
import { UI } from "./theme";

describe("highlightCode", () => {
  test("segments every line as plain code with no colours", () => {
    expect(highlightCode('const x = "hi";\n// yo', "javascript", 80)).toEqual([
      [{ text: 'const x = "hi";', code: true }],
      [{ text: "// yo", code: true }],
    ]);
  });

  test("the cache is keyed by width", () => {
    const lines = highlightCode("const x = 1;", "javascript", 80);
    expect(highlightCode("const x = 1;", "javascript", 80)).toBe(lines);
    expect(highlightCode("const x = 1;", "javascript", 81)).not.toBe(lines);
    expect(highlightCode("const x = 1;", "javascript", 81)).toEqual(lines);
  });
});

const HEADING_FG = RGBA.fromHex(UI.heading);
const KEYWORD_FG = RGBA.fromHex(UI.inFlightBright);
const STRING_FG = RGBA.fromHex(UI.done);
const COMMENT_FG = RGBA.fromHex(UI.textFaint);
const FUNCTION_FG = RGBA.fromHex(UI.inFlight);
const SYNTAX_FGS = [KEYWORD_FG, STRING_FG, COMMENT_FG, FUNCTION_FG];

function renderFence(h: Harness, fence: string): void {
  h.root.add(
    new MarkdownRenderable(h.renderer, {
      syntaxStyle: transcriptSyntaxStyle(),
      fg: UI.text,
      width: 80,
      flexShrink: 0,
      content: fence,
      streaming: false,
    }),
  );
}

async function settleSpans(
  h: Harness,
  ready: (spans: CapturedSpan[]) => boolean,
): Promise<CapturedSpan[]> {
  let spans = h.captureSpans().lines.flatMap((line) => line.spans);
  for (let i = 0; i < 400 && !ready(spans); i++) {
    await h.renderOnce();
    await new Promise((resolve) => setTimeout(resolve, 25));
    spans = h.captureSpans().lines.flatMap((line) => line.spans);
  }
  return spans;
}

function coloured(spans: CapturedSpan[], text: string, fg: RGBA): boolean {
  return spans.some((s) => s.text.includes(text) && s.fg.equals(fg));
}

describe("native fenced rendering", () => {
  test("a js fence colours keywords, strings, comments, and numbers", async () => {
    await withTestRenderer(
      async (h) => {
        renderFence(
          h,
          '```js\nconst greeting = "hi"; // yo\nconst n = 42;\n```',
        );
        const spans = await settleSpans(
          h,
          (s) =>
            coloured(s, "const", KEYWORD_FG) &&
            coloured(s, "hi", STRING_FG) &&
            coloured(s, "// yo", COMMENT_FG) &&
            coloured(s, "42", STRING_FG),
        );
        expect(coloured(spans, "const", KEYWORD_FG)).toBe(true);
        expect(coloured(spans, "hi", STRING_FG)).toBe(true);
        expect(coloured(spans, "// yo", COMMENT_FG)).toBe(true);
        expect(coloured(spans, "42", STRING_FG)).toBe(true);
      },
      { width: 80, height: 24 },
    );
  }, 30000);

  test("a ts fence colours keywords and numbers", async () => {
    await withTestRenderer(
      async (h) => {
        renderFence(h, "```ts\nconst n: number = 42;\n```");
        const spans = await settleSpans(
          h,
          (s) =>
            coloured(s, "const", KEYWORD_FG) && coloured(s, "42", STRING_FG),
        );
        expect(coloured(spans, "const", KEYWORD_FG)).toBe(true);
        expect(coloured(spans, "42", STRING_FG)).toBe(true);
      },
      { width: 80, height: 24 },
    );
  }, 30000);

  test("a markdown fence colours headings", async () => {
    await withTestRenderer(
      async (h) => {
        renderFence(h, "```markdown\n# heading\n```");
        const spans = await settleSpans(h, (s) =>
          coloured(s, "heading", HEADING_FG),
        );
        expect(coloured(spans, "heading", HEADING_FG)).toBe(true);
      },
      { width: 80, height: 24 },
    );
  }, 30000);

  test("jsx and tsx fences highlight through their grammar aliases", async () => {
    for (const fence of [
      "```jsx\nconst el = <div />;\n```",
      "```tsx\nconst el = <div />;\n```",
    ]) {
      await withTestRenderer(
        async (h) => {
          renderFence(h, fence);
          const spans = await settleSpans(h, (s) =>
            coloured(s, "const", KEYWORD_FG),
          );
          expect(coloured(spans, "const", KEYWORD_FG)).toBe(true);
        },
        { width: 80, height: 24 },
      );
    }
  }, 30000);

  test("a zig fence colours keywords", async () => {
    await withTestRenderer(
      async (h) => {
        renderFence(h, "```zig\nconst x: i32 = 1;\n```");
        const spans = await settleSpans(h, (s) =>
          coloured(s, "const", KEYWORD_FG),
        );
        expect(coloured(spans, "const", KEYWORD_FG)).toBe(true);
      },
      { width: 80, height: 24 },
    );
  }, 30000);

  test("python, go, and rust fences render PLAIN with no syntax colours", async () => {
    const fences: [string, string][] = [
      ['```python\ndef greet():\n    return "hi"  # yo\n```', "def greet"],
      ["```go\npackage main\n\nfunc main() {}\n```", "func main"],
      ['```rust\nfn main() {\n    println!("hi");\n}\n```', "fn main"],
    ];
    for (const [fence, marker] of fences) {
      await withTestRenderer(
        async (h) => {
          renderFence(h, fence);
          const spans = await settleSpans(h, () =>
            h.captureCharFrame().includes(marker),
          );
          expect(h.captureCharFrame()).toContain(marker);
          expect(
            spans.some((s) => SYNTAX_FGS.some((fg) => s.fg.equals(fg))),
          ).toBe(false);
        },
        { width: 80, height: 24 },
      );
    }
  }, 60000);
});
