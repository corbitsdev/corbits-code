import { describe, test, expect } from "bun:test";
import {
  secretGuardPlugin,
  isSensitivePath,
  commandReferencesSensitivePath,
} from "./secret-guard-plugin.js";
import type { ToolCall, ToolResult } from "@intx/types/runtime";

const next = async (call: ToolCall): Promise<ToolResult> => ({ callId: call.id, content: "ok" });

function handler() {
  const plugin = secretGuardPlugin();
  return plugin.middleware ? plugin.middleware(next) : next;
}

const read = (path: string): ToolCall => ({ id: "c", name: "read_file", arguments: { path } });
const shell = (command: unknown): ToolCall => ({ id: "c", name: "run_shell", arguments: { command } });

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
    const call: ToolCall = { id: "c", name: "write_file", arguments: { path: ".ssh/id_rsa", content: "x" } };
    const result = await handler()(call, new AbortController().signal);
    expect(result.isError).toBe(true);
  });

  test("allows an ordinary source file", async () => {
    const result = await handler()(read("src/index.ts"), new AbortController().signal);
    expect(result.isError).not.toBe(true);
  });
});

describe("commandReferencesSensitivePath", () => {
  const blocked = [
    "cat .env",
    "cat ~/.corbits/settings.json",
    "less /Users/me/.corbits/settings.json",
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
    test(`flags: ${c}`, () => expect(commandReferencesSensitivePath(c)).toBeDefined());
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
    test(`allows: ${c}`, () => expect(commandReferencesSensitivePath(c)).toBeUndefined());
  }
});

describe("secretGuardPlugin run_shell", () => {
  // Shell commands that mention a secret path are no longer hard-denied here —
  // they require operator approval at the permission gate. The plugin only
  // hard-denies path-keyed tools so approval can still let `bun --env-file=…`
  // through when the operator says yes.
  test("does not hard-deny a shell read of a secret file", async () => {
    const result = await handler()(shell("cat .env"), new AbortController().signal);
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
    const result = await handler()(shell("bun test"), new AbortController().signal);
    expect(result.isError).not.toBe(true);
  });

  test("does not coerce a non-string command (passes through to tool validation)", async () => {
    const result = await handler()(shell(undefined), new AbortController().signal);
    expect(result.content).toBe("ok");
  });
});
