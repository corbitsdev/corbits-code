import { describe, expect, spyOn, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
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

function liveLockHolder(): ChildProcess {
  const holder = spawn("sleep", ["30"], { stdio: "ignore" });
  if (holder.pid === undefined) {
    throw new Error("lock holder did not start");
  }
  return holder;
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
      // The retained generation is the file that crossed the cap, so it can
      // pass the cap by the record that crossed it. The active file stays bounded.
      expect(Buffer.byteLength(previous)).toBeGreaterThan(500);
      expect(Buffer.byteLength(previous)).toBeLessThanOrEqual(500 + 200);
      expect(Buffer.byteLength(active)).toBeLessThanOrEqual(500);
      expect(previous + active).not.toContain("rotate-line-0-");
      expect(active).toContain("rotate-line-39-");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a second writer flushing one line keeps the other writer's rotated log", () => {
    const { dir, file } = tempLogFile();
    try {
      installFileLogSink(file, { maxBytes: 300 });
      const first = getLogger(["logging", "share-a"]);
      first.info("first-marker");
      first.info("first-marker-b");
      first.info("short-active");
      flushFileLogSinkSync();
      const rotated = `${file}.1`;
      const marker = fs.readFileSync(rotated, "utf8");
      const activeBefore = fs.readFileSync(file, "utf8");
      expect(marker).toContain("first-marker");
      expect(activeBefore).toContain("short-active");
      expect(Buffer.byteLength(activeBefore)).toBeLessThan(300);

      installFileLogSink(file, { maxBytes: 300 });
      getLogger(["logging", "share-b"]).info("b-one");
      flushFileLogSinkSync();

      expect(fs.readFileSync(rotated, "utf8")).toBe(marker);
      const active = fs.readFileSync(file, "utf8");
      expect(active.startsWith(activeBefore)).toBe(true);
      expect(active).toContain("b-one");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("crossing the cap once keeps the previous active file as .1", () => {
    const { dir, file } = tempLogFile();
    try {
      installFileLogSink(file, { maxBytes: 300 });
      const first = getLogger(["logging", "cross-a"]);
      first.info("first-marker");
      first.info("first-marker-b");
      first.info("short-active");
      flushFileLogSinkSync();
      const rotated = `${file}.1`;
      const activeBefore = fs.readFileSync(file, "utf8");
      expect(activeBefore).toContain("short-active");

      installFileLogSink(file, { maxBytes: 300 });
      const second = getLogger(["logging", "cross-b"]);
      const wide = `b-wide-${"x".repeat(80)}`;
      second.info(wide);
      second.info(`${wide}-2`);
      flushFileLogSinkSync();

      const kept = fs.readFileSync(rotated, "utf8");
      expect(kept).toContain("short-active");
      expect(kept).not.toContain("b-wide-");
      const active = fs.readFileSync(file, "utf8");
      expect(active).toContain(wide);
      expect(active).toContain(`${wide}-2`);
      expect(Buffer.byteLength(activeBefore)).toBeLessThan(300);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a stale size does not rotate a short file another process just created", () => {
    const { dir, file } = tempLogFile();
    try {
      installFileLogSink(file, { maxBytes: 500 });
      const logger = getLogger(["logging", "stale"]);
      logger.info("x".repeat(600));
      flushFileLogSinkSync();
      expect(fs.statSync(file).size).toBeGreaterThan(500);
      expect(fs.existsSync(`${file}.1`)).toBe(false);

      fs.rmSync(file);
      fs.writeFileSync(file, "short-marker\n");
      logger.info("one-line");
      flushFileLogSinkSync();

      expect(fs.existsSync(`${file}.1`)).toBe(false);
      const active = fs.readFileSync(file, "utf8");
      expect(active).toContain("short-marker");
      expect(active).toContain("one-line");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("renaming onto an existing generation still bounds the active file", () => {
    const { dir, file } = tempLogFile();
    const renameSync = fs.renameSync.bind(fs);
    const rename = spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (fs.existsSync(to)) {
        throw Object.assign(new Error("EPERM, rename"), { code: "EPERM" });
      }
      return renameSync(from, to);
    });
    try {
      installFileLogSink(file, { maxBytes: 500 });
      const logger = getLogger(["logging", "eperm"]);
      for (let i = 0; i < 40; i++) {
        logger.info(`eperm-line-${i}-xxxxxxxxxxxxxxxxxxxx`);
      }
      flushFileLogSinkSync();
      expect(fs.statSync(`${file}.1`).isFile()).toBe(true);
      expect(fs.statSync(file).size).toBeLessThanOrEqual(500 + 200);
      for (let i = 0; i < 10; i++) {
        logger.info(`eperm-more-${i}-xxxxxxxxxxxxxxxxxxxx`);
      }
      flushFileLogSinkSync();
      expect(fs.statSync(file).size).toBeLessThanOrEqual(500 + 200);
      expect(fs.readFileSync(file, "utf8").length).toBeGreaterThan(0);
    } finally {
      rename.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a crash after .1 is removed restores the rotating temp on the next flush", () => {
    const { dir, file } = tempLogFile();
    try {
      const temp = `${file}.${process.pid}.7.rotating`;
      const marker = "crashed-rotation-bytes\n";
      fs.writeFileSync(temp, marker);
      installFileLogSink(file, { maxBytes: 10_000 });
      getLogger(["logging", "recover"]).info("after-crash");
      flushFileLogSinkSync();
      const active = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
      const rotated = fs.existsSync(`${file}.1`)
        ? fs.readFileSync(`${file}.1`, "utf8")
        : "";
      expect(`${active}${rotated}`).toContain("crashed-rotation-bytes");
      expect(fs.existsSync(temp)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a second reclaimer does not delete the lock a winner just created", () => {
    const { dir, file } = tempLogFile();
    const holder = liveLockHolder();
    const lockPath = `${file}.lock`;
    const realRead = fs.readFileSync.bind(fs);
    let lied = false;
    try {
      installFileLogSink(file, { maxBytes: 300 });
      const first = getLogger(["logging", "reclaim-a"]);
      first.info("first-marker");
      first.info("first-marker-b");
      first.info("short-active");
      flushFileLogSinkSync();
      const rotated = `${file}.1`;
      const marker = fs.readFileSync(rotated, "utf8");
      fs.writeFileSync(lockPath, "999999:dead");
      const hooked = spyOn(fs, "readFileSync").mockImplementation(((
        path: fs.PathOrFileDescriptor,
      ) => {
        if (String(path) === lockPath && !lied) {
          lied = true;
          fs.writeFileSync(lockPath, `${holder.pid}:winner`);
          return "999999:dead";
        }
        return realRead(path, "utf8");
      }) as unknown as typeof fs.readFileSync);
      try {
        getLogger(["logging", "reclaim-b"]).info(`b-wide-${"x".repeat(80)}`);
        flushFileLogSinkSync();
        expect(fs.readFileSync(rotated, "utf8")).toBe(marker);
        expect(fs.readFileSync(lockPath, "utf8")).toContain("winner");
      } finally {
        hooked.mockRestore();
      }
    } finally {
      holder.kill();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a flush that cannot acquire the lock does not rotate", () => {
    const { dir, file } = tempLogFile();
    const holder = liveLockHolder();
    try {
      installFileLogSink(file, { maxBytes: 300 });
      const first = getLogger(["logging", "lock-a"]);
      first.info("first-marker");
      first.info("first-marker-b");
      first.info("short-active");
      flushFileLogSinkSync();
      const rotated = `${file}.1`;
      const marker = fs.readFileSync(rotated, "utf8");
      const activeBefore = fs.readFileSync(file, "utf8");
      fs.writeFileSync(`${file}.lock`, `${holder.pid}:held`);
      getLogger(["logging", "lock-b"]).info(`b-wide-${"x".repeat(80)}`);
      flushFileLogSinkSync();
      expect(fs.readFileSync(rotated, "utf8")).toBe(marker);
      expect(fs.readFileSync(file, "utf8")).toBe(activeBefore);
    } finally {
      holder.kill();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a lock that cannot be read is not stolen", () => {
    const { dir, file } = tempLogFile();
    const holder = liveLockHolder();
    const lockPath = `${file}.lock`;
    const realRead = fs.readFileSync.bind(fs);
    try {
      installFileLogSink(file, { maxBytes: 300 });
      const first = getLogger(["logging", "lock-read-a"]);
      first.info("first-marker");
      first.info("first-marker-b");
      first.info("short-active");
      flushFileLogSinkSync();
      const rotated = `${file}.1`;
      const marker = fs.readFileSync(rotated, "utf8");
      const activeBefore = fs.readFileSync(file, "utf8");
      fs.writeFileSync(lockPath, `${holder.pid}:held`);
      const hooked = spyOn(fs, "readFileSync").mockImplementation(((
        path: fs.PathOrFileDescriptor,
      ) => {
        if (String(path) === lockPath) {
          throw Object.assign(new Error("EIO"), { code: "EIO" });
        }
        return realRead(path, "utf8");
      }) as unknown as typeof fs.readFileSync);
      try {
        getLogger(["logging", "lock-read-b"]).info(`b-wide-${"x".repeat(80)}`);
        flushFileLogSinkSync();
      } finally {
        hooked.mockRestore();
      }
      expect(fs.readFileSync(rotated, "utf8")).toBe(marker);
      expect(fs.readFileSync(file, "utf8")).toBe(activeBefore);
      expect(fs.readFileSync(lockPath, "utf8")).toContain("held");
    } finally {
      holder.kill();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a failed rotation keeps already-written records in the active file", () => {
    const { dir, file } = tempLogFile();
    try {
      installFileLogSink(file, { maxBytes: 180 });
      const logger = getLogger(["logging", "rotate-fail"]);
      for (let i = 0; i < 30; i++) logger.info(`seed-line-${i}-xxxxxxxx`);
      flushFileLogSinkSync();
      const rotated = `${file}.1`;
      expect(fs.statSync(rotated).isFile()).toBe(true);
      fs.rmSync(rotated);
      fs.mkdirSync(rotated);
      const kept = fs.readFileSync(file, "utf8");
      expect(kept.length).toBeGreaterThan(0);
      logger.info("kept-tail-1");
      logger.info("kept-tail-2");
      logger.info("kept-tail-3");
      flushFileLogSinkSync();
      const active = fs.readFileSync(file, "utf8");
      expect(active.startsWith(kept)).toBe(true);
      expect(active).toContain("kept-tail-1");
      expect(active).toContain("kept-tail-2");
      expect(active).toContain("kept-tail-3");
      expect(fs.statSync(rotated).isDirectory()).toBe(true);
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
