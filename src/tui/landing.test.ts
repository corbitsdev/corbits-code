/** Landing anatomy: mark, centred prompt box, telemetry disclosure,
 * starters — gone once the transcript has content. */
import { afterEach, describe, expect, test } from "bun:test";
import type { CapturedSpan } from "@opentui/core";
import { rgbToHex } from "@opentui/core";
import { defined } from "../../testkit/defined.js";
import { makePermissionItems, type Harness } from "./harness";
import {
  appendStreamRow,
  applyLandingSuggestion,
  LANDING_IDLE_REPAINT_INTERVAL_MS,
  noticeText,
  paintChrome,
  setChromeZones,
  setPluginNeedsAttention,
  paintLanding,
  toggleTasksPanel,
} from "./shell/chrome";
import { withAppShell } from "./test-helpers";
import { isLanding } from "./shell/internals";
import {
  setPromptModelLabel,
  setPromptWorkspace,
  surfaceSystemNotice,
} from "./shell/prompt";
import { streamRowCount } from "./shell/transcript";
import { openPermissionsOverlay } from "./overlays";
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
import { MARK_LARGE, MARK_MID, MARK_SMALL } from "./mark-shape";
import { SNOW_CHAR } from "./mark-anim";

const SIZE = { width: 80, height: 24 } as const;
const NOTICE = "Anonymous usage telemetry is enabled. Disable in /settings.";

const nativeSetInterval = globalThis.setInterval;
const nativeClearInterval = globalThis.clearInterval;

const stripSnow = (text: string) => text.replaceAll(SNOW_CHAR, " ");

interface IdleTimerHandle {
  unref?: () => void;
}

/** Intercepts the idle interval so tests can see a still-armed timer
 * regardless of cadence. */
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
  globalThis.clearInterval = ((
    handle: Parameters<typeof nativeClearInterval>[0],
  ) => {
    cleared.push(handle as IdleTimerHandle);
    if (armed.includes(handle as IdleTimerHandle)) return;
    return nativeClearInterval.call(globalThis, handle);
  }) as typeof nativeClearInterval;
  return { armed, cleared };
}

function soleLandingIdleHandle(
  armed: readonly IdleTimerHandle[],
): IdleTimerHandle {
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
  return rows(h).filter(
    (row) => /[░▒▓█▁▂▃▄▅▆▇]/.test(row) && !row.includes(LOCKUP_WORDMARK),
  );
}

describe("landing layout math", () => {
  test("splits the transcript zone evenly around the prompt box", () => {
    expect(splitLandingRows(19)).toEqual({ above: 9, below: 10 });
    expect(splitLandingRows(0)).toEqual({ above: 0, below: 0 });
    expect(splitLandingRows(-4)).toEqual({ above: 0, below: 0 });
  });

  test("wraps on words without breaking them", () => {
    expect(wrapLanding("one two three four", 9)).toEqual([
      "one two",
      "three",
      "four",
    ]);
    expect(wrapLanding("supercalifragilistic", 4)).toEqual([
      "supercalifragilistic",
    ]);
  });

  test("the disclosure outranks the starters when rows are scarce", () => {
    const full = landingBelowContent({
      rows: 10,
      columns: 78,
      telemetryNotice: NOTICE,
    });
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
    expect(text.some((line) => line.includes("telemetry"))).toBe(false);
  });

  test("the mark degrades through its tiers and then disappears", () => {
    // Roomy: only the hero reads unambiguously.
    expect(resolveMarkGrid(20, 120)).toBe(MARK_LARGE);
    // A row short of the hero: a tier down, not a clipped hero.
    expect(resolveMarkGrid(12, 120)).toBe(MARK_MID);
    expect(resolveMarkGrid(9, 120)).toBe(MARK_SMALL);
    // 80-column terminal: 78 columns after gutters; the compact mark still
    // seats beside the doors.
    expect(resolveMarkGrid(20, 78)).toBe(MARK_SMALL);
    // Narrow enough that the mark would crowd the hints: the hints win.
    expect(resolveMarkGrid(20, 50)).toBeNull();
    expect(resolveMarkGrid(20, 30)).toBeNull();
    expect(resolveMarkGrid(3, 96)).toBeNull();
  });

  test("a key with no starter selects nothing", () => {
    expect(landingSuggestionFor("z")).toBeNull();
  });
});

describe("landing screen", () => {
  test("centres the prompt box between the mark and the disclosure", async () => {
    await withAppShell(
      async (_shell, h) => {
        await settle(h);
        const painted = rows(h);
        // The prompt border glyphs are the box's business; only position is
        // asserted.
        const top = painted.findIndex((row) => /[┌╭]/.test(row));
        const bottom = painted.findIndex((row) => /[└╰]/.test(row));
        expect(top).toBeGreaterThan(0);
        // The box straddles the terminal's middle row.
        expect(
          Math.abs((top + bottom) / 2 - (SIZE.height - 1) / 2),
        ).toBeLessThanOrEqual(1);

        // Mark above, bottom-anchored against the box; disclosure below it.
        const mark = markRows(h);
        // Whichever tier this terminal seats, the mark is whole; a clipped
        // grid reads as a different shape.
        expect([MARK_LARGE, MARK_MID, MARK_SMALL].map((g) => g.rows)).toContain(
          mark.length,
        );
        expect(painted.indexOf(mark.at(-1) as string)).toBeLessThan(top);
        // The doors sit beside the mark, and their descriptions share one
        // column.
        const descriptionColumns = new Set<number>();
        for (const hint of LANDING_HINTS) {
          const row = painted.find((line) => line.includes(hint.rest));
          expect(row).toBeDefined();
          expect(row).toContain(hint.key);
          expect(defined(row).indexOf(hint.key)).toBeGreaterThan(0);
          descriptionColumns.add(defined(row).indexOf(hint.rest));
        }
        expect(descriptionColumns.size).toBe(1);
        // The version is chrome, not hero: it never shares a row with a hint.
        for (const hint of LANDING_HINTS) {
          const row = painted.find((line) => line.includes(hint.rest));
          expect(row).not.toContain(LANDING_VERSION);
        }
        const versionRow = painted.findIndex((row) =>
          row.includes(LANDING_VERSION),
        );
        expect(versionRow).toBeGreaterThanOrEqual(0);
        // Bottom-right: on the last content row, not under the hints.
        expect(versionRow).toBeGreaterThanOrEqual(SIZE.height - 2);
        const versionCol = defined(painted[versionRow]).lastIndexOf(
          LANDING_VERSION,
        );
        expect(versionCol + LANDING_VERSION.length).toBeGreaterThan(
          SIZE.width - 4,
        );
        const noticeRow = painted.findIndex((row) => row.includes("telemetry"));
        expect(noticeRow).toBeGreaterThan(bottom);
        for (const item of LANDING_SUGGESTIONS) {
          expect(h.captureCharFrame()).toContain(item.label);
        }
      },
      {
        shell: {
          title: "corbits",
          run: "idle",
          telemetryNotice: NOTICE,
        },
      },
    );
  });

  test("the mark advances off an injected clock while a turn runs", async () => {
    await withAppShell(
      async (shell, h) => {
        await settle(h);
        const still = markRows(h).join("\n");

        // Idle holds the filled frame at any clock; the snow still drifts.
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
      },
      {
        shell: {
          run: "idle",
        },
      },
    );
  });

  test("an idle mount keeps the snow drifting on its own, with nothing pumping frames by hand", async () => {
    // Regression: hand-pumped tests drove the mark — how frozen snow shipped.
    // Mount the shell for real so the self-driver has to work.
    await withAppShell(
      async (_shell, h) => {
        await settle(h);
        const before = markRows(h).join("\n");

        // Poll until the idle timer moves the snow or a deadline passes; a
        // fixed sleep races the timer under CI load.
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
      },
      {
        shell: {
          run: "idle",
        },
      },
    );
  }, 15_000);

  describe("landing idle timer", () => {
    afterEach(() => {
      globalThis.setInterval = nativeSetInterval;
      globalThis.clearInterval = nativeClearInterval;
    });

    test("reduced-motion mount never arms the idle timer and never draws snow", async () => {
      const { armed } = wrapLandingIdleTimer();
      await withAppShell(
        async (shell, h) => {
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
        },
        {
          shell: {
            run: "idle",
            reducedMotion: true,
          },
        },
      );
    });

    test("a deferred system notice does not clear the landing idle timer", async () => {
      const { armed, cleared } = wrapLandingIdleTimer();
      await withAppShell(
        async (shell) => {
          const handle = soleLandingIdleHandle(armed);
          surfaceSystemNotice(
            shell,
            "mcp github did not connect (ECONNREFUSED) — its tools are unavailable; /mcp for detail",
          );
          expect(isLanding(shell)).toBe(true);
          expect(cleared).not.toContain(handle);
        },
        {
          shell: {
            run: "idle",
          },
        },
      );
    });

    test("appending a transcript row clears the landing idle timer", async () => {
      const { armed, cleared } = wrapLandingIdleTimer();
      await withAppShell(
        async (shell) => {
          const handle = soleLandingIdleHandle(armed);
          appendStreamRow(shell, { role: "user", text: "first prompt" });
          expect(isLanding(shell)).toBe(false);
          expect(cleared).toContain(handle);
        },
        {
          shell: {
            run: "idle",
          },
        },
      );
    });

    test("disposing the shell with no transcript clears the landing idle timer", async () => {
      const { armed, cleared } = wrapLandingIdleTimer();
      await withAppShell(
        async (shell) => {
          const handle = soleLandingIdleHandle(armed);
          shell.dispose();
          expect(cleared).toContain(handle);
        },
        {
          shell: {
            run: "idle",
          },
        },
      );
    });
  });

  test("a starter key fills the prompt; a typed prompt keeps its digits", async () => {
    await withAppShell(
      async (shell, h) => {
        await settle(h);
        const first = defined(LANDING_SUGGESTIONS[0]);
        expect(applyLandingSuggestion(shell, first.key)).toBe(true);
        expect(shell.prompt.value).toBe(first.prompt);

        // Already typed: the key is a character, not a shortcut.
        expect(applyLandingSuggestion(shell, first.key)).toBe(false);
      },
      {
        shell: {
          run: "idle",
        },
      },
    );
  });

  test("the starters withdraw while the prompt has text", async () => {
    await withAppShell(
      async (shell, h) => {
        await settle(h);
        const first = defined(LANDING_SUGGESTIONS[0]);
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
      },
      {
        shell: {
          telemetryNotice: NOTICE,
        },
      },
    );
  });

  test("a narrow rule drops the lockup and keeps the workspace", async () => {
    await withAppShell(
      async (shell, h) => {
        setPromptWorkspace(shell, { branch: "migration/opentui-tui" });
        await settle(h);
        const frame = h.captureCharFrame();
        // The workspace is information and the mark is not: the mark goes.
        expect(frame).not.toContain(LOCKUP_WORDMARK);
        expect(frame).toContain("(migration/opentui-tui) ─╯");
      },
      {
        width: 34,
        height: 20,
        shell: {
          cwd: "/src/corbits-code",
        },
      },
    );
  });

  test("an overlay covers the landing, sliding it only as far as its content needs", async () => {
    await withAppShell(
      async (shell, h) => {
        await settle(h);
        const before = rows(h);
        const anchors = [
          "message",
          "telemetry",
          defined(LANDING_SUGGESTIONS[0]).label,
        ];
        const was = anchors.map((text) =>
          before.findIndex((row) => row.includes(text)),
        );
        expect(was.every((index) => index > 0)).toBe(true);
        // Anchors listed top to bottom: their positions climb together
        // before the overlay opens.
        expect(was).toEqual([...was].sort((a, b) => a - b));

        // Heavy inset overlay: many choices plus a multi-line body, so the
        // float must take real headroom from the landing split.
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
        // Anchors stay on screen in the same order; the overlay may still
        // re-grid the mark for its content height.
        const nowAt = anchors.map((text) =>
          after.findIndex((row) => row.includes(text)),
        );
        expect(nowAt.every((index) => index > 0)).toBe(true);
        expect(nowAt).toEqual([...nowAt].sort((a, b) => a - b));
        expect(new Set(nowAt).size).toBe(nowAt.length);
        // Real geometry pressure: the prompt field moves so the inset can
        // claim rows.
        expect(nowAt[0]).not.toBe(was[0]);
        expect(h.captureCharFrame()).toContain("Esc cancel");
      },
      {
        width: 100,
        height: 30,
        shell: {
          run: "idle",
          telemetryNotice: NOTICE,
        },
      },
    );
  });

  // Regression: an inset list taller than the even split used to starve to a
  // row or two; the float now asks for the overlay's real height.
  test("a landing overlay with many choices shows them all when there is room", async () => {
    await withAppShell(
      async (shell, h) => {
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
      },
      {
        width: 100,
        height: 48,
        shell: {
          run: "idle",
        },
      },
    );
  });

  test("a short or narrow terminal shrinks the mark, never the prompt box", async () => {
    for (const size of [
      { width: 100, height: 30 },
      { width: 80, height: 24 },
      { width: 60, height: 20 },
    ]) {
      await withAppShell(
        async (_shell, h) => {
          await settle(h);
          const painted = rows(h);
          // The prompt field is on screen at every size, and the mark fits
          // above it rather than overrunning it.
          const field = painted.findIndex((row) => row.includes("message"));
          expect(field).toBeGreaterThan(0);
          expect(field).toBeLessThan(size.height);
          expect(markRows(h).length).toBeLessThan(field);
          expect(h.captureCharFrame()).toContain(
            defined(LANDING_HINTS[0]).rest,
          );
        },
        {
          ...size,
          shell: {
            run: "idle",
            telemetryNotice: NOTICE,
          },
        },
      );
    }
  });

  test("no titlebar, status strip or counter row survives", async () => {
    await withAppShell(
      async (shell, h) => {
        await settle(h);
        // A bare landing seats exactly two zones; resurrected chrome would be
        // a new region.
        expect(Object.keys(shell.layout.regions).sort()).toEqual([
          "prompt",
          "transcript",
        ]);
        // Every painted span shares one background, so no chrome fill
        // survives.
        expect(new Set(backgrounds(h)).size).toBe(1);
      },
      {
        shell: {
          run: "idle",
        },
      },
    );
  });

  test("the landing is dropped once the transcript has content", async () => {
    await withAppShell(
      async (shell, h) => {
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
        expect(painted.findIndex((row) => /[└╰]/.test(row))).toBeGreaterThan(
          SIZE.height - 4,
        );
      },
      {
        shell: {
          telemetryNotice: NOTICE,
        },
      },
    );
  });

  test("startup MCP/load errors keep the mountain and ride the notice strip", async () => {
    // Load-time notices used to wipe the brand hero via appendStreamRow; they
    // surface as secondary chrome instead.
    await withAppShell(
      async (shell, h) => {
        await settle(h);
        expect(isLanding(shell)).toBe(true);
        const before = markRows(h);
        expect([MARK_LARGE, MARK_MID, MARK_SMALL].map((g) => g.rows)).toContain(
          before.length,
        );

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
        expect([MARK_LARGE, MARK_MID, MARK_SMALL].map((g) => g.rows)).toContain(
          after.length,
        );

        // A real session row still ends the landing; deferred notices become
        // durable transcript rows.
        appendStreamRow(shell, { role: "user", text: "first prompt" });
        await settle(h);
        expect(isLanding(shell)).toBe(false);
        expect(markRows(h)).toEqual([]);
        const frame = h.captureCharFrame();
        expect(frame).toContain("first prompt");
        expect(frame).toContain("mcp github did not connect");
      },
      {
        shell: {
          run: "idle",
        },
      },
    );
  });

  test("startup plugin diagnostics keep the mountain and ride plugin !", async () => {
    // Plugin warnings drive the standing `plugin !` mark, not
    // surfaceSystemNotice; the mountain stays up while it is painted.
    await withAppShell(
      async (shell, h) => {
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
      },
      {
        shell: {
          run: "idle",
        },
      },
    );
  });

  test("a flushed startup notice never carries a plumbing gutter label", async () => {
    // The transcript never labels a row "command": the row text says what it
    // is, and the meta column is the operator's.
    await withAppShell(
      async (shell, h) => {
        await settle(h);
        surfaceSystemNotice(
          shell,
          "mcp github did not connect (ECONNREFUSED) — its tools are unavailable; /mcp for detail",
        );
        appendStreamRow(shell, { role: "user", text: "first prompt" });
        await settle(h);

        expect(isLanding(shell)).toBe(false);
        // Assert on the flushed notice rows, not the full frame: a cwd or
        // worktree path containing "overlay"/"command" would false-positive.
        const noticeNeedle = "mcp github did not connect";
        const noticeRows = shell.streamLog.filter((row) =>
          row.text.includes(noticeNeedle),
        );
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
      },
      {
        shell: {
          run: "idle",
        },
      },
    );
  });

  test("the version is chrome, not the hero: it hides before actionable chrome does on a narrow terminal", async () => {
    // Above the badge's thresholds, below nothing else: the badge degrades
    // first.
    const roomy = {
      width: VERSION_BADGE_MIN_COLUMNS + 20,
      height: VERSION_BADGE_MIN_ROWS + 8,
    };
    await withAppShell(
      async (_shell, h) => {
        await settle(h);
        expect(h.captureCharFrame()).toContain(LANDING_VERSION);
      },
      {
        ...roomy,
        shell: {
          run: "idle",
        },
      },
    );

    // Just under the badge's column floor: the badge is gone, the prompt
    // field stays.
    const narrowColumns = {
      width: VERSION_BADGE_MIN_COLUMNS - 1,
      height: VERSION_BADGE_MIN_ROWS + 8,
    };
    expect(versionBadgeVisible(narrowColumns.width, narrowColumns.height)).toBe(
      false,
    );
    await withAppShell(
      async (_shell, h) => {
        await settle(h);
        const frame = h.captureCharFrame();
        expect(frame).not.toContain(LANDING_VERSION);
        expect(frame).toContain("message");
      },
      {
        ...narrowColumns,
        shell: {
          run: "idle",
        },
      },
    );

    // Just under the badge's row floor: same story, short rather than narrow.
    const shortRows = {
      width: VERSION_BADGE_MIN_COLUMNS + 20,
      height: VERSION_BADGE_MIN_ROWS - 1,
    };
    expect(versionBadgeVisible(shortRows.width, shortRows.height)).toBe(false);
    await withAppShell(
      async (_shell, h) => {
        await settle(h);
        const frame = h.captureCharFrame();
        expect(frame).not.toContain(LANDING_VERSION);
        expect(frame).toContain("message");
      },
      {
        ...shortRows,
        shell: {
          run: "idle",
        },
      },
    );
  });

  test("the task panel and the version badge both paint while landing is still mounted, without clipping the prompt", async () => {
    // A resumed session can land with tasks visible before teardown; chrome
    // and the badge row compete on a short terminal.
    const size = { width: 100, height: 17 };
    await withAppShell(
      async (shell, h) => {
        setChromeZones(shell, {
          task: [{ label: "wire the version badge", status: "doing" }],
        });
        // Hidden by default; opt in so the regression exercises both at once.
        toggleTasksPanel(shell);
        await settle(h);

        expect(isLanding(shell)).toBe(true);
        expect(shell.taskBox.visible).toBe(true);

        const painted = rows(h);
        // captureCharFrame's trailing newline yields one extra split entry.
        expect(painted.length).toBe(size.height + 1);
        // The frame is exactly as tall as the terminal, not taller.
        expect(painted.slice(size.height).every((row) => row === "")).toBe(
          true,
        );

        const frame = painted.join("\n");
        expect(frame).toContain("wire the version badge");
        expect(frame).toContain(LANDING_VERSION);
        // The prompt field stays on screen, not pushed off by the task and
        // version rows.
        const promptRow = painted.findIndex((row) => row.includes("message"));
        expect(promptRow).toBeGreaterThan(0);
        const box = defined(shell.layout.regions.prompt);
        expect(box.y + box.height).toBeLessThanOrEqual(size.height);
      },
      {
        ...size,
        shell: {
          run: "idle",
        },
      },
    );
  });
});
