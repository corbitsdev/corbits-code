/**
 * Transcript markdown rendering — assistant rows must render formatted,
 * not as literal markdown source.
 */

import { describe, expect, test } from "bun:test";
import { MarkdownRenderable, BoxRenderable, type CapturedSpan } from "@opentui/core";
import { withTestRenderer, type Harness } from "./harness";
import {
  appendStreamRow,
  createAppShell,
  createStreamRowRenderable,
  replaceStreamRowAt,
  splitAtSettledHeading,
} from "./shell";
import { isMarkdownRow } from "./stream";

const WIDE = { width: 80, height: 24 } as const;

const shellOpts = {
  terminal: { columns: 80, rows: 24 },
  wireKeys: false,
} as const;

/**
 * Highlighting runs on a worker outside the render scheduler, so the
 * scheduler goes idle before the highlighted frame lands. Pass a predicate
 * for the settled shape and get the frame back the moment it's true, rather
 * than gambling on a fixed sleep long enough to outrun load.
 */
async function settle(h: Harness, isSettled: (frame: string) => boolean): Promise<string> {
  const deadline = Date.now() + 2000;
  for (;;) {
    await h.renderOnce();
    const frame = h.captureCharFrame();
    if (isSettled(frame)) return frame;
    if (Date.now() >= deadline) {
      throw new Error(`markdown row never settled; last frame:\n${frame}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("markdown transcript rows", () => {
  test("row roles pick markdown only for assistant text", () => {
    expect(isMarkdownRow({ role: "assistant", text: "# hi" })).toBe(true);
    expect(isMarkdownRow({ role: "tool", text: "# hi" })).toBe(false);
    expect(isMarkdownRow({ role: "user", text: "# hi" })).toBe(false);
    expect(isMarkdownRow({ role: "system", text: "# hi" })).toBe(false);
    expect(isMarkdownRow({ role: "tool", text: "# hi", markdown: true })).toBe(true);
  });

  test("heading, bold, list, fence and link render formatted", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, shellOpts);
      appendStreamRow(shell, {
        role: "assistant",
        text: [
          "## Title",
          "",
          "**bolded** text",
          "",
          "- alpha",
          "- beta",
          "",
          "```ts",
          "const x = 1",
          "```",
          "",
          "[docs](https://example.com/docs)",
        ].join("\n"),
      });

      const frame = await settle(
        h,
        // Require formatted heading, bold, fence, and link: "docs" plus
        // absence of "## Title" can match a frame where the heading has not
        // painted yet, and formatted heading+bold can land while fence/link
        // syntax is still literal (same class as the ### heading flake below).
        (f) =>
          f.includes("Title") &&
          f.includes("bolded") &&
          f.includes("docs") &&
          f.includes("alpha") &&
          f.includes("const x = 1") &&
          !f.includes("## Title") &&
          !f.includes("**bolded**") &&
          !f.includes("```") &&
          !f.includes("](https://example.com/docs)"),
      );
      expect(frame).toContain("Title");
      expect(frame).not.toContain("## Title");
      expect(frame).toContain("bolded");
      expect(frame).not.toContain("**bolded**");
      expect(frame).toContain("alpha");
      expect(frame).toContain("const x = 1");
      expect(frame).not.toContain("```");
      expect(frame).toContain("docs");
      expect(frame).not.toContain("](https://example.com/docs)");
    }, WIDE);
  });

  test("### heading conceals its marker with no preceding blank line", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, shellOpts);
      appendStreamRow(shell, {
        role: "assistant",
        text: [
          "### What the site is",
          "It's a product storefront + brand hub. Nav covers:",
          "",
          "**Hardware:** boards and enclosures.",
        ].join("\n"),
      });

      const frame = await settle(
        h,
        // Require the bold body line too: heading-only frames can pass a
        // "no ### / no **Hardware:**" check while the body has not painted yet
        // (CI flake CL-5715).
        (f) =>
          f.includes("What the site is") &&
          f.includes("Hardware:") &&
          !f.includes("###") &&
          !f.includes("**Hardware:**"),
      );
      expect(frame).toContain("What the site is");
      expect(frame).not.toContain("###");
      expect(frame).toContain("Hardware:");
      expect(frame).not.toContain("**Hardware:**");
    }, WIDE);
  });

  test("tool and system rows stay literal", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, shellOpts);
      appendStreamRow(shell, { role: "tool", text: "## not a heading" });
      appendStreamRow(shell, { role: "system", text: "**raw**" });

      const frame = await settle(h, (f) => f.includes("**raw**"));
      expect(frame).toContain("## not a heading");
      expect(frame).toContain("**raw**");
    }, WIDE);
  });

  test("streaming row keeps a partial fence uncorrupted", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, shellOpts);
      appendStreamRow(shell, {
        role: "assistant",
        streaming: true,
        text: ["## Done", "", "```ts", "const partial = "].join("\n"),
      });

      const frame = await settle(
        h,
        (f) => f.includes("Done") && !f.includes("## Done") && f.includes("const partial ="),
      );
      expect(frame).toContain("Done");
      expect(frame).not.toContain("## Done");
      expect(frame).toContain("const partial =");
    }, WIDE);
  });

  test("a half-arrived heading marker never paints as literal text", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, shellOpts);
      appendStreamRow(shell, {
        role: "assistant",
        streaming: true,
        text: ["Some body text.", "", "#### "].join("\n"),
      });

      // `####` on its own is not yet a heading, so the parser reads it as
      // literal text and the row paints the bare markers until the title's
      // first character lands. Held back instead, so the line's classification
      // cannot flip under text already on screen.
      const frame = await settle(h, (f) => f.includes("Some body text.") && !f.includes("####"));
      expect(frame).toContain("Some body text.");
      expect(frame).not.toContain("####");

      replaceStreamRowAt(shell, shell.streamLog.length - 1, {
        role: "assistant",
        streaming: true,
        text: ["Some body text.", "", "#### Title"].join("\n"),
      });
      const next = await settle(h, (f) => f.includes("Title") && !f.includes("#### Title"));
      expect(next).toContain("Title");
      expect(next).not.toContain("#### Title");
    }, WIDE);
  });

  test("a row with no settled heading paints through a single renderer, not a wasted split", async () => {
    // Most rows never have a settled heading behind their tail (no heading at
    // all, or the only one is still being typed). Building the frozen/live
    // pair unconditionally would double every markdown row's renderer count
    // for no benefit in the common case.
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, shellOpts);
      const node = createStreamRowRenderable(shell, {
        role: "assistant",
        text: "Just a paragraph, no heading at all.",
      });
      expect(node).toBeInstanceOf(BoxRenderable);
      const [, bodyNode] = (node as BoxRenderable).getChildren();
      expect(bodyNode).toBeInstanceOf(MarkdownRenderable);
    }, WIDE);
  });

  test("a closed heading renders in its own settled renderer, separate from the prose after it", async () => {
    // The library's default block mode merges a heading into the same raw
    // chunk as the paragraph that follows it, so every keystroke of that
    // paragraph re-highlights the heading's already-settled text too — the
    // heading's markers and styling visibly flicker while the rest of the
    // message keeps streaming in. Splitting the body at the heading gives it
    // its own renderer, marked non-streaming, that the live (still-growing)
    // half never shares — so it is never asked to re-highlight again.
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, shellOpts);
      const node = createStreamRowRenderable(shell, {
        role: "assistant",
        streaming: true,
        text: ["### Title", "", "Some body text."].join("\n"),
      });
      expect(node).toBeInstanceOf(BoxRenderable);
      const [, bodyNode] = (node as BoxRenderable).getChildren();
      expect(bodyNode).toBeInstanceOf(BoxRenderable);
      const [frozenNode, liveNode] = (bodyNode as BoxRenderable).getChildren();
      expect(frozenNode).toBeInstanceOf(MarkdownRenderable);
      expect(liveNode).toBeInstanceOf(MarkdownRenderable);
      expect((frozenNode as MarkdownRenderable).content).toContain("### Title");
      expect((frozenNode as MarkdownRenderable).streaming).toBe(false);
      expect((liveNode as MarkdownRenderable).content).toBe("Some body text.");
      expect((liveNode as MarkdownRenderable).streaming).toBe(true);
    }, WIDE);
  });

  test("the settled heading renderer is never rewritten while the prose after it keeps streaming", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, shellOpts);
      appendStreamRow(shell, {
        role: "assistant",
        streaming: true,
        text: ["### Title", "", "Some"].join("\n"),
      });
      const children = shell.transcript.getChildren().slice(1);
      const [, bodyNode] = (children[0] as BoxRenderable).getChildren();
      const [frozenNode] = (bodyNode as BoxRenderable).getChildren();
      const before = (frozenNode as MarkdownRenderable).content;

      replaceStreamRowAt(shell, shell.streamLog.length - 1, {
        role: "assistant",
        streaming: true,
        text: ["### Title", "", "Some body text that keeps growing and growing."].join("\n"),
      });
      const childrenAfter = shell.transcript.getChildren().slice(1);
      const [, bodyNodeAfter] = (childrenAfter[0] as BoxRenderable).getChildren();
      const [frozenNodeAfter] = (bodyNodeAfter as BoxRenderable).getChildren();

      expect(frozenNodeAfter).toBe(frozenNode);
      expect((frozenNodeAfter as MarkdownRenderable).content).toBe(before);
    }, WIDE);
  });

  test("a list directly under a paragraph, with no blank line, keeps that shape after the split", async () => {
    // Regression guard: the split must never fall at a list boundary — only
    // at a settled heading — so paragraph/list spacing stays byte-identical
    // to the unsplit renderer's own default layout.
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, shellOpts);
      appendStreamRow(shell, {
        role: "assistant",
        text: ["### Title", "", "Here is the list:", "- alpha", "- beta"].join("\n"),
      });
      const frame = await settle(h, (f) => f.includes("alpha"));
      const lines = frame.split("\n").map((line) => line.trimEnd());
      const listLine = lines.findIndex((line) => line.includes("Here is the list:"));
      expect(listLine).toBeGreaterThan(-1);
      // No blank row inserted between the paragraph and the list beneath it.
      expect(lines[listLine + 1]).toContain("alpha");
    }, WIDE);
  });

  test("a ten-item ordered list under a heading keeps unpadded markers", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, shellOpts);
      const items = Array.from({ length: 10 }, (_, i) => `${i + 1}. item ${i + 1}`);
      appendStreamRow(shell, {
        role: "assistant",
        text: ["### Steps", "", ...items].join("\n"),
      });
      const frame = await settle(h, (f) => f.includes("10. item 10"));
      expect(frame).toContain("1. item 1");
      expect(frame).toContain("10. item 10");
    }, WIDE);
  });

  /** The heading's own painted span, wherever it lands in the current frame. */
  function headingSpan(h: Harness): CapturedSpan | null {
    for (const line of h.captureSpans().lines) {
      for (const span of line.spans) {
        if (span.text.includes("Title")) return span;
      }
    }
    return null;
  }

  test("a settled heading's painted span never changes while the prose after it keeps streaming", async () => {
    // The shake this fixes is a transient re-highlight, not a settled-frame
    // difference — a snapshot taken only after several idle ticks (as every
    // other test in this file does) cannot see it, because the async
    // highlight pass has always finished by then. This test instead samples
    // the heading's span on every delta, immediately after a single render
    // with no settle wait, which is the one place the flicker would show up.
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, shellOpts);
      const full = "Some body text that keeps growing and growing more and more and even more.";
      appendStreamRow(shell, {
        role: "assistant",
        streaming: true,
        text: ["### Title", "", full.slice(0, 1)].join("\n"),
      });
      // Warm up once: the first highlight pass in a process loads the
      // tree-sitter grammar and is not itself part of what this test samples.
      await settle(h, () => headingSpan(h) !== null);
      const baseline = headingSpan(h);
      expect(baseline).not.toBeNull();

      for (let i = 2; i <= full.length; i += 1) {
        replaceStreamRowAt(shell, shell.streamLog.length - 1, {
          role: "assistant",
          streaming: true,
          text: ["### Title", "", full.slice(0, i)].join("\n"),
        });
        await h.renderOnce();
        const span = headingSpan(h);
        expect(span).not.toBeNull();
        expect(span!.text).toBe(baseline!.text);
        expect(span!.fg).toEqual(baseline!.fg);
        expect(span!.attributes).toBe(baseline!.attributes);
      }
    }, WIDE);
  });

  describe("splitAtSettledHeading never splits a fenced code block", () => {
    test("a `#` shell comment inside a fence is not read as a heading boundary", () => {
      const text = [
        "```bash",
        "# this is a comment, not a heading",
        "echo hi",
        "```",
        "",
        "more prose streaming in",
      ].join("\n");
      const split = splitAtSettledHeading(text);
      // No real heading anywhere in this text, fenced or not: no split at all.
      expect(split).toBeNull();
    });

    test("a real heading before an open fence still splits, and the fence stays whole", () => {
      const text = [
        "### Title",
        "",
        "```bash",
        "# comment, not a heading",
        "echo hi",
        "```",
        "",
        "more prose streaming in",
      ].join("\n");
      const split = splitAtSettledHeading(text);
      expect(split).not.toBeNull();
      // The fence opens and closes on the same side of the split.
      expect(split!.frozen).toBe("### Title");
      expect(split!.live).toContain("```bash");
      expect(split!.live).toContain("```\n");
    });

    test("a fence opened before a heading keeps the heading out of the boundary search until it closes", () => {
      const text = [
        "```py",
        "# looks like a heading but is not",
        "```",
        "",
        "### Real Title",
        "",
        "body text",
      ].join("\n");
      const split = splitAtSettledHeading(text);
      expect(split).not.toBeNull();
      expect(split!.frozen).toContain("### Real Title");
      expect(split!.frozen).not.toContain("body text");
      expect(split!.live).toBe("body text");
    });

    test("a fenced `#` comment renders inside a matched fence, not split across two renderers", async () => {
      await withTestRenderer(async (h) => {
        const shell = createAppShell(h.renderer, shellOpts);
        appendStreamRow(shell, {
          role: "assistant",
          streaming: true,
          text: [
            "```bash",
            "# this is a comment, not a heading",
            "echo hi",
            "```",
            "",
            "more prose streaming in",
          ].join("\n"),
        });
        const frame = await settle(
          h,
          (f) =>
            f.includes("# this is a comment, not a heading") &&
            f.includes("more prose streaming in"),
        );
        expect(frame).toContain("# this is a comment, not a heading");
        expect(frame).toContain("echo hi");
        expect(frame).toContain("more prose streaming in");
      }, WIDE);
    });

    test("a closing-fence-shaped line carrying trailing text does not close the fence", () => {
      // CommonMark: the closing delimiter may contain only the fence
      // characters and trailing whitespace. "```stillcode" is more fence
      // content, not a closer, so the `#` after the real closer is still the
      // first heading — not the "```stillcode" line before it.
      const text = [
        "```bash",
        "echo hi",
        "```stillcode",
        "# should still be inside fence per CommonMark",
        "```",
        "",
        "### Title",
        "",
        "body",
      ].join("\n");
      const split = splitAtSettledHeading(text);
      expect(split).not.toBeNull();
      expect(split!.frozen).toContain("### Title");
      expect(split!.frozen).toContain("```stillcode");
      expect(split!.frozen).toContain("# should still be inside fence per CommonMark");
      expect(split!.live).toBe("body");
    });

    test("adversarial fence pairings: length and character must both match, indentation is bounded", () => {
      // Four backticks are not closed by three — the fence stays open, so
      // "### Title" is fence content too and there is no heading at all.
      expect(
        splitAtSettledHeading(
          ["````", "# not a heading", "```", "### Title", "", "body"].join("\n"),
        ),
      ).toBeNull();
      // The same shape, properly closed by a run of 4+: now it is a heading.
      expect(
        splitAtSettledHeading(
          [
            "````",
            "# not a heading",
            "```",
            "### not a heading either",
            "````",
            "",
            "### Title",
            "",
            "body",
          ].join("\n"),
        )!.frozen,
      ).toContain("### Title");
      // Three backticks are closed by four (a longer run of the same char).
      expect(
        splitAtSettledHeading(
          ["```", "# not a heading", "````", "", "### Title", "", "body"].join("\n"),
        )!.frozen,
      ).toContain("### Title");
      // A tilde run never closes a backtick fence, or vice versa.
      expect(
        splitAtSettledHeading(
          ["```", "~~~", "# not a heading", "```", "### Title", "", "body"].join("\n"),
        )!.frozen,
      ).toContain("### Title");
      // Up to 3 spaces of indent still opens/closes a fence.
      expect(
        splitAtSettledHeading(
          ["   ```", "# not a heading", "   ```", "### Title", "", "body"].join("\n"),
        )!.frozen,
      ).toContain("### Title");
      // 4 spaces is indented code, not a fence — the `#` line is still inside
      // it as indented code, never a heading boundary on its own.
      expect(
        splitAtSettledHeading(["    ```", "    # not a heading", "body"].join("\n")),
      ).toBeNull();
      // An unclosed fence at end of input, with a `#` line inside it and no
      // real heading anywhere: nothing to split at.
      expect(
        splitAtSettledHeading(
          ["```", "# still fence content, not a heading", "still going"].join("\n"),
        ),
      ).toBeNull();
    });
  });

  test("an indented heading (CommonMark allows up to 3 leading spaces) still closes the split", () => {
    const split = splitAtSettledHeading(["  ### Title", "", "body"].join("\n"));
    expect(split).not.toBeNull();
    expect(split!.frozen).toBe("  ### Title");
    expect(split!.live).toBe("body");
  });
});
