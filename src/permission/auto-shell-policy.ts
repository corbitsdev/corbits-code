import type { ToolCall } from "@intx/types/runtime";
import { commandHasRecursiveRm } from "../shell/run-shell-authz.js";
import { commandReferencesSensitivePath } from "../plugins/secret-guard-plugin.js";
import { tokenize } from "./command.js";

// Auto-mode shell policy: a flat table of rules that constrain what a run_shell
// command may do when auto mode is on. Auto mode otherwise rubber-stamps every
// consequential call, so these rules carve out the categories that are unsafe to
// run unattended.
//
// To add a category: append one rule. `deny` blocks the command outright and
// returns `reason`; `ask` refuses to auto-allow and routes the call to the
// operator approval prompt instead (the agent may still request it). The first
// matching rule wins, so order most-specific first.

export type AutoShellEffect = "deny" | "ask";

export type AutoShellRule = {
  name: string;
  effect: AutoShellEffect;
  reason: string;
  patterns: RegExp[];
};

// The start of the command, or immediately after a shell separator / subshell
// or brace-group open, optionally preceded by NAME=value env assignments — so a
// program name is only matched in command position, not inside a path argument.
const CMD = String.raw`(?:^|[\n;&|({]\s*)(?:\w+=\S*\s+)*`;
const inCmd = (body: string): RegExp => new RegExp(`${CMD}${body}`);

// Drop the contents of single- and double-quoted spans before matching so a
// quoted argument cannot trip a rule (e.g. `git commit -m 'fix > bug'` is not a
// redirect, `echo "npm install"` is not an install). Quoted-out redirect targets
// and heredoc markers fall away with their quotes, which is why the file-mutation
// heredoc pattern keys on the bare `<<` operator rather than the marker word.
const stripQuoted = (command: string): string => command.replace(/'[^']*'|"[^"]*"/g, " ");

export const AUTO_SHELL_RULES: AutoShellRule[] = [
  {
    name: "file-mutation",
    effect: "deny",
    reason:
      "File creation and edits must go through the write_file and edit_file tools, not shell tooling (python, sed -i, awk, perl, tee, or output redirection). Re-do this change with edit_file for a surgical replacement or write_file for the full contents.",
    patterns: [
      // `>` / `>>` (optionally fd-qualified) to a target that is not an fd dup
      // (`2>&1`) or a safe pseudo-device (`> /dev/null`, a TTY).
      /[0-9]?>>?\s*(?!&|\/dev\/(?:null|stdout|stderr|stdin|tty|pts\/|fd\/))[^\s|;&)]/,
      // tee writes its stdin to one or more files.
      /(?:^|[\n;&|({]\s*)tee\b/,
      // In-place stream editors: sed -i, perl -pi -e, ruby -i.
      /\b(?:sed|perl|ruby)\b[^\n|;]*?\s-[A-Za-z]*i\b/,
      // gawk's inplace extension.
      /\bgawk\b[^\n|;]*-i\s+inplace\b/,
      // An interpreter handed an inline program (-c/-e/--eval) or a heredoc,
      // which is how agents smuggle read-modify-write file edits past the tools.
      /\b(?:python3?|python2|node|bun|deno|ruby|perl|php)\b[^\n]*?(?:\s-(?:c|e)\b|\s--eval\b|<<)/,
    ],
  },
  {
    name: "dependency-install",
    effect: "ask",
    reason:
      "Installing or adding dependencies fetches and runs untrusted code, so it needs explicit operator approval and never runs unattended in auto mode.",
    patterns: [
      // JS package managers: install / i / ci / add (npm, yarn, pnpm, bun).
      inCmd(String.raw`(?:npm|yarn|pnpm|bun)\s+(?:install|i|ci|add)\b`),
      // Remote package runners that fetch and execute code on the fly.
      inCmd(String.raw`(?:npx|bunx|pnpm\s+dlx|yarn\s+dlx)\b`),
      // Python: pip / pip3 / pipx / uv pip / uv add / poetry / conda.
      inCmd(String.raw`pip[23]?\s+install\b`),
      inCmd(String.raw`pipx\s+install\b`),
      inCmd(String.raw`uv\s+(?:pip\s+install|add)\b`),
      inCmd(String.raw`poetry\s+(?:add|install)\b`),
      inCmd(String.raw`conda\s+install\b`),
      // Other ecosystems: cargo, go, gem, bundle, composer, system pkg mgrs.
      inCmd(String.raw`cargo\s+(?:install|add)\b`),
      inCmd(String.raw`go\s+(?:get|install)\b`),
      inCmd(String.raw`gem\s+install\b`),
      inCmd(String.raw`bundle\s+(?:install|add)\b`),
      inCmd(String.raw`composer\s+(?:require|install)\b`),
      inCmd(String.raw`(?:brew|apt|apt-get|yum|dnf|apk|pacman)\s+(?:install|add)\b`),
    ],
  },
];

export function matchAutoShellRule(command: string): AutoShellRule | undefined {
  const scannable = stripQuoted(command);
  return AUTO_SHELL_RULES.find((rule) => rule.patterns.some((pattern) => pattern.test(scannable)));
}

const WORKTREE_ASK_RULE: AutoShellRule = {
  name: "git-worktree",
  effect: "ask",
  reason:
    "Git worktree add, remove, and prune change the workspace boundary and need explicit operator approval in auto mode. Only read-only git worktree list can run unattended.",
  patterns: [],
};

const RECURSIVE_RM_ASK_RULE: AutoShellRule = {
  name: "recursive-rm",
  effect: "ask",
  reason:
    "Recursive delete (rm with -r, -R, or --recursive) removes entire directory trees and must not run unattended in auto mode. Use delete_file for a single file, or wait for explicit operator approval.",
  patterns: [],
};

// Shell commands that mention a secret file (`.env`, keys, certs, …) never run
// unattended in auto mode. The operator can still approve them — secret-guard
// only hard-denies path-keyed tools, not shell — so legitimate uses like
// `--env-file=.env.staging` work after an explicit yes.
const SENSITIVE_PATH_ASK_RULE: AutoShellRule = {
  name: "sensitive-path",
  effect: "ask",
  reason:
    "This command references a sensitive file (credentials, keys, or env secrets). It needs explicit operator approval and never runs unattended in auto mode.",
  patterns: [],
};

const WORKTREE_LIST_FLAGS = new Set(["--porcelain", "-v", "--verbose", "-z"]);

function safeWorktreeCommand(command: string): boolean | undefined {
  const tokens = tokenize(command);
  if (tokens[0] !== "git" || !tokens.slice(1).includes("worktree")) return undefined;
  // Worktree policy applies only to one plain command with no git cwd override;
  // composed forms and global git options conservatively fall back to ask.
  if (/[&;<>|`$(){}]|\\\n|\n/.test(command) || tokens[1] !== "worktree") return false;
  const subcommand = tokens[2];
  const args = tokens.slice(3);

  if (subcommand === "list") return args.every((arg) => WORKTREE_LIST_FLAGS.has(arg));
  // Boundary-changing subcommands always route to ask, even when the destination is inside cwd.
  return false;
}

export function autoShellRuleForCall(
  call: ToolCall,
  _isRestricted: (path: string, isWrite: boolean) => boolean = () => false,
): AutoShellRule | undefined {
  if (call.name !== "run_shell") return undefined;
  const command = call.arguments.command;
  if (typeof command !== "string") return undefined;
  if (commandHasRecursiveRm(command)) return RECURSIVE_RM_ASK_RULE;
  if (commandReferencesSensitivePath(command) !== undefined) return SENSITIVE_PATH_ASK_RULE;
  const safeWorktree = safeWorktreeCommand(command);
  if (safeWorktree === false) return WORKTREE_ASK_RULE;
  return matchAutoShellRule(command);
}
