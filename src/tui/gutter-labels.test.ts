/**
 * The transcript never labels a row with the machinery that produced it.
 * Adding a painted chrome label means editing this list on purpose.
 */
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { withTestRenderer } from "./harness.js";
import type { PrimaryOverlayKind } from "./overlays.js";
import {
  makePermissionItems,
  openModelPickerOverlay,
  openOperatorOverlay,
  openPermissionsOverlay,
} from "./overlays.js";
import { acceptOverlaySelection, createAppShell, type AppShell } from "./shell.js";
import { streamRowGutter, type RowLayout } from "./stream.js";

const OVERLAY_KIND_GUTTER = {
  permissions: "permissions",
  operator: "operator",
  model_picker: "model picker",
  add_provider: "add provider",
  demo: "demo",
  palette: "palette",
  settings: "settings",
  help: "help",
  plugins: "plugins",
  resume: "resume",
  mentions: "mentions",
  copy: "copy",
  hooks: "hooks",
  mcp: "mcp",
  plugin_credentials: "plugin credentials",
} as const satisfies Record<PrimaryOverlayKind, string>;

const CHROME_LITERALS = ["error", "plan", "report", "stop", "observe"] as const;

const PERMITTED_CHROME_GUTTER_LABELS = [...CHROME_LITERALS, ...Object.values(OVERLAY_KIND_GUTTER)];

const STORED_NOT_GUTTER = [
  "thinking",
  "steer",
  "queue",
  "steering",
  "following-up",
  "reinject",
  "cancelled",
];

const FORBIDDEN = ["permission", "command", "overlay"];

const LAYOUT: RowLayout = { width: 80, multiAgent: false };

const IMMEDIATE_META = /meta:\s*["']([^"']+)["']/g;
const TERNARY_META = /meta:\s*[^,\n]+\?\s*["']([^"']+)["']\s*:\s*["']([^"']+)["']/g;

function sortedSet(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

async function assertEchoRecap(open: (shell: AppShell) => void, word: string): Promise<void> {
  await withTestRenderer(
    async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        wireKeys: false,
      });
      try {
        open(shell);
        acceptOverlaySelection(shell);
        const row = shell.streamLog.at(-1);
        expect(row).toBeDefined();
        if (row === undefined) return;
        expect(row.meta).toBe(word);
        expect(FORBIDDEN).not.toContain(row.meta);
        expect(streamRowGutter(row, LAYOUT).content.trim()).toBe(word);
      } finally {
        shell.dispose();
      }
    },
    { width: 80, height: 24 },
  );
}

describe("transcript gutter labels", () => {
  test("production meta literals are a closed operator-facing set", async () => {
    const tuiDir = import.meta.dirname;
    const files = await Array.fromAsync(new Bun.Glob("**/*.ts").scan(tuiDir));
    const captured = new Set<string>();
    for (const relative of files) {
      const base = relative.split("/").pop() ?? relative;
      if (base.endsWith(".test.ts") || base === "demo.ts") continue;
      const source = await Bun.file(join(tuiDir, relative)).text();
      for (const match of source.matchAll(IMMEDIATE_META)) {
        const token = match[1];
        if (token !== undefined) captured.add(token);
      }
      for (const match of source.matchAll(TERNARY_META)) {
        if (match[1] !== undefined) captured.add(match[1]);
        if (match[2] !== undefined) captured.add(match[2]);
      }
    }

    expect(FORBIDDEN.filter((token) => captured.has(token))).toEqual([]);
    const permitted = new Set<string>(PERMITTED_CHROME_GUTTER_LABELS);
    expect(FORBIDDEN.filter((token) => permitted.has(token))).toEqual([]);

    // Painted overlay words are decided here, not inferred from the literal scan.
    expect(sortedSet(Object.values(OVERLAY_KIND_GUTTER))).toEqual(
      sortedSet(Object.keys(OVERLAY_KIND_GUTTER).map((kind) => kind.replace(/_/g, " "))),
    );

    expect(sortedSet(captured)).toEqual(sortedSet([...CHROME_LITERALS, ...STORED_NOT_GUTTER]));
  });

  test("an expand dump with no meta paints an empty gutter", () => {
    expect(streamRowGutter({ role: "system", text: "payload" }, LAYOUT).content).toBe("");
  });

  test("thinking rows paint an empty gutter", () => {
    expect(
      streamRowGutter({ role: "system", text: "chain of thought", meta: "thinking" }, LAYOUT)
        .content,
    ).toBe("");
  });

  test("permitted chrome paints in the gutter", () => {
    const gutter = streamRowGutter({ role: "system", text: "failed", meta: "error" }, LAYOUT);
    expect(gutter.content.length).toBeGreaterThan(0);
    expect(gutter.content.trim()).toBe("error");
  });

  test("a default-echo permissions recap paints the overlay word", async () => {
    await assertEchoRecap(
      (shell) => openPermissionsOverlay(shell, { items: makePermissionItems(3) }),
      OVERLAY_KIND_GUTTER.permissions,
    );
  });

  test("a default-echo operator recap paints the overlay word", async () => {
    await assertEchoRecap(
      (shell) => openOperatorOverlay(shell, { choices: ["A", "B"] }),
      OVERLAY_KIND_GUTTER.operator,
    );
  });

  test("a default-echo model-picker recap paints the overlay word", async () => {
    await assertEchoRecap(
      (shell) => openModelPickerOverlay(shell, { items: ["claude-sonnet-4"] }),
      OVERLAY_KIND_GUTTER.model_picker,
    );
  });
});
