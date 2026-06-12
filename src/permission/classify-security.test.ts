import { describe, test, expect } from "bun:test";
import type { ToolCall } from "@intx/types/runtime";
import { isAutoAllowedShellCall } from "./classify.js";
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

  test("still auto-allows ordinary rg/grep searches", () => {
    expect(isAutoAllowedShellCall(shellCall("rg pattern src"))).toBe(true);
    expect(isAutoAllowedShellCall(shellCall("grep -r needle ."))).toBe(true);
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

describe("secret-guard plugin hard-denies regardless of classification", () => {
  test("blocks cat .env at the plugin layer even when not auto-allowed", async () => {
    const middleware = secretGuardPlugin().middleware;
    if (middleware === undefined) throw new Error("secretGuardPlugin must provide middleware");
    const next = async () => ({ callId: "c", content: "should not run", isError: false });
    const result = await middleware(next)(shellCall("cat .env"), new AbortController().signal);
    expect(result.isError).toBe(true);
    expect(typeof result.content === "string" ? result.content : "").toContain("sensitive file blocked");
  });
});
