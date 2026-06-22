import { test, expect } from "bun:test";

import { commandPlugin } from "../fixtures/plugins/scribe/src/index.js";
import type { CommandContext } from "../../src/tui/commands/registry.js";
import manifest from "../fixtures/plugins/scribe/manifest.json";

const cmd = commandPlugin.commands[0]!;

function ctx(): CommandContext {
  return { signalClear: () => {} };
}

test("scribe plugin manifest declares a command plugin", () => {
  expect(manifest.kind).toBe("command");
  expect(manifest.id).toBe("scribe");
  expect(commandPlugin.commands).toHaveLength(1);
  expect(cmd.name).toBe("scribe");
});

test("scribe command returns skill injection with target text", () => {
  const result = cmd.handler("the README", ctx());
  expect(result).toEqual({
    type: "skill",
    skill: "gaas:scribe",
    text: "Apply the scribe skill to: the README",
  });
});

test("scribe command returns skill injection without target", () => {
  const result = cmd.handler("   ", ctx());
  expect(result).toEqual({
    type: "skill",
    skill: "gaas:scribe",
    text: "Apply the scribe skill to the current task context.",
  });
});