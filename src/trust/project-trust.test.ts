import { describe, test, expect } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  loadProjectTrust,
  projectTrustPath,
  readProjectTrustStore,
  trustMcpServer,
  trustPlugin,
  type ProjectTrustStore,
} from "./project-trust.js";
import type { MCPServerConfig } from "../config/settings.js";

async function withTempHome(fn: (home: string, cwd: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "project-trust-test-"));
  try {
    await fn(home, "/repo/under/test");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

const mcpServer = (name: string): MCPServerConfig => ({ name, command: "node", args: [name] });

describe("project trust store", () => {
  test("concurrent plugin trust grants both survive without a corrupt file", async () => {
    await withTempHome(async (home, cwd) => {
      await Promise.all([
        trustPlugin(cwd, "/plugins/a", home),
        trustPlugin(cwd, "/plugins/b", home),
      ]);

      const store = await loadProjectTrust(cwd, home);
      expect(store.trustedPluginPaths.sort()).toEqual(["/plugins/a", "/plugins/b"]);

      // File on disk must be complete, valid JSON — not truncated by an
      // interleaved write.
      const raw = await readFile(projectTrustPath(cwd, home), "utf8");
      expect(() => JSON.parse(raw)).not.toThrow();
    });
  });

  test("concurrent plugin-trust and MCP-trust updates both survive", async () => {
    await withTempHome(async (home, cwd) => {
      const server1 = mcpServer("server-one");
      const server2 = mcpServer("server-two");

      await Promise.all([
        trustPlugin(cwd, "/plugins/a", home),
        trustMcpServer(cwd, server1, home),
        trustPlugin(cwd, "/plugins/b", home),
        trustMcpServer(cwd, server2, home),
      ]);

      const store: ProjectTrustStore = await loadProjectTrust(cwd, home);
      expect(store.trustedPluginPaths.sort()).toEqual(["/plugins/a", "/plugins/b"]);
      expect(store.trustedMcpFingerprints).toHaveLength(2);

      const raw = await readFile(projectTrustPath(cwd, home), "utf8");
      expect(() => JSON.parse(raw)).not.toThrow();
    });
  });

  test("many concurrent writers never drop a grant", async () => {
    await withTempHome(async (home, cwd) => {
      const pluginPaths = Array.from({ length: 20 }, (_, i) => `/plugins/p${i}`);
      const servers = Array.from({ length: 20 }, (_, i) => mcpServer(`server-${i}`));

      await Promise.all([
        ...pluginPaths.map((p) => trustPlugin(cwd, p, home)),
        ...servers.map((s) => trustMcpServer(cwd, s, home)),
      ]);

      const store = await loadProjectTrust(cwd, home);
      expect(store.trustedPluginPaths).toHaveLength(pluginPaths.length);
      expect(store.trustedMcpFingerprints).toHaveLength(servers.length);

      const raw = await readFile(projectTrustPath(cwd, home), "utf8");
      const parsed = JSON.parse(raw);
      expect(Array.isArray(parsed.trustedPluginPaths)).toBe(true);
      expect(Array.isArray(parsed.trustedMcpFingerprints)).toBe(true);
    });
  });

  test("no leftover .tmp file remains after concurrent writes settle", async () => {
    await withTempHome(async (home, cwd) => {
      await Promise.all([
        trustPlugin(cwd, "/plugins/a", home),
        trustPlugin(cwd, "/plugins/b", home),
        trustMcpServer(cwd, mcpServer("s"), home),
      ]);
      const path = projectTrustPath(cwd, home);
      const tmp = `${path}.${process.pid}.tmp`;
      const exists = await readFile(tmp, "utf8").then(
        () => true,
        () => false,
      );
      expect(exists).toBe(false);
    });
  });

  test("store without a repo field is invalid, not defaulted to empty-but-valid", async () => {
    await withTempHome(async (home, cwd) => {
      const path = projectTrustPath(cwd, home);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(
        path,
        JSON.stringify({ trustedPluginPaths: ["/plugins/a"], trustedMcpFingerprints: [] }),
      );

      const result = await readProjectTrustStore(cwd, home);
      expect(result.state).toBe("invalid");
      expect(result.store.trustedPluginPaths).toEqual([]);
      expect(result.store.trustedMcpFingerprints).toEqual([]);
    });
  });

  test("store with a non-string repo field is invalid", async () => {
    await withTempHome(async (home, cwd) => {
      const path = projectTrustPath(cwd, home);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify({ repo: 12345, trustedPluginPaths: [] }));

      const result = await readProjectTrustStore(cwd, home);
      expect(result.state).toBe("invalid");
      expect(result.store).toEqual({ trustedPluginPaths: [], trustedMcpFingerprints: [] });
    });
  });
});
