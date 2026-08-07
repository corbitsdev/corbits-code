import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// The TUI holds the alternate screen for the whole interactive session, so any
// plugin-diagnostics summary that lands on raw stderr corrupts the rendered
// frame instead of showing up as a single controlled line (see CL-5411).
// `emitPluginWarningSummary` defaults to a raw `process.stderr.write` sink
// when called with no second argument; interactive callers must route through
// `emitPluginWarningLog` (the structured-logger sink) instead.
describe("runner.ts plugin diagnostics", () => {
  test("never calls emitPluginWarningSummary with its raw-stderr default", async () => {
    const src = await readFile(join(import.meta.dir, "runner.ts"), "utf8");
    const bareCalls = src.match(/emitPluginWarningSummary\([^,)]+\)/g) ?? [];
    expect(bareCalls).toEqual([]);
  });
});
