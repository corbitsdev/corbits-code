/**
 * URL click-through (CL-7346): Ctrl+click opens an http(s) URL in the
 * default browser; a plain click keeps today's row behavior. Armed
 * plain/structured rows open through their own node handlers (with hover
 * highlight); assistant markdown opens through the bubbling transcript
 * handler — click only, no hover highlight.
 *
 * The opener is mocked (setUrlOpener) — no test spawns a real browser.
 * Whether a real terminal reports the Ctrl modifier is a harness blind
 * spot (docs/TUI.md); headless, the mock delivers it like any click.
 */
import { describe, expect, test } from "bun:test";
import { TextRenderable } from "@opentui/core";

import { defined } from "../../tests/helpers/defined.js";
import { withTestRenderer } from "./harness";
import { appendStreamRow, replaceStreamRowAt } from "./shell/chrome";
import { createAppShell } from "./shell/index";
import { isUnderlined, markdownLinkAt, paintLinkLine } from "./url-links";
import { isOpenableUrl, resetUrlOpener, setUrlOpener } from "./link-open";
import { splitLinkSpans } from "./link-spans";
import { type StreamRow } from "./stream";

const CALL: StreamRow = {
  role: "tool",
  text: "",
  meta: "web_fetch",
  verb: "Web Fetch",
  summary: "see https://www.example.com/docs for details",
  detail: [[{ text: "url: https://www.example.com/docs", fg: "#f7ead5" }]],
};

/** Screen position of the first cell of `needle`, or null when not painted. */
function findCell(
  frame: string,
  needle: string,
): { readonly x: number; readonly y: number } | null {
  const lines = frame.split("\n");
  for (const [y, line] of lines.entries()) {
    const x = line.indexOf(needle);
    if (x !== -1) return { x, y };
  }
  return null;
}

describe("Ctrl+clicking a transcript URL", () => {
  test("opens it, while plain click and Ctrl+drag do not", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        });
        const opened: string[] = [];
        setUrlOpener((url) => {
          opened.push(url);
        });
        try {
          appendStreamRow(shell, CALL);
          await h.renderOnce();

          const link = findCell(h.captureCharFrame(), "example.com");
          expect(link).not.toBeNull();
          const at = defined(link);

          await h.mockMouse.click(at.x, at.y, 0, {
            modifiers: { ctrl: true },
          });
          await h.renderOnce();
          expect(opened).toEqual(["https://www.example.com/docs"]);

          opened.length = 0;
          await h.mockMouse.click(at.x, at.y);
          await h.renderOnce();
          expect(opened).toEqual([]);
          expect(shell.streamLog[0]?.expanded).not.toBe(true);

          await h.mockMouse.drag(at.x, at.y, at.x + 12, at.y, 0, {
            modifiers: { ctrl: true },
          });
          await h.renderOnce();
          expect(opened).toEqual([]);
        } finally {
          resetUrlOpener();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("Ctrl+hover underlines the link until the pointer leaves it", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        });
        try {
          appendStreamRow(shell, CALL);
          await h.renderOnce();

          const link = findCell(h.captureCharFrame(), "example.com");
          expect(link).not.toBeNull();
          const at = defined(link);

          const linkSpanUnderlined = (): boolean =>
            defined(h.captureSpans().lines[at.y]).spans.some(
              (span) =>
                span.text.includes("example.com") &&
                isUnderlined(span.attributes),
            );

          await h.mockMouse.moveTo(at.x, at.y, {
            modifiers: { ctrl: true },
          });
          await h.renderOnce();
          expect(linkSpanUnderlined()).toBe(true);

          await h.mockMouse.moveTo(at.x, at.y);
          await h.renderOnce();
          expect(linkSpanUnderlined()).toBe(false);
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("retexting the URL away disarms the node: old columns open nothing", async () => {
    await withTestRenderer(
      async (h) => {
        const opened: string[] = [];
        setUrlOpener((url) => {
          opened.push(url);
        });
        try {
          const line = "see https://example.com/x ok";
          const node = new TextRenderable(h.renderer, { content: line });
          h.root.add(node);
          paintLinkLine(node, [splitLinkSpans([{ text: line, fg: "#fff" }])]);
          await h.renderOnce();

          const link = findCell(h.captureCharFrame(), "example.com");
          expect(link).not.toBeNull();
          const at = defined(link);

          await h.mockMouse.click(at.x, at.y, 0, {
            modifiers: { ctrl: true },
          });
          await h.renderOnce();
          expect(opened).toEqual(["https://example.com/x"]);

          // Retext the URL away, exactly as the row retext path does. The
          // handlers are setter-only (no getter to assert on), so pin the
          // disarm behaviorally: the old columns open nothing and hover
          // leaves the painted text intact.
          const retexted = "see nothing here";
          paintLinkLine(node, [
            splitLinkSpans([{ text: retexted, fg: "#fff" }]),
          ]);
          await h.renderOnce();
          const frame = h.captureCharFrame();
          expect(frame).toContain("nothing here");
          expect(frame).not.toContain("example.com");

          opened.length = 0;
          await h.mockMouse.click(at.x, at.y, 0, {
            modifiers: { ctrl: true },
          });
          await h.renderOnce();
          expect(opened).toEqual([]);

          const before = h.captureCharFrame();
          await h.mockMouse.moveTo(at.x, at.y, {
            modifiers: { ctrl: true },
          });
          await h.renderOnce();
          expect(h.captureCharFrame()).toBe(before);
        } finally {
          resetUrlOpener();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("retexting a plain row's URL away through the row path disarms it", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        });
        const opened: string[] = [];
        setUrlOpener((url) => {
          opened.push(url);
        });
        try {
          // A user row paints literal text through paintPlainRowNode, so the
          // arm and the later disarm both run on the production row path.
          appendStreamRow(shell, {
            role: "user",
            text: "see https://example.com/x ok",
          });
          await h.renderOnce();

          const link = findCell(h.captureCharFrame(), "example.com");
          expect(link).not.toBeNull();
          const at = defined(link);

          await h.mockMouse.click(at.x, at.y, 0, {
            modifiers: { ctrl: true },
          });
          await h.renderOnce();
          expect(opened).toEqual(["https://example.com/x"]);

          // Retext in place through replaceStreamRowAt -> retextStreamRow ->
          // paintPlainRowNode's URL-free branch. Reverting that branch's
          // disarm must fail this test (stale handlers survive on the node).
          replaceStreamRowAt(shell, 0, {
            role: "user",
            text: "see nothing here",
          });
          await h.renderOnce();
          const frame = h.captureCharFrame();
          expect(frame).toContain("nothing here");
          expect(frame).not.toContain("example.com");

          opened.length = 0;
          await h.mockMouse.click(at.x, at.y, 0, {
            modifiers: { ctrl: true },
          });
          await h.renderOnce();
          expect(opened).toEqual([]);

          const before = h.captureCharFrame();
          await h.mockMouse.moveTo(at.x, at.y, {
            modifiers: { ctrl: true },
          });
          await h.renderOnce();
          expect(h.captureCharFrame()).toBe(before);
        } finally {
          resetUrlOpener();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("a wrapped URL in a thinking row opens the full target", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 40, rows: 24 },
          wireKeys: false,
          run: "idle",
        });
        const opened: string[] = [];
        setUrlOpener((url) => {
          opened.push(url);
        });
        try {
          // Agent thinking paints through the same plain-row path as user
          // rows; the long URL wraps mid-run at this width. Before the fix
          // the row armed the first fragment as its own truncated target.
          const full =
            "https://example.com/abcdefghijklmnopqrstuvwxyz0123456789";
          appendStreamRow(shell, {
            role: "system",
            meta: "thinking",
            text: `checking ${full} today`,
          });
          await h.renderOnce();

          const link = findCell(h.captureCharFrame(), "example.com");
          expect(link).not.toBeNull();
          const at = defined(link);

          await h.mockMouse.click(at.x, at.y, 0, {
            modifiers: { ctrl: true },
          });
          await h.renderOnce();
          expect(opened).toEqual([full]);
        } finally {
          resetUrlOpener();
          shell.dispose();
        }
      },
      { width: 40, height: 24 },
    );
  });

  test("a URL wrapped across bubble lines opens the full target", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 40, rows: 24 },
          wireKeys: false,
          run: "idle",
        });
        const opened: string[] = [];
        setUrlOpener((url) => {
          opened.push(url);
        });
        try {
          // The bubble body is narrower than the terminal, so the long URL
          // wraps across continuation rows. Every fragment must resolve to
          // the one target, not to its own truncated text.
          const full =
            "https://example.com/abcdefghijklmnopqrstuvwxyz0123456789";
          appendStreamRow(shell, {
            role: "user",
            text: `see ${full} ok`,
          });
          await h.renderOnce();

          const link = findCell(h.captureCharFrame(), "example.com");
          expect(link).not.toBeNull();
          const at = defined(link);

          await h.mockMouse.click(at.x, at.y, 0, {
            modifiers: { ctrl: true },
          });
          await h.renderOnce();
          expect(opened).toEqual([full]);
        } finally {
          resetUrlOpener();
          shell.dispose();
        }
      },
      { width: 40, height: 24 },
    );
  });

  test("assistant markdown bare URL and link label open on Ctrl+click", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        });
        const opened: string[] = [];
        setUrlOpener((url) => {
          opened.push(url);
        });
        try {
          // Markdown blocks paint through childless library renderers, so
          // their clicks are only visible through the bubbling transcript
          // handler armed by createAppShell.
          appendStreamRow(shell, {
            role: "assistant",
            text: "see https://example.com/docs and [guide](https://example.com/guide) ok",
          });
          // Assistant rows are markdown; their blocks highlight
          // asynchronously (see shell.test.ts), so wait for the paint
          // instead of sleeping a fixed settle.
          const bare = await waitForPaintedCell(h, "example.com/docs");
          await h.mockMouse.click(bare.x, bare.y, 0, {
            modifiers: { ctrl: true },
          });
          await h.renderOnce();
          expect(opened).toEqual(["https://example.com/docs"]);

          opened.length = 0;
          const label = await waitForPaintedCell(h, "guide");
          await h.mockMouse.click(label.x, label.y, 0, {
            modifiers: { ctrl: true },
          });
          await h.renderOnce();
          expect(opened).toEqual(["https://example.com/guide"]);
        } finally {
          resetUrlOpener();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("plain click on a markdown link does not open", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        });
        const opened: string[] = [];
        setUrlOpener((url) => {
          opened.push(url);
        });
        try {
          appendStreamRow(shell, {
            role: "assistant",
            text: "see https://example.com/docs ok",
          });
          const bare = await waitForPaintedCell(h, "example.com/docs");
          await h.mockMouse.click(bare.x, bare.y);
          await h.renderOnce();
          expect(opened).toEqual([]);
        } finally {
          resetUrlOpener();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("a markdown link to a non-http(s) target never opens", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        });
        const opened: string[] = [];
        setUrlOpener((url) => {
          opened.push(url);
        });
        try {
          appendStreamRow(shell, {
            role: "assistant",
            text: "see [target](custom://thing/pull/1) ok",
          });
          const label = await waitForPaintedCell(h, "target");
          await h.mockMouse.click(label.x, label.y, 0, {
            modifiers: { ctrl: true },
          });
          await h.renderOnce();
          expect(opened).toEqual([]);
        } finally {
          resetUrlOpener();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("Ctrl+press on a markdown link, release off it, does not open", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        });
        const opened: string[] = [];
        setUrlOpener((url) => {
          opened.push(url);
        });
        try {
          appendStreamRow(shell, {
            role: "assistant",
            text: "see https://example.com/docs and more prose here ok",
          });
          const bare = await waitForPaintedCell(h, "example.com/docs");
          await h.mockMouse.drag(bare.x, bare.y, bare.x + 30, bare.y, 0, {
            modifiers: { ctrl: true },
          });
          await h.renderOnce();
          expect(opened).toEqual([]);
        } finally {
          resetUrlOpener();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("Ctrl+click on an armed plain-row link opens exactly once", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        });
        const opened: string[] = [];
        setUrlOpener((url) => {
          opened.push(url);
        });
        try {
          // The armed row's own release handler opens and stops propagation;
          // the transcript-root markdown handler must not see the same
          // gesture and open the (resolver-resolved) target a second time.
          appendStreamRow(shell, {
            role: "user",
            text: "see https://example.com/x ok",
          });
          const link = await waitForPaintedCell(h, "example.com");
          await h.mockMouse.click(link.x, link.y, 0, {
            modifiers: { ctrl: true },
          });
          await h.renderOnce();
          expect(opened).toEqual(["https://example.com/x"]);
        } finally {
          resetUrlOpener();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });
});

describe("transcript markdown resolver edges (CL-7955)", () => {
  test("adjacent-link boundary cells miss and never resolve garbage", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        });
        const opened: string[] = [];
        setUrlOpener((url) => {
          opened.push(url);
        });
        try {
          appendStreamRow(shell, {
            role: "assistant",
            text: "[a](https://a.com)[b](https://b.com)",
          });
          const painted = await waitForPaintedCell(h, "a.com");
          const line = h.captureCharFrame().split("\n")[painted.y] ?? "";

          // Every resolved cell is a real openable target: the junction
          // between two adjacent links must miss rather than fuse their
          // sources into a garbage URL.
          for (let x = 0; x < line.length; x += 1) {
            const hit = markdownLinkAt(h.renderer, x, painted.y);
            if (hit === null) continue;
            expect(isOpenableUrl(hit)).toBe(true);
            expect([`https://a.com`, `https://b.com`]).toContain(hit);
          }

          // The junction cell itself (the ")" before "b (") misses, and
          // Ctrl+clicking it opens nothing.
          const junction = line.indexOf(")b (");
          expect(junction).toBeGreaterThan(-1);
          expect(markdownLinkAt(h.renderer, junction, painted.y)).toBeNull();
          await h.mockMouse.click(junction, painted.y, 0, {
            modifiers: { ctrl: true },
          });
          await h.renderOnce();
          expect(opened).toEqual([]);

          // Either side still opens its own target: the labels are
          // unambiguous, so the miss stays pinned to the boundary.
          const labelA = findCell(h.captureCharFrame(), " a (");
          expect(labelA).not.toBeNull();
          await h.mockMouse.click(defined(labelA).x + 1, defined(labelA).y, 0, {
            modifiers: { ctrl: true },
          });
          await h.renderOnce();
          expect(opened).toEqual(["https://a.com"]);

          opened.length = 0;
          const targetB = findCell(h.captureCharFrame(), "https://b.com");
          expect(targetB).not.toBeNull();
          await h.mockMouse.click(defined(targetB).x, defined(targetB).y, 0, {
            modifiers: { ctrl: true },
          });
          await h.renderOnce();
          expect(opened).toEqual(["https://b.com"]);
        } finally {
          resetUrlOpener();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("non-link prose in a markdown row misses", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        });
        const opened: string[] = [];
        setUrlOpener((url) => {
          opened.push(url);
        });
        try {
          appendStreamRow(shell, {
            role: "assistant",
            text: "see https://example.com/docs ok",
          });
          const bare = await waitForPaintedCell(h, "example.com/docs");
          const prose = findCell(h.captureCharFrame(), "see ");
          expect(prose).not.toBeNull();
          const at = defined(prose);
          expect(markdownLinkAt(h.renderer, at.x, at.y)).toBeNull();
          await h.mockMouse.click(at.x, at.y, 0, {
            modifiers: { ctrl: true },
          });
          await h.renderOnce();
          expect(opened).toEqual([]);

          await h.mockMouse.click(bare.x, bare.y, 0, {
            modifiers: { ctrl: true },
          });
          await h.renderOnce();
          expect(opened).toEqual(["https://example.com/docs"]);
        } finally {
          resetUrlOpener();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("image markup never opens, even with a URL-shaped label", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        });
        const opened: string[] = [];
        setUrlOpener((url) => {
          opened.push(url);
        });
        try {
          appendStreamRow(shell, {
            role: "assistant",
            text: "see ![logo](https://example.com/logo.png) ok",
          });
          const logo = await waitForPaintedCell(h, "logo");
          expect(markdownLinkAt(h.renderer, logo.x, logo.y)).toBeNull();
          await h.mockMouse.click(logo.x, logo.y, 0, {
            modifiers: { ctrl: true },
          });
          await h.renderOnce();
          expect(opened).toEqual([]);

          // A URL-shaped image label paints as URL text but stays an
          // image: Ctrl+clicking it must not open the label.
          appendStreamRow(shell, {
            role: "assistant",
            text: "see ![https://evil.example/x](https://img.example/y.png) ok",
          });
          const evil = await waitForPaintedCell(h, "evil.example");
          await h.mockMouse.click(evil.x + 1, evil.y, 0, {
            modifiers: { ctrl: true },
          });
          await h.renderOnce();
          expect(opened).toEqual([]);
        } finally {
          resetUrlOpener();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("a markdown bare URL wrapped across rows opens the full target", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 40, rows: 24 },
          wireKeys: false,
          run: "idle",
        });
        const opened: string[] = [];
        setUrlOpener((url) => {
          opened.push(url);
        });
        try {
          const full =
            "https://example.com/abcdefghijklmnopqrstuvwxyz0123456789";
          appendStreamRow(shell, {
            role: "assistant",
            text: `checking ${full} today`,
          });
          const first = await waitForPaintedCell(h, "example.com");
          await h.mockMouse.click(first.x, first.y, 0, {
            modifiers: { ctrl: true },
          });
          await h.renderOnce();
          expect(opened).toEqual([full]);
        } finally {
          resetUrlOpener();
          shell.dispose();
        }
      },
      { width: 40, height: 24 },
    );
  });

  test("a markdown link still opens at its post-scroll position", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        });
        const opened: string[] = [];
        setUrlOpener((url) => {
          opened.push(url);
        });
        try {
          for (let i = 0; i < 25; i += 1) {
            appendStreamRow(shell, {
              role: "assistant",
              text: `filler line ${i}`,
            });
          }
          appendStreamRow(shell, {
            role: "assistant",
            text: "see https://example.com/docs ok",
          });
          for (let i = 0; i < 3; i += 1) {
            appendStreamRow(shell, {
              role: "assistant",
              text: `trailing filler ${i}`,
            });
          }
          const before = await waitForPaintedCell(h, "example.com/docs");
          for (let i = 0; i < 2; i += 1) {
            await h.mockMouse.scroll(before.x, before.y, "up");
          }
          // Let in-flight scroll work land before clicking: a Ctrl+click
          // whose down/up straddles a scroll re-render never arms, so the
          // keeper settles first and tests the post-scroll position itself.
          await new Promise((r) => setTimeout(r, 100));
          await h.renderOnce();
          await h.renderOnce();
          const after = findCell(h.captureCharFrame(), "example.com/docs");
          expect(after).not.toBeNull();
          expect(defined(after).y).not.toBe(before.y);
          await h.mockMouse.click(defined(after).x, defined(after).y, 0, {
            modifiers: { ctrl: true },
          });
          await h.renderOnce();
          expect(opened).toEqual(["https://example.com/docs"]);
        } finally {
          resetUrlOpener();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });
});

/** Poll until `needle` paints, rendering between tries. */
async function waitForPaintedCell(
  h: {
    renderOnce: () => Promise<void>;
    captureCharFrame: () => string;
  },
  needle: string,
  timeoutMs = 2000,
): Promise<{ readonly x: number; readonly y: number }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await h.renderOnce();
    const cell = findCell(h.captureCharFrame(), needle);
    if (cell !== null) return cell;
    if (Date.now() > deadline) throw new Error(`never painted: ${needle}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
