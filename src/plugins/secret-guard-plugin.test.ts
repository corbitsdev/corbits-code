import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  isSensitiveShellToken,
  commandReferencesSensitivePath,
  expandShellToken,
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
    ".envrc",
    ".env.local",
    ".env.production",
    "/abs/path/.env",
    "/abs/path/.flaskenv",
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
    ".env.example",
    ".env.sample",
    ".env.template",
    ".env.dist",
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

  test("normalizes drive-relative paths only for cmd", () => {
    expect(isSensitivePath("C:.envrc", "posix")).toBe(false);
    expect(isSensitivePath("C:.envrc", "cmd")).toBe(true);
  });

  test("normalizes exact Windows file aliases only for cmd", () => {
    for (const path of [
      ".env ",
      ".envrc.",
      ".flaskenv::$DATA",
      String.raw`C:\repo\.EnV.LoCaL::$data`,
    ]) {
      expect(isSensitivePath(path, "cmd")).toBe(true);
      expect(isSensitivePath(path, "posix")).toBe(false);
    }
  });

  test("normalizes aliases on ordinary Windows path components", () => {
    for (const path of [
      String.raw`C:\repo\.corbits.\permissions.json`,
      String.raw`C:\repo\.aws.\credentials`,
      String.raw`C:\repo\.config\gcloud.\credentials.db`,
    ]) {
      expect(isSensitivePath(path, "cmd")).toBe(true);
    }
    expect(
      isSensitivePath(
        String.raw`\\?\C:\repo\.corbits.\permissions.json`,
        "cmd",
      ),
    ).toBe(false);
  });

  test("preserves Windows template exceptions and non-default streams", () => {
    for (const path of [
      ".env.example.",
      ".env.sample::$DATA",
      ".envrc:backup",
    ]) {
      expect(isSensitivePath(path, "cmd")).toBe(false);
    }
  });
});

describe("secretGuardPlugin", () => {
  for (const path of [".env", ".envrc", "/abs/path/.flaskenv"]) {
    test(`denies reading sensitive file ${path}`, async () => {
      const result = await handler()(read(path), new AbortController().signal);
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/sensitive file blocked/);
    });
  }

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
    // `?`/`[…]` globs read a secret the matcher only sees as a pattern.
    "cat .en?",
    "cat .e?v",
    "cat .en[v]",
    "head -c 100 .en?",
    // Runtime env-file loaders — detected so the gate can ask, not hard-deny.
    "bun --env-file=../../.env.staging run bin/publish.ts",
    "bun --env-file=.env run -e 'console.log(1)'",
    "sed --fil=.envrc input.txt",
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
    "cat .env.sample",
    "cat .env.template",
    "cat .env.dist",
    String.raw`cat ordinary\=.envrc`,
    "sed --fil=.env.example input.txt",
    "sed --f=.envrc input.txt",
    "grep --fil=.envrc needle",
    "bun test",
    // `*` stays an accepted residual: it cannot resolve without running the
    // shell, and prompting on it would fire on every benign `cat *`.
    "cat *",
    "cat *.txt",
  ];
  for (const c of allowed) {
    test(`allows: ${c}`, () =>
      expect(commandReferencesSensitivePath(c)).toBeUndefined());
  }
});

describe("secret-guard glob narrowing (CL-8999)", () => {
  let savedUnknown: string | undefined;

  beforeEach(() => {
    savedUnknown = process.env.UNKNOWN_X;
    delete process.env.UNKNOWN_X;
  });

  afterEach(() => {
    if (savedUnknown === undefined) delete process.env.UNKNOWN_X;
    else process.env.UNKNOWN_X = savedUnknown;
  });
  // `?`/`[` fire only on file-operand-shaped tokens: URLs, regex operands,
  // and the `[` test builtin itself must not prompt.
  const allowed = [
    "curl https://api.example.com/search?q=term",
    "grep -E colou?r file.txt",
    "grep 'colou?r' file.txt",
    "grep [0-9] file.txt",
    "grep '[0-9]' file.txt",
    "[ -f Makefile ]",
  ];
  for (const c of allowed) {
    test(`allows: ${c}`, () =>
      expect(commandReferencesSensitivePath(c)).toBeUndefined());
  }

  // Dotfile-rooted `*` globs deterministically match `.env` in any realistic
  // cwd, so they prompt; bare `*` cannot match a leading dot and stays free.
  const blocked = ["cat .*", "cat .env*", "cat ${UNKNOWN_X:=.env*}"];
  for (const c of blocked) {
    test(`flags: ${c}`, () =>
      expect(commandReferencesSensitivePath(c)).toBeDefined());
  }

  // `file:`-scheme URLs are local reads, so the `://` exemption must not
  // cover them: query-suffixed and globbed secret names still prompt.
  const fileBlocked = [
    "curl file:/home/u/.env?q=x",
    "curl file:///home/u/.env?q=x",
    "cat file:///home/u/.env?q=x",
    "wget file:///home/u/.env?q=x",
    "curl file:///home/u/id_rsa?q=x",
    "curl file:///home/u/.en?",
    "curl file:///home/u/.en[v]",
    "curl FILE:///home/u/.env?q=x",
  ];
  for (const c of fileBlocked) {
    test(`flags: ${c}`, () =>
      expect(commandReferencesSensitivePath(c)).toBeDefined());
  }

  test("keeps bare * allowed", () => {
    expect(commandReferencesSensitivePath("cat *")).toBeUndefined();
    expect(commandReferencesSensitivePath("cat *.txt")).toBeUndefined();
  });
});

describe("secret-guard file URL normalization", () => {
  const encodedSecrets = [
    "curl file:///tmp/%2Eenv",
    "curl file:///tmp/.%65nv",
    "curl file:///tmp/%69d_rsa",
    "curl FILE:///tmp/%2Eenv",
    "curl file:///tmp/secrets%2F%2Eenv",
    "curl file:///tmp/secrets/%2e%2e/%2Eenv",
    "curl file:./%2Eenv",
    "curl file://localhost/tmp/%2Eenv",
    "curl file:////tmp/%2Eenv",
  ];

  for (const command of encodedSecrets) {
    test(`flags decoded local path: ${command}`, () => {
      expect(commandReferencesSensitivePath(command)).toBeDefined();
    });
  }

  const braceGlobs = [
    "{%2Eenv,README.md}",
    "{README.md,%2Eenv}",
    "{.env,README.md}",
    "%2E{env,missing}",
  ];

  for (const braceGlob of braceGlobs) {
    test.skipIf(Bun.which("curl") === null)(
      `flags curl brace expansion that reads a real .env: ${braceGlob}`,
      async () => {
        const cwd = await mkdtemp(join(tmpdir(), "secret-guard-file-url-"));
        try {
          await writeFile(join(cwd, ".env"), "CURL_BRACE_PROOF=exfiltrated\n");
          await writeFile(join(cwd, "README.md"), "ordinary file\n");
          const url = `file://${cwd}/${braceGlob}`;
          const result = Bun.spawnSync([
            "curl",
            "--silent",
            "--show-error",
            url,
          ]);

          expect(result.stdout.toString()).toContain(
            "CURL_BRACE_PROOF=exfiltrated",
          );
          expect(
            commandReferencesSensitivePath(`curl '${url}'`, cwd),
          ).toBeDefined();
        } finally {
          await rm(cwd, { recursive: true, force: true });
        }
      },
    );
  }

  for (const malformed of ["%", "%2", "%GG", "%E0%A4%A"]) {
    test(`fails closed for malformed file URL escape: ${malformed}`, () => {
      expect(
        commandReferencesSensitivePath(`curl file:///tmp/${malformed}`),
      ).toBeDefined();
    });
  }

  test("flags percent-encoded local brace syntax", () => {
    expect(
      commandReferencesSensitivePath("curl file:///tmp/%7BREADME.md,%2Eenv%7D"),
    ).toBeDefined();
  });

  test("decodes file URL paths exactly once", () => {
    expect(
      commandReferencesSensitivePath("curl file:///tmp/%252Eenv"),
    ).toBeUndefined();
    expect(
      commandReferencesSensitivePath(
        "curl file:///tmp/%257BREADME.md,%252Eenv%257D",
      ),
    ).toBeUndefined();
  });

  test("uses the pathname before a file URL fragment", () => {
    expect(
      commandReferencesSensitivePath("curl 'file:///tmp/%2Eenv#section'"),
    ).toBeDefined();
  });

  test("allows localhost with a benign decoded path", () => {
    expect(
      commandReferencesSensitivePath("curl file://localhost/tmp/README.md"),
    ).toBeUndefined();
  });

  test("fails closed for unsupported file URL hosts and Windows forms", () => {
    expect(isSensitiveShellToken("file://server/share/README.md")).toBe(true);
    expect(
      isSensitiveShellToken(
        "file:///C:/safe.txt",
        process.cwd(),
        true,
        () => false,
        "cmd",
      ),
    ).toBe(true);
  });

  test("does not decode percent escapes in remote URLs", () => {
    expect(
      commandReferencesSensitivePath("curl https://example.com/%2Eenv"),
    ).toBeUndefined();
    expect(
      commandReferencesSensitivePath("curl https://example.com/.env"),
    ).toBeDefined();
  });
});

describe("commandReferencesSensitivePath shell-variable expansion (CL-8999)", () => {
  const CFG_VALUE = "/tmp/cl-8999-cfg/.corbits";
  let savedCFG: string | undefined;
  let savedUnknown: string | undefined;
  let savedPort: string | undefined;
  let savedEmpty: string | undefined;

  beforeEach(() => {
    savedCFG = process.env.CFG;
    savedUnknown = process.env.UNKNOWN_X;
    savedPort = process.env.PORT;
    savedEmpty = process.env.EMPTY_X;
    process.env.CFG = CFG_VALUE;
    delete process.env.UNKNOWN_X;
    delete process.env.PORT;
    delete process.env.EMPTY_X;
  });

  afterEach(() => {
    if (savedCFG === undefined) delete process.env.CFG;
    else process.env.CFG = savedCFG;
    if (savedUnknown === undefined) delete process.env.UNKNOWN_X;
    else process.env.UNKNOWN_X = savedUnknown;
    if (savedPort === undefined) delete process.env.PORT;
    else process.env.PORT = savedPort;
    if (savedEmpty === undefined) delete process.env.EMPTY_X;
    else process.env.EMPTY_X = savedEmpty;
  });

  const expandedSensitive = [
    "cat $HOME/.env",
    "cat ${HOME}/.env",
    'cat "$HOME/.env"',
    "cat ${CFG}/settings.json",
    "cat $CFG/settings.json",
    "cat $UNKNOWN_X/.env",
    "cat ${UNKNOWN_X:-$CFG/settings.json}",
    "cat ${UNKNOWN_X:=.env}",
  ];
  for (const c of expandedSensitive) {
    test(`flags: ${c}`, () =>
      expect(commandReferencesSensitivePath(c)).toBeDefined());
  }

  test("flags an unexpandable variable reference fail-closed", () => {
    expect(isSensitiveShellToken("${BROKEN")).toBe(true);
  });

  test("flags a variable-expanded token directly", () => {
    expect(isSensitiveShellToken("$CFG/settings.json")).toBe(true);
  });

  test("resolves := without prompting when the default is benign", () => {
    expect(isSensitiveShellToken("${UNKNOWN_X:=fallback.txt}")).toBe(false);
  });

  test("allows := / :+ port defaults without a prompt", () => {
    expect(
      commandReferencesSensitivePath("bun --port ${PORT:=3000} run x"),
    ).toBeUndefined();
    process.env.PORT = "4000";
    expect(
      commandReferencesSensitivePath("bun --port ${PORT:=3000} run x"),
    ).toBeUndefined();
    delete process.env.PORT;
    expect(
      commandReferencesSensitivePath("bun --port ${PORT:+3000} run x"),
    ).toBeUndefined();
  });

  test("expands := like :- for unset and empty variables", () => {
    expect(expandShellToken("${UNKNOWN_X:=dflt}")).toEqual({
      expanded: "dflt",
      expandable: true,
    });
    expect(expandShellToken("${CFG:=dflt}").expanded).toBe(CFG_VALUE);
    process.env.EMPTY_X = "";
    expect(expandShellToken("${EMPTY_X:=dflt}").expanded).toBe("dflt");
  });

  test("expands :+ and + only when the variable is set", () => {
    expect(expandShellToken("${CFG:+alt}").expanded).toBe("alt");
    expect(expandShellToken("${CFG+alt}").expanded).toBe("alt");
    expect(expandShellToken("${UNKNOWN_X:+alt}")).toEqual({
      expanded: "",
      expandable: true,
    });
    expect(expandShellToken("${UNKNOWN_X+alt}").expanded).toBe("");
    process.env.EMPTY_X = "";
    expect(expandShellToken("${EMPTY_X:+alt}").expanded).toBe("");
    expect(expandShellToken("${EMPTY_X+alt}").expanded).toBe("alt");
  });

  test("keeps :?, #, %, / and offsets fail-closed", () => {
    for (const token of [
      "${CFG:?must be set}",
      "${CFG#prefix}",
      "${CFG%post}",
      "${CFG/a/b}",
      "${CFG:1}",
      "${CFG:1:2}",
      "${UNKNOWN_X:-${BROKEN}",
    ]) {
      expect(expandShellToken(token).expandable).toBe(false);
    }
  });

  const expandedBenign = [
    "cat $HOME/README.md",
    "cat Makefile",
    "cat ${UNKNOWN_X:-prefix}",
  ];
  for (const c of expandedBenign) {
    test(`allows: ${c}`, () =>
      expect(commandReferencesSensitivePath(c)).toBeUndefined());
  }
});

describe("secret-guard ordering keepers (CL-8999)", () => {
  // H1: the pure-listing leg precedes the `?`/`[` glob check — moving the
  // glob check earlier would prompt on a listing that never dumps contents.
  test("pure listing with ?/[...] globs still lists freely", () => {
    expect(commandReferencesSensitivePath("ls .en?")).toBeUndefined();
    expect(commandReferencesSensitivePath("ls .en[v]")).toBeUndefined();
  });

  // H3: the cmd device-path exemption precedes the `?` check — the `?` in
  // `\\?\…` must not fail closed to a prompt.
  test("cmd device-path names keep working", () => {
    expect(
      isSensitiveShellToken(
        String.raw`\\?\C:\repo\notes.txt`,
        process.cwd(),
        true,
        () => false,
        "cmd",
      ),
    ).toBe(false);
  });

  // H7: a piped ls loses the listing exemption and takes the resolve leg,
  // so the glob check fires and prompts.
  test("piped listing with a ? glob prompts", () => {
    expect(commandReferencesSensitivePath("ls .en? | cat")).toBeDefined();
  });
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
