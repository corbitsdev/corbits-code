import { describe, expect, test } from "bun:test";
import { withMockedModuleDuring } from "../../testkit/mock-module.js";
import { sandboxFromSettings } from "../config/settings.js";
import {
  buildSandboxRuntimeConfig,
  createShellSandbox,
  quotePosixArgv,
  type SandboxManagerLike,
} from "./sandbox-config.js";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { Settings } from "../config/settings.js";
import type { ShellSandbox } from "./sandbox-config.js";

const tmpCwd = process.cwd();

function sandboxSettings(enabled: boolean, allowedHosts?: string[]): Settings {
  return {
    providers: {},
    ...(enabled || allowedHosts !== undefined
      ? {
          shell: {
            sandbox: {
              ...(enabled ? { enabled: true } : {}),
              ...(allowedHosts !== undefined
                ? { network: { allowedHosts } }
                : {}),
            },
          },
        }
      : {}),
  };
}

// Minimal glob matcher for the denyRead table's own grammar: `**/` depth
// prefixes, a trailing `/**`, and `*` inside a name. Magic splitter tokens
// keep the widened replacements out of the later "any other *" rewrite.
// Enough to assert coverage of representative sensitive paths; anything
// fancier belongs in srt itself.
function globCovers(glob: string, path: string): boolean {
  const DIR = "[[DIR]]";
  const TAIL = "[[TAIL]]";
  const source = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, DIR)
    .replace(/\/\*\*/g, TAIL)
    .replace(/\*/g, "[^/]*")
    .split(DIR)
    .join("(?:[^/]*/)*")
    .split(TAIL)
    .join("(?:/.*)");
  return new RegExp(`^${source}$`).test(path);
}

// A denyRead entry covers `path` when a glob or literal entry matches.
function denyCovers(
  denyRead: readonly (string | { path: string; literal: true })[],
  path: string,
): boolean {
  return denyRead.some((entry) =>
    typeof entry === "string" ? globCovers(entry, path) : entry.path === path,
  );
}

function fakeGate() {
  const asks: { name: string; url: string }[] = [];
  return {
    asks,
    evaluate: async (call: {
      name: string;
      arguments: Record<string, unknown>;
    }) => {
      asks.push({ name: call.name, url: String(call.arguments["url"] ?? "") });
      return { allowed: true as const };
    },
  };
}

/** createShellSandbox returns undefined when disabled; these tests require it enabled. */
function mustSandbox(options: {
  sessionRoot: string;
  settings: Settings;
  gate: ReturnType<typeof fakeGate>;
  manager: SandboxManagerLike;
  extraDeniedPaths?: readonly string[];
}): ShellSandbox {
  const sandbox = createShellSandbox(options);
  if (sandbox === undefined) throw new Error("expected sandbox to be enabled");
  return sandbox;
}

function fakeManager(
  overrides: Partial<SandboxManagerLike> = {},
): SandboxManagerLike {
  // getConfig mirrors the real singleton's contract: defined between
  // initialize() and reset(), undefined otherwise — a torn-down detectable
  // manager without extra plumbing.
  let activeConfig: SandboxRuntimeConfig | undefined = undefined;
  return {
    initialize: async (config, ask) => {
      activeConfig = config;
      await overrides.initialize?.(config, ask);
    },
    getConfig: () =>
      overrides.getConfig !== undefined ? overrides.getConfig() : activeConfig,
    wrapWithSandbox: async (command) =>
      overrides.wrapWithSandbox !== undefined
        ? overrides.wrapWithSandbox(command)
        : `wrapped ${command}`,
    wrapWithSandboxArgv: async (command) =>
      overrides.wrapWithSandboxArgv !== undefined
        ? overrides.wrapWithSandboxArgv(command)
        : { argv: ["/bin/sh", "-c", command], env: {} },
    isSupportedPlatform: () => overrides.isSupportedPlatform?.() ?? true,
    reset: async () => {
      activeConfig = undefined;
      await overrides.reset?.();
    },
  };
}

describe("sandbox settings resolution", () => {
  test("default off: unset settings resolve to enabled=false", () => {
    expect(sandboxFromSettings(undefined)).toEqual({ enabled: false });
    expect(sandboxFromSettings(null)).toEqual({ enabled: false });
    expect(sandboxFromSettings({ providers: {} })).toEqual({ enabled: false });
  });

  test("sandbox block resolves the enable flag and the network allowlist", () => {
    expect(sandboxFromSettings(sandboxSettings(true))).toEqual({
      enabled: true,
    });
    expect(
      sandboxFromSettings(sandboxSettings(true, ["api.example.com"])),
    ).toEqual({
      enabled: true,
      network: { allowedHosts: ["api.example.com"] },
    });
  });
});

describe("buildSandboxRuntimeConfig", () => {
  test("workspace, tmpdir, and /tmp/claude are writable; secrets denied", () => {
    const config = buildSandboxRuntimeConfig({ sessionRoot: tmpCwd });
    expect(config.network).toEqual({ allowedDomains: [], deniedDomains: [] });
    expect(config.filesystem.allowWrite).toContain(tmpCwd);
    expect(config.filesystem.allowWrite).toContain("/tmp/claude");
    expect(config.filesystem.allowWrite).toContain("/private/tmp/claude");
    expect(config.filesystem.denyRead).toContain("**/.env");
  });

  test("representative sensitive paths are denied; templates stay readable", () => {
    const config = buildSandboxRuntimeConfig({ sessionRoot: tmpCwd });
    const denyRead = config.filesystem.denyRead;
    const representatives = [
      "/home/u/.env",
      "/home/u/.env.local",
      "/repo/.envrc",
      "/home/u/.dev.vars",
      "/home/u/.npmrc",
      "/home/u/.netrc",
      "/home/u/.git-credentials",
      "/home/u/.pgpass",
      "/home/u/.ssh/id_rsa",
      "/home/u/.ssh/config",
      "/home/u/.aws/credentials",
      "/home/u/.corbits/settings.json",
      "/home/u/.corbits/permissions.json",
      "/home/u/.kube/config",
      "/home/u/.docker/config.json",
      "/home/u/.azure/accessTokens.json",
      "/g/.gnupg/pubring.kbx",
      "/home/u/.config/gcloud/x.json",
      "/x/backup.tfstate",
      "/x/key.pem",
      "/x/cert.p12",
      "/x/cert.pfx",
      "/x/server.key",
      "/x/cert.p8",
      "/x/store.jks",
      "/x/store.keystore",
      "/x/id_ed25519",
      "/home/u/.bash_history",
      "/etc/shadow",
      "/etc/sudoers",
      "/home/u/Library/Keychains/login.keychain-db",
      "/users/me/Library/Application Support/x/Cookies",
      "/profile/Login Data",
      "/profile/cookies.sqlite",
      "/profile/logins.json",
      "/profile/key4.db",
      "/storm/service-account.json",
      "/storm/my-service_account-key.json",
      "/g/creds/application_default_credentials.json",
      "/h/.zsh_history",
      "/h/.config/x/fish_history",
    ];
    for (const path of representatives) {
      expect(denyCovers(denyRead, path)).toBe(true);
    }
    // The denylist intent excludes env templates — only concrete variants.
    expect(denyCovers(denyRead, "/repo/.env.example")).toBe(false);
  });

  test("extraDeniedPaths becomes literal deny entries", () => {
    const config = buildSandboxRuntimeConfig({
      sessionRoot: tmpCwd,
      extraDeniedPaths: ["/active/settings.json"],
    });
    expect(config.filesystem.denyRead).toContainEqual({
      path: "/active/settings.json",
      literal: true,
    });
  });

  test("network allowlist and known credential env vars are denied", () => {
    const config = buildSandboxRuntimeConfig({
      sessionRoot: tmpCwd,
      allowedHosts: ["api.example.com", "*.github.com"],
    });
    expect(config.network.allowedDomains).toEqual([
      "api.example.com",
      "*.github.com",
    ]);
    const envVars = config.credentials?.envVars ?? [];
    const names = envVars.map((entry) => entry.name);
    for (const expected of [
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "GH_TOKEN",
      "AWS_SECRET_ACCESS_KEY",
    ]) {
      expect(names).toContain(expected);
    }
    for (const entry of envVars) {
      expect(entry.mode).toBe("deny");
    }
  });
});

describe("quotePosixArgv", () => {
  test("single-quotes entries; embedded quotes survive re-parse", () => {
    expect(quotePosixArgv(["node", "-x", "a b"])).toBe("'node' '-x' 'a b'");
    expect(quotePosixArgv(["sh", "-c", "echo 'a b'"])).toBe(
      "'sh' '-c' 'echo '\\''a b'\\'''",
    );
    expect(quotePosixArgv(["x", ""])).toBe("'x' ''");
    expect(quotePosixArgv([])).toBe("");
  });
});

describe("createShellSandbox", () => {
  test("returns undefined when disabled so spawn sites pass through", () => {
    expect(
      createShellSandbox({
        sessionRoot: tmpCwd,
        settings: sandboxSettings(false),
        gate: fakeGate(),
        manager: fakeManager(),
      }),
    ).toBeUndefined();
    expect(
      createShellSandbox({
        sessionRoot: tmpCwd,
        settings: undefined,
        gate: fakeGate(),
        manager: fakeManager(),
      }),
    ).toBeUndefined();
  });

  test("initializes once with the merged config and wraps via the manager", async () => {
    const configSeen: unknown[] = [];
    const manager = fakeManager({
      initialize: async (config) => {
        configSeen.push(config);
      },
    });
    const sandboxHandle = mustSandbox({
      sessionRoot: tmpCwd,
      extraDeniedPaths: ["/active/settings.json"],
      settings: sandboxSettings(true, ["api.example.com"]),
      gate: fakeGate(),
      manager,
    });
    const request = sandboxHandle.wrapShellCommand("echo one");
    await request;
    expect(configSeen).toHaveLength(1);
    const config = configSeen[0] as {
      network: { allowedDomains: string[] };
      filesystem: { denyRead: unknown[] };
    };
    expect(config.network.allowedDomains).toEqual(["api.example.com"]);
    expect(config.filesystem.denyRead).toContainEqual({
      path: "/active/settings.json",
      literal: true,
    });
    // Second wrap must not re-initialize.
    await sandboxHandle.wrapShellCommand("echo two");
    // initCalls is not directly observable on the fake; dedupe via configSeen.
    expect(configSeen).toHaveLength(1);
  });

  test("wrapExecArgv passes a POSIX-quoted command string to the argv wrap", async () => {
    const argvWrapArgs: string[] = [];
    const manager = fakeManager({
      wrapWithSandboxArgv: async (command) => {
        argvWrapArgs.push(command);
        return { argv: ["/bin/bash", "-c", command], env: {} };
      },
    });
    const sandbox = mustSandbox({
      sessionRoot: tmpCwd,
      settings: sandboxSettings(true),
      gate: fakeGate(),
      manager,
    });
    const { argv } = await sandbox.wrapExecArgv("node", ["-x", "a b"]);
    expect(argv).toEqual([
      "/bin/bash",
      "-c",
      quotePosixArgv(["node", "-x", "a b"]),
    ]);
  });

  test("a wrap failure surfaces the fail-closed message", async () => {
    const manager = fakeManager({
      wrapWithSandbox: async () => {
        throw new Error("seatbelt boom");
      },
    });
    const sandbox = mustSandbox({
      sessionRoot: tmpCwd,
      settings: sandboxSettings(true),
      gate: fakeGate(),
      manager,
    });
    await expect(sandbox.wrapShellCommand("echo x")).rejects.toThrow(
      "shell sandbox is enabled but unavailable: seatbelt boom",
    );
  });

  test("an unwritable /tmp/claude fails enablement, never a raw wrap", async () => {
    const outcome = await withMockedModuleDuring(
      "node:fs",
      (real: typeof import("node:fs")) => ({
        ...real,
        mkdirSync: () => {
          throw new Error("read-only volume");
        },
      }),
      async () => {
        const manager = fakeManager();
        const sandbox = mustSandbox({
          sessionRoot: tmpCwd,
          settings: sandboxSettings(true),
          gate: fakeGate(),
          manager,
        });
        await expect(sandbox.wrapShellCommand("echo x")).rejects.toThrow(
          "cannot create sandbox scratch dir /tmp/claude",
        );
        return manager;
      },
    );
    // The failing mkdir aborts before initialize is ever reached.
    expect(outcome).toBeDefined();
  });

  test("dispose resets the sandbox manager and swallows teardown errors", async () => {
    let resetCalls = 0;
    const manager = fakeManager({
      reset: async () => {
        resetCalls += 1;
        throw new Error("already gone");
      },
    });
    const sandbox = mustSandbox({
      sessionRoot: tmpCwd,
      settings: sandboxSettings(true),
      gate: fakeGate(),
      manager,
    });
    await sandbox.dispose();
    expect(resetCalls).toBe(1);
  });

  test("a second composition with differing config fails loud, not silently inherited", () => {
    const manager = fakeManager();
    mustSandbox({
      sessionRoot: tmpCwd,
      settings: sandboxSettings(true, ["api.example.com"]),
      gate: fakeGate(),
      manager,
    });
    expect(() =>
      createShellSandbox({
        sessionRoot: "/other/workspace",
        settings: sandboxSettings(true, ["api.example.com"]),
        gate: fakeGate(),
        manager,
      }),
    ).toThrow(
      "shell sandbox is already active in this process with a different configuration",
    );
  });

  test("same-composition handles share the manager via refcount", async () => {
    const inits: unknown[] = [];
    const manager = fakeManager({
      initialize: async (config) => {
        inits.push(config);
      },
    });
    const first = mustSandbox({
      sessionRoot: tmpCwd,
      settings: sandboxSettings(true),
      gate: fakeGate(),
      manager,
    });
    const second = mustSandbox({
      sessionRoot: tmpCwd,
      settings: sandboxSettings(true),
      gate: fakeGate(),
      manager,
    });
    await second.wrapShellCommand("echo shared");
    expect(inits).toHaveLength(1);
    // First owner disposes: the shared manager stays live for the second.
    await first.dispose();
    await second.wrapShellCommand("echo still-shared");
    expect(inits).toHaveLength(1);
    // Last owner disposes: the singleton resets and a later wrap on a
    // disposed handle fails closed.
    await second.dispose();
    await expect(second.wrapShellCommand("echo after-dispose")).rejects.toThrow(
      "already tore down its sandbox",
    );
    // A fresh same-composition handle re-initializes cleanly (no config-less
    // inherit): the init state was dropped, not kept.
    const reborn = mustSandbox({
      sessionRoot: tmpCwd,
      settings: sandboxSettings(true),
      gate: fakeGate(),
      manager,
    });
    await reborn.wrapShellCommand("echo reborn");
    expect(inits).toHaveLength(2);
  });

  test("wrap after the manager lost its config fails closed", async () => {
    const manager = fakeManager({
      getConfig: () => undefined,
    });
    const sandbox = mustSandbox({
      sessionRoot: tmpCwd,
      settings: sandboxSettings(true),
      gate: fakeGate(),
      manager,
    });
    await expect(sandbox.wrapShellCommand("echo ghost")).rejects.toThrow(
      "the sandbox runtime lost its configuration",
    );
  });
});
