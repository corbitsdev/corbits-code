/**
 * Landing anatomy: the animated mark, a vertically centred prompt box, the
 * telemetry disclosure and selectable starters — and nothing left over once
 * the transcript has content.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { CapturedSpan } from "@opentui/core";
import { rgbToHex } from "@opentui/core";
import { withTestRenderer, type Harness } from "./harness";
import {
  appendStreamRow,
  applyLandingSuggestion,
  createAppShell,
  noticeText,
  paintChrome,
  setChromeZones,
  setPluginNeedsAttention,
  setPromptModelLabel,
  setPromptWorkspace,
  isLanding,
  paintLanding,
  streamRowCount,
  surfaceSystemNotice,
  toggleTasksPanel,
} from "./shell";
import { makePermissionItems, openPermissionsOverlay } from "./overlays";
import {
  LANDING_HINTS,
  LANDING_SUGGESTIONS,
  LANDING_VERSION,
  landingBelowContent,
  landingBelowRows,
  landingSuggestionFor,
  resolveMarkGrid,
  splitLandingRows,
  VERSION_BADGE_MIN_COLUMNS,
  VERSION_BADGE_MIN_ROWS,
  versionBadgeVisible,
  wrapLanding,
} from "./landing";
import { LOCKUP_WORDMARK } from "./lockup";
import pkg from "../../package.json" with { type: "json" };
import { MARK_LARGE, MARK_MID, MARK_SMALL } from "./mark-shape";
import { SNOW_CHAR } from "./mark-anim";
import { UI } from "./theme";

const SIZE = { width: 80, height: 24 } as const;
const NOTICE = "Anonymous usage telemetry is enabled. Disable in /settings.";

const nativeSetInterval = globalThis.setInterval;
const nativeClearInterval = globalThis.clearInterval;

/**
 * 125 is `LANDING_IDLE_REPAINT_INTERVAL_MS` in shell.ts. Hardcoded so a
 * cadence change fails these tests on purpose rather than tracking a product
 * export.
 */
const LANDING_IDLE_REPAINT_INTERVAL_MS = 125;
const stripSnow = (text: string) => text.replaceAll(SNOW_CHAR, " ");

interface IdleTimerHandle {
  unref?: () => void;
}

function wrapLandingIdleTimer(): {
  armed: IdleTimerHandle[];
  cleared: IdleTimerHandle[];
} {
  const armed: IdleTimerHandle[] = [];
  const cleared: IdleTimerHandle[] = [];
  // Do not arm a real interval. Callers inject clocks or only inspect handles.
  globalThis.setInterval = ((
    handler: Parameters<typeof nativeSetInterval>[0],
    delay?: number,
    ...args: unknown[]
  ) => {
    if (delay === LANDING_IDLE_REPAINT_INTERVAL_MS) {
      const handle: IdleTimerHandle = {};
      armed.push(handle);
      return handle;
    }
    return nativeSetInterval.call(globalThis, handler, delay, ...args);
  }) as typeof nativeSetInterval;
  globalThis.clearInterval = ((handle: Parameters<typeof nativeClearInterval>[0]) => {
    cleared.push(handle as IdleTimerHandle);
    if (armed.includes(handle as IdleTimerHandle)) return;
    return nativeClearInterval.call(globalThis, handle);
  }) as typeof nativeClearInterval;
  return { armed, cleared };
}

function soleLandingIdleHandle(armed: readonly IdleTimerHandle[]): IdleTimerHandle {
  const handle = armed[0];
  if (armed.length !== 1 || handle === undefined) {
    throw new Error(
      `expected exactly one ${LANDING_IDLE_REPAINT_INTERVAL_MS}ms interval, got ${armed.length}`,
    );
  }
  return handle;
}

/** Newly added scroll-box children need a layout pass before they paint. */
async function settle(h: Harness): Promise<void> {
  await h.renderOnce();
  await h.renderOnce();
}

function backgrounds(h: Harness): readonly string[] {
  const frame = h.captureSpans();
  return frame.lines.flatMap((line: { spans: CapturedSpan[] }) =>
    line.spans
      .filter((span) => span.text.trim().length > 0 || span.width > 20)
      .map((span) => rgbToHex(span.bg).toLowerCase().slice(0, 7)),
  );
}

function rows(h: Harness): readonly string[] {
  return h.captureCharFrame().split("\n");
}

/** Landing mark rows only — the bottom-left lockup shares the same glyphs. */
function markRows(h: Harness): readonly string[] {
  return rows(h).filter((row) => /[░▒▓█▁▂▃▄▅▆▇]/.test(row) && !row.includes(LOCKUP_WORDMARK));
}

describe("landing layout math", () => {
  test("splits the transcript zone evenly around the prompt box", () => {
    expect(splitLandingRows(19)).toEqual({ above: 9, below: 10 });
    expect(splitLandingRows(0)).toEqual({ above: 0, below: 0 });
    expect(splitLandingRows(-4)).toEqual({ above: 0, below: 0 });
  });

  test("wraps on words without breaking them", () => {
    expect(wrapLanding("one two three four", 9)).toEqual(["one two", "three", "four"]);
    expect(wrapLanding("supercalifragilistic", 4)).toEqual(["supercalifragilistic"]);
  });

  test("the disclosure outranks the starters when rows are scarce", () => {
    const full = landingBelowContent({ rows: 10, columns: 78, telemetryNotice: NOTICE });
    expect(full.notice.length).toBeGreaterThan(0);
    expect(full.suggestions).toEqual(LANDING_SUGGESTIONS);

    const cramped = landingBelowContent({
      rows: 3,
      columns: 78,
      telemetryNotice: NOTICE,
    });
    expect(cramped.notice.length).toBeGreaterThan(0);
    expect(cramped.suggestions).toEqual([]);
  });

  test("no notice means no notice rows", () => {
    const content = landingBelowContent({ rows: 10, columns: 78 });
    expect(content.notice).toEqual([]);
    const text = landingBelowRows(content).map((row) => row.text);
    expect(text).toContain("try");
    expect(text.some((line) => line.includes("telemetry"))).toBe(false);
  });

  test("the two doors are commands and /yolo", () => {
    expect(LANDING_HINTS).toEqual([
      { key: "/", rest: "for commands" },
      { key: "/yolo", rest: "so Corbits Code doesn't have to ask for permissions" },
    ]);
  });

  test("the mark degrades through its tiers and then disappears", () => {
    // Roomy: the hero grid, which is the only size that reads unambiguously.
    expect(resolveMarkGrid(20, 120)).toBe(MARK_LARGE);
    // A row short of the hero, a tier down rather than a clipped hero.
    expect(resolveMarkGrid(12, 120)).toBe(MARK_MID);
    expect(resolveMarkGrid(9, 120)).toBe(MARK_SMALL);
    // 80-column terminal: contentWidth is 78 after gutters; the compact mark
    // still seats beside the two doors.
    expect(resolveMarkGrid(20, 78)).toBe(MARK_SMALL);
    // Narrow enough that the mark would crowd the hints: the hints win.
    expect(resolveMarkGrid(20, 50)).toBeNull();
    expect(resolveMarkGrid(20, 30)).toBeNull();
    expect(resolveMarkGrid(3, 96)).toBeNull();
  });

  test("every starter is reachable by its key", () => {
    for (const item of LANDING_SUGGESTIONS) {
      expect(landingSuggestionFor(item.key)).toBe(item);
    }
    expect(landingSuggestionFor("z")).toBeNull();
  });
});

describe("landing screen", () => {
  test("centres the prompt box between the mark and the disclosure", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        title: "corbits",
        terminal: { columns: 80, rows: 24 },
        wireKeys: false,
        run: "idle",
        telemetryNotice: NOTICE,
      });
      try {
        await settle(h);
        const painted = rows(h);
        // Either corner set: the prompt border's glyphs are the box owner's
        // business, the box's position is what this asserts.
        const top = painted.findIndex((row) => /[┌╭]/.test(row));
        const bottom = painted.findIndex((row) => /[└╰]/.test(row));
        expect(top).toBeGreaterThan(0);
        // The box straddles the terminal's middle row (within the half row an
        // odd-height box on an even-height terminal cannot avoid).
        expect(Math.abs((top + bottom) / 2 - (SIZE.height - 1) / 2)).toBeLessThanOrEqual(1);

        // Mark above, bottom-anchored against the box; disclosure below it.
        const mark = markRows(h);
        // Whichever tier this terminal seats, the mark is whole: a clipped
        // grid would read as a different shape.
        expect([MARK_LARGE, MARK_MID, MARK_SMALL].map((g) => g.rows)).toContain(mark.length);
        expect(painted.indexOf(mark.at(-1) as string)).toBeLessThan(top);
        // The two doors sit beside the mark, not under it, and their
        // descriptions share one column — ragged, the pair reads as two
        // unrelated lines rather than as a set.
        const descriptionColumns = new Set<number>();
        for (const hint of LANDING_HINTS) {
          const row = painted.find((line) => line.includes(hint.rest));
          expect(row).toBeDefined();
          expect(row).toContain(hint.key);
          expect(row!.indexOf(hint.key)).toBeGreaterThan(0);
          descriptionColumns.add(row!.indexOf(hint.rest));
        }
        expect(descriptionColumns.size).toBe(1);
        // The version is chrome, not part of the hero: it never shares a row
        // with a hint, and cannot drift from package.json.
        expect(LANDING_VERSION).toBe(`v${pkg.version}`);
        for (const hint of LANDING_HINTS) {
          const row = painted.find((line) => line.includes(hint.rest));
          expect(row).not.toContain(LANDING_VERSION);
        }
        const versionRow = painted.findIndex((row) => row.includes(LANDING_VERSION));
        expect(versionRow).toBeGreaterThanOrEqual(0);
        // Bottom-right: on the terminal's last content row, hugging the right
        // edge rather than sitting under the hints.
        expect(versionRow).toBeGreaterThanOrEqual(SIZE.height - 2);
        const versionCol = painted[versionRow]!.lastIndexOf(LANDING_VERSION);
        expect(versionCol + LANDING_VERSION.length).toBeGreaterThan(SIZE.width - 4);
        const noticeRow = painted.findIndex((row) => row.includes("telemetry"));
        expect(noticeRow).toBeGreaterThan(bottom);
        for (const item of LANDING_SUGGESTIONS) {
          expect(h.captureCharFrame()).toContain(item.label);
        }
      } finally {
        shell.dispose();
      }
    }, SIZE);
  });

  test("the mark paints in the brand orange, not a cool accent", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        wireKeys: false,
        run: "idle",
      });
      try {
        await settle(h);
        const tones = new Set(
          h
            .captureSpans()
            .lines.flatMap((line: { spans: CapturedSpan[] }) => line.spans)
            .filter((span) => /[░▒▓█]/.test(span.text))
            .map((span) => rgbToHex(span.fg).toLowerCase().slice(0, 7)),
        );
        expect(tones.size).toBeGreaterThan(0);
        for (const tone of tones) {
          expect([UI.action, UI.actionDim] as readonly string[]).toContain(tone);
        }
      } finally {
        shell.dispose();
      }
    }, SIZE);
  });

  test("the mark advances off an injected clock while a turn runs", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        wireKeys: false,
        run: "idle",
      });
      try {
        await settle(h);
        const still = markRows(h).join("\n");

        // Idle re-entry holds the mountain's filled frame however far the
        // clock moves — but the snow drifting over it is not still, since the
        // idle landing screen is exactly where it needs to animate.
        paintLanding(shell, 1_700, false);
        await settle(h);
        expect(stripSnow(markRows(h).join("\n"))).toBe(stripSnow(still));

        const frames = new Set<string>();
        for (const nowMs of [0, 500, 1_100, 1_900, 2_600, 3_400]) {
          paintLanding(shell, nowMs, true);
          await settle(h);
          frames.add(markRows(h).join("\n"));
        }
        expect(frames.size).toBeGreaterThan(1);
      } finally {
        shell.dispose();
      }
    }, SIZE);
  });

  test("an idle mount keeps the snow drifting on its own, with nothing pumping frames by hand", async () => {
    // Regression for CL-5737: every other test in this file drives the mark
    // by calling `paintLanding` directly with a hand-picked clock. That is
    // exactly why the landing snow shipped completely unreachable — none of
    // those tests go through the real driver a running session actually
    // uses. This one mounts the shell for real and lets it repaint itself:
    // no `paintLanding`/`renderMark` calls, and critically no `renderOnce`
    // loop either while waiting — a test that pumps frames by hand can stay
    // green even when production's self-driving mechanism is dead, which is
    // exactly the blind spot that let the throttled build ship frozen snow.
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        wireKeys: false,
        run: "idle",
      });
      try {
        await settle(h);
        const before = markRows(h).join("\n");

        // Poll until the product's own idle-repaint timer moves the snow, or
        // until a deadline. A single fixed sleep-then-check races the timer
        // under CI load (CL-5766): when the interval is delayed past the
        // sleep, `flush` finds nothing scheduled and the capture is still
        // the mount frame. Polling keeps the property intact — nothing here
        // calls `paintLanding`/`renderMark`/`renderOnce`, so a frozen timer
        // still fails — while early exit drops the average suite cost below
        // the old fixed 3s wait.
        const deadline = performance.now() + 5_000;
        let after = before;
        while (performance.now() < deadline) {
          // Drain any render the product already scheduled; do not force one.
          await h.flush();
          after = markRows(h).join("\n");
          if (after !== before) break;
          // Yield so the mount-scoped interval can fire; not a frame pump.
          await new Promise((resolve) => setTimeout(resolve, 50));
        }

        expect(after).not.toBe(before);
        expect(stripSnow(after)).toBe(stripSnow(before));
      } finally {
        shell.dispose();
      }
    }, SIZE);
  }, 15_000);

  describe("landing idle timer", () => {
    afterEach(() => {
      globalThis.setInterval = nativeSetInterval;
      globalThis.clearInterval = nativeClearInterval;
    });

    test("reduced-motion mount never arms the idle timer and never draws snow", async () => {
      const { armed } = wrapLandingIdleTimer();
      await withTestRenderer(async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
          reducedMotion: true,
        });
        try {
          expect(armed).toHaveLength(0);
          await settle(h);
          const first = markRows(h).join("\n");
          expect(first.includes(SNOW_CHAR)).toBe(false);
          expect(first.length).toBeGreaterThan(0);

          const frames = new Set<string>([first]);
          for (const nowMs of [0, 500, 1_100, 1_900, 2_600, 3_400]) {
            paintLanding(shell, nowMs, true);
            await settle(h);
            const frame = markRows(h).join("\n");
            expect(frame.includes(SNOW_CHAR)).toBe(false);
            frames.add(frame);
          }
          expect(frames.size).toBe(1);
        } finally {
          shell.dispose();
        }
      }, SIZE);
    });

    test("a deferred system notice does not clear the landing idle timer", async () => {
      const { armed, cleared } = wrapLandingIdleTimer();
      await withTestRenderer(async (h) => {
        const shell = createAppShell(h.renderer, {
          run: "idle",
          wireKeys: false,
          terminal: { columns: 80, rows: 24 },
        });
        try {
          const handle = soleLandingIdleHandle(armed);
          surfaceSystemNotice(
            shell,
            "mcp github did not connect (ECONNREFUSED) — its tools are unavailable; /mcp for detail",
          );
          expect(isLanding(shell)).toBe(true);
          expect(cleared).not.toContain(handle);
        } finally {
          shell.dispose();
        }
      }, SIZE);
    });

    test("appending a transcript row clears the landing idle timer", async () => {
      const { armed, cleared } = wrapLandingIdleTimer();
      await withTestRenderer(async (h) => {
        const shell = createAppShell(h.renderer, {
          run: "idle",
          wireKeys: false,
          terminal: { columns: 80, rows: 24 },
        });
        try {
          const handle = soleLandingIdleHandle(armed);
          appendStreamRow(shell, { role: "user", text: "first prompt" });
          expect(isLanding(shell)).toBe(false);
          expect(cleared).toContain(handle);
        } finally {
          shell.dispose();
        }
      }, SIZE);
    });

    test("disposing the shell with no transcript clears the landing idle timer", async () => {
      const { armed, cleared } = wrapLandingIdleTimer();
      await withTestRenderer(async (h) => {
        const shell = createAppShell(h.renderer, {
          run: "idle",
          wireKeys: false,
          terminal: { columns: 80, rows: 24 },
        });
        try {
          const handle = soleLandingIdleHandle(armed);
          shell.dispose();
          expect(cleared).toContain(handle);
        } finally {
          shell.dispose();
        }
      }, SIZE);
    });
  });

  test("a starter key fills the prompt; a typed prompt keeps its digits", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        wireKeys: false,
        run: "idle",
      });
      try {
        await settle(h);
        const first = LANDING_SUGGESTIONS[0];
        expect(first).toBeDefined();
        expect(applyLandingSuggestion(shell, first!.key)).toBe(true);
        expect(shell.prompt.value).toBe(first!.prompt);

        // Already typed: the key is a character, not a shortcut.
        expect(applyLandingSuggestion(shell, first!.key)).toBe(false);
      } finally {
        shell.dispose();
      }
    }, SIZE);
  });

  test("the starters withdraw while the prompt has text", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        wireKeys: false,
        telemetryNotice: NOTICE,
      });
      try {
        await settle(h);
        const first = LANDING_SUGGESTIONS[0]!;
        expect(h.captureCharFrame()).toContain(first.label);

        shell.prompt.value = "wri";
        paintChrome(shell);
        await settle(h);
        const typing = h.captureCharFrame();
        expect(typing).not.toContain(first.label);
        // The disclosure is not a suggestion and must not withdraw with them.
        expect(typing).toContain("telemetry");

        shell.prompt.value = "";
        paintChrome(shell);
        await settle(h);
        expect(h.captureCharFrame()).toContain(first.label);
      } finally {
        shell.dispose();
      }
    }, SIZE);
  });

  test("the brand lockup sits in the prompt box's bottom border, session-long", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        wireKeys: false,
      });
      try {
        await settle(h);
        // The lockup rides the box's bottom rule, so it is on the rule itself
        // rather than on a row of its own beneath it.
        const landingPainted = rows(h);
        const landingRow = landingPainted.findIndex((row) => row.includes(LOCKUP_WORDMARK));
        expect(landingRow).toBeGreaterThanOrEqual(0);
        expect(landingPainted[landingRow]).toContain("╰");

        // It outlives the landing: this is session chrome, not a splash.
        appendStreamRow(shell, { role: "user", text: "first prompt" });
        await settle(h);
        const painted = rows(h);
        const ruleRow = painted.findIndex((row) => row.includes(LOCKUP_WORDMARK));
        // Session-active: the version row only reserves space on the landing
        // screen (see `relayout`). Once there is real transcript content the
        // box sits one row above the terminal's last line — the optical
        // bottom pad (`BOTTOM_MARGIN_ROWS`) keeps it off the frame edge.
        expect(ruleRow).toBe(SIZE.height - 2);
        const row = painted[ruleRow]!;
        // Left end of the rule, inside the shell gutter, costing no row.
        expect(row.startsWith(" ╰─ ")).toBe(true);
        expect(row.trimEnd().endsWith("╯")).toBe(true);
      } finally {
        shell.dispose();
      }
    }, SIZE);
  });

  test("a narrow rule drops the lockup and keeps the workspace", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 34, rows: 20 },
          wireKeys: false,
          cwd: "/src/corbits-code",
        });
        try {
          setPromptWorkspace(shell, { branch: "migration/opentui-tui" });
          await settle(h);
          const frame = h.captureCharFrame();
          // The workspace is information and the mark is not: the mark goes.
          expect(frame).not.toContain(LOCKUP_WORDMARK);
          expect(frame).toContain("(migration/opentui-tui) ─╯");
        } finally {
          shell.dispose();
        }
      },
      { width: 34, height: 20 },
    );
  });

  test("an overlay covers the landing, sliding it only as far as its content needs", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 100, rows: 30 },
          wireKeys: false,
          run: "idle",
          telemetryNotice: NOTICE,
        });
        try {
          await settle(h);
          const before = rows(h);
          const anchors = ["message", "telemetry", LANDING_SUGGESTIONS[0]!.label];
          const was = anchors.map((text) => before.findIndex((row) => row.includes(text)));
          expect(was.every((index) => index > 0)).toBe(true);
          // The anchors are listed top to bottom, so their positions climb
          // together before the overlay opens.
          expect(was).toEqual([...was].sort((a, b) => a - b));

          // Heavy inset permission overlay: many choices plus a multi-line body
          // so the float must take real headroom from the landing split. A
          // three-item empty body leaves message delta 0 and would pass even if
          // the split never slid.
          const heavyBody = [
            "run_shell",
            "Run shell command",
            "Proposed: git reset --hard origin/main && rm -rf node_modules",
            "Files at risk: 128 modified, 12 untracked.",
            "Continue only if you accept discarding local work.",
            "Also note: this path was requested by the explore agent.",
            "Scopes include session, project, and once-only grants.",
            "Review carefully before approving this request.",
          ].join("\n");
          openPermissionsOverlay(shell, {
            items: makePermissionItems(16),
            body: heavyBody,
          });
          expect(shell.layout.overlayMode).toBe("inset");
          await settle(h);
          const after = rows(h);
          // Every landing anchor is still on screen and in the same relative
          // order: the overlay is not letting the composition it covers spill
          // off the viewport, overlap itself, or reshuffle. It may still
          // slide the composition (up or down a little, as the mark re-grids
          // for its new tier) when its own content needs more room than the
          // even top/bottom split would otherwise leave it.
          const nowAt = anchors.map((text) => after.findIndex((row) => row.includes(text)));
          expect(nowAt.every((index) => index > 0)).toBe(true);
          expect(nowAt).toEqual([...nowAt].sort((a, b) => a - b));
          expect(new Set(nowAt).size).toBe(nowAt.length);
          // Real geometry pressure: the prompt field moves so the inset can
          // claim rows the even split would not have given it.
          expect(nowAt[0]).not.toBe(was[0]);
          expect(h.captureCharFrame()).toContain("Esc cancel");
        } finally {
          shell.dispose();
        }
      },
      { width: 100, height: 30 },
    );
  });

  // An inset permission list with more choices than the even top/bottom split
  // would leave room for used to get its list starved down to whatever that
  // split happened to allow — as little as one or two choices — because the
  // float only asked the split for one choice row of headroom. It now asks for
  // the overlay's real, already fraction-capped content height, so a terminal
  // tall enough for that content shows every choice without scrolling.
  test("a landing overlay with many choices shows them all when there is room", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 100, rows: 48 },
          wireKeys: false,
          run: "idle",
        });
        try {
          const items = makePermissionItems(8);
          openPermissionsOverlay(shell, {
            items,
            body: "run_shell\nRun shell command\nbun test src/tui",
          });
          expect(shell.layout.overlayMode).toBe("inset");
          await settle(h);
          const frame = h.captureCharFrame();
          for (const choice of items) {
            expect(frame).toContain(choice);
          }
        } finally {
          shell.dispose();
        }
      },
      { width: 100, height: 48 },
    );
  });

  test("a short or narrow terminal shrinks the mark, never the prompt box", async () => {
    for (const size of [
      { width: 100, height: 30 },
      { width: 80, height: 24 },
      { width: 60, height: 20 },
    ]) {
      await withTestRenderer(async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: size.width, rows: size.height },
          wireKeys: false,
          run: "idle",
          telemetryNotice: NOTICE,
        });
        try {
          await settle(h);
          const painted = rows(h);
          // The prompt field is on screen at every size, and the mark fits
          // above it rather than overrunning it.
          const field = painted.findIndex((row) => row.includes("message"));
          expect(field).toBeGreaterThan(0);
          expect(field).toBeLessThan(size.height);
          expect(markRows(h).length).toBeLessThan(field);
          expect(h.captureCharFrame()).toContain(LANDING_HINTS[0]!.rest);
        } finally {
          shell.dispose();
        }
      }, size);
    }
  });

  test("no titlebar, status strip or counter row survives", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        wireKeys: false,
        run: "idle",
      });
      try {
        await settle(h);
        const frame = h.captureCharFrame();
        // Assert the badge token, not "queue": this worktree path contains
        // "queued" and would false-fail a cwd substring check.
        for (const gone of ["BUSY", "IDLE", "FOLLOW", "follow-up", "lines", "focus"]) {
          expect(frame).not.toContain(gone);
        }
        // The old header blue and status green are gone as fills.
        const fills = new Set(backgrounds(h));
        expect(fills.has("#3d59a1")).toBe(false);
        expect(fills.has("#9ece6a")).toBe(false);
      } finally {
        shell.dispose();
      }
    }, SIZE);
  });

  test("the landing is dropped once the transcript has content", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        wireKeys: false,
        telemetryNotice: NOTICE,
      });
      try {
        await settle(h);
        expect(isLanding(shell)).toBe(true);
        appendStreamRow(shell, { role: "user", text: "first prompt" });
        await settle(h);
        expect(isLanding(shell)).toBe(false);
        const frame = h.captureCharFrame();
        expect(markRows(h)).toEqual([]);
        expect(frame).toContain("first prompt");
        expect(frame).not.toContain("explain this codebase");
        // The disclosure survives the teardown as a transcript row.
        expect(frame).toContain("telemetry");
        // The prompt box is back at the foot of the screen.
        const painted = rows(h);
        expect(painted.findIndex((row) => /[└╰]/.test(row))).toBeGreaterThan(SIZE.height - 4);
      } finally {
        shell.dispose();
      }
    }, SIZE);
  });

  test("startup MCP/load errors keep the mountain and ride the notice strip", async () => {
    // CL-5618 / CL-5600: system notices on load used to appendStreamRow →
    // clearLandingMark, wiping the brand hero. They must surface as secondary
    // chrome while geometry still seats MARK_SMALL or larger.
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        wireKeys: false,
        run: "idle",
      });
      try {
        await settle(h);
        expect(isLanding(shell)).toBe(true);
        const before = markRows(h);
        expect([MARK_LARGE, MARK_MID, MARK_SMALL].map((g) => g.rows)).toContain(before.length);

        const mcpError =
          "mcp github did not connect (ECONNREFUSED) — its tools are unavailable; /mcp for detail";
        surfaceSystemNotice(shell, mcpError);
        await settle(h);

        // The mountain stays; the notice strip carries the wording.
        expect(isLanding(shell)).toBe(true);
        expect(streamRowCount(shell)).toBe(0);
        expect(shell.statusFlash).toBe(mcpError);
        expect(noticeText(shell)).toContain("mcp github did not connect");
        const after = markRows(h);
        expect(after.length).toBe(before.length);
        expect([MARK_LARGE, MARK_MID, MARK_SMALL].map((g) => g.rows)).toContain(after.length);

        // A real session row still ends the landing; deferred notices become
        // durable transcript rows rather than vanishing with the flash.
        appendStreamRow(shell, { role: "user", text: "first prompt" });
        await settle(h);
        expect(isLanding(shell)).toBe(false);
        expect(markRows(h)).toEqual([]);
        const frame = h.captureCharFrame();
        expect(frame).toContain("first prompt");
        expect(frame).toContain("mcp github did not connect");
      } finally {
        shell.dispose();
      }
    }, SIZE);
  });

  test("startup plugin diagnostics keep the mountain and ride plugin !", async () => {
    // Plugin load warnings no longer go through surfaceSystemNotice — they
    // drive the standing `plugin !` attention mark instead. The mountain must
    // still stay up while that mark is painted.
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        wireKeys: false,
        run: "idle",
      });
      try {
        await settle(h);
        expect(isLanding(shell)).toBe(true);
        const before = markRows(h);
        expect(before.length).toBeGreaterThan(0);

        setPromptModelLabel(shell, { profile: "xai", model: "grok" });
        setPluginNeedsAttention(shell, true);
        await settle(h);

        expect(isLanding(shell)).toBe(true);
        expect(markRows(h).length).toBe(before.length);
        expect(streamRowCount(shell)).toBe(0);
        expect(noticeText(shell)).toBe("");
        expect(shell.pluginNeedsAttention).toBe(true);
        const frame = h.captureCharFrame();
        expect(frame).toContain("plugin !");
        expect(frame).not.toContain("skills missing");
      } finally {
        shell.dispose();
      }
    }, SIZE);
  });

  test("a flushed startup notice never carries a plumbing gutter label", async () => {
    // The transcript must never label a row "command": a system row's text
    // already says what it is, and the meta column is the operator's, not the
    // wiring's. (MCP notices still use the notice strip; plugin skill-miss
    // summaries do not.)
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        wireKeys: false,
        run: "idle",
      });
      try {
        await settle(h);
        surfaceSystemNotice(
          shell,
          "mcp github did not connect (ECONNREFUSED) — its tools are unavailable; /mcp for detail",
        );
        appendStreamRow(shell, { role: "user", text: "first prompt" });
        await settle(h);

        expect(isLanding(shell)).toBe(false);
        // Assert on the flushed notice row(s) — not the full char frame. The
        // footer/chrome can echo the process cwd, and a worktree path that
        // happens to contain "overlay" (or "command") must not false-positive
        // the plumbing-label invariant.
        const noticeNeedle = "mcp github did not connect";
        const noticeRows = shell.streamLog.filter((row) => row.text.includes(noticeNeedle));
        expect(noticeRows.length).toBeGreaterThan(0);
        for (const row of noticeRows) {
          expect(row.meta).not.toBe("command");
          expect(row.meta).not.toBe("overlay");
        }
        const painted = rows(h).filter((line) => line.includes(noticeNeedle));
        expect(painted.length).toBeGreaterThan(0);
        for (const line of painted) {
          expect(line).not.toContain("command");
          expect(line).not.toContain("overlay");
        }
      } finally {
        shell.dispose();
      }
    }, SIZE);
  });

  test("the version is chrome, not the hero: it hides before actionable chrome does on a narrow terminal", async () => {
    // Comfortably above the badge's own thresholds but below nothing else —
    // proves the badge is what degrades, and degrades first.
    const roomy = { width: VERSION_BADGE_MIN_COLUMNS + 20, height: VERSION_BADGE_MIN_ROWS + 8 };
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: roomy.width, rows: roomy.height },
        wireKeys: false,
        run: "idle",
      });
      try {
        await settle(h);
        expect(h.captureCharFrame()).toContain(LANDING_VERSION);
      } finally {
        shell.dispose();
      }
    }, roomy);

    // Just under the badge's column floor: the badge is gone, but the prompt
    // field — genuinely actionable chrome — is still on screen.
    const narrowColumns = {
      width: VERSION_BADGE_MIN_COLUMNS - 1,
      height: VERSION_BADGE_MIN_ROWS + 8,
    };
    expect(versionBadgeVisible(narrowColumns.width, narrowColumns.height)).toBe(false);
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: narrowColumns.width, rows: narrowColumns.height },
        wireKeys: false,
        run: "idle",
      });
      try {
        await settle(h);
        const frame = h.captureCharFrame();
        expect(frame).not.toContain(LANDING_VERSION);
        expect(frame).toContain("message");
      } finally {
        shell.dispose();
      }
    }, narrowColumns);

    // Just under the badge's row floor: same story, short rather than narrow.
    const shortRows = {
      width: VERSION_BADGE_MIN_COLUMNS + 20,
      height: VERSION_BADGE_MIN_ROWS - 1,
    };
    expect(versionBadgeVisible(shortRows.width, shortRows.height)).toBe(false);
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: shortRows.width, rows: shortRows.height },
        wireKeys: false,
        run: "idle",
      });
      try {
        await settle(h);
        const frame = h.captureCharFrame();
        expect(frame).not.toContain(LANDING_VERSION);
        expect(frame).toContain("message");
      } finally {
        shell.dispose();
      }
    }, shortRows);
  });

  test("the task panel and the version badge both paint while landing is still mounted, without clipping the prompt", async () => {
    // A resumed session can land with tasks already visible while the
    // landing screen has not been torn down yet (no transcript content sent)
    // — restored chrome and the version badge's reserved row both compete
    // for the same short terminal at once. This is the regression case for
    // that interaction (CL-5735/5736 review, blocker 4).
    const size = { width: 100, height: 17 };
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: size.width, rows: size.height },
        wireKeys: false,
        run: "idle",
      });
      try {
        setChromeZones(shell, {
          task: [{ label: "wire the version badge", status: "doing" }],
        });
        // CL-5847: hidden by default — opt in so the regression case (task
        // row + version badge competing for the same short terminal) still
        // exercises both painting at once.
        toggleTasksPanel(shell);
        await settle(h);

        expect(isLanding(shell)).toBe(true);
        expect(shell.taskBox.visible).toBe(true);

        const painted = rows(h);
        // captureCharFrame's trailing newline yields one extra split entry.
        expect(painted.length).toBe(size.height + 1);
        // Nothing is clipped off past the terminal's own row count — the
        // frame is exactly as tall as the terminal, not taller.
        expect(painted.slice(size.height).every((row) => row === "")).toBe(true);

        const frame = painted.join("\n");
        expect(frame).toContain("wire the version badge");
        expect(frame).toContain(LANDING_VERSION);
        // The prompt field itself is on screen, intact, not pushed off by
        // the combination of the task row and the version row.
        const promptRow = painted.findIndex((row) => row.includes("message"));
        expect(promptRow).toBeGreaterThan(0);
        const box = shell.layout.regions.prompt;
        expect(box).toBeDefined();
        expect(box!.y + box!.height).toBeLessThanOrEqual(size.height);
      } finally {
        shell.dispose();
      }
    }, size);
  });

  test("the version never appears inside the hero block beside the mark/hints", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: SIZE.width, rows: SIZE.height },
        wireKeys: false,
        run: "idle",
      });
      try {
        await settle(h);
        const painted = rows(h);
        const heroEnd = painted.findIndex((row) => /[┌╭]/.test(row));
        expect(heroEnd).toBeGreaterThan(0);
        // Nothing above the box's own top border carries the version — the
        // hero (mark + hint doors) is exactly the two lines, no third.
        for (const row of painted.slice(0, heroEnd)) {
          expect(row).not.toContain(LANDING_VERSION);
        }
      } finally {
        shell.dispose();
      }
    }, SIZE);
  });
});
