import { describe, test, expect } from "bun:test";
import { secretGuardPlugin, isSensitivePath } from "./secret-guard-plugin.js";
import type { ToolCall, ToolResult } from "@intx/types/runtime";

const next = async (call: ToolCall): Promise<ToolResult> => ({ callId: call.id, content: "ok" });

function handler() {
  const plugin = secretGuardPlugin();
  return plugin.middleware ? plugin.middleware(next) : next;
}

const read = (path: string): ToolCall => ({ id: "c", name: "read_file", arguments: { path } });

describe("isSensitivePath", () => {
  const sensitive = [
    ".env",
    ".env.local",
    ".env.production",
    "/abs/path/.env",
    "config/.dev.vars",
    ".npmrc",
    ".git-credentials",
    ".ssh/id_rsa",
    "secrets/server.pem",
    "id_ed25519",
    ".aws/credentials",
    ".interchange/settings.json",
    "/Users/me/.interchange/settings.json",
  ];
  for (const p of sensitive) {
    test(`flags ${p}`, () => expect(isSensitivePath(p)).toBe(true));
  }

  const ok = ["src/index.ts", "README.md", "env.ts", "environment.json", ".env.example.md", "docs/pem.md", ".interchange/hooks/post-turn.ts"];
  for (const p of ok) {
    test(`allows ${p}`, () => expect(isSensitivePath(p)).toBe(false));
  }
});

describe("secretGuardPlugin", () => {
  test("denies reading a sensitive file", async () => {
    const result = await handler()(read(".env"), new AbortController().signal);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/sensitive file blocked/);
  });

  test("denies writing a sensitive file", async () => {
    const call: ToolCall = { id: "c", name: "write_file", arguments: { path: ".ssh/id_rsa", content: "x" } };
    const result = await handler()(call, new AbortController().signal);
    expect(result.isError).toBe(true);
  });

  test("allows an ordinary source file", async () => {
    const result = await handler()(read("src/index.ts"), new AbortController().signal);
    expect(result.isError).not.toBe(true);
  });
});
