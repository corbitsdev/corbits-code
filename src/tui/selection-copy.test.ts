import { describe, expect, test } from "bun:test";
import { defined } from "../testkit/defined.js";
import { createRecordingClipboard } from "./copy-path.js";
import {
  copyFinishedSelection,
  type SelectionCopyHost,
} from "./selection-copy.js";

function host(): SelectionCopyHost & {
  readonly clipboard: ReturnType<typeof createRecordingClipboard>;
  flashes: string[];
  cleared: number;
} {
  const clipboard = createRecordingClipboard();
  const flashes: string[] = [];
  let cleared = 0;
  return {
    clipboard,
    flashes,
    get cleared() {
      return cleared;
    },
    flash: (text: string) => {
      flashes.push(text);
    },
    clearSelection: () => {
      cleared += 1;
    },
  };
}

describe("copyFinishedSelection", () => {
  test("writes selected text, flashes, and clears the highlight", () => {
    const h = host();
    const selected = "hello world";
    const ok = copyFinishedSelection(h, {
      isDragging: false,
      getSelectedText: () => selected,
    });
    expect(ok).toBe(true);
    expect(h.clipboard.writes).toEqual([selected]);
    expect(h.flashes).toHaveLength(1);
    expect(h.flashes[0]).toContain(String(selected.length));
    expect(h.flashes[0]).toContain(selected);
    expect(h.cleared).toBe(1);
  });

  test("skips while still dragging", () => {
    const h = host();
    const ok = copyFinishedSelection(h, {
      isDragging: true,
      getSelectedText: () => "partial",
    });
    expect(ok).toBe(false);
    expect(h.clipboard.writes).toEqual([]);
    expect(h.flashes).toEqual([]);
    expect(h.cleared).toBe(0);
  });

  test("skips empty selection", () => {
    const h = host();
    const ok = copyFinishedSelection(h, {
      isDragging: false,
      getSelectedText: () => "",
    });
    expect(ok).toBe(false);
    expect(h.clipboard.writes).toEqual([]);
    expect(h.cleared).toBe(0);
  });

  test("truncates long flash previews", () => {
    const h = host();
    const long = "x".repeat(80);
    copyFinishedSelection(h, {
      isDragging: false,
      getSelectedText: () => long,
    });
    expect(h.clipboard.writes).toEqual([long]);
    expect(h.flashes[0]).toContain("…");
    expect(defined(h.flashes[0]).length).toBeLessThan(long.length + 40);
  });

  test("collapses multi-line selections in the flash preview", () => {
    const h = host();
    const ok = copyFinishedSelection(h, {
      isDragging: false,
      getSelectedText: () => "ok\ngo",
    });
    expect(ok).toBe(true);
    expect(h.clipboard.writes).toEqual(["ok\ngo"]);
    expect(h.flashes[0]).toContain("ok go");
    expect(h.flashes[0]).not.toContain("\n");
  });

  test("clears highlight immediately while write is still pending", async () => {
    let resolveWrite: () => void = () => undefined;
    const writeP = new Promise<void>((r) => {
      resolveWrite = r;
    });
    const flashes: string[] = [];
    let cleared = 0;
    const ok = copyFinishedSelection(
      {
        clipboard: {
          writeText: () => writeP,
        },
        flash: (text: string) => {
          flashes.push(text);
        },
        clearSelection: () => {
          cleared += 1;
        },
      },
      {
        isDragging: false,
        getSelectedText: () => "pending",
      },
    );
    expect(ok).toBe(true);
    expect(cleared).toBe(1);
    expect(flashes).toEqual([]);
    resolveWrite();
    await writeP;
    await Promise.resolve();
    expect(flashes[0]).toContain(String("pending".length));
    expect(cleared).toBe(1);
  });

  test("flashes a failure after clear when write rejects", async () => {
    const flashes: string[] = [];
    let cleared = 0;
    const ok = copyFinishedSelection(
      {
        clipboard: {
          writeText: () => Promise.reject(new Error("no clipboard")),
        },
        flash: (text: string) => {
          flashes.push(text);
        },
        clearSelection: () => {
          cleared += 1;
        },
      },
      {
        isDragging: false,
        getSelectedText: () => "secret",
      },
    );
    expect(ok).toBe(true);
    expect(cleared).toBe(1);
    expect(flashes).toEqual([]);
    await Promise.resolve();
    await Promise.resolve();
    expect(flashes).toHaveLength(1);
    expect(cleared).toBe(1);
  });

  test("flashes a failure when write throws synchronously", () => {
    const flashes: string[] = [];
    let cleared = 0;
    const ok = copyFinishedSelection(
      {
        clipboard: {
          writeText: () => {
            throw new Error("no clipboard");
          },
        },
        flash: (text: string) => {
          flashes.push(text);
        },
        clearSelection: () => {
          cleared += 1;
        },
      },
      {
        isDragging: false,
        getSelectedText: () => "secret",
      },
    );
    expect(ok).toBe(true);
    expect(cleared).toBe(1);
    expect(flashes).toHaveLength(1);
  });
});
