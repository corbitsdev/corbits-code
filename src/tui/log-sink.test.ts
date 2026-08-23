/**
 * CL-5593: a raw structured log line from a vendored logger
 * (`interchange.inference.default-director`) painted itself over the prompt
 * box mid-frame, because nothing had ever pointed LogTape away from its
 * default console sink. This drives the real shell in a live session and
 * fires that exact logger the way the vendored code does, then asserts the
 * rendered frame is untouched and nothing reached stdout/stderr.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLogger } from "@intx/log";

import { installFileLogSink } from "../logging/sink.js";
import { createAppShell } from "./shell.js";
import { withTestRenderer } from "./harness.js";

describe("log sink during a live TUI session", () => {
  let logDir: string;
  let logFile: string;

  beforeEach(() => {
    logDir = mkdtempSync(join(tmpdir(), "corbits-log-sink-test-"));
    logFile = join(logDir, "corbits.log");
  });

  afterEach(() => {
    rmSync(logDir, { recursive: true, force: true });
  });

  test("a vendored logger's error never reaches stdout, stderr, or the frame", async () => {
    installFileLogSink(logFile);

    const stdoutWrite = spyOn(process.stdout, "write");
    const stderrWrite = spyOn(process.stderr, "write");

    try {
      await withTestRenderer(async (h) => {
        createAppShell(h.renderer, { cwd: "/workspace/corbits-code" });
        await h.renderOnce();

        const before = h.captureCharFrame();
        expect(before).toContain("/workspace/corbits-code");

        // Same category and tagged-template call shape as
        // vendor/intx-inference's default-director.
        const vendoredLogger = getLogger(["interchange", "inference", "default-director"]);
        vendoredLogger.error`Inference error in default director: ${"could not be verified"} [HTTP 400] (category: ${"fatal"})`;

        await h.renderOnce();
        const after = h.captureCharFrame();

        expect(after).toContain("/workspace/corbits-code");
        expect(after).not.toContain("@timestamp");
        expect(after).not.toContain("interchange.inference.default-director");
      });
    } finally {
      stdoutWrite.mockRestore();
      stderrWrite.mockRestore();
    }

    expect(stdoutWrite).not.toHaveBeenCalled();
    expect(stderrWrite).not.toHaveBeenCalled();

    const logged = readFileSync(logFile, "utf8");
    expect(logged).toContain("interchange.inference.default-director");
  });
});
