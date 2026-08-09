import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, expect, spyOn } from "bun:test";
import * as posixModule from "@intx/tools-posix";

afterEach(() => {
  spyOn(posixModule, "createPosixTools").mockRestore();
});

test("createAgentToolset wires posix tools for a real cwd", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "corbits-toolset-"));
  spyOn(posixModule, "createPosixTools").mockReturnValue({
    definitions: [],
    run: async () => ({ output: "" }),
    dispose: async () => {},
  } as unknown as ReturnType<typeof posixModule.createPosixTools>);

  const { createAgentToolset } = await import("../../src/agent/tools.js");
  const permissionGate = {
    check: async () => ({ allowed: true }),
    getSkipPermissions: () => false,
  } as never;

  const toolset = await createAgentToolset({
    cwd,
    permissionGate,
    onOperatorGate: async () => ({ kind: "option", index: 0 }),
  });

  expect(toolset.dynamicRunner).toBeDefined();
  await toolset.dispose();
});