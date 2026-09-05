/**
 * The transcript never labels a row with the machinery that produced it.
 * Adding a painted chrome label means editing CHROME_LITERALS or
 * OVERLAY_KIND_GUTTER on purpose.
 */
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { withTestRenderer } from "./harness.js";
import {
  makePermissionItems,
  openModelPickerOverlay,
  openOperatorOverlay,
  openPermissionsOverlay,
} from "./overlays.js";
import {
  acceptOverlaySelection,
  createAppShell,
  overlayKindWord,
  type AppShell,
  type PrimaryOverlayKind,
} from "./shell.js";
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

const STORED_META_LITERALS = [
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

function isOverlayKind(value: string): value is PrimaryOverlayKind {
  return Object.hasOwn(OVERLAY_KIND_GUTTER, value);
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
        if (row === undefined) {
          throw new Error("expected an echo recap row");
        }
        expect(row.meta).toBe(word);
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
      if (
        relative.endsWith(".test.ts") ||
        relative === "demo.ts" ||
        relative.endsWith("/demo.ts")
      ) {
        continue;
      }
      const source = await Bun.file(join(tuiDir, relative)).text();
      for (const match of source.matchAll(IMMEDIATE_META)) {
        const token = match[1];
        if (token) captured.add(token);
      }
      for (const match of source.matchAll(TERNARY_META)) {
        if (match[1]) captured.add(match[1]);
        if (match[2]) captured.add(match[2]);
      }
    }

    expect(FORBIDDEN.filter((token) => captured.has(token))).toEqual([]);
    const painted = new Set<string>([...CHROME_LITERALS, ...Object.values(OVERLAY_KIND_GUTTER)]);
    expect(FORBIDDEN.filter((token) => painted.has(token))).toEqual([]);

    for (const key of Object.keys(OVERLAY_KIND_GUTTER)) {
      if (!isOverlayKind(key)) {
        throw new Error(`unexpected overlay kind key: ${key}`);
      }
      expect(overlayKindWord(key)).toBe(OVERLAY_KIND_GUTTER[key]);
    }

    expect(sortedSet(captured)).toEqual(sortedSet([...CHROME_LITERALS, ...STORED_META_LITERALS]));
  });

  test("thinking rows paint an empty gutter", () => {
    expect(
      streamRowGutter({ role: "system", text: "chain of thought", meta: "thinking" }, LAYOUT)
        .content,
    ).toBe("");
  });

  test.each([...CHROME_LITERALS])("permitted chrome paints %s in the gutter", (meta) => {
    expect(streamRowGutter({ role: "system", text: "notice", meta }, LAYOUT).content.trim()).toBe(
      meta,
    );
  });

  test.each([
    {
      name: "permissions",
      open: (shell: AppShell) => openPermissionsOverlay(shell, { items: makePermissionItems(3) }),
      word: OVERLAY_KIND_GUTTER.permissions,
    },
    {
      name: "operator",
      open: (shell: AppShell) => openOperatorOverlay(shell, { choices: ["A", "B"] }),
      word: OVERLAY_KIND_GUTTER.operator,
    },
    {
      name: "model_picker",
      open: (shell: AppShell) => openModelPickerOverlay(shell, { items: ["claude-sonnet-4"] }),
      word: OVERLAY_KIND_GUTTER.model_picker,
    },
  ])("a default-echo $name recap paints the overlay word", async ({ open, word }) => {
    await assertEchoRecap(open, word);
  });
});
