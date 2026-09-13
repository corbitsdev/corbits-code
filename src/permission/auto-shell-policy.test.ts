import { describe, test, expect } from "bun:test";
import type { ToolCall } from "@intx/types/runtime";
import { autoShellRuleForCall } from "./auto-shell-policy.js";

const shellCall = (command: string): ToolCall => ({
  id: "c",
  name: "run_shell",
  arguments: { command },
});

// Base git-global-config routing (--global/--system/--edit, --file targets,
// unset/reassignment of GIT_CONFIG_GLOBAL, repo-local pass-through) is pinned
// in classify-security.test.ts. This file pins the surface that file does not:
// shell wrappers and quoting must not demote the ask to an auto-allow.
describe("git-global-config ask survives shell wrappers", () => {
  // Control: the plain form names the rule the wrapped forms must still hit.
  test("plain form names the rule", () => {
    expect(
      autoShellRuleForCall(shellCall("git config --global user.name foo"))
        ?.name,
    ).toBe("git-global-config");
  });

  test("sh -c and bash -c payloads still match", () => {
    expect(
      autoShellRuleForCall(
        shellCall("sh -c 'git config --global user.name foo'"),
      )?.name,
    ).toBe("git-global-config");
    expect(
      autoShellRuleForCall(
        shellCall('bash -c "git config --global user.email x@y.z"'),
      )?.name,
    ).toBe("git-global-config");
  });

  test("bare and piped xargs do not bypass the ask", () => {
    expect(
      autoShellRuleForCall(shellCall("xargs git config --global user.name foo"))
        ?.name,
    ).toBe("git-global-config");
    expect(
      autoShellRuleForCall(
        shellCall("echo refs | xargs git config --global user.name foo"),
      )?.name,
    ).toBe("git-global-config");
  });

  test("transparent env prefix still peels through to the rule", () => {
    expect(
      autoShellRuleForCall(shellCall("env git config --global user.name foo"))
        ?.name,
    ).toBe("git-global-config");
  });

  test("a NAME=value prefix still asks (env-assignment fires first)", () => {
    // The assignment itself is the earlier ask rule in the table, so the name
    // differs — what is pinned here is that the call never auto-allows.
    const rule = autoShellRuleForCall(
      shellCall("FOO=bar git config --global user.name foo"),
    );
    expect(rule?.effect).toBe("ask");
    expect(rule?.name).toBe("env-assignment");
  });

  test("quote round-trips on the program or flag still match", () => {
    expect(
      autoShellRuleForCall(shellCall('git "config" --global user.name foo'))
        ?.name,
    ).toBe("git-global-config");
    expect(
      autoShellRuleForCall(shellCall("git config '--global' user.name foo"))
        ?.name,
    ).toBe("git-global-config");
    expect(
      autoShellRuleForCall(
        shellCall("sh -c 'git \"config\" --global user.name foo'"),
      )?.name,
    ).toBe("git-global-config");
  });
});

describe("read-only git commands pass through the policy", () => {
  test("scoped reads and repo-local writes stay unflagged", () => {
    expect(
      autoShellRuleForCall(shellCall("git config --get user.name")),
    ).toBeUndefined();
    expect(
      autoShellRuleForCall(shellCall("git config --list")),
    ).toBeUndefined();
    expect(
      autoShellRuleForCall(shellCall("git config --get-regexp '^branch\\.'")),
    ).toBeUndefined();
    expect(
      autoShellRuleForCall(shellCall("git status --porcelain")),
    ).toBeUndefined();
  });
});

describe("git worktree force spellings ask (CL-6824)", () => {
  // Control: a contained non-force add is not flagged at all.
  test("contained non-force add stays unflagged", () => {
    expect(
      autoShellRuleForCall(shellCall("git worktree add ./wt-plain")),
    ).toBeUndefined();
  });

  // Git has no --force=<value> form — real git dies with
  // "error: option `force' takes no value" (exit 129) — but the spelling
  // still expresses force intent, so the policy asks rather than letting the
  // --flag=value skip swallow it the way the old exact-match check did.
  test("--force=<value> spellings hit the worktree ask rule", () => {
    for (const flag of ["--force=true", "--force=1", "--force="]) {
      expect(
        autoShellRuleForCall(shellCall(`git worktree add ${flag} ./wt-eq`))
          ?.name,
      ).toBe("git-worktree");
    }
  });

  // Short -f takes no value either — real git dies with
  // "error: unknown switch `='" for `-f=<value>` and
  // "error: unknown switch `<char>'" for glued `-f<val>` (exit 129 both) —
  // but the spellings still express force intent, so the policy asks rather
  // than letting the generic-flag skip swallow them.
  test("-f=<value> and glued -f<val> spellings hit the worktree ask rule", () => {
    for (const flag of ["-f=true", "-f=", "-ftrue", "-ff"]) {
      expect(
        autoShellRuleForCall(shellCall(`git worktree add ${flag} ./wt-short`))
          ?.name,
      ).toBe("git-worktree");
      expect(
        autoShellRuleForCall(
          shellCall(`git worktree remove ${flag} ./wt-short`),
        )?.name,
      ).toBe("git-worktree");
    }
  });

  // The negation is not force: --no-force must not be caught by the prefix.
  test("--no-force stays unflagged", () => {
    expect(
      autoShellRuleForCall(shellCall("git worktree add --no-force ./wt-no")),
    ).toBeUndefined();
    expect(
      autoShellRuleForCall(shellCall("git worktree remove --no-force ./wt-no")),
    ).toBeUndefined();
  });
});
