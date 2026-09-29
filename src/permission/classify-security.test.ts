import { describe, test, expect } from "bun:test";
import type { ToolCall } from "@intx/types/runtime";
import {
  isAutoAllowedShellCall,
  isAutoAllowedShellSegment,
} from "./classify.js";
import { autoShellRuleForCall } from "./auto-shell-policy.js";
import { createPermissionGate } from "./gate.js";
import type { Approval } from "./types.js";
import { secretGuardPlugin } from "../plugins/secret-guard-plugin.js";

const shellCall = (command: string): ToolCall => ({
  id: "c",
  name: "run_shell",
  arguments: { command },
});

describe("isAutoAllowedShellCall — code-executing flags", () => {
  test.each([
    // --pre and friends execute an arbitrary binary per match.
    ["rg --pre sh foo", false],
    ["rg --pre=sh foo", false],
    ["rg --pre-glob '*.gz' foo", false],
    ["rg --hostname-bin /bin/sh foo", false],
    ["rg --search-zip foo", false],
    ["rg -z foo", false],
    // Open-ended search is authz policy, not auto-allowable.
    ["rg pattern src", false],
    ["grep -r needle .", false],
    ["grep -n foo file.ts", true],
  ])("isAutoAllowedShellCall(%s)", (command, expected) => {
    expect(isAutoAllowedShellCall(shellCall(command))).toBe(expected);
  });
});

describe("isAutoAllowedShellCall — sensitive-path arguments", () => {
  test.each([
    ["cat .env", false],
    ["cat .env.production", false],
    ["head id_rsa", false],
    ["cat server.pem", false],
    ["cat cert.p12", false],
    ["cat .ssh/known_hosts", false],
    ["cat .netrc", false],
    ["cat .git-credentials", false],
    ["env FILE=.envrc sh -c 'cat \"$FILE\"'", false],
    ["sed -Enf.flaskenv input", false],
    ["sed --fil=.envrc input.txt", false],
    ["cat src/index.ts", true],
    ["cat .env.example", true],
    ["echo grep --file=.envrc", true],
    ["echo dd if=.flaskenv", true],
  ])("isAutoAllowedShellCall(%s)", (command, expected) => {
    expect(isAutoAllowedShellCall(shellCall(command))).toBe(expected);
  });

  test("aliases, clusters, control prefixes, and ambiguity cannot auto-allow", () => {
    for (const command of [
      "egrep -Jf.envrc needle",
      "grep -2f.flaskenv needle",
      "sed -anf.envrc input.txt",
      "{ awk -f.flaskenv input.txt; }",
      "! grep -Tf.envrc needle",
      "grep -Xf.envrc needle",
      "grep -uf.envrc needle",
      "cat $'.envrc'",
      "bash -c \"cat \\$'.envrc'\"",
      "bash -lc \"cat \\$'.envrc'\"",
      "bash -lc \"cat \\$'.flaskenv'\"",
      `bash -c "cat "'.envrc'`,
      `sh -cc "cat "'.flaskenv'`,
      "cat $'notes\\cQ'",
    ]) {
      expect(isAutoAllowedShellCall(shellCall(command))).toBe(false);
    }
  });
});

describe("nested interpreter secret reads", () => {
  const nestedSecrets = [
    'fish -c "cat .envrc"',
    'fish -c "cat .env"',
    'busybox sh -c "cat .envrc"',
    'csh -c "cat .envrc"',
    'tcsh -c "cat .envrc"',
    'pwsh -c "cat .envrc"',
  ];

  test("does not auto-allow secret reads behind nested interpreters", () => {
    for (const command of nestedSecrets) {
      expect(isAutoAllowedShellCall(shellCall(command))).toBe(false);
      expect(autoShellRuleForCall(shellCall(command))).toMatchObject({
        name: "sensitive-path",
        effect: "ask",
      });
    }
  });

  test("auto mode does not allow nested-interpreter secret reads", async () => {
    for (const command of nestedSecrets) {
      const gate = createPermissionGate({
        approvals: [],
        interactive: false,
        skipPermissions: false,
        reactorGated: false,
        auto: true,
      });
      expect((await gate.evaluate(shellCall(command))).allowed).toBe(false);
    }
  });

  test("templates behind nested interpreters stay unsensitive", () => {
    expect(
      autoShellRuleForCall(shellCall('fish -c "cat .env.example"'))?.name,
    ).not.toBe("sensitive-path");
    expect(
      autoShellRuleForCall(shellCall('busybox sh -c "cat .env.sample"'))?.name,
    ).not.toBe("sensitive-path");
  });
});

describe("clustered shell command options", () => {
  test("classifies clustered command payloads like canonical command payloads", () => {
    for (const options of ["-c", "-lc", "-xec", "-cc", "-cache"]) {
      const call = shellCall(`bash ${options} "echo x > .env"`);
      expect(autoShellRuleForCall(call)?.name).toBe("file-mutation");
      expect(autoShellRuleForCall(call)?.effect).toBe("deny");
    }
  });

  test("classifies interpreter-specific and conservative alphabetic clusters", () => {
    for (const [shell, options] of [
      ["zsh", "-yc"],
      ["dash", "-Vc"],
      ["ksh", "-Gc"],
      ["bash", "-zc"],
      ["bash", "-lc"],
      ["sh", "-ec"],
    ]) {
      expect(
        autoShellRuleForCall(shellCall(`${shell} ${options} "echo x > .env"`)),
      ).toMatchObject({ name: "file-mutation", effect: "deny" });
    }
  });

  test("classifies complete adjacent-fragment payloads", () => {
    for (const command of [
      `bash -c "echo x "'> .env'`,
      `bash -lc 'echo x '" > .env"`,
      `bash -xec "echo x"' > .env'`,
      `bash -cc echo" x > .env"`,
    ]) {
      expect(autoShellRuleForCall(shellCall(command))).toMatchObject({
        name: "file-mutation",
        effect: "deny",
      });
    }
  });
});

describe("isAutoAllowedShellCall — environment dump", () => {
  test.each(["printenv", "printenv PATH", "env"])(
    "does not auto-allow %s",
    (command) => {
      expect(isAutoAllowedShellCall(shellCall(command))).toBe(false);
    },
  );
});

describe("isAutoAllowedShellCall — workspace containment", () => {
  // Pure directory listing is names/metadata only — outside-workspace targets
  // still auto-allow. Content readers (cat, head, …) remain contained.
  // tree requires an explicit depth bound (-L / --max-depth); unbounded tree
  // walks are not pure listing (same OOM class as open-ended find/rg).
  test.each([
    ["cat /etc/passwd", false],
    ["strings /proc/self/environ", false],
    ["xxd ../../etc/hosts", false],
    ["cat ~/.aws/config", false],
    ["head ~/.aws/config", false],
    ["cat src/index.ts", true],
    ["wc -l README.md", true],
    ["ls -la", true],
    ["grep -n needle README.md", true],
    // Outside paths glued to a flag value — and a separated flag value, which
    // is a positional token and already caught.
    ["grep --file=/etc/passwd .", false],
    ["grep -f/etc/passwd .", false],
    ["rg --file=/etc/passwd .", false],
    ["grep -f /etc/passwd .", false],
    ["grep --file=patterns.txt src", true],
    ["ls /tmp", true],
    ["ls -la ~", true],
    ["tree -L 1 /var", true],
    ["tree --max-depth=2 /var", true],
    ["tree -L10 /var", true],
    ["ls -R /", false],
    ["ls -laR /tmp", false],
    ["ls --recursive /var", false],
    ["tree /", false],
    ["tree /var", false],
    // Depth present but over the pure-listing cap still forces ask (OOM).
    ["tree -L 999999 /", false],
    ["tree --max-depth=99 /var", false],
  ])("isAutoAllowedShellCall(%s) under /repo", (command, expected) => {
    expect(isAutoAllowedShellCall(shellCall(command), "/repo")).toBe(expected);
  });

  test.each([
    ["ls -R .", "unbounded-listing"],
    ["ls -laR packages", "unbounded-listing"],
    ["tree .", "unbounded-listing"],
    ["tree packages", "unbounded-listing"],
    ["tree -L 999999 packages", "unbounded-listing"],
    // Bounded forms stay free of the ask rule.
    ["ls packages", undefined],
    ["tree -L 2 packages", undefined],
  ])(
    "auto-mode rule for unbounded recursive listing: %s",
    (command, expected) => {
      expect(autoShellRuleForCall(shellCall(command))?.name).toBe(expected);
    },
  );
});

describe("pure directory listing — outside-workspace auto-shell policy", () => {
  // Paths that resolve outside /repo are restricted; ~ is also treated as
  // outside by commandTargetsRestricted. Pure ls/tree must not trip the ask rule.
  const isRestricted = (path: string): boolean =>
    path.startsWith("~") || path.startsWith("/") || path.includes("..");

  test.each([
    ["ls /tmp", undefined],
    ["ls -la ~", undefined],
    ["tree -L 1 /var", undefined],
    // Unbounded listing is the more specific OOM rule and wins over
    // outside-workspace when both would apply.
    ["ls -R /tmp", "unbounded-listing"],
    ["tree /var", "unbounded-listing"],
    // Non-sensitive outside paths so this asserts containment, not the
    // sensitive-path ask rule (which fires first for e.g. ~/.aws/config).
    ["cat /etc/passwd", "outside-workspace"],
    ["head /tmp/notes.txt", "outside-workspace"],
    // A chained safe listing does not hide the content-reading half.
    ["ls /tmp && cat /etc/passwd", "outside-workspace"],
  ])("%s", (command, expected) => {
    expect(autoShellRuleForCall(shellCall(command), isRestricted)?.name).toBe(
      expected,
    );
  });
});

describe("isAutoAllowedShellSegment — command substitution", () => {
  test.each(["echo `rm -rf ./build`", "echo $(rm -rf ./build)"])(
    "does not auto-allow substitution in %s",
    (command) => {
      expect(isAutoAllowedShellSegment(command)).toBe(false);
    },
  );
});

describe("credential-print shell commands force ask in auto mode", () => {
  test.each([
    ["security find-generic-password -w -s myservice", "credential-print"],
    ["security find-internet-password -w -s example.com", "credential-print"],
    ["gpg --export-secret-keys -a me@example.com", "credential-print"],
    ["aws configure get aws_secret_access_key", "credential-print"],
    ["gcloud auth print-access-token", "credential-print"],
    ["gcloud auth list", undefined],
    ["aws configure list", undefined],
  ])("%s", (command, expected) => {
    expect(autoShellRuleForCall(shellCall(command))?.name).toBe(expected);
  });
});

describe("git config mutation outside the repo forces ask in auto mode", () => {
  test.each([
    ["git config --global user.name foo", "git-global-config"],
    ["git config --global --get-regexp url.", "git-global-config"],
    ["git config --system user.name foo", "git-global-config"],
    // --edit opens an editor on a config file, which can write anything.
    ["git config --global --edit", "git-global-config"],
    ["git config --edit", "git-global-config"],
    // --file to a workspace-relative path still asks under its own rule.
    ["git config --file scratch.gitconfig user.name foo", "git-global-config"],
    // --file to a path outside the workspace asks via outside-workspace.
    ["git config --file ~/.gitconfig user.name foo", "outside-workspace"],
    // Unsetting GIT_CONFIG_GLOBAL falls back to the real ~/.gitconfig.
    ["unset GIT_CONFIG_GLOBAL", "git-global-config"],
    // Reassigning GIT_CONFIG_GLOBAL is caught by the env-assignment rule.
    ["GIT_CONFIG_GLOBAL=/tmp/x git config --global foo bar", "env-assignment"],
    // Plain repo-local config reads and writes stay unflagged.
    ["git config user.name", undefined],
    ["git config user.email me@example.com", undefined],
    ["git config --local user.name foo", undefined],
  ])("%s", (command, expected) => {
    expect(autoShellRuleForCall(shellCall(command))?.name).toBe(expected);
  });
});

describe("sensitive-path shell commands require approval, not a hard deny", () => {
  test("secret-guard no longer hard-denies shell references to secret files", async () => {
    const middleware = secretGuardPlugin().middleware;
    if (middleware === undefined)
      throw new Error("secretGuardPlugin must provide middleware");
    const next = async () => ({ callId: "c", content: "ran", isError: false });
    const result = await middleware(next)(
      shellCall("cat .env"),
      new AbortController().signal,
    );
    expect(result.isError).not.toBe(true);
    expect(result.content).toBe("ran");
  });

  test("auto mode forces ask for shell commands that reference secret files", () => {
    const rule = autoShellRuleForCall(shellCall("cat .envrc"));
    expect(rule?.name).toBe("sensitive-path");
    expect(rule?.effect).toBe("ask");
  });

  test("auto mode asks for clustered bash secret reads", () => {
    for (const command of [
      "bash -lc \"cat \\$'.envrc'\"",
      "bash -lc \"cat \\$'.flaskenv'\"",
    ]) {
      expect(autoShellRuleForCall(shellCall(command))).toMatchObject({
        name: "sensitive-path",
        effect: "ask",
      });
    }
  });

  // Gate fixture for the table below: an interactive (or headless where the
  // row says so) ask-tier gate whose prompt resolves allow; `asked` counts
  // prompts. Secret-path commands must always reach the operator — a stored
  // grant that covered them verbatim would silently launder secret reads.
  const secretGate = (options: {
    approvals?: readonly Approval[];
    auto?: boolean;
    interactive?: boolean;
    providerName?: string;
    model?: string;
  }) => {
    const asked = { count: 0 };
    const gate = createPermissionGate({
      approvals: [...(options.approvals ?? [])],
      requestApproval: async () => {
        asked.count += 1;
        return { allow: true };
      },
      interactive: options.interactive ?? true,
      skipPermissions: false,
      reactorGated: false,
      auto: options.auto,
      providerName: options.providerName,
      model: options.model,
    });
    return { gate, asked };
  };
  const catGrant = { tool: "run_shell", pattern: "cat *" };

  test.each([
    // Operator approval lets a sensitive-path command through — the point is
    // that a human decided, not that the gate blocked.
    {
      label: "operator approval lets it through",
      command: "bun --env-file=../../.env.staging run bin/publish.ts",
      options: {},
      allowed: true,
      asked: 1,
    },
    {
      label: "auto mode prompts rather than rubber-stamping",
      command: "cat .env",
      options: { auto: true },
      allowed: true,
      asked: 1,
    },
    {
      label: "a broad stored grant does not authorize",
      command: "cat .flaskenv",
      options: { approvals: [catGrant] },
      allowed: true,
      asked: 1,
    },
    {
      label: "an exact stored grant still re-prompts",
      command: "cat .env",
      options: { approvals: [{ tool: "run_shell", pattern: "cat .env" }] },
      allowed: true,
      asked: 1,
    },
    {
      label: "the same broad grant still covers ordinary reads",
      command: "cat ordinary=.envrc",
      options: { approvals: [catGrant] },
      allowed: true,
      asked: 0,
    },
    {
      label: "auto mode plus a grant still re-prompts",
      command: "cat .env",
      options: { approvals: [catGrant], auto: true },
      allowed: true,
      asked: 1,
    },
    {
      label: "headless denies even with a matching grant",
      command: "cat .env",
      options: { approvals: [catGrant], interactive: false },
      allowed: false,
      asked: 0,
    },
    {
      label: "a provider-model grant does not authorize",
      command: "cat .env",
      options: {
        approvals: [
          {
            tool: "run_shell",
            pattern: "cat *",
            providerModel: "openai:gpt-4o",
          },
        ],
        providerName: "openai",
        model: "gpt-4o",
      },
      allowed: true,
      asked: 1,
    },
    // File mutation of a secret path is a hard deny, not an ask — grant or not.
    {
      label: "auto mode hard-denies mutation of a secret path",
      command: "echo x > .env",
      options: { auto: true },
      allowed: false,
      asked: 0,
    },
    {
      label: "auto mode plus a grant still hard-denies mutation",
      command: "echo x > .env",
      options: {
        approvals: [{ tool: "run_shell", pattern: "echo *" }],
        auto: true,
      },
      allowed: false,
      asked: 0,
    },
  ])("$label", async ({ command, options, allowed, asked: wantAsked }) => {
    const { gate, asked } = secretGate(options);
    const verdict = await gate.evaluate(shellCall(command));
    expect(verdict.allowed).toBe(allowed);
    expect(asked.count).toBe(wantAsked);
  });

  test("file-mutation deny beats sensitive-path ask in auto mode", () => {
    const rule = autoShellRuleForCall(shellCall("echo x > .env"));
    expect(rule?.name).toBe("file-mutation");
    expect(rule?.effect).toBe("deny");
  });

  test("pipeline with secret segment prompts once for the full block; safe tail grant-skips under the hood", async () => {
    const subjects: string[] = [];
    const full = "cat .env | sort";
    const gate = createPermissionGate({
      approvals: [{ tool: "run_shell", pattern: "sort *" }],
      requestApproval: async (req) => {
        subjects.push(req.subject);
        return { allow: true };
      },
      interactive: true,
      skipPermissions: false,
      reactorGated: false,
    });
    const verdict = await gate.evaluate(shellCall(full));
    expect(verdict.allowed).toBe(true);
    // One full-block prompt (secret segment forces ask); safe tail is not a separate subject.
    expect(subjects).toEqual([full]);
  });

  test("chain with grant on safe segment still re-prompts the full block for a secret segment", async () => {
    const subjects: string[] = [];
    const full = "cat README.md && cat .env";
    const gate = createPermissionGate({
      approvals: [{ tool: "run_shell", pattern: "cat *" }],
      requestApproval: async (req) => {
        subjects.push(req.subject);
        return { allow: true };
      },
      interactive: true,
      skipPermissions: false,
      reactorGated: false,
    });
    const verdict = await gate.evaluate(shellCall(full));
    expect(verdict.allowed).toBe(true);
    // Broad `cat *` must not authorize the secret path; operator sees the full block once.
    expect(subjects).toEqual([full]);
  });

  test("secret-path approval strips persist scopes and ignores persist payloads", async () => {
    const seenScopes: { pattern: string | null }[][] = [];
    const persisted: unknown[] = [];
    let asked = 0;
    const gate = createPermissionGate({
      approvals: [],
      requestApproval: async (req) => {
        asked++;
        seenScopes.push(req.scopes.map((s) => ({ pattern: s.pattern })));
        return {
          allow: true,
          persist: {
            id: "exact",
            label: "Always",
            pattern: "cat .env",
            grant: "project" as const,
          },
        };
      },
      persist: (a) => persisted.push(a),
      interactive: true,
      skipPermissions: false,
      reactorGated: false,
    });
    expect((await gate.evaluate(shellCall("cat .env"))).allowed).toBe(true);
    expect((await gate.evaluate(shellCall("cat .env"))).allowed).toBe(true);
    // Persist scopes stripped; no grant stored so every call re-asks.
    expect(seenScopes).toEqual([[], []]);
    expect(persisted).toHaveLength(0);
    expect(asked).toBe(2);
  });
});

describe("env-assignment shell commands force ask in auto mode", () => {
  test.each([
    ["FOO=bar npm start", "env-assignment"],
    ["A=1 B=2 npm start", "env-assignment"],
    ["export FOO=bar", "env-assignment"],
    ["export FOO", "env-assignment"],
    ["env FOO=bar npm start", "env-assignment"],
    // Bare env/nice/timeout wrappers with no assignment peel through untouched.
    ["env npm test", undefined],
    ["nice -n 10 npm test", undefined],
    ["timeout 30 npm test", undefined],
    // An assignment prefix on a later chain segment still asks.
    ["ls && FOO=bar npm start", "env-assignment"],
    // A stricter rule beats the env-assignment ask.
    ["FOO=bar sh -c 'echo x > .env'", "file-mutation"],
    // env -S carries the assignment inside the quoted argument.
    [`env -S "FOO=bar sh -c 'echo got:$FOO'"`, "env-assignment"],
    [`env --split-string="FOO=bar npm start"`, "env-assignment"],
    [`env --split-string "FOO=bar npm start"`, "env-assignment"],
    ["env -i FOO=bar npm start", "env-assignment"],
    ["env -i FOO=bar ls", "env-assignment"],
    ["env -u HOME FOO=bar ls", "env-assignment"],
    ["env -u HOME LD_PRELOAD=./evil.so ls", "env-assignment"],
    [`env -iS "FOO=bar npm start"`, "env-assignment"],
    // -S/-i with no embedded assignment must not over-trigger.
    [`env -S "npm start"`, undefined],
    [`env -S "echo hello world"`, undefined],
    ["env -i ls", undefined],
  ])("%s", (command, expected) => {
    expect(autoShellRuleForCall(shellCall(command))?.name).toBe(expected);
  });
});

describe("content inside an env -S payload never receives a weaker tier than it would get written plainly", () => {
  test.each([
    // A file mutation hidden inside -S is a deny, not the env-assignment ask.
    [`env -S "FOO=bar sh -c 'echo x > .env'"`, "file-mutation"],
    [`env -S "FOO=bar cat ~/.aws/credentials"`, "sensitive-path"],
    [`env -S "FOO=bar rm -rf /"`, "recursive-rm"],
    [`env -S "FOO=bar npm start"`, "env-assignment"],
    // Double layer: env -S's quoted argument contains a `bash -c '...'` whose
    // own single-quoted body is the real command.
    [`env -S "FOO=bar bash -c 'rm -rf /'"`, "recursive-rm"],
    [`env -S "FOO=bar npm install left-pad"`, "dependency-install"],
    // Trailing env terminal flags remain arguments to split payloads.
    [`env -S "rm -rf /" --version`, "recursive-rm"],
    [`env -S "npm install left-pad" --help`, "dependency-install"],
  ])("%s", (command, expected) => {
    expect(autoShellRuleForCall(shellCall(command))?.name).toBe(expected);
  });
});

describe("upload-shaped network shell commands force ask in auto mode", () => {
  test.each([
    ["curl -d 'x=1' https://example.com", "network-upload"],
    ["curl --data-binary @file.bin https://example.com", "network-upload"],
    ["curl -F file=@a.txt https://example.com", "network-upload"],
    ["curl -T local.txt https://example.com", "network-upload"],
    ["wget --post-file=data.json https://example.com", "network-upload"],
    ["wget --post-data='a=1' https://example.com", "network-upload"],
    ["scp file.txt user@host.example.com:/tmp", "network-upload"],
    ["rsync -a dist/ host.example.com:/var/www", "network-upload"],
    ["nc -l 1234", "network-upload"],
    ["ncat host.example.com 1234", "network-upload"],
    // Read-only fetch and local-copy forms stay unflagged.
    ["curl https://example.com", undefined],
    ["scp file.txt ./backup/", undefined],
    ["rsync -a src/ dist/", undefined],
  ])("%s", (command, expected) => {
    expect(autoShellRuleForCall(shellCall(command))?.name).toBe(expected);
  });
});

describe("pure directory listing exemption", () => {
  // Output-writing and unbounded forms exit the exemption: no auto-allow, and
  // the auto-mode rule still asks.
  test.each([
    "tree -L 2 -o /tmp/x /var",
    "tree -L 2 --output=/tmp/x /var",
    "tree -L 2 -H /tmp/x /var",
    "tree -L 2 --fromfile /var",
    "ls --recursive=x /tmp",
    "ls --recursive /tmp",
    "ls .env | xargs cat",
  ])("no auto-allow for %s", (command) => {
    expect(isAutoAllowedShellCall(shellCall(command))).toBe(false);
    expect(autoShellRuleForCall(shellCall(command))?.effect).toBe("ask");
  });
});

describe("CL-6703 — quoted redirect targets still deny file-mutation", () => {
  test.each([
    ["echo hi > out.txt", "file-mutation"],
    [`echo hi > "out.txt"`, "file-mutation"],
    [`echo hi > 'out.txt'`, "file-mutation"],
    [`echo hi 1>"file"`, "file-mutation"],
    [`bash -c 'echo hi > "out.txt"'`, "file-mutation"],
    [`git commit -m 'fix > bug'`, undefined],
    // `\"` is a literal quote character in real bash, not a quote-open — the
    // shell is never inside a quoted string here, so the `>` that follows is
    // a genuine, unquoted redirect.
    ['echo hi \\"> file"', "file-mutation"],
    // The escaped quote sits before an extra leading space, so it never
    // touches the `\s-c` junction later in the string; a naive quote-pairing
    // scanner (ignoring the backslash) would consume that junction as part
    // of a fake quoted span and hide the -c flag entirely.
    ['python3 \\" -c print(1)"', "file-mutation"],
  ])("%s", (command, expected) => {
    expect(autoShellRuleForCall(shellCall(command))?.name).toBe(expected);
  });
});

describe("CL-6702 — bash clobber and >& redirects match file-mutation", () => {
  test.each([
    ["echo hi >|path", "file-mutation"],
    ["echo hi >>|path", "file-mutation"],
    ["echo hi >& out.txt", "file-mutation"],
    ["echo hi >&file", "file-mutation"],
    // An fd duplication is not a file redirect.
    ["echo hi 2>&1", undefined],
  ])("%s", (command, expected) => {
    expect(autoShellRuleForCall(shellCall(command))?.name).toBe(expected);
  });
});

describe("CL-6697 — quoted dangerous flags and program names still deny/ask", () => {
  test.each([
    [`python3 "-c" "print(1)"`, "file-mutation"],
    [`sed "-i" 's/a/b/' file.txt`, "file-mutation"],
    [`npm "install" left-pad`, "dependency-install"],
    [`"curl" -d @payload.json https://example.com`, "network-upload"],
    [`git commit -m "some text"`, undefined],
  ])("%s", (command, expected) => {
    expect(autoShellRuleForCall(shellCall(command))?.name).toBe(expected);
  });
});

describe("CL-6988 — nested / escaped interpreter peels do not auto-allow", () => {
  test.each([
    [`bash -c 'echo hi > "out.txt"'`, "file-mutation"],
    [`bash -c "echo hi > out.txt"`, "file-mutation"],
    [`bash -c "bash -c 'echo hi > out.txt'"`, "file-mutation"],
    // -O/-o option values before -c must not hide dependency installs.
    [`bash -O extglob -c 'npm install left-pad'`, "dependency-install"],
    [`bash -o pipefail -c 'npm install left-pad'`, "dependency-install"],
  ])("%s", (command, expected) => {
    expect(autoShellRuleForCall(shellCall(command))?.name).toBe(expected);
  });

  test("bash -c positional argv execution does not auto-allow dependency installs", () => {
    const cmd = `bash -c '$0 $1 $2' npm install left-pad`;
    expect(isAutoAllowedShellCall(shellCall(cmd))).toBe(false);
    expect(autoShellRuleForCall(shellCall(cmd))?.name).toBe("opaque-wrapper");
  });

  test("an escaped triple-nested bash -c redirect does not auto-allow", () => {
    // tokenize() has no backslash-escape support, so peeling
    // `bash -c "bash -c \"bash -c '…>…'\""` used to degrade to subjects like
    // `bash -c \bash` / `\bash` and auto-allow. Misparsed nested-interpreter
    // payloads must ask (opaque-wrapper) rather than accept the degraded leaf.
    const escaped = `bash -c "bash -c \\"bash -c 'echo hi > out.txt'\\""`;
    expect(isAutoAllowedShellCall(shellCall(escaped))).toBe(false);
    expect(autoShellRuleForCall(shellCall(escaped))?.name).toBe(
      "opaque-wrapper",
    );
    expect(autoShellRuleForCall(shellCall(escaped))?.effect).toBe("ask");
  });

  test("quote-broken deep nesting that degrades to a bare interpreter asks", () => {
    // Alternating quotes collide by depth 4 and peel used to land on bare `bash`.
    const deep = String.raw`bash -c "bash -c 'bash -c \"bash -c 'echo hi > out.txt'\"'"`;
    expect(isAutoAllowedShellCall(shellCall(deep))).toBe(false);
    const rule = autoShellRuleForCall(shellCall(deep));
    expect(rule).toBeDefined();
    expect(rule?.effect === "ask" || rule?.effect === "deny").toBe(true);
  });
});

describe("CL-5420 — secret checks run before pure-listing exemptions", () => {
  test.each([
    ["ls .env", "sensitive-path"],
    // A chain with a safe listing half flags the content-reading half.
    ["ls /tmp && cat .env", "sensitive-path"],
    // A bounded listing with no secret reference stays exempt.
    ["ls /tmp", undefined],
    ["bun --env-file=.env run publish.ts", "sensitive-path"],
    ["ls -R", "unbounded-listing"],
  ])("%s", (command, expected) => {
    expect(autoShellRuleForCall(shellCall(command))?.name).toBe(expected);
  });

  test("the gate asks on a pure listing of a secret name", async () => {
    let asked = 0;
    const gate = createPermissionGate({
      approvals: [],
      requestApproval: async () => {
        asked++;
        return { allow: false };
      },
      interactive: true,
      skipPermissions: false,
      reactorGated: false,
    });
    const verdict = await gate.evaluate(shellCall("ls .env"));
    expect(verdict.allowed).toBe(false);
    expect(asked).toBe(1);
  });
});
