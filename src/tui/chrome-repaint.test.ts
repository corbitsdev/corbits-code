/**
 * Chrome repaint gating (CL-6791 J2): paintChrome recomposes only when a
 * composed input changed, so idle poll ticks cost nothing.
 */
import { describe, expect, test } from "bun:test";
import { withTestRenderer } from "./harness";
import { chromeComposeCount, paintChrome, setLockupFrame, setStatusFlash } from "./shell/chrome";
import { createAppShell } from "./shell/index";
import type { AppShell } from "./shell/internals";

async function withShell(fn: (shell: AppShell) => void, columns = 80): Promise<void> {
  await withTestRenderer(
    async (h) => {
      const shell = createAppShell(h.renderer, {
        title: "test",
        cwd: "/src/corbits-code",
        terminal: { columns, rows: 24 },
        wireKeys: false,
      });
      try {
        fn(shell);
      } finally {
        shell.dispose();
      }
    },
    { width: columns, height: 24 },
  );
}

describe("chrome repaint gate", () => {
  test("idle ticks do not recompose", async () => {
    await withShell((shell) => {
      paintChrome(shell);
      const baseline = chromeComposeCount(shell);
      // What stickyPoll does every 200ms while fully idle.
      for (let tick = 0; tick < 10; tick++) paintChrome(shell);
      expect(chromeComposeCount(shell)).toBe(baseline);
    });
  });

  test("flipping each composed input individually recomposes exactly once", async () => {
    await withShell((shell) => {
      paintChrome(shell);
      const baseline = chromeComposeCount(shell);

      // Notice text (status flash feeds the notice row). The extra recompose
      // is the notice row appearing: visibility flips trigger a relayout whose
      // trailing chrome pass is forced by design.
      setStatusFlash(shell, "hold on");
      paintChrome(shell);
      const afterNotice = chromeComposeCount(shell);
      expect(afterNotice).toBeGreaterThan(baseline);

      // Workspace label.
      shell.workspace = { ...shell.workspace, branch: "feature/x" };
      paintChrome(shell);
      expect(chromeComposeCount(shell)).toBe(afterNotice + 1);

      // Border column budget.
      shell.layout = { ...shell.layout, contentWidth: 60 };
      paintChrome(shell);
      expect(chromeComposeCount(shell)).toBe(afterNotice + 2);

      // Lockup frame state.
      setLockupFrame(shell, {
        nowMs: 5_000,
        animating: true,
        phase: "working",
        rampPhase: null,
        stalledForMs: null,
      });
      expect(chromeComposeCount(shell)).toBe(afterNotice + 3);
      paintChrome(shell);
      expect(chromeComposeCount(shell)).toBe(afterNotice + 3);
    });
  });

  test("animating lockup frames recompose per frame", async () => {
    await withShell((shell) => {
      paintChrome(shell);
      const baseline = chromeComposeCount(shell);
      for (let frame = 0; frame < 3; frame++) {
        setLockupFrame(shell, {
          nowMs: 10_000 + frame * 80,
          animating: true,
          phase: "working",
          rampPhase: null,
          stalledForMs: null,
        });
      }
      expect(chromeComposeCount(shell)).toBe(baseline + 3);
    });
  });

  test("forced repaint recomposes despite an unchanged tuple", async () => {
    await withShell((shell) => {
      paintChrome(shell);
      const baseline = chromeComposeCount(shell);
      paintChrome(shell, { force: true });
      paintChrome(shell, { force: true });
      expect(chromeComposeCount(shell)).toBe(baseline + 2);
      // And the gate still holds afterwards.
      paintChrome(shell);
      expect(chromeComposeCount(shell)).toBe(baseline + 2);
    });
  });
});
