import { test, expect } from "bun:test";
import "../../src/tui/commands/built-in.js";
import { getCommand, type CommandContext } from "../../src/tui/commands/registry.js";

function ctxWith(enabled: boolean): { ctx: CommandContext; setCalls: boolean[] } {
  let current = enabled;
  const setCalls: boolean[] = [];
  const ctx: CommandContext = {
    signalClear: () => {},
    telemetry: {
      isEnabled: () => current,
      setEnabled: (next: boolean) => {
        setCalls.push(next);
        current = next;
      },
    },
  };
  return { ctx, setCalls };
}

test("/telemetry with no args reports current status", () => {
  const cmd = getCommand("telemetry")!;
  const { ctx } = ctxWith(true);
  expect(cmd.handler("", ctx)).toEqual({
    type: "message",
    text: "Telemetry is enabled. Use /telemetry on or /telemetry off to change it. See docs/TELEMETRY.md.",
  });
});

test("/telemetry off disables and reports", () => {
  const cmd = getCommand("telemetry")!;
  const { ctx, setCalls } = ctxWith(true);
  expect(cmd.handler("off", ctx)).toEqual({ type: "message", text: "Telemetry disabled." });
  expect(setCalls).toEqual([false]);
});

test("/telemetry on enables and reports", () => {
  const cmd = getCommand("telemetry")!;
  const { ctx, setCalls } = ctxWith(false);
  expect(cmd.handler("on", ctx)).toEqual({ type: "message", text: "Telemetry enabled." });
  expect(setCalls).toEqual([true]);
});

test("/telemetry is unavailable without a telemetry surface in context", () => {
  const cmd = getCommand("telemetry")!;
  const ctx: CommandContext = { signalClear: () => {} };
  expect(cmd.handler("", ctx)).toEqual({
    type: "message",
    text: "Telemetry is not available in this session.",
  });
});
