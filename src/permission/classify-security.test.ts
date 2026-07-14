import { describe, test, expect } from "bun:test";
import type { ToolCall } from "@intx/types/runtime";
import { isAutoAllowedShellCall } from "./classify.js";
import { autoShellRuleForCall } from "./auto-shell-policy.js";
import { createPermissionGate } from "./gate.js";
import { secretGuardPlugin } from "../plugins/secret-guard-plugin.js";

const shellCall = (command: string): ToolCall => ({ id: "c", name: "run_shell", arguments: { command } });

describe("isAutoAllowedShellCall — code-executing flags", () => {
  test("does not auto-allow rg --pre (arbitrary binary execution)", () => {
    expect(isAutoAllowedShellCall(shellCall("rg --pre sh foo"))).toBe(false);
    expect(isAutoAllowedShellCall(shellCall("rg --pre=sh foo"))).toBe(false);
  });

  test("does not auto-allow other rg exec-capable flags", () => {
    expect(isAutoAllowedShellCall(shellCall("rg --pre-glob '*.gz' foo"))).toBe(false);
    expect(isAutoAllowedShellCall(shellCall("rg --hostname-bin /bin/sh foo"))).toBe(false);
    expect(isAutoAllowedShellCall(shellCall("rg --search-zip foo"))).toBe(false);
    expect(isAutoAllowedShellCall(shellCall("rg -z foo"))).toBe(false);
  });

  test("does not auto-allow shell rg or recursive grep (authz open-ended search)", () => {
    expect(isAutoAllowedShellCall(shellCall("rg pattern src"))).toBe(false);
    expect(isAutoAllowedShellCall(shellCall("grep -r needle ."))).toBe(false);
  });

  test("still auto-allows bounded non-recursive grep", () => {
    expect(isAutoAllowedShellCall(shellCall("grep -n foo file.ts"))).toBe(true);
  });
});

describe("isAutoAllowedShellCall — sensitive-path arguments", () => {
  test("does not auto-allow reads of secret files", () => {
    expect(isAutoAllowedShellCall(shellCall("cat .env"))).toBe(false);
    expect(isAutoAllowedShellCall(shellCall("cat .env.production"))).toBe(false);
    expect(isAutoAllowedShellCall(shellCall("head id_rsa"))).toBe(false);
    expect(isAutoAllowedShellCall(shellCall("cat server.pem"))).toBe(false);
    expect(isAutoAllowedShellCall(shellCall("cat cert.p12"))).toBe(false);
    expect(isAutoAllowedShellCall(shellCall("cat .ssh/known_hosts"))).toBe(false);
    expect(isAutoAllowedShellCall(shellCall("cat .netrc"))).toBe(false);
    expect(isAutoAllowedShellCall(shellCall("cat .git-credentials"))).toBe(false);
  });

  test("still auto-allows reads of ordinary files", () => {
    expect(isAutoAllowedShellCall(shellCall("cat src/index.ts"))).toBe(true);
    expect(isAutoAllowedShellCall(shellCall("cat .env.example"))).toBe(true);
  });
});

describe("isAutoAllowedShellCall — environment dump", () => {
  test("does not auto-allow printenv (full env dump)", () => {
    expect(isAutoAllowedShellCall(shellCall("printenv"))).toBe(false);
    expect(isAutoAllowedShellCall(shellCall("printenv PATH"))).toBe(false);
  });

  test("does not auto-allow bare env", () => {
    expect(isAutoAllowedShellCall(shellCall("env"))).toBe(false);
  });
});

describe("isAutoAllowedShellCall — workspace containment", () => {
  test("denies reads of paths outside the workspace", () => {
    expect(isAutoAllowedShellCall(shellCall("cat /etc/passwd"), "/repo")).toBe(false);
    expect(isAutoAllowedShellCall(shellCall("strings /proc/self/environ"), "/repo")).toBe(false);
    expect(isAutoAllowedShellCall(shellCall("xxd ../../etc/hosts"), "/repo")).toBe(false);
    expect(isAutoAllowedShellCall(shellCall("cat ~/.aws/config"), "/repo")).toBe(false);
  });

  test("allows reads of paths inside the workspace", () => {
    expect(isAutoAllowedShellCall(shellCall("cat src/index.ts"), "/repo")).toBe(true);
    expect(isAutoAllowedShellCall(shellCall("wc -l README.md"), "/repo")).toBe(true);
    expect(isAutoAllowedShellCall(shellCall("ls -la"), "/repo")).toBe(true);
    expect(isAutoAllowedShellCall(shellCall("grep -n needle README.md"), "/repo")).toBe(true);
  });

  test("denies a workspace-escaping path glued to a grep/rg flag value", () => {
    expect(isAutoAllowedShellCall(shellCall("grep --file=/etc/passwd ."), "/repo")).toBe(false);
    expect(isAutoAllowedShellCall(shellCall("grep -f/etc/passwd ."), "/repo")).toBe(false);
    expect(isAutoAllowedShellCall(shellCall("rg --file=/etc/passwd ."), "/repo")).toBe(false);
    // A separated flag value is a positional token and already caught.
    expect(isAutoAllowedShellCall(shellCall("grep -f /etc/passwd ."), "/repo")).toBe(false);
  });

  test("allows an in-workspace flag-glued path", () => {
    expect(isAutoAllowedShellCall(shellCall("grep --file=patterns.txt src"), "/repo")).toBe(true);
  });
});

describe("sensitive-path shell commands require approval, not a hard deny", () => {
  test("secret-guard no longer hard-denies shell references to secret files", async () => {
    const middleware = secretGuardPlugin().middleware;
    if (middleware === undefined) throw new Error("secretGuardPlugin must provide middleware");
    const next = async () => ({ callId: "c", content: "ran", isError: false });
    const result = await middleware(next)(shellCall("cat .env"), new AbortController().signal);
    expect(result.isError).not.toBe(true);
    expect(result.content).toBe("ran");
  });

  test("auto mode forces ask for shell commands that reference secret files", () => {
    const rule = autoShellRuleForCall(shellCall("bun --env-file=.env.staging run publish.ts"));
    expect(rule?.name).toBe("sensitive-path");
    expect(rule?.effect).toBe("ask");
  });

  test("operator approval lets a sensitive-path shell command through the gate", async () => {
    let asked = 0;
    const gate = createPermissionGate({
      approvals: [],
      requestApproval: async () => {
        asked++;
        return { allow: true };
      },
      interactive: true,
      skipPermissions: false,
    });
    const verdict = await gate.evaluate(
      shellCall("bun --env-file=../../.env.staging run bin/publish.ts"),
    );
    expect(verdict.allowed).toBe(true);
    expect(asked).toBe(1);
  });

  test("auto mode still prompts (does not rubber-stamp) sensitive-path shell commands", async () => {
    let asked = 0;
    const gate = createPermissionGate({
      approvals: [],
      requestApproval: async () => {
        asked++;
        return { allow: true };
      },
      interactive: true,
      skipPermissions: false,
      auto: true,
    });
    const verdict = await gate.evaluate(shellCall("cat .env"));
    expect(verdict.allowed).toBe(true);
    expect(asked).toBe(1);
  });
});
