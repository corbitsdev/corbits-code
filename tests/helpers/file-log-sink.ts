import { expect, spyOn } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installFileLogSink } from "../../src/logging/sink.js";

/**
 * Installs a temp-file log sink, spies stdout/stderr around `fn`, asserts
 * those streams were unused, and returns the sink file contents.
 *
 * Leaves the sink installed (same as `src/logging/sink.test.ts`) and does
 * not delete the temp dir — later tests in the same process may still log.
 */
export async function withFileLogSink(fn: () => Promise<void>): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "corbits-silence-log-"));
  const file = join(dir, "corbits.log");
  installFileLogSink(file);

  const stdoutWrite = spyOn(process.stdout, "write");
  const stderrWrite = spyOn(process.stderr, "write");
  try {
    await fn();
    expect(stdoutWrite).not.toHaveBeenCalled();
    expect(stderrWrite).not.toHaveBeenCalled();
  } finally {
    stdoutWrite.mockRestore();
    stderrWrite.mockRestore();
  }

  return existsSync(file) ? readFileSync(file, "utf8") : "";
}
