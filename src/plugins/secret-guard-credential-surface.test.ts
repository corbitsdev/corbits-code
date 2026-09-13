import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolCall, ToolResult } from "@intx/types/runtime";
import { resolveAtMentions } from "../tui/mention-resolution.js";
import {
  isSensitivePath,
  isSensitivePathResolved,
  secretGuardPlugin,
} from "./secret-guard-plugin.js";

const CODEX_BYTES =
  '{"profiles":{"personal":{"tokens":{"access":"CODEX-FIXTURE-ACCESS"}}}}';
const XAI_BYTES =
  '{"profiles":{"personal":{"tokens":{"access":"XAI-FIXTURE-ACCESS"}}}}';
const MCP_BYTES = '{"tokens":{"access_token":"MCP-FIXTURE-ACCESS"}}';

async function fakeHome(): Promise<{
  home: string;
  codexAuth: string;
  xaiAuth: string;
  settings: string;
  permissions: string;
  mcpAuth: string;
  cleanup: () => Promise<void>;
}> {
  const home = await mkdtemp(join(tmpdir(), "cl7789-fake-home-"));
  const configDir = join(home, ".corbits");
  const mcpDir = join(configDir, "mcp-auth");
  await mkdir(mcpDir, { recursive: true });
  const codexAuth = join(configDir, "codex-auth.json");
  const xaiAuth = join(configDir, "xai-auth.json");
  const settings = join(configDir, "settings.json");
  const permissions = join(configDir, "permissions.json");
  const mcpAuth = join(
    mcpDir,
    "my-server-9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00.json",
  );
  await writeFile(codexAuth, `${CODEX_BYTES}\n`);
  await writeFile(xaiAuth, `${XAI_BYTES}\n`);
  await writeFile(settings, '{"provider":"codex"}\n');
  await writeFile(permissions, '{"approvals":[]}\n');
  await writeFile(mcpAuth, `${MCP_BYTES}\n`);
  return {
    home,
    codexAuth,
    xaiAuth,
    settings,
    permissions,
    mcpAuth,
    cleanup: () => rm(home, { recursive: true, force: true }),
  };
}

const next = async (call: ToolCall): Promise<ToolResult> => ({
  callId: call.id,
  content: "ok",
});

function denyReason(path: string): Promise<ToolResult> {
  const plugin = secretGuardPlugin();
  const handler = plugin.middleware ? plugin.middleware(next) : next;
  return handler(
    { id: "c", name: "read_file", arguments: { path } },
    new AbortController().signal,
  );
}

describe("CL-7789 default-install credential surface", () => {
  test("lexical denylist covers every default credential file", async () => {
    const fake = await fakeHome();
    try {
      for (const path of [
        fake.codexAuth,
        fake.xaiAuth,
        fake.settings,
        fake.permissions,
        fake.mcpAuth,
      ]) {
        expect(isSensitivePath(path)).toBe(true);
        expect(isSensitivePathResolved(path)).toBe(true);
      }
    } finally {
      await fake.cleanup();
    }
  });

  test("read_file hard-denies every default credential file", async () => {
    const fake = await fakeHome();
    try {
      for (const path of [
        fake.codexAuth,
        fake.xaiAuth,
        fake.settings,
        fake.permissions,
        fake.mcpAuth,
      ]) {
        const result = await denyReason(path);
        expect(result.isError).toBe(true);
        expect(String(result.content)).toMatch(/sensitive file blocked/);
      }
    } finally {
      await fake.cleanup();
    }
  });

  test("credential backups and sidecars resolve as sensitive", () => {
    const home = join(tmpdir(), "cl7789-never-created");
    for (const basename of [
      "settings.json",
      "permissions.json",
      "codex-auth.json",
      "xai-auth.json",
    ]) {
      expect(
        isSensitivePathResolved(
          join(home, ".corbits", `${basename}.bak-2026-01-01`),
        ),
      ).toBe(true);
    }
    expect(
      isSensitivePathResolved(
        join(
          home,
          ".corbits",
          "mcp-auth",
          "my-server-9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00.json.bak-2026-01-01",
        ),
      ),
    ).toBe(true);
    expect(
      isSensitivePathResolved(join(home, ".corbits", "codex-auth.json.lock")),
    ).toBe(true);
    for (const basename of [
      "settings.json",
      "permissions.json",
      "codex-auth.json",
      "xai-auth.json",
    ]) {
      expect(
        isSensitivePathResolved(join(home, ".corbits", `${basename}~`)),
      ).toBe(true);
      expect(
        isSensitivePathResolved(join(home, ".corbits", `${basename}.swp`)),
      ).toBe(true);
      expect(
        isSensitivePathResolved(join(home, ".corbits", `.${basename}.swp`)),
      ).toBe(true);
    }
    expect(
      isSensitivePathResolved(
        join(home, ".corbits", "xai-auth.json.12345.1.tmp"),
      ),
    ).toBe(true);
  });

  test("@mentions of credential files stay blocked without leaking bytes", async () => {
    const fake = await fakeHome();
    const cwd = await mkdtemp(join(tmpdir(), "cl7789-mention-cwd-"));
    try {
      for (const [path, marker] of [
        [fake.codexAuth, "CODEX-FIXTURE-ACCESS"],
        [fake.mcpAuth, "access_token"],
      ] as const) {
        const resolved = await resolveAtMentions(`read @${path}`, cwd);
        expect(resolved).toContain("(blocked: sensitive path)");
        expect(resolved).not.toContain(marker);
      }
    } finally {
      await fake.cleanup();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("@mentions of credential backup paths stay blocked without leaking bytes", async () => {
    const fake = await fakeHome();
    const cwd = await mkdtemp(join(tmpdir(), "cl7789-mention-bak-cwd-"));
    try {
      const backup = `${fake.codexAuth}.bak-2026-01-01`;
      await writeFile(backup, `${CODEX_BYTES}\n`);
      const resolved = await resolveAtMentions(`read @${backup}`, cwd);
      expect(resolved).toContain("(blocked: sensitive path)");
      expect(resolved).not.toContain("CODEX-FIXTURE-ACCESS");
    } finally {
      await fake.cleanup();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("a symlink to a credential file is blocked by mention and by read", async () => {
    const fake = await fakeHome();
    const cwd = await mkdtemp(join(tmpdir(), "cl7789-symlink-cwd-"));
    try {
      const link = join(cwd, "link-to-codex-auth");
      await symlink(fake.codexAuth, link);
      const denied = await denyReason(link);
      expect(denied.isError).toBe(true);
      expect(String(denied.content)).toMatch(/sensitive file blocked/);
      const resolved = await resolveAtMentions(`read @${link}`, cwd);
      expect(resolved).toContain("(blocked: sensitive path)");
      expect(resolved).not.toContain("CODEX-FIXTURE-ACCESS");
    } finally {
      await fake.cleanup();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
