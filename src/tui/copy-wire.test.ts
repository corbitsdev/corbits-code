import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CliRenderEvents } from "@opentui/core";
import { createHarness, type Harness } from "./harness";
import {
  appendStreamRow,
  confirmCopySelection,
  copyAllTargets,
  createAppShell,
  enterCopyMode,
  toggleMouseCapture,
} from "./shell";
import { createRecordingClipboard } from "./copy-path";

// One renderer for the whole file: harness renderers are a scarce native
// resource and the suite exhausts them when every test claims its own.
let harness: Harness;

beforeAll(async () => {
  harness = await createHarness({ width: 100, height: 30 });
});

afterAll(() => {
  harness.destroy();
});

describe("Alt+C reaches the injected clipboard", () => {
  test("confirming a copy target writes its text", () => {
    const clipboard = createRecordingClipboard();
    const shell = createAppShell(harness.renderer, { clipboard });
    appendStreamRow(shell, { role: "assistant", text: "copy me" });
    expect(enterCopyMode(shell)).toBe(true);
    expect(confirmCopySelection(shell)).toBe(true);
    expect(clipboard.writes).toEqual(["copy me"]);
    shell.dispose();
  });

  test("copy all writes every non-system row", () => {
    const clipboard = createRecordingClipboard();
    const shell = createAppShell(harness.renderer, { clipboard });
    appendStreamRow(shell, { role: "user", text: "one" });
    appendStreamRow(shell, { role: "assistant", text: "two" });
    enterCopyMode(shell);
    expect(copyAllTargets(shell)).toBe(true);
    expect(clipboard.writes).toHaveLength(1);
    expect(clipboard.writes[0]).toContain("one");
    expect(clipboard.writes[0]).toContain("two");
    shell.dispose();
  });
});

describe("drag-select auto-copy", () => {
  test("SELECTION event writes finished text and flashes", () => {
    const clipboard = createRecordingClipboard();
    const shell = createAppShell(harness.renderer, { clipboard });
    harness.renderer.emit(CliRenderEvents.SELECTION, {
      isDragging: false,
      getSelectedText: () => "dragged snippet",
    });
    expect(clipboard.writes).toEqual(["dragged snippet"]);
    expect(shell.statusFlash).toContain("Copied 15 chars");
    expect(shell.statusFlash).toContain("dragged snippet");
    shell.dispose();
  });

  test("SELECTION while dragging is a no-op", () => {
    const clipboard = createRecordingClipboard();
    const shell = createAppShell(harness.renderer, { clipboard });
    harness.renderer.emit(CliRenderEvents.SELECTION, {
      isDragging: true,
      getSelectedText: () => "partial",
    });
    expect(clipboard.writes).toEqual([]);
    expect(shell.statusFlash).toBeNull();
    shell.dispose();
  });

  test("empty SELECTION is a no-op", () => {
    const clipboard = createRecordingClipboard();
    const shell = createAppShell(harness.renderer, { clipboard });
    harness.renderer.emit(CliRenderEvents.SELECTION, {
      isDragging: false,
      getSelectedText: () => "",
    });
    expect(clipboard.writes).toEqual([]);
    shell.dispose();
  });
});

describe("Alt+M mouse capture", () => {
  test("toggles the host port and reports the new state", () => {
    let enabled = false;
    const shell = createAppShell(harness.renderer, {
      mouseCapture: {
        get: () => enabled,
        set: (v) => {
          enabled = v;
        },
      },
    });
    expect(toggleMouseCapture(shell)).toBe(true);
    expect(enabled).toBe(true);
    expect(shell.statusFlash).toContain("drag text to copy");
    expect(toggleMouseCapture(shell)).toBe(false);
    expect(enabled).toBe(false);
    shell.dispose();
  });

  test("reports unavailable when the host exposes no control", () => {
    const shell = createAppShell(harness.renderer);
    expect(toggleMouseCapture(shell)).toBeNull();
    expect(shell.statusFlash).toContain("not controllable");
    shell.dispose();
  });
});
