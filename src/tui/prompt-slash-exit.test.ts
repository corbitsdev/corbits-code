/**
 * Integration: `/` command popup and the double Ctrl+C exit, both driven
 * through the wired key path on a headless shell.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { withTestRenderer } from "./harness";
import type { PaletteCommand } from "./command-catalog";
import type { PendingImageAttachment } from "./image-attachments.js";
import {
  CTRL_C_EXIT_WINDOW_MS,
  addPendingAttachment,
  clearPendingAttachments,
  createAppShell,
  handleCtrlC,
  isSlashPopupOpen,
  noticeText,
  setShellExitHandler,
  setShellRunState,
  setStatusFlash,
  type AppShell,
} from "./shell";
import { RUNTIME_FLASH_MS } from "./runtime-notices";

const CATALOG: readonly PaletteCommand[] = [
  {
    id: "model",
    label: "/model",
    description: "Open model picker",
    keywords: ["model", "Open model picker", "slash", "command"],
  },
  { id: "mcp", label: "/mcp" },
  { id: "compact", label: "/compact" },
];

interface Ctx {
  readonly shell: AppShell;
  readonly dispatched: string[];
  readonly press: (key: string) => void;
  readonly render: () => Promise<void>;
  readonly frame: () => string;
}

function withShell(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  return withTestRenderer(
    async (h) => {
      const dispatched: string[] = [];
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        wireKeys: true,
        run: "idle",
        paletteCatalog: CATALOG,
        onCommand: (name) => dispatched.push(name),
      });
      try {
        await fn({
          shell,
          dispatched,
          press: (key) => h.pressKey(key as Parameters<typeof h.pressKey>[0]),
          render: h.renderOnce,
          frame: () => h.captureCharFrame(),
        });
      } finally {
        shell.dispose();
      }
    },
    { width: 80, height: 24 },
  );
}

describe("slash command popup", () => {
  test("typing / at an empty prompt opens the command list", async () => {
    await withShell(async ({ shell, press, render }) => {
      press("/");
      await render();
      expect(shell.prompt.value).toBe("/");
      expect(shell.overlayKind).toBe("palette");
      expect(isSlashPopupOpen(shell)).toBe(true);
      expect(shell.paletteCommands).toHaveLength(CATALOG.length);
    });
  });

  test("further characters filter the list", async () => {
    await withShell(async ({ shell, press }) => {
      press("/");
      press("m");
      expect(shell.prompt.value).toBe("/m");
      expect(shell.paletteCommands.map((c) => c.id)).toEqual(["model", "mcp"]);
      press("o");
      expect(shell.prompt.value).toBe("/mo");
      expect(shell.paletteCommands.map((c) => c.id)).toEqual(["model"]);
    });
  });

  test("backspace widens the filter again", async () => {
    await withShell(async ({ shell, press }) => {
      press("/");
      press("m");
      press("o");
      press("Backspace");
      expect(shell.prompt.value).toBe("/m");
      expect(shell.paletteCommands.map((c) => c.id)).toEqual(["model", "mcp"]);
    });
  });

  test("Esc cancels and leaves the typed text intact", async () => {
    await withShell(async ({ shell, press, render }) => {
      press("/");
      press("m");
      press("Escape");
      // A bare ESC is held by the input parser until it cannot be a sequence.
      await render();
      await Bun.sleep(60);
      expect(isSlashPopupOpen(shell)).toBe(false);
      expect(shell.overlayList).toBeNull();
      expect(shell.prompt.value).toBe("/m");
    });
  });

  test("Enter dispatches through the registry command path", async () => {
    await withShell(async ({ shell, dispatched, press }) => {
      press("/");
      press("m");
      press("o");
      press("Enter");
      expect(dispatched).toEqual(["model"]);
      expect(shell.prompt.value).toBe("");
      expect(shell.overlayList).toBeNull();
    });
  });

  test("Tab completes the name so arguments can be typed", async () => {
    await withShell(async ({ shell, dispatched, press }) => {
      press("/");
      press("m");
      press("c");
      press("Tab");
      expect(dispatched).toEqual([]);
      expect(shell.prompt.value).toBe("/mcp ");
      expect(isSlashPopupOpen(shell)).toBe(false);
    });
  });

  test("a space closes the popup and keeps the prompt editable", async () => {
    await withShell(async ({ shell, press }) => {
      press("/");
      press("m");
      press("c");
      press("p");
      press(" ");
      expect(shell.prompt.value).toBe("/mcp ");
      expect(isSlashPopupOpen(shell)).toBe(false);
    });
  });

  test("/ mid-prompt is a literal character", async () => {
    await withShell(async ({ shell, press }) => {
      press("s");
      press("r");
      press("c");
      press("/");
      expect(isSlashPopupOpen(shell)).toBe(false);
      expect(shell.prompt.value).toBe("src/");
    });
  });

  test("an unmatched name prefix refreshes in place instead of closing", async () => {
    await withShell(async ({ shell, press, render, frame }) => {
      press("/");
      press("z");
      await render();
      // The popup was already open (from "/") when the filter zeroed out —
      // closing here would release the host, which is exactly the gap a
      // queued gate can drain into mid-filter. It stays owned and shows the
      // same "(no matches)" row the general palette uses.
      expect(isSlashPopupOpen(shell)).toBe(true);
      expect(shell.overlayList).not.toBeNull();
      expect(shell.prompt.value).toBe("/z");
      expect(shell.overlayItems).toEqual(["(no matches)"]);
      expect(frame()).toContain("(no matches)");

      // A backspace that restores a match refreshes back in place.
      press("Backspace");
      expect(isSlashPopupOpen(shell)).toBe(true);
      expect(shell.paletteCommands.map((c) => c.id)).toEqual(CATALOG.map((c) => c.id));
    });
  });

  test("description prose keeps the slash list open with no matches", async () => {
    await withShell(async ({ shell, press, render, frame }) => {
      press("/");
      press("p");
      await render();
      expect(isSlashPopupOpen(shell)).toBe(true);
      expect(shell.overlayList).not.toBeNull();
      expect(shell.prompt.value).toBe("/p");
      expect(shell.overlayItems).toEqual(["(no matches)"]);
      expect(frame()).toContain("(no matches)");
    });
  });
});

describe("Ctrl+C exit", () => {
  test("first press interrupts a busy run, second exits via the handler", async () => {
    await withShell(async ({ shell, press }) => {
      setShellRunState(shell, "busy");
      let exits = 0;
      setShellExitHandler(shell, () => {
        exits += 1;
      });
      press("Ctrl+C");
      expect(exits).toBe(0);
      expect(shell.session.run).not.toBe("busy");
      press("Ctrl+C");
      expect(exits).toBe(1);
    });
  });

  test("the exit notice clears itself when the arming window lapses", async () => {
    await withShell(async ({ shell }) => {
      const lapse: (() => void)[] = [];
      handleCtrlC(shell, 0, {
        schedule: (fn, ms) => {
          expect(ms).toBe(CTRL_C_EXIT_WINDOW_MS);
          lapse.push(fn);
          return () => {};
        },
      });
      expect(shell.statusFlash).toBe("press ctrl+c again to exit");
      expect(noticeText(shell)).toContain("press ctrl+c again to exit");

      lapse[0]?.();
      expect(shell.statusFlash).toBeNull();
      // The row has nothing left to say, so it is given back to the transcript.
      expect(noticeText(shell)).toBe("");
    });
  });

  test("a lapsed window never clears a flash set after it", async () => {
    await withShell(async ({ shell }) => {
      const lapse: (() => void)[] = [];
      handleCtrlC(shell, 0, {
        schedule: (fn) => {
          lapse.push(fn);
          return () => {};
        },
      });
      setStatusFlash(shell, "copied 3 lines", {
        ttlMs: RUNTIME_FLASH_MS,
        schedule: (fn) => {
          // Armed but not fired — the ctrl+c window must not clear it.
          return () => {
            void fn;
          };
        },
      });
      lapse[0]?.();
      expect(shell.statusFlash).toBe("copied 3 lines");
    });
  });

  test("a press outside the window re-arms instead of exiting", async () => {
    await withShell(async ({ shell }) => {
      let exits = 0;
      setShellExitHandler(shell, () => {
        exits += 1;
      });
      handleCtrlC(shell, 0);
      handleCtrlC(shell, CTRL_C_EXIT_WINDOW_MS + 1);
      expect(exits).toBe(0);
      handleCtrlC(shell, CTRL_C_EXIT_WINDOW_MS + 2);
      expect(exits).toBe(1);
    });
  });

  test("idle Ctrl+C with prompt text also drops pending attachments", async () => {
    await withShell(async ({ shell }) => {
      addPendingAttachment(shell, pendingImage("clip"));
      shell.prompt.value = "look at this";
      expect(noticeText(shell)).toContain("1 image");

      handleCtrlC(shell, 0);

      expect(shell.prompt.value).toBe("");
      expect(shell.pendingAttachments).toHaveLength(0);
      expect(noticeText(shell)).not.toContain("1 image");
    });
  });

  test("idle Ctrl+C with only attachments clears them and does not arm exit", async () => {
    await withShell(async ({ shell }) => {
      let exits = 0;
      setShellExitHandler(shell, () => {
        exits += 1;
      });
      addPendingAttachment(shell, pendingImage("clip"));
      expect(shell.prompt.value).toBe("");
      expect(noticeText(shell)).toContain("1 image");

      handleCtrlC(shell, 0);
      expect(shell.pendingAttachments).toHaveLength(0);
      expect(noticeText(shell)).not.toContain("1 image");
      expect(shell.statusFlash).not.toBe("press ctrl+c again to exit");
      expect(noticeText(shell)).not.toContain("press ctrl+c again to exit");
      expect(exits).toBe(0);

      handleCtrlC(shell, 1);
      expect(exits).toBe(0);
    });
  });

  test("busy Ctrl+C interrupts without dropping pending attachments", async () => {
    await withShell(async ({ shell }) => {
      setShellRunState(shell, "busy");
      addPendingAttachment(shell, pendingImage("clip"));

      handleCtrlC(shell, 0);

      expect(shell.pendingAttachments).toHaveLength(1);
      expect(shell.session.run).not.toBe("busy");
    });
  });

  test("clearPendingAttachments unlinks ephemeralPath and leaves the operator path", async () => {
    await withShell(async ({ shell }) => {
      const dir = mkdtempSync(join(tmpdir(), "ctrlc-attach-"));
      const ephemeral = join(dir, "ours.png");
      const operator = join(dir, "theirs.png");
      writeFileSync(ephemeral, "ephemeral-bytes");
      writeFileSync(operator, "operator-bytes");
      try {
        addPendingAttachment(shell, pendingImage("ours", { ephemeralPath: ephemeral }));
        addPendingAttachment(shell, pendingImage("theirs", { path: operator }));

        clearPendingAttachments(shell);

        expect(shell.pendingAttachments).toHaveLength(0);
        expect(existsSync(ephemeral)).toBe(false);
        expect(existsSync(operator)).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

function pendingImage(id: string, extra?: Partial<PendingImageAttachment>): PendingImageAttachment {
  return {
    id,
    name: `${id}.png`,
    contentType: "image/png",
    data: new Uint8Array([137, 80, 78, 71]),
    contentHash: `hash-${id}`,
    ...extra,
  };
}
