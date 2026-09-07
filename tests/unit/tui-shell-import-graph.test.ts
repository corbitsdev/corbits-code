import { describe, expect, test } from "bun:test";
import { join } from "node:path";

// CL-6791 phase 2 pinned the src/tui/shell split architecture in eslint
// (no-restricted-imports for host surfaces), but eslint does not run under
// `bun test` and it does not encode the sibling dependency gradient. This test
// machine-pins the import graph so a regression fails the suite directly.

const repoRoot = join(import.meta.dirname, "../..");
const shellDir = join(repoRoot, "src/tui/shell");

// Topological gradient: a shell module may only import siblings of STRICTLY
// LOWER rank (chrome -> transcript is fine; transcript -> chrome is not).
// Adding a module to src/tui/shell is a decision: assign it a rank here.
const RANKS: Record<string, number> = {
  "internals.ts": 0,
  "layout.ts": 1,
  "transcript.ts": 1,
  "chrome.ts": 2,
  "overlay-list.ts": 3,
  "overlay-host.ts": 4,
  "prompt.ts": 5,
  "palette.ts": 5,
  "copy.ts": 6,
  "observe.ts": 6,
  "keys.ts": 7,
  "index.ts": 8,
};

// Host surfaces that own the shell; shell/** must never import them (any
// relative spelling). Mirrors the eslint CL-6791 rule in eslint.config.js.
const BANNED =
  /^(?:\.\.\/)+(?:tui\/)?(?:provider|runner|product-host|overlays|command-surfaces|gate-wire|model-catalog|list-modal)(?:\/[^/]+)*(?:\.js)?$/;

interface ImportEdge {
  file: string;
  specifier: string;
}

/** Extract every import/export-from specifier from TS source text. */
function importSpecifiers(text: string): string[] {
  const out: string[] = [];
  const re = /(?:^|[\s;}])(?:import|export)\s[^;]*?from\s*["']([^"']+)["']/gs;
  for (const m of text.matchAll(re)) out.push(m[1]!);
  // Bare side-effect imports: import "./x.js";
  for (const m of text.matchAll(/(?:^|[\s;}])import\s*["']([^"']+)["']/g)) {
    out.push(m[1]!);
  }
  return out;
}

async function readShell(): Promise<ImportEdge[]> {
  const glob = new Bun.Glob("*.ts");
  const edges: ImportEdge[] = [];
  for await (const rel of glob.scan({ cwd: shellDir, dot: true })) {
    const text = await Bun.file(join(shellDir, rel)).text();
    for (const specifier of importSpecifiers(text)) {
      edges.push({ file: rel, specifier });
    }
  }
  return edges;
}

function rankOf(file: string): number | undefined {
  return RANKS[file];
}

describe("tui shell import graph (CL-6791 P2 split)", () => {
  const edgesPromise = readShell();

  test("every shell module has an assigned rank", async () => {
    const files = new Set((await edgesPromise).map((e) => e.file));
    const unknown = [...files].filter((f) => rankOf(f) === undefined);
    expect(
      unknown.length === 0,
      `New shell module(s) without a rank in RANKS (tests/unit/tui-shell-import-graph.test.ts). ` +
        `Adding a module to src/tui/shell is an architecture decision: assign it a rank ` +
        `(internals=0 < layout/transcript=1 < chrome=2 < overlay-list=3 < overlay-host=4 < ` +
        `prompt/palette=5 < copy/observe=6 < keys=7 < index=8). Unranked: ${unknown.join(", ")}`,
    ).toBe(true);
  });

  test("internals.ts imports no sibling shell modules", async () => {
    const violations = (await edgesPromise).filter(
      (e) => e.file === "internals.ts" && e.specifier.startsWith("./"),
    );
    expect(
      violations.map((v) => `${v.file} imports "${v.specifier}"`),
      `internals.ts is the layer-0 foundation of the shell; it must not import any sibling ` +
        `(no relative "./..." imports at all) or the gradient has a cycle.`,
    ).toEqual([]);
  });

  test("sibling imports follow the topological gradient (lower rank only)", async () => {
    const violations: string[] = [];
    for (const { file, specifier } of await edgesPromise) {
      if (!specifier.startsWith("./")) continue;
      const target = specifier.replace(/^\.\//, "").replace(/\.js$/, "");
      const targetRank = rankOf(`${target}.ts`);
      const sourceRank = rankOf(file);
      if (targetRank === undefined || sourceRank === undefined) continue; // covered by rank test
      if (targetRank >= sourceRank) {
        violations.push(
          `${file} (rank ${sourceRank}) imports "./${target}.js" (rank ${targetRank}): ` +
            `a shell module may only import siblings of STRICTLY LOWER rank`,
        );
      }
    }
    expect(violations).toEqual([]);
  });

  test("no shell module imports a banned host surface", async () => {
    const violations = (await edgesPromise)
      .filter((e) => BANNED.test(e.specifier))
      .map((e) => `${e.file} imports "${e.specifier}"`);
    expect(
      violations,
      `shell/** must not import host surfaces (provider, runner, product-host, overlays, ` +
        `command-surfaces, gate-wire, model-catalog, list-modal) via any relative spelling — ` +
        `those own the shell, never the reverse.`,
    ).toEqual([]);
  });
});
