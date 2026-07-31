import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  readProjectTrustStore,
  trustMcpServer,
  trustPlugin,
} from "../../src/trust/project-trust.js";
import type { MCPServerConfig } from "../../src/config/settings.js";

// Every test injects a temp `home` so the trust store never touches the real
// ~/.corbits and the tests stay hermetic.
async function scratch(): Promise<{ cwd: string; home: string; cleanup: () => Promise<void> }> {
  const base = await mkdtemp(join(tmpdir(), "corbits-trust-"));
  const cwd = join(base, "repo");
  const home = join(base, "home");
  await mkdir(cwd, { recursive: true });
  await mkdir(home, { recursive: true });
  return { cwd, home, cleanup: () => rm(base, { recursive: true, force: true }) };
}

describe("project-trust", () => {
  test("originRequiresTrust only for project and path", () => {
    expect(originRequiresTrust("repo")).toBe(false);
    expect(originRequiresTrust("user")).toBe(false);
    expect(originRequiresTrust("project")).toBe(true);
    expect(originRequiresTrust("path")).toBe(true);
  });

  test("trust store lives under home, not inside the repo", async () => {
    const { cwd, home, cleanup } = await scratch();
    try {
      const path = projectTrustPath(cwd, home);
      expect(path.startsWith(join(home, ".corbits", "trust"))).toBe(true);
      expect(path.startsWith(cwd)).toBe(false);
    } finally {
      await cleanup();
    }
  });

  test("trustPlugin persists absolute path and reloads", async () => {
    const { cwd, home, cleanup } = await scratch();
    try {
      const pluginPath = join(cwd, ".corbits", "plugins", "evil");
      const store = await trustPlugin(cwd, pluginPath, home);
      expect(isPluginTrusted(store, pluginPath)).toBe(true);
      const reloaded = await loadProjectTrust(cwd, home);
      expect(isPluginTrusted(reloaded, pluginPath)).toBe(true);
      const raw = await readFile(projectTrustPath(cwd, home), "utf8");
      expect(raw).toContain(pluginPath);
    } finally {
      await cleanup();
    }
  });

  test("SECURITY: a trust.json shipped inside the repo grants nothing", async () => {
    const { cwd, home, cleanup } = await scratch();
    try {
      const server: MCPServerConfig = { name: "evil", command: "node", args: ["-e", "1"] };
      // Attacker ships a pre-forged consent file at the OLD in-repo location
      // with the correct fingerprint precomputed.
      const repoTrust = join(cwd, ".corbits", "trust.json");
      await mkdir(join(cwd, ".corbits"), { recursive: true });
      await writeFile(
        repoTrust,
        JSON.stringify({
          trustedPluginPaths: [join(cwd, ".corbits", "plugins", "evil")],
          trustedMcpFingerprints: [mcpServerFingerprint(server)],
        }),
      );
      // Loading trust for this repo must ignore the in-repo file entirely.
      const store = await loadProjectTrust(cwd, home);
      expect(store.trustedMcpFingerprints).toEqual([]);
      expect(store.trustedPluginPaths).toEqual([]);
      expect(isMcpServerTrusted(store, server)).toBe(false);
      const denied = await filterMcpServersForConnect([server], {
        source: "local",
        store,
        cwd,
        home,
      });
      expect(denied).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test("SECURITY: a home-store record keyed to another repo is rejected", async () => {
    const { cwd, home, cleanup } = await scratch();
    try {
      // Write a valid-looking record but stamped with a different repo path.
      const path = projectTrustPath(cwd, home);
      await mkdir(join(home, ".corbits", "trust"), { recursive: true });
      await writeFile(
        path,
        JSON.stringify({
          repo: join(cwd, "..", "other-repo"),
          trustedMcpFingerprints: ["deadbeef"],
          trustedPluginPaths: [],
        }),
      );
      const result = await readProjectTrustStore(cwd, home);
      expect(result.state).toBe("invalid");
      expect(result.store.trustedMcpFingerprints).toEqual([]);
      const store = await loadProjectTrust(cwd, home);
      expect(store.trustedMcpFingerprints).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test("readProjectTrustStore: missing file is missing with empty store", async () => {
    const { cwd, home, cleanup } = await scratch();
    try {
      const result = await readProjectTrustStore(cwd, home);
      expect(result.state).toBe("missing");
      expect(result.store).toEqual({ trustedPluginPaths: [], trustedMcpFingerprints: [] });
    } finally {
      await cleanup();
    }
  });

  test("readProjectTrustStore: corrupt JSON is invalid with empty store", async () => {
    const { cwd, home, cleanup } = await scratch();
    try {
      const path = projectTrustPath(cwd, home);
      await mkdir(join(home, ".corbits", "trust"), { recursive: true });
      await writeFile(path, "{ not json", "utf8");
      const result = await readProjectTrustStore(cwd, home);
      expect(result.state).toBe("invalid");
      expect(result.store).toEqual({ trustedPluginPaths: [], trustedMcpFingerprints: [] });
    } finally {
      await cleanup();
    }
  });

  test("readProjectTrustStore: wrong shape is invalid", async () => {
    const { cwd, home, cleanup } = await scratch();
    try {
      const path = projectTrustPath(cwd, home);
      await mkdir(join(home, ".corbits", "trust"), { recursive: true });
      await writeFile(
        path,
        JSON.stringify({
          repo: cwd,
          trustedPluginPaths: "nope",
          trustedMcpFingerprints: [],
        }),
        "utf8",
      );
      const result = await readProjectTrustStore(cwd, home);
      expect(result.state).toBe("invalid");
      expect(result.store).toEqual({ trustedPluginPaths: [], trustedMcpFingerprints: [] });
    } finally {
      await cleanup();
    }
  });

  test("readProjectTrustStore: valid file is valid with resolved absolute paths", async () => {
    const { cwd, home, cleanup } = await scratch();
    try {
      const pluginRel = join(cwd, "plugins", "good");
      const path = projectTrustPath(cwd, home);
      await mkdir(join(home, ".corbits", "trust"), { recursive: true });
      await writeFile(
        path,
        JSON.stringify({
          repo: cwd,
          trustedPluginPaths: [pluginRel],
          trustedMcpFingerprints: ["abc123"],
        }),
        "utf8",
      );
      const result = await readProjectTrustStore(cwd, home);
      expect(result.state).toBe("valid");
      expect(result.store.trustedPluginPaths).toEqual([join(cwd, "plugins", "good")]);
      expect(result.store.trustedMcpFingerprints).toEqual(["abc123"]);
      // loadProjectTrust remains store-only for callers.
      const storeOnly = await loadProjectTrust(cwd, home);
      expect(storeOnly).toEqual(result.store);
    } finally {
      await cleanup();
    }
  });

  test("mcp fingerprint is stable, binds env key names, and trust gates filter", async () => {
    const { cwd, home, cleanup } = await scratch();
    try {
      const server: MCPServerConfig = {
        name: "evil",
        command: "node",
        args: ["-e", "process.exit(0)"],
      };
      const fp = mcpServerFingerprint(server);
      expect(mcpServerFingerprint({ ...server })).toBe(fp);
      // Adding an injected env var invalidates a prior grant.
      expect(mcpServerFingerprint({ ...server, env: { SECRET: "x" } })).not.toBe(fp);

      const empty = await loadProjectTrust(cwd, home);
      expect(isMcpServerTrusted(empty, server)).toBe(false);

      const denied = await filterMcpServersForConnect([server], {
        source: "local",
        store: empty,
        cwd,
        home,
      });
      expect(denied).toEqual([]);

      const globalAllowed = await filterMcpServersForConnect([server], {
        source: "global",
        store: empty,
        cwd,
        home,
      });
      expect(globalAllowed).toEqual([server]);

      await trustMcpServer(cwd, server, home);
      const trusted = await loadProjectTrust(cwd, home);
      const allowed = await filterMcpServersForConnect([server], {
        source: "local",
        store: trusted,
        cwd,
        home,
      });
      expect(allowed).toEqual([server]);
    } finally {
      await cleanup();
    }
  });

  test("interactive requestTrust can grant and persist", async () => {
    const { cwd, home, cleanup } = await scratch();
    try {
      const server: MCPServerConfig = { name: "files", command: "npx", args: ["-y", "x"] };
      const allowed = await filterMcpServersForConnect([server], {
        source: "local",
        store: await loadProjectTrust(cwd, home),
        cwd,
        home,
        requestTrust: async () => true,
      });
      expect(allowed).toEqual([server]);
      expect(isMcpServerTrusted(await loadProjectTrust(cwd, home), server)).toBe(true);
    } finally {
      await cleanup();
    }
  });
});
