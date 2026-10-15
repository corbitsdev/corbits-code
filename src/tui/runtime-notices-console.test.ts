/**
 * Flash notices stay on the status row and are mirrored into the OpenTUI
 * console overlay. Rows stay on the transcript and are not mirrored.
 * The overlay stays hidden, so the mirror must not add frame rows.
 */
import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import { ManualClock } from "@opentui/core/testing";

import { createHarness } from "./harness.js";
import { mountProductHost } from "./product-host.js";

const cleanHook = {
  type: "hook.updated",
  hook: {
    id: "fmt",
    name: "format",
    type: "shell",
    path: "/hooks/format.sh",
    enabled: true,
    lastFiredAt: 1,
    lastKind: "postTurn",
    lastExitStatus: { code: 0, signal: null, stderr: "" },
  },
};

const failingHook = {
  type: "hook.updated",
  hook: {
    ...cleanHook.hook,
    lastExitStatus: { code: 2, signal: null, stderr: "prettier not found" },
  },
};

describe("runtime notice console mirror", () => {
  test("a flash stays on the status row and in the hidden console cache", async () => {
    const clock = new ManualClock();
    const harness = await createHarness({
      width: 100,
      height: 30,
      consoleMode: "console-overlay",
      clock,
    });
    const emitter = new EventEmitter();
    const host = await mountProductHost({
      title: "test-session",
      eventEmitter: emitter,
      send: () => undefined,
      interrupt: () => undefined,
      deliver: () => undefined,
      createRenderer: async () => harness.renderer,
    });
    try {
      expect(harness.renderer.consoleMode).toBe("console-overlay");
      harness.renderer.console.clear();
      emitter.emit("hook", cleanHook);
      await harness.renderOnce();
      const frame = harness.captureCharFrame();
      expect(frame).toContain("format");
      expect(frame).not.toContain("Console");
      expect(host.shell.streamLog).toEqual([]);
      expect(host.shell.statusFlash).toContain("format");
      expect(harness.renderer.console.getCachedLogs()).toContain(
        "hook format ran",
      );
      clock.advance(0);
    } finally {
      host.dispose();
      harness.destroy();
    }
  });

  test("a row notice stays on the transcript and is not mirrored", async () => {
    const harness = await createHarness({
      width: 100,
      height: 30,
      consoleMode: "console-overlay",
      clock: new ManualClock(),
    });
    const emitter = new EventEmitter();
    const host = await mountProductHost({
      title: "test-session",
      eventEmitter: emitter,
      send: () => undefined,
      interrupt: () => undefined,
      deliver: () => undefined,
      createRenderer: async () => harness.renderer,
    });
    try {
      harness.renderer.console.clear();
      emitter.emit("hook", failingHook);
      await harness.renderOnce();
      const frame = harness.captureCharFrame();
      expect(frame).toMatch(/format[^\n]*\b2\b/);
      expect(frame).not.toContain("Console");
      expect(harness.renderer.console.getCachedLogs()).not.toContain(
        "prettier not found",
      );
    } finally {
      host.dispose();
      harness.destroy();
    }
  });
});
