import { describe, test, expect } from "bun:test";
import type { ToolCall } from "@intx/types/runtime";
import { isAutoAllowedShellCall, isAutoAllowedShellSegment } from "./classify.js";
import { autoShellRuleForCall } from "./auto-shell-policy.js";
import { createPermissionGate } from "./gate.js";
import { secretGuardPlugin } from "../plugins/secret-guard-plugin.js";

const shellCall = (command: string): ToolCall => ({
  id: "c",
  name: "run_shell",
  arguments: { command },
});

describe("isAutoAllowedShellCall — code-executing flags", () => {
  test("does not auto-allow rg --pre (arbitrary binary execution)", () => {
    expect(isAutoAllowedShellCall(shellCall("rg --pre sh foo"))).toBe(false);
    expect(isAutoAllowedShellCall(shellCall("rg --pre=sh foo"))).toBe(false);
  });

  test("does not auto-allow other rg exec-capable flags", () => {
    expect(isAutoAllowedShellCall(shellCall("rg --pre-glob '*.gz' foo"))).toBe(false);
    expect(isAutoAllowedShellCall(shellCall("rg --hostname-bin /bin/sh foo"))).toBe(false);
    expect(isAutoAllowedShellCall(shellCall("rg --search-zip foo"))).toBe(false);
    expect(isAutoAllowedShellCall(shellCall("rg -z foo"))).toBe(false);
  });

  test("does not auto-allow shell rg or recursive grep (authz open-ended search)", () => {
    expect(isAutoAllowedShellCall(shellCall("rg pattern src"))).toBe(false);
    expect(isAutoAllowedShellCall(shellCall("grep -r needle ."))).toBe(false);
  });

  test("still auto-allows bounded non-recursive grep", () => {
    expect(isAutoAllowedShellCall(shellCall("grep -n foo file.ts"))).toBe(true);
  });
});

describe("isAutoAllowedShellCall — sensitive-path arguments", () => {
  test("does not auto-allow reads of secret files", () => {
    expect(isAutoAllowedShellCall(shellCall("cat .env"))).toBe(false);
    expect(isAutoAllowedShellCall(shellCall("cat .env.production"))).toBe(false);
    expect(isAutoAllowedShellCall(shellCall("head id_rsa"))).toBe(false);
    expect(isAutoAllowedShellCall(shellCall("cat server.pem"))).toBe(false);
    expect(isAutoAllowedShellCall(shellCall("cat cert.p12"))).toBe(false);
    expect(isAutoAllowedShellCall(shellCall("cat .ssh/known_hosts"))).toBe(false);
    expect(isAutoAllowedShellCall(shellCall("cat .netrc"))).toBe(false);
    expect(isAutoAllowedShellCall(shellCall("cat .git-credentials"))).toBe(false);
  });

  test("still auto-allows reads of ordinary files", () => {
    expect(isAutoAllowedShellCall(shellCall("cat src/index.ts"))).toBe(true);
    expect(isAutoAllowedShellCall(shellCall("cat .env.example"))).toBe(true);
  });
});

describe("isAutoAllowedShellCall — environment dump", () => {
  test("does not auto-allow printenv (full env dump)", () => {
    expect(isAutoAllowedShellCall(shellCall("printenv"))).toBe(false);
    expect(isAutoAllowedShellCall(shellCall("printenv PATH"))).toBe(false);
  });

  test("does not auto-allow bare env", () => {
    expect(isAutoAllowedShellCall(shellCall("env"))).toBe(false);
  });
});

describe("isAutoAllowedShellCall — workspace containment", () => {
  test("denies reads of paths outside the workspace", () => {
    expect(isAutoAllowedShellCall(shellCall("cat /etc/passwd"), "/repo")).toBe(false);
    expect(isAutoAllowedShellCall(shellCall("strings /proc/self/environ"), "/repo")).toBe(false);
    expect(isAutoAllowedShellCall(shellCall("xxd ../../etc/hosts"), "/repo")).toBe(false);
    expect(isAutoAllowedShellCall(shellCall("cat ~/.aws/config"), "/repo")).toBe(false);
  });

  test("allows reads of paths inside the workspace", () => {
    expect(isAutoAllowedShellCall(shellCall("cat src/index.ts"), "/repo")).toBe(true);
    expect(isAutoAllowedShellCall(shellCall("wc -l README.md"), "/repo")).toBe(true);
    expect(isAutoAllowedShellCall(shellCall("ls -la"), "/repo")).toBe(true);
    expect(isAutoAllowedShellCall(shellCall("grep -n needle README.md"), "/repo")).toBe(true);
  });

  test("denies a workspace-escaping path glued to a grep/rg flag value", () => {
    expect(isAutoAllowedShellCall(shellCall("grep --file=/etc/passwd ."), "/repo")).toBe(false);
    expect(isAutoAllowedShellCall(shellCall("grep -f/etc/passwd ."), "/repo")).toBe(false);
    expect(isAutoAllowedShellCall(shellCall("rg --file=/etc/passwd ."), "/repo")).toBe(false);
    // A separated flag value is a positional token and already caught.
    expect(isAutoAllowedShellCall(shellCall("grep -f /etc/passwd ."), "/repo")).toBe(false);
  });

  test("allows an in-workspace flag-glued path", () => {
    expect(isAutoAllowedShellCall(shellCall("grep --file=patterns.txt src"), "/repo")).toBe(true);
  });

  // Pure directory listing is names/metadata only — outside-workspace targets
  // still auto-allow. Content readers (cat, head, …) remain contained.
  // tree requires an explicit depth bound (-L / --max-depth); unbounded tree
  // walks are not pure listing (same OOM class as open-ended find/rg).
  test("auto-allows pure directory listing outside the workspace", () => {
    expect(isAutoAllowedShellCall(shellCall("ls /tmp"), "/repo")).toBe(true);
    expect(isAutoAllowedShellCall(shellCall("ls -la ~"), "/repo")).toBe(true);
    expect(isAutoAllowedShellCall(shellCall("tree -L 1 /var"), "/repo")).toBe(true);
    expect(isAutoAllowedShellCall(shellCall("tree --max-depth=2 /var"), "/repo")).toBe(true);
    expect(isAutoAllowedShellCall(shellCall("tree -L10 /var"), "/repo")).toBe(true);
  });

  test("does not auto-allow unbounded recursive directory listing", () => {
    expect(isAutoAllowedShellCall(shellCall("ls -R /"), "/repo")).toBe(false);
    expect(isAutoAllowedShellCall(shellCall("ls -laR /tmp"), "/repo")).toBe(false);
    expect(isAutoAllowedShellCall(shellCall("ls --recursive /var"), "/repo")).toBe(false);
    expect(isAutoAllowedShellCall(shellCall("tree /"), "/repo")).toBe(false);
    expect(isAutoAllowedShellCall(shellCall("tree /var"), "/repo")).toBe(false);
    // Depth present but over the pure-listing cap still forces ask (OOM).
    expect(isAutoAllowedShellCall(shellCall("tree -L 999999 /"), "/repo")).toBe(false);
    expect(isAutoAllowedShellCall(shellCall("tree --max-depth=99 /var"), "/repo")).toBe(false);
  });

  test("auto mode forces ask for unbounded recursive listing even inside workspace", () => {
    expect(autoShellRuleForCall(shellCall("ls -R ."))?.name).toBe("unbounded-listing");
    expect(autoShellRuleForCall(shellCall("ls -laR packages"))?.name).toBe("unbounded-listing");
    expect(autoShellRuleForCall(shellCall("tree ."))?.name).toBe("unbounded-listing");
    expect(autoShellRuleForCall(shellCall("tree packages"))?.name).toBe("unbounded-listing");
    expect(autoShellRuleForCall(shellCall("tree -L 999999 packages"))?.name).toBe(
      "unbounded-listing",
    );
    // Bounded forms stay free of the ask rule.
    expect(autoShellRuleForCall(shellCall("ls packages"))).toBeUndefined();
    expect(autoShellRuleForCall(shellCall("tree -L 2 packages"))).toBeUndefined();
  });

  test("still denies content reads outside the workspace", () => {
    expect(isAutoAllowedShellCall(shellCall("cat /etc/passwd"), "/repo")).toBe(false);
    expect(isAutoAllowedShellCall(shellCall("head ~/.aws/config"), "/repo")).toBe(false);
  });
});

describe("pure directory listing — outside-workspace auto-shell policy", () => {
  // Paths that resolve outside /repo are restricted; ~ is also treated as
  // outside by commandTargetsRestricted. Pure ls/tree must not trip the ask rule.
  const isRestricted = (path: string): boolean =>
    path.startsWith("~") || path.startsWith("/") || path.includes("..");

  test("does not force outside-workspace ask for pure ls/tree outside paths", () => {
    expect(autoShellRuleForCall(shellCall("ls /tmp"), isRestricted)).toBeUndefined();
    expect(autoShellRuleForCall(shellCall("ls -la ~"), isRestricted)).toBeUndefined();
    expect(autoShellRuleForCall(shellCall("tree -L 1 /var"), isRestricted)).toBeUndefined();
  });

  test("unbounded recursive listing outside still forces ask", () => {
    // Unbounded listing is the more specific OOM rule and wins over
    // outside-workspace when both would apply.
    expect(autoShellRuleForCall(shellCall("ls -R /tmp"), isRestricted)?.name).toBe(
      "unbounded-listing",
    );
    expect(autoShellRuleForCall(shellCall("tree /var"), isRestricted)?.name).toBe(
      "unbounded-listing",
    );
  });

  test("still forces outside-workspace ask for content reads outside paths", () => {
    // Non-sensitive outside paths so this asserts containment, not the
    // sensitive-path ask rule (which fires first for e.g. ~/.aws/config).
    expect(autoShellRuleForCall(shellCall("cat /etc/passwd"), isRestricted)?.name).toBe(
      "outside-workspace",
    );
    expect(autoShellRuleForCall(shellCall("head /tmp/notes.txt"), isRestricted)?.name).toBe(
      "outside-workspace",
    );
  });

  test("chained ls outside + cat outside still asks for the content half", () => {
    expect(autoShellRuleForCall(shellCall("ls /tmp && cat /etc/passwd"), isRestricted)?.name).toBe(
      "outside-workspace",
    );
  });
});

describe("isAutoAllowedShellSegment — command substitution", () => {
  test("does not auto-allow a segment containing backtick command substitution", () => {
    expect(isAutoAllowedShellSegment("echo `rm -rf ./build`")).toBe(false);
  });

  test("does not auto-allow a segment containing $() command substitution", () => {
    expect(isAutoAllowedShellSegment("echo $(rm -rf ./build)")).toBe(false);
  });
});

describe("credential-print shell commands force ask in auto mode", () => {
  test("macOS keychain find-*-password subcommands", () => {
    expect(
      autoShellRuleForCall(shellCall("security find-generic-password -w -s myservice"))?.name,
    ).toBe("credential-print");
    expect(
      autoShellRuleForCall(shellCall("security find-internet-password -w -s example.com"))?.name,
    ).toBe("credential-print");
  });

  test("gpg secret-key export", () => {
    const rule = autoShellRuleForCall(shellCall("gpg --export-secret-keys -a me@example.com"));
    expect(rule?.name).toBe("credential-print");
    expect(rule?.effect).toBe("ask");
  });

  test("cloud CLI token printers", () => {
    expect(autoShellRuleForCall(shellCall("aws configure get aws_secret_access_key"))?.name).toBe(
      "credential-print",
    );
    expect(autoShellRuleForCall(shellCall("gcloud auth print-access-token"))?.name).toBe(
      "credential-print",
    );
  });

  test("does not flag ordinary security/gcloud/aws usage", () => {
    expect(autoShellRuleForCall(shellCall("gcloud auth list"))).toBeUndefined();
    expect(autoShellRuleForCall(shellCall("aws configure list"))).toBeUndefined();
  });
});

describe("git config mutation outside the repo forces ask in auto mode", () => {
  test("--global write or read", () => {
    expect(autoShellRuleForCall(shellCall("git config --global user.name foo"))?.name).toBe(
      "git-global-config",
    );
    expect(autoShellRuleForCall(shellCall("git config --global --get-regexp url."))?.name).toBe(
      "git-global-config",
    );
  });

  test("--system", () => {
    expect(autoShellRuleForCall(shellCall("git config --system user.name foo"))?.name).toBe(
      "git-global-config",
    );
  });

  test("--edit opens an editor on a config file, which can write anything", () => {
    expect(autoShellRuleForCall(shellCall("git config --global --edit"))?.name).toBe(
      "git-global-config",
    );
    expect(autoShellRuleForCall(shellCall("git config --edit"))?.name).toBe("git-global-config");
  });

  test("--file to a path outside the workspace asks (via the outside-workspace rule)", () => {
    expect(
      autoShellRuleForCall(shellCall("git config --file ~/.gitconfig user.name foo"))?.effect,
    ).toBe("ask");
  });

  test("--file to a workspace-relative path still asks on its own", () => {
    expect(
      autoShellRuleForCall(shellCall("git config --file scratch.gitconfig user.name foo"))?.name,
    ).toBe("git-global-config");
  });

  test("unsetting GIT_CONFIG_GLOBAL falls back to the real ~/.gitconfig", () => {
    expect(autoShellRuleForCall(shellCall("unset GIT_CONFIG_GLOBAL"))?.name).toBe(
      "git-global-config",
    );
  });

  test("reassigning GIT_CONFIG_GLOBAL is caught by the general env-assignment rule", () => {
    expect(
      autoShellRuleForCall(shellCall("GIT_CONFIG_GLOBAL=/tmp/x git config --global foo bar"))?.name,
    ).toBe("env-assignment");
  });

  test("does not flag a plain repo-local config read or write", () => {
    expect(autoShellRuleForCall(shellCall("git config user.name"))).toBeUndefined();
    expect(autoShellRuleForCall(shellCall("git config user.email me@example.com"))).toBeUndefined();
    expect(autoShellRuleForCall(shellCall("git config --local user.name foo"))).toBeUndefined();
  });
});

describe("sensitive-path shell commands require approval, not a hard deny", () => {
  test("secret-guard no longer hard-denies shell references to secret files", async () => {
    const middleware = secretGuardPlugin().middleware;
    if (middleware === undefined) throw new Error("secretGuardPlugin must provide middleware");
    const next = async () => ({ callId: "c", content: "ran", isError: false });
    const result = await middleware(next)(shellCall("cat .env"), new AbortController().signal);
    expect(result.isError).not.toBe(true);
    expect(result.content).toBe("ran");
  });

  test("auto mode forces ask for shell commands that reference secret files", () => {
    const rule = autoShellRuleForCall(shellCall("bun --env-file=.env.staging run publish.ts"));
    expect(rule?.name).toBe("sensitive-path");
    expect(rule?.effect).toBe("ask");
  });

  test("operator approval lets a sensitive-path shell command through the gate", async () => {
    let asked = 0;
    const gate = createPermissionGate({
      approvals: [],
      requestApproval: async () => {
        asked++;
        return { allow: true };
      },
      interactive: true,
      skipPermissions: false,
    });
    const verdict = await gate.evaluate(
      shellCall("bun --env-file=../../.env.staging run bin/publish.ts"),
    );
    expect(verdict.allowed).toBe(true);
    expect(asked).toBe(1);
  });

  test("auto mode still prompts (does not rubber-stamp) sensitive-path shell commands", async () => {
    let asked = 0;
    const gate = createPermissionGate({
      approvals: [],
      requestApproval: async () => {
        asked++;
        return { allow: true };
      },
      interactive: true,
      skipPermissions: false,
      auto: true,
    });
    const verdict = await gate.evaluate(shellCall("cat .env"));
    expect(verdict.allowed).toBe(true);
    expect(asked).toBe(1);
  });

  test("stored grants do not authorize secret-path shell commands", async () => {
    let asked = 0;
    const gate = createPermissionGate({
      approvals: [{ tool: "run_shell", pattern: "cat *" }],
      requestApproval: async () => {
        asked++;
        return { allow: true };
      },
      interactive: true,
      skipPermissions: false,
    });
    const verdict = await gate.evaluate(shellCall("cat .env"));
    expect(verdict.allowed).toBe(true);
    expect(asked).toBe(1);
  });

  test("stored grants still authorize ordinary shell reads", async () => {
    let asked = 0;
    const gate = createPermissionGate({
      approvals: [{ tool: "run_shell", pattern: "cat *" }],
      requestApproval: async () => {
        asked++;
        return { allow: true };
      },
      interactive: true,
      skipPermissions: false,
    });
    const verdict = await gate.evaluate(shellCall("cat README.md"));
    expect(verdict.allowed).toBe(true);
    expect(asked).toBe(0);
  });

  test("auto mode + grant still re-prompts for secret-path shell", async () => {
    let asked = 0;
    const gate = createPermissionGate({
      approvals: [{ tool: "run_shell", pattern: "cat *" }],
      requestApproval: async () => {
        asked++;
        return { allow: true };
      },
      interactive: true,
      skipPermissions: false,
      auto: true,
    });
    const verdict = await gate.evaluate(shellCall("cat .env"));
    expect(verdict.allowed).toBe(true);
    expect(asked).toBe(1);
  });

  test("headless mode denies secret-path shell even with a matching grant", async () => {
    const gate = createPermissionGate({
      approvals: [{ tool: "run_shell", pattern: "cat *" }],
      interactive: false,
      skipPermissions: false,
    });
    const verdict = await gate.evaluate(shellCall("cat .env"));
    expect(verdict.allowed).toBe(false);
  });

  test("file-mutation deny beats sensitive-path ask in auto mode", () => {
    const rule = autoShellRuleForCall(shellCall("echo x > .env"));
    expect(rule?.name).toBe("file-mutation");
    expect(rule?.effect).toBe("deny");
  });

  test("auto mode hard-denies shell file mutation of a secret path", async () => {
    let asked = 0;
    const gate = createPermissionGate({
      approvals: [],
      requestApproval: async () => {
        asked++;
        return { allow: true };
      },
      interactive: true,
      skipPermissions: false,
      auto: true,
    });
    const verdict = await gate.evaluate(shellCall("echo x > .env"));
    expect(verdict.allowed).toBe(false);
    expect(asked).toBe(0);
  });

  test("exact grant for a secret-path command still re-prompts", async () => {
    let asked = 0;
    const gate = createPermissionGate({
      approvals: [{ tool: "run_shell", pattern: "cat .env" }],
      requestApproval: async () => {
        asked++;
        return { allow: true };
      },
      interactive: true,
      skipPermissions: false,
    });
    const verdict = await gate.evaluate(shellCall("cat .env"));
    expect(verdict.allowed).toBe(true);
    expect(asked).toBe(1);
  });

  test("provider-model grant does not authorize secret-path shell", async () => {
    let asked = 0;
    const gate = createPermissionGate({
      approvals: [{ tool: "run_shell", pattern: "cat *", providerModel: "openai:gpt-4o" }],
      requestApproval: async () => {
        asked++;
        return { allow: true };
      },
      interactive: true,
      skipPermissions: false,
      providerName: "openai",
      model: "gpt-4o",
    });
    const verdict = await gate.evaluate(shellCall("cat .env"));
    expect(verdict.allowed).toBe(true);
    expect(asked).toBe(1);
  });

  test("preApprove of a secret-path command still re-prompts", async () => {
    let asked = 0;
    const gate = createPermissionGate({
      approvals: [],
      requestApproval: async () => {
        asked++;
        return { allow: true };
      },
      interactive: true,
      skipPermissions: false,
    });
    gate.preApprove("run_shell", "cat .env");
    const verdict = await gate.evaluate(shellCall("cat .env"));
    expect(verdict.allowed).toBe(true);
    expect(asked).toBe(1);
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
    });
    expect((await gate.evaluate(shellCall("cat .env"))).allowed).toBe(true);
    expect((await gate.evaluate(shellCall("cat .env"))).allowed).toBe(true);
    // Persist scopes stripped; no grant stored so every call re-asks.
    expect(seenScopes).toEqual([[], []]);
    expect(persisted).toHaveLength(0);
    expect(asked).toBe(2);
  });

  test("auto mode + grant still hard-denies mutation of a secret path", async () => {
    let asked = 0;
    const gate = createPermissionGate({
      approvals: [{ tool: "run_shell", pattern: "echo *" }],
      requestApproval: async () => {
        asked++;
        return { allow: true };
      },
      interactive: true,
      skipPermissions: false,
      auto: true,
    });
    const verdict = await gate.evaluate(shellCall("echo x > .env"));
    expect(verdict.allowed).toBe(false);
    expect(asked).toBe(0);
  });
});

describe("env-assignment shell commands force ask in auto mode", () => {
  test("a bare NAME=value prefix asks", () => {
    expect(autoShellRuleForCall(shellCall("FOO=bar npm start"))?.name).toBe("env-assignment");
    expect(autoShellRuleForCall(shellCall("A=1 B=2 npm start"))?.name).toBe("env-assignment");
  });

  test("export asks, with or without an assignment", () => {
    expect(autoShellRuleForCall(shellCall("export FOO=bar"))?.name).toBe("env-assignment");
    expect(autoShellRuleForCall(shellCall("export FOO"))?.name).toBe("env-assignment");
  });

  test("the env command used to set a variable asks", () => {
    expect(autoShellRuleForCall(shellCall("env FOO=bar npm start"))?.name).toBe("env-assignment");
  });

  test("bare env/nice/timeout wrappers with no assignment still peel through untouched", () => {
    expect(autoShellRuleForCall(shellCall("env npm test"))).toBeUndefined();
    expect(autoShellRuleForCall(shellCall("nice -n 10 npm test"))).toBeUndefined();
    expect(autoShellRuleForCall(shellCall("timeout 30 npm test"))).toBeUndefined();
  });

  test("an env-assignment prefix on a later chain segment still asks", () => {
    const rule = autoShellRuleForCall(shellCall("ls && FOO=bar npm start"));
    expect(rule?.name).toBe("env-assignment");
  });

  test("file-mutation deny still beats an env-assignment ask", () => {
    const rule = autoShellRuleForCall(shellCall("FOO=bar sh -c 'echo x > .env'"));
    expect(rule?.name).toBe("file-mutation");
  });

  test("env -S with an embedded assignment asks (the assignment lives inside the quoted argument)", () => {
    expect(autoShellRuleForCall(shellCall(`env -S "FOO=bar sh -c 'echo got:$FOO'"`))?.name).toBe(
      "env-assignment",
    );
  });

  test("env --split-string sibling forms with an embedded assignment ask", () => {
    expect(autoShellRuleForCall(shellCall(`env --split-string="FOO=bar npm start"`))?.name).toBe(
      "env-assignment",
    );
    expect(autoShellRuleForCall(shellCall(`env --split-string "FOO=bar npm start"`))?.name).toBe(
      "env-assignment",
    );
  });

  test("env -i with a plain assignment argument asks", () => {
    expect(autoShellRuleForCall(shellCall("env -i FOO=bar npm start"))?.name).toBe(
      "env-assignment",
    );
  });

  test("stacked short flags (env -iS) with an embedded assignment ask", () => {
    expect(autoShellRuleForCall(shellCall(`env -iS "FOO=bar npm start"`))?.name).toBe(
      "env-assignment",
    );
  });

  test("env -S with no embedded assignment does not over-trigger", () => {
    expect(autoShellRuleForCall(shellCall(`env -S "npm start"`))).toBeUndefined();
    expect(autoShellRuleForCall(shellCall(`env -S "echo hello world"`))).toBeUndefined();
  });

  test("env -i with no assignment does not over-trigger", () => {
    expect(autoShellRuleForCall(shellCall("env -i ls"))).toBeUndefined();
  });
});

describe("content inside an env -S payload never receives a weaker tier than it would get written plainly", () => {
  test("a file mutation hidden inside -S is a deny, not the plain env-assignment ask", () => {
    const rule = autoShellRuleForCall(shellCall(`env -S "FOO=bar sh -c 'echo x > .env'"`));
    expect(rule?.name).toBe("file-mutation");
    expect(rule?.effect).toBe("deny");
  });

  test("a secret-path reference hidden inside -S gets the sensitive-path ask, not env-assignment", () => {
    const rule = autoShellRuleForCall(shellCall(`env -S "FOO=bar cat ~/.aws/credentials"`));
    expect(rule?.name).toBe("sensitive-path");
  });

  test("a catastrophic recursive rm hidden inside -S is recognized as recursive-rm, not env-assignment", () => {
    const rule = autoShellRuleForCall(shellCall(`env -S "FOO=bar rm -rf /"`));
    expect(rule?.name).toBe("recursive-rm");
  });

  test("an assignment plus a benign command inside -S still just asks (unchanged)", () => {
    const rule = autoShellRuleForCall(shellCall(`env -S "FOO=bar npm start"`));
    expect(rule?.name).toBe("env-assignment");
  });

  test("nested quoting inside the payload (env -S wrapping bash -c) still surfaces the stricter tier", () => {
    // Double layer: env -S's own double-quoted argument contains a
    // `bash -c '...'` whose own single-quoted body is the real command.
    const rule = autoShellRuleForCall(shellCall(`env -S "FOO=bar bash -c 'rm -rf /'"`));
    expect(rule?.name).toBe("recursive-rm");
    expect(rule?.name).not.toBe("env-assignment");
  });

  test("a dependency install hidden inside -S still asks under its own more specific name", () => {
    const rule = autoShellRuleForCall(shellCall(`env -S "FOO=bar npm install left-pad"`));
    expect(rule?.name).toBe("dependency-install");
  });
});

describe("upload-shaped network shell commands force ask in auto mode", () => {
  test("curl with a data flag asks", () => {
    expect(autoShellRuleForCall(shellCall("curl -d 'x=1' https://example.com"))?.name).toBe(
      "network-upload",
    );
    expect(
      autoShellRuleForCall(shellCall("curl --data-binary @file.bin https://example.com"))?.name,
    ).toBe("network-upload");
    expect(autoShellRuleForCall(shellCall("curl -F file=@a.txt https://example.com"))?.name).toBe(
      "network-upload",
    );
    expect(autoShellRuleForCall(shellCall("curl -T local.txt https://example.com"))?.name).toBe(
      "network-upload",
    );
  });

  test("a plain read-only curl GET does not ask under this rule", () => {
    expect(autoShellRuleForCall(shellCall("curl https://example.com"))).toBeUndefined();
  });

  test("wget posting a file or payload asks", () => {
    expect(
      autoShellRuleForCall(shellCall("wget --post-file=data.json https://example.com"))?.name,
    ).toBe("network-upload");
    expect(
      autoShellRuleForCall(shellCall("wget --post-data='a=1' https://example.com"))?.name,
    ).toBe("network-upload");
  });

  test("scp/rsync to a remote target asks", () => {
    expect(autoShellRuleForCall(shellCall("scp file.txt user@host.example.com:/tmp"))?.name).toBe(
      "network-upload",
    );
    expect(autoShellRuleForCall(shellCall("rsync -a dist/ host.example.com:/var/www"))?.name).toBe(
      "network-upload",
    );
  });

  test("scp/rsync to a local target does not ask under this rule", () => {
    expect(autoShellRuleForCall(shellCall("scp file.txt ./backup/"))).toBeUndefined();
    expect(autoShellRuleForCall(shellCall("rsync -a src/ dist/"))).toBeUndefined();
  });

  test("netcat in any form asks", () => {
    expect(autoShellRuleForCall(shellCall("nc -l 1234"))?.name).toBe("network-upload");
    expect(autoShellRuleForCall(shellCall("ncat host.example.com 1234"))?.name).toBe(
      "network-upload",
    );
  });
});

describe("pure directory listing exemption", () => {
  test("tree writing its output to a file does not auto-allow", () => {
    expect(isAutoAllowedShellCall(shellCall("tree -L 2 -o /tmp/x /var"))).toBe(false);
    expect(autoShellRuleForCall(shellCall("tree -L 2 -o /tmp/x /var"))?.effect).toBe("ask");
    expect(autoShellRuleForCall(shellCall("tree -L 2 --output=/tmp/x /var"))?.effect).toBe("ask");
    expect(autoShellRuleForCall(shellCall("tree -L 2 -H /tmp/x /var"))?.effect).toBe("ask");
    expect(autoShellRuleForCall(shellCall("tree -L 2 --fromfile /var"))?.effect).toBe("ask");
  });

  test("long-form recursive ls does not auto-allow", () => {
    expect(isAutoAllowedShellCall(shellCall("ls --recursive=x /tmp"))).toBe(false);
    expect(autoShellRuleForCall(shellCall("ls --recursive=x /tmp"))?.effect).toBe("ask");
    expect(autoShellRuleForCall(shellCall("ls --recursive /tmp"))?.effect).toBe("ask");
  });

  test("a listing stage piped into a content reader does not auto-allow", () => {
    expect(isAutoAllowedShellCall(shellCall("ls .env | xargs cat"))).toBe(false);
    expect(autoShellRuleForCall(shellCall("ls .env | xargs cat"))?.effect).toBe("ask");
  });
});

describe("CL-6703 — quoted redirect targets still deny file-mutation", () => {
  test("plain unquoted redirect denies (baseline)", () => {
    expect(autoShellRuleForCall(shellCall("echo hi > out.txt"))?.name).toBe("file-mutation");
  });

  test("a quoted redirect target denies", () => {
    expect(autoShellRuleForCall(shellCall(`echo hi > "out.txt"`))?.name).toBe("file-mutation");
    expect(autoShellRuleForCall(shellCall(`echo hi > 'out.txt'`))?.name).toBe("file-mutation");
  });

  test('a quoted fd-qualified redirect target (1>"file") denies', () => {
    expect(autoShellRuleForCall(shellCall(`echo hi 1>"file"`))?.name).toBe("file-mutation");
  });

  test("a nested bash -c form with a quoted redirect denies", () => {
    expect(autoShellRuleForCall(shellCall(`bash -c 'echo hi > "out.txt"'`))?.name).toBe(
      "file-mutation",
    );
  });

  test("a quoted '>' inside non-redirect text does not false-positive", () => {
    expect(autoShellRuleForCall(shellCall(`git commit -m 'fix > bug'`))).toBeUndefined();
  });
});

describe("CL-6702 — bash clobber redirects match file-mutation", () => {
  test("echo hi >|path denies", () => {
    expect(autoShellRuleForCall(shellCall("echo hi >|path"))?.name).toBe("file-mutation");
  });

  test("echo hi >>|path denies", () => {
    expect(autoShellRuleForCall(shellCall("echo hi >>|path"))?.name).toBe("file-mutation");
  });
});

describe("CL-6697 — quoted dangerous flags and program names still deny/ask", () => {
  test("a quoted -c interpreter one-liner denies", () => {
    expect(autoShellRuleForCall(shellCall(`python3 "-c" "print(1)"`))?.name).toBe("file-mutation");
  });

  test("a quoted sed -i denies", () => {
    expect(autoShellRuleForCall(shellCall(`sed "-i" 's/a/b/' file.txt`))?.name).toBe(
      "file-mutation",
    );
  });

  test("a quoted npm install asks", () => {
    expect(autoShellRuleForCall(shellCall(`npm "install" left-pad`))?.name).toBe(
      "dependency-install",
    );
  });

  test("a quoted upload-tool argv0 (curl) asks", () => {
    expect(
      autoShellRuleForCall(shellCall(`"curl" -d @payload.json https://example.com`))?.name,
    ).toBe("network-upload");
  });

  test("an innocent quoted argument interior does not false-positive", () => {
    expect(autoShellRuleForCall(shellCall(`git commit -m "some text"`))).toBeUndefined();
  });
});
