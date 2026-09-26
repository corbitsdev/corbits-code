import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  filterMcpServersForConnect,
  formatMcpTrustQuestion,
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
async function scratch(): Promise<{
  cwd: string;
  home: string;
  cleanup: () => Promise<void>;
}> {
  const base = await mkdtemp(join(tmpdir(), "corbits-trust-"));
  const cwd = join(base, "repo");
  const home = join(base, "home");
  await mkdir(cwd, { recursive: true });
  await mkdir(home, { recursive: true });
  return {
    cwd,
    home,
    cleanup: () => rm(base, { recursive: true, force: true }),
  };
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
      const server: MCPServerConfig = {
        name: "evil",
        command: "node",
        args: ["-e", "1"],
      };
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
      expect(result.store).toEqual({
        trustedPluginPaths: [],
        trustedMcpFingerprints: [],
        trustedGrantFingerprints: [],
      });
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
      expect(result.store).toEqual({
        trustedPluginPaths: [],
        trustedMcpFingerprints: [],
        trustedGrantFingerprints: [],
      });
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
          trustedGrantFingerprints: [],
        }),
        "utf8",
      );
      const result = await readProjectTrustStore(cwd, home);
      expect(result.state).toBe("invalid");
      expect(result.store).toEqual({
        trustedPluginPaths: [],
        trustedMcpFingerprints: [],
        trustedGrantFingerprints: [],
      });
    } finally {
      await cleanup();
    }
  });

  test("readProjectTrustStore: top-level JSON array is invalid", async () => {
    const { cwd, home, cleanup } = await scratch();
    try {
      const path = projectTrustPath(cwd, home);
      await mkdir(join(home, ".corbits", "trust"), { recursive: true });
      await writeFile(path, JSON.stringify([1, 2, 3]), "utf8");
      const result = await readProjectTrustStore(cwd, home);
      expect(result.state).toBe("invalid");
      expect(result.store).toEqual({
        trustedPluginPaths: [],
        trustedMcpFingerprints: [],
        trustedGrantFingerprints: [],
      });
    } finally {
      await cleanup();
    }
  });

  test("readProjectTrustStore: non-string repo field is invalid", async () => {
    const { cwd, home, cleanup } = await scratch();
    try {
      const path = projectTrustPath(cwd, home);
      await mkdir(join(home, ".corbits", "trust"), { recursive: true });
      await writeFile(
        path,
        JSON.stringify({
          repo: 7,
          trustedPluginPaths: [],
          trustedMcpFingerprints: [],
          trustedGrantFingerprints: [],
        }),
        "utf8",
      );
      const result = await readProjectTrustStore(cwd, home);
      expect(result.state).toBe("invalid");
      expect(result.store).toEqual({
        trustedPluginPaths: [],
        trustedMcpFingerprints: [],
        trustedGrantFingerprints: [],
      });
    } finally {
      await cleanup();
    }
  });

  test("readProjectTrustStore: partial file with only trustedPluginPaths stays valid", async () => {
    const { cwd, home, cleanup } = await scratch();
    try {
      const pluginPath = join(cwd, "plugins", "kept");
      const path = projectTrustPath(cwd, home);
      await mkdir(join(home, ".corbits", "trust"), { recursive: true });
      await writeFile(
        path,
        JSON.stringify({
          repo: cwd,
          trustedPluginPaths: [pluginPath],
        }),
        "utf8",
      );
      const result = await readProjectTrustStore(cwd, home);
      expect(result.state).toBe("valid");
      expect(result.store.trustedPluginPaths).toEqual([pluginPath]);
      expect(result.store.trustedMcpFingerprints).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test("readProjectTrustStore: mixed-type array keeps string entries", async () => {
    const { cwd, home, cleanup } = await scratch();
    try {
      const pluginPath = join(cwd, "plugins", "good");
      const path = projectTrustPath(cwd, home);
      await mkdir(join(home, ".corbits", "trust"), { recursive: true });
      await writeFile(
        path,
        JSON.stringify({
          repo: cwd,
          trustedPluginPaths: [pluginPath, 42, null, { bad: true }],
          trustedMcpFingerprints: ["abc123", false, "def456"],
        }),
        "utf8",
      );
      const result = await readProjectTrustStore(cwd, home);
      expect(result.state).toBe("valid");
      expect(result.store.trustedPluginPaths).toEqual([pluginPath]);
      expect(result.store.trustedMcpFingerprints).toEqual(["abc123", "def456"]);
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
      expect(result.store.trustedPluginPaths).toEqual([
        join(cwd, "plugins", "good"),
      ]);
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
      expect(
        mcpServerFingerprint({ ...server, env: { SECRET: "x" } }),
      ).not.toBe(fp);

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

  test("trust question quotes whitespace args so argv boundaries stay visible", () => {
    const one = formatMcpTrustQuestion({
      name: "s",
      command: "run",
      args: ["a b"],
    });
    const two = formatMcpTrustQuestion({
      name: "s",
      command: "run",
      args: ["a", "b"],
    });
    expect(one).toBe(
      'Trust local MCP server "s" for this project?\nCommand: run "a b"',
    );
    expect(one).not.toBe(two);
  });

  test("trust question escapes control characters so args stay single-line", () => {
    const question = formatMcpTrustQuestion({
      name: "s",
      command: "run",
      args: ["x\nTrust local MCP server evil", "a\tb", "c\rd"],
    });
    // Only the structural header/Command separator newline may remain.
    const lines = question.split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      for (const ch of line) {
        const code = ch.charCodeAt(0);
        expect(code > 0x1f && code !== 0x7f).toBe(true);
      }
    }
    expect(question).toContain('"x\\nTrust local MCP server evil"');
    expect(question).toContain('"a\\tb"');
    expect(question).toContain('"c\\rd"');
  });

  test("trust question quotes a spaced binary path so the command is unambiguous", () => {
    expect(
      formatMcpTrustQuestion({
        name: "s",
        command: "/tmp/my tool/server",
        args: ["--dir", "/tmp/work"],
      }),
    ).toBe(
      'Trust local MCP server "s" for this project?\nCommand: "/tmp/my tool/server" --dir /tmp/work',
    );
    expect(
      formatMcpTrustQuestion({ name: "s", command: "/tmp/my tool/server" }),
    ).toBe(
      'Trust local MCP server "s" for this project?\nCommand: "/tmp/my tool/server"',
    );
  });

  test("trust question leaves plain args unquoted and hides secrets", () => {
    expect(
      formatMcpTrustQuestion({
        name: "filesystem",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp/work"],
      }),
    ).toBe(
      'Trust local MCP server "filesystem" for this project?\nCommand: npx -y @modelcontextprotocol/server-filesystem /tmp/work',
    );
    const question = formatMcpTrustQuestion({
      name: "private",
      command: "private-server",
      env: { API_TOKEN: "super-secret" },
    });
    expect(question).toBe(
      'Trust local MCP server "private" for this project?\nCommand: private-server',
    );
    expect(question).not.toContain("super-secret");
  });

  test("trust question shows an HTTP server URL", () => {
    expect(
      formatMcpTrustQuestion({
        name: "remote",
        type: "http",
        url: "https://mcp.example.test/api",
      }),
    ).toBe(
      'Trust local MCP server "remote" for this project?\nURL: https://mcp.example.test/api',
    );
  });

  test("trust question shows URL not Command when command, args, and url are set without type", () => {
    const question = formatMcpTrustQuestion({
      name: "s",
      command: "run",
      args: ["--secret"],
      url: "https://mcp.example.test/api",
    });
    expect(question).toContain("\nURL: https://mcp.example.test/api");
    expect(question).not.toContain("Command:");
    expect(question).not.toContain("run");
  });

  test("trust question shows URL when type is http even if command is also set", () => {
    const question = formatMcpTrustQuestion({
      name: "s",
      type: "http",
      command: "run",
      url: "https://mcp.example.test/api",
    });
    expect(question).toContain("\nURL: https://mcp.example.test/api");
    expect(question).not.toContain("Command:");
  });

  test("trust question still shows Command when type is stdio even if url is set", () => {
    const question = formatMcpTrustQuestion({
      name: "s",
      type: "stdio",
      command: "run",
      args: ["a"],
      url: "https://mcp.example.test/api",
    });
    expect(question).toContain("\nCommand: run a");
    expect(question).not.toContain("URL:");
  });

  test("trust question escapes name so a newline or quote cannot inject extra Command lines", () => {
    const question = formatMcpTrustQuestion({
      name: 's"\nCommand: evil',
      command: "run",
      args: ["a"],
    });
    const lines = question.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]?.startsWith("Trust local MCP server")).toBe(true);
    expect(lines[1]).toBe("Command: run a");
    expect(question).not.toContain("\nCommand: evil");
    expect(question).toContain("\\n");
    expect(question).toContain('\\"');
  });

  test("trust question escapes url so an embedded newline stays single-line", () => {
    const question = formatMcpTrustQuestion({
      name: "remote",
      type: "http",
      url: "https://mcp.example.test/api\nCommand: evil",
    });
    const lines = question.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]?.startsWith("URL:")).toBe(true);
    expect(question).not.toContain("\nCommand:");
    expect(question).toContain("\\n");
  });

  test("trust question escapes Unicode line breaks and C1 controls in args", () => {
    const question = formatMcpTrustQuestion({
      name: "s",
      command: "run",
      args: ["x\u2028y", "a\u0085b"],
    });
    expect(question.split("\n")).toHaveLength(2);
    expect(question).not.toContain("\u2028");
    expect(question).not.toContain("\u0085");
    for (const line of question.split("\n")) {
      for (const ch of line) {
        const code = ch.charCodeAt(0);
        expect(
          code > 0x1f &&
            code !== 0x7f &&
            !(code >= 0x80 && code <= 0x9f) &&
            code !== 0x2028 &&
            code !== 0x2029,
        ).toBe(true);
      }
    }
  });

  test("mcp fingerprint still hashes command and url together", () => {
    const mixed: MCPServerConfig = {
      name: "s",
      command: "run",
      args: ["a"],
      url: "https://evil.test",
    };
    expect(mcpServerFingerprint(mixed)).toBe(
      "d06726e3489e2513056178f392b492a77aef02b239c8922c5a6cdca0b4fd886d",
    );
    expect(
      mcpServerFingerprint({
        name: "s",
        type: "http",
        command: "run",
        url: "https://mcp.example.test",
      }),
    ).toBe("75b80b4878d818362a918027917cd149c0d948d509b8c0c08b7406fd69de53b9");
  });

  test("readProjectTrustStore: malformed file with wrong types, missing fields, and extra fields drops bad entries and ignores unknown keys", async () => {
    const { cwd, home, cleanup } = await scratch();
    try {
      const pluginPath = join(cwd, "plugins", "good");
      const path = projectTrustPath(cwd, home);
      await mkdir(join(home, ".corbits", "trust"), { recursive: true });
      await writeFile(
        path,
        JSON.stringify({
          repo: cwd,
          trustedPluginPaths: [pluginPath, 7, false, { nope: true }],
          // trustedMcpFingerprints omitted entirely
          somethingUnexpected: "should be ignored",
        }),
        "utf8",
      );
      const result = await readProjectTrustStore(cwd, home);
      expect(result.state).toBe("valid");
      expect(result.store.trustedPluginPaths).toEqual([pluginPath]);
      expect(result.store.trustedMcpFingerprints).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test("interactive requestTrust can grant and persist", async () => {
    const { cwd, home, cleanup } = await scratch();
    try {
      const server: MCPServerConfig = {
        name: "files",
        command: "npx",
        args: ["-y", "x"],
      };
      const allowed = await filterMcpServersForConnect([server], {
        source: "local",
        store: await loadProjectTrust(cwd, home),
        cwd,
        home,
        requestTrust: async () => true,
      });
      expect(allowed).toEqual([server]);
      expect(
        isMcpServerTrusted(await loadProjectTrust(cwd, home), server),
      ).toBe(true);
    } finally {
      await cleanup();
    }
  });
});
