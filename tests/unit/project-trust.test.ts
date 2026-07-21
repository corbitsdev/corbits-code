import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  filterMcpServersForConnect,
  isMcpServerTrusted,
  isPluginTrusted,
  loadProjectTrust,
  mcpServerFingerprint,
  originRequiresTrust,
  projectTrustPath,
  trustMcpServer,
  trustPlugin,
} from "../../src/trust/project-trust.js";
import type { MCPServerConfig } from "../../src/config/settings.js";

describe("project-trust", () => {
  test("originRequiresTrust only for project and path", () => {
    expect(originRequiresTrust("repo")).toBe(false);
    expect(originRequiresTrust("user")).toBe(false);
    expect(originRequiresTrust("project")).toBe(true);
    expect(originRequiresTrust("path")).toBe(true);
  });

  test("trustPlugin persists absolute path and reloads", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "intercode-trust-"));
    try {
      const pluginPath = join(cwd, ".intercode", "plugins", "evil");
      const store = await trustPlugin(cwd, pluginPath);
      expect(isPluginTrusted(store, pluginPath)).toBe(true);
      const reloaded = await loadProjectTrust(cwd);
      expect(isPluginTrusted(reloaded, pluginPath)).toBe(true);
      const raw = await readFile(projectTrustPath(cwd), "utf8");
      expect(raw).toContain(pluginPath);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("mcp fingerprint is stable and trust gates filter", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "intercode-mcp-trust-"));
    try {
      const server: MCPServerConfig = {
        name: "evil",
        command: "node",
        args: ["-e", "process.exit(0)"],
      };
      const fp = mcpServerFingerprint(server);
      expect(mcpServerFingerprint({ ...server })).toBe(fp);

      const empty = await loadProjectTrust(cwd);
      expect(isMcpServerTrusted(empty, server)).toBe(false);

      // Fail closed without requestTrust
      const denied = await filterMcpServersForConnect([server], {
        source: "local",
        store: empty,
        cwd,
      });
      expect(denied).toEqual([]);

      // Global source skips trust
      const globalAllowed = await filterMcpServersForConnect([server], {
        source: "global",
        store: empty,
        cwd,
      });
      expect(globalAllowed).toEqual([server]);

      await trustMcpServer(cwd, server);
      const trusted = await loadProjectTrust(cwd);
      const allowed = await filterMcpServersForConnect([server], {
        source: "local",
        store: trusted,
        cwd,
      });
      expect(allowed).toEqual([server]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("interactive requestTrust can grant and persist", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "intercode-mcp-tofu-"));
    try {
      const server: MCPServerConfig = { name: "files", command: "npx", args: ["-y", "x"] };
      const allowed = await filterMcpServersForConnect([server], {
        source: "local",
        store: await loadProjectTrust(cwd),
        cwd,
        requestTrust: async () => true,
      });
      expect(allowed).toEqual([server]);
      expect(isMcpServerTrusted(await loadProjectTrust(cwd), server)).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
