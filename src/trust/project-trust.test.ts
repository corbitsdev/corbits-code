import { describe, test, expect } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { resolve } from "node:path";

import {
  isPluginTrusted,
  filterMcpServersForConnect,
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
  test("connects global MCP servers without local trust and fails closed for local lists", async () => {
    const servers = [
      { name: "exa", type: "http" as const, url: "https://mcp.exa.ai/mcp" },
      { name: "global", command: "global-mcp" },
    ];

    await expect(
      filterMcpServersForConnect(servers, {
        source: "global",
        cwd: "/repo/under/test",
        store: { trustedPluginPaths: [], trustedMcpFingerprints: [] },
      }),
    ).resolves.toEqual(servers);
    await expect(
      filterMcpServersForConnect(servers, {
        source: "local",
        cwd: "/repo/under/test",
        store: { trustedPluginPaths: [], trustedMcpFingerprints: [] },
      }),
    ).resolves.toEqual([]);
  });

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

  test("a relative grant resolves against the project cwd, not process.cwd()", async () => {
    // process.cwd() during test runs is the repo checkout, not the project
    // directory under test — a real-world stand-in for "some other tree".
    expect(process.cwd()).not.toBe("/repo/under/test");
    await withTempHome(async (home, cwd) => {
      await trustPlugin(cwd, "relative/plugin", home);

      const store = await loadProjectTrust(cwd, home);
      expect(store.trustedPluginPaths).toEqual([resolve(cwd, "relative/plugin")]);

      // The grant binds to the project cwd's tree...
      expect(isPluginTrusted(store, "relative/plugin", cwd)).toBe(true);
      // ...not to process.cwd()'s tree, even though it resolves the same
      // relative string.
      expect(isPluginTrusted(store, "relative/plugin", process.cwd())).toBe(false);
      expect(isPluginTrusted(store, resolve(process.cwd(), "relative/plugin"))).toBe(false);
    });
  });

  test("a non-absolute trustedPluginPaths entry on disk is dropped on load, not resolved against process.cwd()", async () => {
    await withTempHome(async (home, cwd) => {
      const path = projectTrustPath(cwd, home);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(
        path,
        JSON.stringify({
          repo: cwd,
          trustedPluginPaths: ["relative/plugin", "/plugins/absolute"],
          trustedMcpFingerprints: [],
        }),
      );

      const result = await readProjectTrustStore(cwd, home);
      expect(result.state).toBe("valid");
      expect(result.store.trustedPluginPaths).toEqual(["/plugins/absolute"]);
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

  test("grants written via one symlink twin are found via the other (same repo, two spellings)", async () => {
    const home = await mkdtemp(join(tmpdir(), "project-trust-test-home-"));
    const realRepoParent = await mkdtemp(join(tmpdir(), "project-trust-test-real-"));
    const realRepo = join(realRepoParent, "repo");
    await mkdir(realRepo, { recursive: true });
    const linkRepo = join(realRepoParent, "repo-link");
    await symlink(realRepo, linkRepo);

    try {
      // Same directory on disk, reached through two different lexical
      // spellings — the macOS /tmp vs /private/tmp scenario in miniature.
      await trustPlugin(realRepo, "/plugins/a", home);
      await trustMcpServer(linkRepo, mcpServer("via-link"), home);

      // Both spellings must key to the same on-disk store file.
      expect(projectTrustPath(realRepo, home)).toBe(projectTrustPath(linkRepo, home));

      const viaReal = await loadProjectTrust(realRepo, home);
      const viaLink = await loadProjectTrust(linkRepo, home);
      expect(viaReal.trustedPluginPaths).toEqual(["/plugins/a"]);
      expect(viaLink.trustedPluginPaths).toEqual(["/plugins/a"]);
      expect(viaReal.trustedMcpFingerprints).toEqual(viaLink.trustedMcpFingerprints);
      expect(viaLink.trustedMcpFingerprints).toHaveLength(1);

      // Relaunching "through" the symlink twin still finds the grant valid
      // (not rejected by the repo-mismatch guard).
      const result = await readProjectTrustStore(linkRepo, home);
      expect(result.state).toBe("valid");
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(realRepoParent, { recursive: true, force: true });
    }
  });
});
