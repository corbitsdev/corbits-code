import { describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLogger } from "@intx/log";

import {
  corbitsLogFilePath,
  flushFileLogSinkSync,
  installFileLogSink,
} from "./sink.js";

function tempLogFile(): { dir: string; file: string } {
  const dir = fs.mkdtempSync(join(tmpdir(), "corbits-sink-test-"));
  return { dir, file: join(dir, "corbits.log") };
}

describe("corbitsLogFilePath", () => {
  test("nests under the settings dir, not directly in home", () => {
    expect(corbitsLogFilePath("/home/dev")).toBe(
      "/home/dev/.corbits/logs/corbits.log",
    );
  });
});

describe("installFileLogSink", () => {
  test("routes a logger's output to the file, never to stdout/stderr", () => {
    const { dir, file } = tempLogFile();
    try {
      installFileLogSink(file);

      const stdoutWrite = spyOn(process.stdout, "write");
      const stderrWrite = spyOn(process.stderr, "write");
      try {
        getLogger(["some", "vendored", "logger"]).error("boom {detail}", {
          detail: "bad",
        });
        flushFileLogSinkSync();
      } finally {
        stdoutWrite.mockRestore();
        stderrWrite.mockRestore();
      }

      expect(stdoutWrite).not.toHaveBeenCalled();
      expect(stderrWrite).not.toHaveBeenCalled();

      const logged = fs.readFileSync(file, "utf8");
      expect(logged).toContain("boom bad");
      expect(logged).toContain("some.vendored.logger");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("queues records instead of appending once per call", () => {
    const { dir, file } = tempLogFile();
    const calls: string[] = [];
    const append = spyOn(fs, "appendFileSync").mockImplementation((path) => {
      calls.push(String(path));
      const until = performance.now() + 5;
      while (performance.now() < until) {
        // A per-record sync append would make the burst pay this stall each time.
      }
    });
    try {
      installFileLogSink(file, { maxBytes: 10 * 1024 * 1024 });
      const logger = getLogger(["logging", "burst"]);
      const started = performance.now();
      for (let i = 0; i < 20; i++) logger.info(`burst-${i}`);
      const elapsed = performance.now() - started;
      const duringBurst = calls.length;
      expect(duringBurst).toBe(0);
      // 20 sync appends would spend about 100ms inside the loop.
      expect(elapsed).toBeLessThan(50);
      expect(existsUnwritten(file)).not.toContain("burst-19");
      flushFileLogSinkSync();
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.length).toBeLessThan(20);
    } finally {
      append.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rotates the active log once it passes the size cap", () => {
    const { dir, file } = tempLogFile();
    try {
      installFileLogSink(file, { maxBytes: 500 });
      const logger = getLogger(["logging", "rotate"]);
      for (let i = 0; i < 40; i++) {
        logger.info(`rotate-line-${i}-xxxxxxxxxxxxxxxxxxxx`);
      }
      flushFileLogSinkSync();
      const rotated = `${file}.1`;
      expect(fs.existsSync(rotated)).toBe(true);
      const previous = fs.readFileSync(rotated, "utf8");
      const active = fs.readFileSync(file, "utf8");
      const earlier = lineIndex(previous);
      const later = lineIndex(active);
      expect(earlier).toBeLessThan(later);
      expect(active).not.toContain(`rotate-line-${earlier}-`);
      expect(Buffer.byteLength(previous)).toBeLessThanOrEqual(500);
      expect(Buffer.byteLength(active)).toBeLessThanOrEqual(500);
      expect(previous + active).not.toContain("rotate-line-0-");
      expect(active).toContain("rotate-line-39-");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a crash or exit flush writes the pending tail", () => {
    const { dir, file } = tempLogFile();
    try {
      installFileLogSink(file);
      expect(process.listeners("exit")).toContain(flushFileLogSinkSync);
      getLogger(["logging", "crash"]).error("pending-tail");
      const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
      expect(before).not.toContain("pending-tail");
      // Same function handleFatal, signal exit, and process exit call.
      flushFileLogSinkSync();
      expect(fs.readFileSync(file, "utf8")).toContain("pending-tail");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

function lineIndex(text: string): number {
  const match = /rotate-line-(\d+)-/.exec(text);
  if (match === null || match[1] === undefined) {
    throw new Error("rotated log is missing a record");
  }
  return Number(match[1]);
}

function existsUnwritten(file: string): string {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}
