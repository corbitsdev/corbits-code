import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createPluginLoadDiagnostics,
  formatPluginWarningsSummary,
  pluginWarningSink,
} from "./diagnostics.js";
import { loadPluginEntry } from "./loader.js";

async function makePlugin(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "diag-plugin-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, body);
  }
  await writeFile(
    join(dir, "plugin.json"),
    JSON.stringify({
      name: "diag-test",
      version: "0.0.1",
      description: "diagnostics test plugin",
    }),
  );
  return dir;
}

describe("formatPluginWarningsSummary", () => {
  test("returns undefined for empty", () => {
    expect(formatPluginWarningsSummary([])).toBeUndefined();
  });

  test("collapses pure skill-miss list to one line", () => {
    const summary = formatPluginWarningsSummary([
      'agent a: skill "style" referenced but not found in skill search path',
      'agent a: skill "philosophy" referenced but not found in skill search path',
    ]);
    expect(summary).toBe("plugins: 2 skills missing: style, philosophy");
  });

  test("counts mixed warnings", () => {
    const summary = formatPluginWarningsSummary([
      'agent a: skill "x" referenced but not found in skill search path',
      "other problem",
    ]);
    expect(summary).toContain("1 skill missing");
    expect(summary).toContain("1 other warning");
  });
});

describe("plugin load diagnostics wiring", () => {
  test("collector records skill misses without calling stderr fallback", async () => {
    const dir = await makePlugin({
      "agents/a.md": "---\nskills: [nope, also-missing]\n---\nbody\n",
    });
    const diag = createPluginLoadDiagnostics();
    const stderrLines: string[] = [];
    const sink = pluginWarningSink(diag, (msg) => stderrLines.push(msg));

    // Sink itself must not hit fallback when diag is set.
    sink("should only land in diag");
    expect(diag.warnings).toEqual(["should only land in diag"]);
    expect(stderrLines).toEqual([]);

    diag.warnings.length = 0;
    const mod = await loadPluginEntry(dir, {
      cwd: dir,
      origin: "path",
      diagnostics: diag,
    });
    expect(mod).not.toBeNull();
    expect(diag.warnings.length).toBeGreaterThanOrEqual(2);
    expect(diag.warnings.every((w) => w.includes("referenced but not found"))).toBe(
      true,
    );

    const summary = formatPluginWarningsSummary(diag.warnings);
    expect(summary).toBeDefined();
    expect(summary!.startsWith("plugins:")).toBe(true);
    // One summary line, not N raw plugins: lines from default sink.
    expect(summary!.split("\n").length).toBe(1);
  });
});
