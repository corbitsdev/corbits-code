import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLogger } from "@intx/log";

import { corbitsLogFilePath, installFileLogSink } from "./sink.js";

describe("corbitsLogFilePath", () => {
  test("nests under the settings dir, not directly in home", () => {
    expect(corbitsLogFilePath("/home/dev")).toBe("/home/dev/.corbits/logs/corbits.log");
  });
});

describe("installFileLogSink", () => {
  test("routes a logger's output to the file, never to stdout/stderr", () => {
    const dir = mkdtempSync(join(tmpdir(), "corbits-sink-test-"));
    const file = join(dir, "corbits.log");
    try {
      installFileLogSink(file);

      const stdoutWrite = spyOn(process.stdout, "write");
      const stderrWrite = spyOn(process.stderr, "write");
      try {
        getLogger(["some", "vendored", "logger"]).error("boom {detail}", { detail: "bad" });
      } finally {
        stdoutWrite.mockRestore();
        stderrWrite.mockRestore();
      }

      expect(stdoutWrite).not.toHaveBeenCalled();
      expect(stderrWrite).not.toHaveBeenCalled();

      const logged = readFileSync(file, "utf8");
      expect(logged).toContain("boom bad");
      expect(logged).toContain("some.vendored.logger");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
