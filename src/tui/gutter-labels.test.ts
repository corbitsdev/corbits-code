/**
 * The transcript never labels a row with the machinery that produced it.
 * Adding a painted chrome label means editing CHROME_LITERALS or
 * OVERLAY_KIND_GUTTER on purpose.
 */
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { withTestRenderer } from "./harness.js";
import { overlayKindWord } from "./overlay-body.js";
import {
  acceptOverlaySelection,
  createAppShell,
  openListOverlay,
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

/** Palette and copy accept on a different path; they never echo overlayKindWord. */
const NON_ECHO_OVERLAY_KINDS = new Set<PrimaryOverlayKind>(["palette", "copy"]);

const LAYOUT: RowLayout = { width: 80, multiAgent: false };

const IMMEDIATE_META = /meta:\s*["']([^"']+)["']/g;
const TERNARY_META = /meta:\s*[^,\n]+\?\s*["']([^"']+)["']\s*:\s*["']([^"']+)["']/g;
const META_LINE = /\bmeta:\s*([^\n]+)/g;
const SKIP_RHS = /^(true|false|string|boolean|number|unknown|null)\b/;

function sortedSet(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function isOverlayKind(value: string): value is PrimaryOverlayKind {
  return Object.hasOwn(OVERLAY_KIND_GUTTER, value);
}

function overlayKindCases(): { kind: PrimaryOverlayKind; word: string }[] {
  const cases: { kind: PrimaryOverlayKind; word: string }[] = [];
  for (const key of Object.keys(OVERLAY_KIND_GUTTER)) {
    if (!isOverlayKind(key)) continue;
    cases.push({ kind: key, word: OVERLAY_KIND_GUTTER[key] });
  }
  return cases;
}

function normalizeRhs(raw: string): string {
  return raw
    .replace(/\/\/.*$/, "")
    .replace(/,?\s*$/, "")
    .trim();
}

function isRecognisedMetaRhs(rhs: string): boolean {
  if (SKIP_RHS.test(rhs)) return true;
  if (rhs.startsWith("row.meta") || rhs === "input.name") return true;
  if (rhs.startsWith("overlayKindWord(")) return true;
  if (rhs.startsWith('"') || rhs.startsWith("'")) return true;
  if (rhs.includes("?") && /["']/.test(rhs)) return true;
  return false;
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
    const unrecognized: string[] = [];
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
      for (const match of source.matchAll(META_LINE)) {
        const rhs = normalizeRhs(match[1] ?? "");
        if (rhs.length === 0 || isRecognisedMetaRhs(rhs)) continue;
        unrecognized.push(`${relative}: ${rhs}`);
      }
    }

    expect(unrecognized).toEqual([]);
    expect(FORBIDDEN.filter((token) => captured.has(token))).toEqual([]);
    const painted = new Set<string>([...CHROME_LITERALS, ...Object.values(OVERLAY_KIND_GUTTER)]);
    expect(FORBIDDEN.filter((token) => painted.has(token))).toEqual([]);

    for (const { kind, word } of overlayKindCases()) {
      expect(overlayKindWord(kind)).toBe(word);
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

  test.each(overlayKindCases().filter(({ kind }) => !NON_ECHO_OVERLAY_KINDS.has(kind)))(
    "a default-echo $kind recap paints the overlay word",
    async ({ kind, word }) => {
      await assertEchoRecap((shell) => openListOverlay(shell, { kind, items: ["one"] }), word);
    },
  );
});
