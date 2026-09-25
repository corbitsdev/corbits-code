import { describe, test, expect } from "bun:test";
import { isAutoAllowedShellCall } from "./classify.js";
import { createPermissionGate } from "./gate.js";

const shellCall = (command: string) => ({
  id: "c",
  name: "run_shell",
  arguments: { command },
});

describe("critique permission lane", () => {
  test("grep --file=.env should not auto-allow", () => {
    expect(
      isAutoAllowedShellCall(shellCall("grep --file=.env foo"), process.cwd()),
    ).toBe(false);
  });

  test("interactive gate must prompt for grep --file=.env, not auto-allow", async () => {
    let asked = 0;
    const gate = createPermissionGate({
      approvals: [],
      requestApproval: async () => {
        asked++;
        return { allow: false };
      },
      interactive: true,
      skipPermissions: false,
      reactorGated: false,
      auto: false,
    });
    const v = await gate.evaluate(shellCall("grep --file=.env foo"));
    expect(v.allowed).toBe(false);
    expect(asked).toBe(1);
  });

  test("a stored grant cannot bypass an expanded sensitive operand", async () => {
    let asked = 0;
    const gate = createPermissionGate({
      approvals: [{ tool: "run_shell", pattern: "*" }],
      requestApproval: async () => {
        asked++;
        return { allow: false };
      },
      interactive: true,
      skipPermissions: false,
      reactorGated: false,
      auto: false,
    });

    const verdict = await gate.evaluate(
      shellCall("xargs grep --file=.envrc needle"),
    );
    expect(verdict.allowed).toBe(false);
    expect(asked).toBe(1);
  });

  test("skipPermissions allows shell sensitive ref at gate", async () => {
    const gate = createPermissionGate({
      approvals: [],
      interactive: false,
      skipPermissions: true,
      reactorGated: false,
    });
    const v = await gate.evaluate(shellCall("cat .env"));
    expect(v).toEqual({ allowed: true });
  });
});
