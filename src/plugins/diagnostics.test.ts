import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createPluginLoadDiagnostics,
  emitPluginWarningLog,
  emitPluginWarningSummary,
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

  test("names a skill once however many sources missed it", () => {
    // The same skill missing from three plugins is one missing skill, not
    // three: the operator installs it once to fix all of them.
    const summary = formatPluginWarningsSummary([
      'agent a: skill "brand-identity" referenced but not found in skill search path',
      'agent a: skill "style" referenced but not found in skill search path',
      'agent b: skill "philosophy" referenced but not found in skill search path',
      'agent b: skill "style" referenced but not found in skill search path',
      'agent c: skill "philosophy" referenced but not found in skill search path',
      'agent c: skill "style" referenced but not found in skill search path',
      'agent c: skill "brand-identity" referenced but not found in skill search path',
    ]);
    expect(summary).toBe(
      "plugins: 3 skills missing: brand-identity, style, philosophy",
    );
  });

  test("mixed-warning count also counts distinct skills", () => {
    const summary = formatPluginWarningsSummary([
      'agent a: skill "style" referenced but not found in skill search path',
      'agent b: skill "style" referenced but not found in skill search path',
      "other problem",
    ]);
    expect(summary).toContain("1 skill missing (style)");
    expect(summary).toContain("1 other warning");
  });
});

describe("emitPluginWarningSummary", () => {
  test("writes one summary line via custom sink", () => {
    const diag = createPluginLoadDiagnostics();
    diag.warnings.push(
      'agent a: skill "style" referenced but not found in skill search path',
      'agent a: skill "philosophy" referenced but not found in skill search path',
    );
    const lines: string[] = [];
    emitPluginWarningSummary(diag, (line) => lines.push(line));
    expect(lines).toEqual(["plugins: 2 skills missing: style, philosophy"]);
  });

  test("is a no-op when there are no warnings", () => {
    const diag = createPluginLoadDiagnostics();
    const lines: string[] = [];
    emitPluginWarningSummary(diag, (line) => lines.push(line));
    expect(lines).toEqual([]);
  });
});

describe("emitPluginWarningLog", () => {
  test("never writes to stderr — interactive TUI holds the alt screen and a raw write corrupts the frame", () => {
    const diag = createPluginLoadDiagnostics();
    diag.warnings.push('agent a: skill "style" referenced but not found in skill search path');
    const originalWrite = process.stderr.write.bind(process.stderr);
    let stderrCalls = 0;
    process.stderr.write = ((..._args: unknown[]) => {
      stderrCalls++;
      return true;
    }) as typeof process.stderr.write;
    try {
      emitPluginWarningLog(diag);
    } finally {
      process.stderr.write = originalWrite;
    }
    expect(stderrCalls).toBe(0);
  });
});

describe("plugin load diagnostics wiring", () => {
  test("collector records skill misses without calling stderr fallback", async () => {
    const dir = await makePlugin({
      "agents/a.md": "---\nskills: [nope, also-missing]\n---\nbody\n",
    });
    const diag = createPluginLoadDiagnostics();
    const sink = pluginWarningSink(diag);

    sink("should only land in diag");
    expect(diag.warnings).toEqual(["should only land in diag"]);

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
