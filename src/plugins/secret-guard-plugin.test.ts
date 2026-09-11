import { describe, test, expect } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPosixTools } from "@intx/tools-posix";
import type { ToolCall, ToolResult } from "@intx/types/runtime";
import { buildCorePosixToolPlugins } from "../agent/posix-tool-plugins.js";
import { createPermissionGate } from "../permission/gate.js";
import { loadProjectApprovals } from "../permission/store.js";
import {
  secretGuardPlugin,
  isSensitivePath,
  commandReferencesSensitivePath,
} from "./secret-guard-plugin.js";

const next = async (call: ToolCall): Promise<ToolResult> => ({
  callId: call.id,
  content: "ok",
});

function handler() {
  const plugin = secretGuardPlugin();
  return plugin.middleware ? plugin.middleware(next) : next;
}

const read = (path: string): ToolCall => ({
  id: "c",
  name: "read_file",
  arguments: { path },
});
const shell = (command: unknown): ToolCall => ({
  id: "c",
  name: "run_shell",
  arguments: { command },
});

const GRANT_STORE_PAYLOAD = JSON.stringify({
  approvals: [{ tool: "run_shell", pattern: "bash -c *" }],
});

const APPLY_PATCH_GRANT_STORE = `*** Begin Patch
*** Add File: .corbits/permissions.json
+${GRANT_STORE_PAYLOAD}
*** End Patch
`;

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
    ".aws/config",
    ".config/gcloud/application_default_credentials.json",
    ".kube/config",
    ".docker/config.json",
    ".config/gh/hosts.yml",
    "terraform.tfstate",
    "terraform.tfstate.backup",
    "server.key",
    "cert.p8",
    "app.jks",
    "release.keystore",
    "server.ppk",
    "service-account.json",
    "my-project_service_account-key.json",
    ".corbits/settings.json",
    "/Users/me/.corbits/settings.json",
    ".corbits/permissions.json",
    "/Users/me/.corbits/permissions.json",
    // Shell histories.
    "/home/me/.bash_history",
    ".zsh_history",
    ".sh_history",
    "/home/me/.local/share/fish/fish_history",
    // System account and privilege files.
    "/etc/shadow",
    "/etc/sudoers",
    "/etc/sudoers.d/90-cloud-init-users",
    // macOS Keychain.
    "/Users/me/Library/Keychains/login.keychain-db",
    "backup.keychain",
    // Browser cookie jars and saved-login stores.
    "/Users/me/Library/Application Support/Google/Chrome/Default/Cookies",
    "/Users/me/Library/Application Support/Google/Chrome/Default/Login Data",
    "/home/me/.mozilla/firefox/abc123.default/cookies.sqlite",
    "/home/me/.mozilla/firefox/abc123.default/logins.json",
    "/home/me/.mozilla/firefox/abc123.default/key4.db",
    // Cloud credentials beyond AWS.
    "/home/me/.config/gcloud/legacy_credentials/me@example.com/adc.json",
    "/home/me/.config/gcloud/credentials.db",
    "/home/me/.azure/accessTokens.json",
    "/home/me/.azure/azureProfile.json",
  ];
  for (const p of sensitive) {
    test(`flags ${p}`, () => expect(isSensitivePath(p)).toBe(true));
  }

  const ok = [
    "src/index.ts",
    "README.md",
    "env.ts",
    "environment.json",
    ".env.example.md",
    "docs/pem.md",
    ".corbits/hooks/post-turn.ts",
    "permissions.json",
    "docker-compose.yml",
    "keystore.md",
    "account.json",
    "src/keyboard.ts",
    // Near-misses for the new patterns: plausible legitimate filenames that
    // share a word or extension with a sensitive pattern but aren't the
    // sensitive file itself.
    "docs/bash_history_format.md",
    "src/keychain-helper.ts",
    "test/fixtures/cookies.json",
    "src/etc/shadow-dom.ts",
    "docs/sudoers-explained.md",
    "src/gcloud-deploy.ts",
    "src/azure-profile-view.tsx",
  ];
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
    const call: ToolCall = {
      id: "c",
      name: "write_file",
      arguments: { path: ".ssh/id_rsa", content: "x" },
    };
    const result = await handler()(call, new AbortController().signal);
    expect(result.isError).toBe(true);
  });

  test("denies writing the project grant store", async () => {
    const call: ToolCall = {
      id: "c",
      name: "write_file",
      arguments: {
        path: ".corbits/permissions.json",
        content: GRANT_STORE_PAYLOAD,
      },
    };
    const result = await handler()(call, new AbortController().signal);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/sensitive file blocked/);
  });

  test("denies editing the project grant store", async () => {
    const call: ToolCall = {
      id: "c",
      name: "edit_file",
      arguments: {
        path: ".corbits/permissions.json",
        old_string: "{}",
        new_string: GRANT_STORE_PAYLOAD,
      },
    };
    const result = await handler()(call, new AbortController().signal);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/sensitive file blocked/);
  });

  test("denies apply_patch of the project grant store", async () => {
    const call: ToolCall = {
      id: "c",
      name: "apply_patch",
      arguments: { input: APPLY_PATCH_GRANT_STORE },
    };
    const result = await handler()(call, new AbortController().signal);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/sensitive file blocked/);
  });

  test("allows an ordinary source file", async () => {
    const result = await handler()(
      read("src/index.ts"),
      new AbortController().signal,
    );
    expect(result.isError).not.toBe(true);
  });
});

describe("commandReferencesSensitivePath", () => {
  const blocked = [
    "cat .env",
    "cat ~/.corbits/settings.json",
    "less /Users/me/.corbits/settings.json",
    "cat .corbits/permissions.json",
    "xxd .ssh/id_rsa",
    "base64 secrets/server.pem",
    "grep KEY .env.production",
    // Quote/escape obfuscation collapses back to the real path.
    "cat .e''nv",
    "cat '.env'",
    "cat \\.env",
    // Env-assignment and redirection forms expose the path token.
    "FILE=.env cat $FILE",
    "dd if=.aws/credentials of=/tmp/x",
    // Chained after a harmless command.
    "ls && cat .env",
    // Relative-dot prefixes resolve to the same anchored match as a raw token.
    "cat ./.env",
    "cat ./secrets/.env",
    // Runtime env-file loaders — detected so the gate can ask, not hard-deny.
    "bun --env-file=../../.env.staging run bin/publish.ts",
    "bun --env-file=.env run -e 'console.log(1)'",
    // Cloud, keychain, and infra credential stores.
    "cat ~/.aws/config",
    "cat ~/.config/gcloud/application_default_credentials.json",
    "cat ~/.kube/config",
    "cat ~/.docker/config.json",
    "cat ~/.config/gh/hosts.yml",
    "cat terraform.tfstate",
    "cat server.key",
    "cat cert.p8",
    "cat app.jks",
    "cat release.keystore",
    "cat server.ppk",
    "cat service-account.json",
  ];
  for (const c of blocked) {
    test(`flags: ${c}`, () =>
      expect(commandReferencesSensitivePath(c)).toBeDefined());
  }

  const allowed = [
    "ls -la",
    "cat README.md",
    "grep TODO src/index.ts",
    "echo environment",
    "cat .env.example",
    "bun test",
  ];
  for (const c of allowed) {
    test(`allows: ${c}`, () =>
      expect(commandReferencesSensitivePath(c)).toBeUndefined());
  }
});

describe("secretGuardPlugin run_shell", () => {
  // Shell commands that mention a secret path are no longer hard-denied here —
  // they require operator approval at the permission gate. The plugin only
  // hard-denies path-keyed tools so approval can still let `bun --env-file=…`
  // through when the operator says yes.
  test("does not hard-deny a shell read of a secret file", async () => {
    const result = await handler()(
      shell("cat .env"),
      new AbortController().signal,
    );
    expect(result.isError).not.toBe(true);
    expect(result.content).toBe("ok");
  });

  test("does not hard-deny a shell command that loads an env file", async () => {
    const result = await handler()(
      shell("bun --env-file=../../.env.staging run bin/publish.ts"),
      new AbortController().signal,
    );
    expect(result.isError).not.toBe(true);
    expect(result.content).toBe("ok");
  });

  test("does not hard-deny a shell read of the credential settings file", async () => {
    const result = await handler()(
      shell("cat ~/.corbits/settings.json"),
      new AbortController().signal,
    );
    expect(result.isError).not.toBe(true);
  });

  test("allows a harmless shell command", async () => {
    const result = await handler()(
      shell("bun test"),
      new AbortController().signal,
    );
    expect(result.isError).not.toBe(true);
  });

  test("does not coerce a non-string command (passes through to tool validation)", async () => {
    const result = await handler()(
      shell(undefined),
      new AbortController().signal,
    );
    expect(result.content).toBe("ok");
  });
});

describe("auto-mode project grant store", () => {
  async function withAutoTools<T>(
    run: (args: {
      cwd: string;
      tools: ReturnType<typeof createPosixTools>;
    }) => Promise<T>,
  ): Promise<T> {
    const cwd = await mkdtemp(join(tmpdir(), "cl7634-grant-store-"));
    await mkdir(join(cwd, ".corbits"), { recursive: true });
    const gate = createPermissionGate({
      approvals: [],
      interactive: false,
      skipPermissions: false,
      reactorGated: false,
      auto: true,
      cwd,
    });
    const tools = createPosixTools({
      cwd,
      plugins: buildCorePosixToolPlugins({ cwd, permissionGate: gate }),
    });
    try {
      return await run({ cwd, tools });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }

  test("auto mode denies write_file of the project grant store", async () => {
    await withAutoTools(async ({ cwd, tools }) => {
      const result = await tools.run(
        {
          id: "1",
          name: "write_file",
          arguments: {
            path: ".corbits/permissions.json",
            content: GRANT_STORE_PAYLOAD,
          },
        },
        new AbortController().signal,
      );
      expect(result.isError).toBe(true);
      expect(String(result.content)).toMatch(/sensitive file blocked/i);
      expect(await loadProjectApprovals(cwd)).toEqual([]);
    });
  });

  test("auto mode denies edit_file of the project grant store", async () => {
    await withAutoTools(async ({ cwd, tools }) => {
      const result = await tools.run(
        {
          id: "1",
          name: "edit_file",
          arguments: {
            path: ".corbits/permissions.json",
            old_string: "{}",
            new_string: GRANT_STORE_PAYLOAD,
          },
        },
        new AbortController().signal,
      );
      expect(result.isError).toBe(true);
      expect(String(result.content)).toMatch(/sensitive file blocked/i);
      expect(await loadProjectApprovals(cwd)).toEqual([]);
    });
  });

  test("a denied grant-store write cannot auto-allow bash -c npm install on a fresh gate", async () => {
    await withAutoTools(async ({ cwd, tools }) => {
      await tools.run(
        {
          id: "1",
          name: "write_file",
          arguments: {
            path: ".corbits/permissions.json",
            content: GRANT_STORE_PAYLOAD,
          },
        },
        new AbortController().signal,
      );
      const seeded = await loadProjectApprovals(cwd);
      let asked = 0;
      const gate = createPermissionGate({
        approvals: seeded,
        requestApproval: async () => {
          asked++;
          return { allow: true };
        },
        interactive: true,
        skipPermissions: false,
        reactorGated: false,
        auto: true,
        cwd,
      });
      const verdict = await gate.evaluate({
        id: "c",
        name: "run_shell",
        arguments: { command: "bash -c 'npm install lodash'" },
      });
      expect(asked).toBeGreaterThan(0);
      expect(verdict.allowed).toBe(true);
    });
  });
});
