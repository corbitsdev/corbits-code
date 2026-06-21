import { test, expect, mock } from "bun:test";

import { commandPlugin, manifest } from "../../plugins/scribe/src/index.js";
import type { CommandContext } from "../../src/tui/commands/registry.js";

const cmd = commandPlugin.commands[0]!;

function ctx(startWorkflow?: (name: string) => string): CommandContext {
  return {
    signalClear: () => {},
    ...(startWorkflow !== undefined ? { startWorkflow } : {}),
  };
}

test("scribe plugin manifest declares a command plugin", () => {
  expect(manifest.kind).toBe("command");
  expect(manifest.id).toBe("scribe");
  expect(commandPlugin.commands).toHaveLength(1);
  expect(cmd.name).toBe("scribe");
});

test("scribe command starts the workflow and forwards a target", () => {
  const startWorkflow = mock((_name: string): string => "Started scribe workflow.");
  const result = cmd.handler("the README", ctx(startWorkflow));
  expect(startWorkflow).toHaveBeenCalledTimes(1);
  expect(startWorkflow.mock.calls[0]![0]).toBe("scribe");
  expect(result).toEqual({ type: "send", text: "Begin the scribe workflow for: the README" });
});

test("scribe command starts the bare workflow with no target", () => {
  const startWorkflow = mock((_name: string): string => "Started scribe workflow.");
  const result = cmd.handler("   ", ctx(startWorkflow));
  expect(result).toEqual({ type: "send", text: "Begin the scribe workflow." });
});

test("scribe command surfaces a non-started status as a message", () => {
  const startWorkflow = mock((_name: string): string =>
    "A workflow is already active. Run /scribe again to replace it.",
  );
  const result = cmd.handler("", ctx(startWorkflow));
  expect(result).toEqual({
    type: "message",
    text: "A workflow is already active. Run /scribe again to replace it.",
  });
});

test("scribe command reports when workflows are unavailable", () => {
  const result = cmd.handler("anything", ctx());
  expect(result).toEqual({ type: "message", text: "Workflows are not available in this context." });
});
