import type { ToolCall } from "@intx/types/runtime";
import { commandHasRecursiveRm, expandShellSubjects } from "../shell/run-shell-authz.js";
import { commandReferencesSensitivePath } from "../plugins/secret-guard-plugin.js";
import { commandHasUnboundedDirectoryListing, commandTargetsRestricted } from "./classify.js";
import { splitChainedCommand, tokenize } from "./command.js";
import { isPermittedSiblingWorktreePath } from "./path-restriction.js";
import type { RootsProvider } from "./worktree-roots.js";

// Auto-mode shell policy: a flat table of rules that constrain what a run_shell
// command may do when auto mode is on. Auto mode otherwise rubber-stamps every
// consequential call, so these rules carve out the categories that are unsafe to
// run unattended.
//
// To add a category: append one rule. `deny` blocks the command outright and
// returns `reason`; `ask` refuses to auto-allow and routes the call to the
// operator approval prompt instead (the agent may still request it). The first
// matching rule wins, so order most-specific first. Shell wrappers (bash -c,
// xargs, env/nice/timeout prefixes) are peeled so rules see the inner payload;
// unparseable wrappers force ask rather than auto-allow.

export type AutoShellEffect = "deny" | "ask";

export interface AutoShellRule {
  name: string;
  effect: AutoShellEffect;
  reason: string;
  patterns: RegExp[];
}

// The start of the command, or immediately after a shell separator / subshell
// or brace-group open, optionally preceded by NAME=value env assignments — so a
// program name is only matched in command position, not inside a path argument.
const CMD = String.raw`(?:^|[\n;&|({]\s*)(?:\w+=\S*\s+)*`;
const inCmd = (body: string): RegExp => new RegExp(`${CMD}${body}`);

// Quote-aware dequoting for rule matching. Real shells strip the quote
// characters themselves and hand the program a literal argument, so a rule
// must see the same thing the program would: a quoted redirect target
// (`>"file"`), a quoted flag (`"-c"`), or a quoted program/subcommand name
// (`"sed" -i`, `npm "install"`) all read exactly like their unquoted form.
// The one thing quoting genuinely changes is that a shell *operator*
// character loses its operator meaning inside quotes — `'fix > bug'` is a
// literal string, not a redirect — so only that small set of operator
// characters (`> < | & ; \``) is neutralized when it occurs inside a quoted
// span; every other character (letters, digits, `-`) passes through
// dequoted. Heredoc bodies are left alone: the file-mutation heredoc pattern
// keys on the bare `<<` operator, which is always outside any quoting.
const QUOTE_NEUTRALIZED_OPERATORS = new Set(["<", ">", "|", "&", ";", "`"]);

const dequoteForMatching = (command: string): string => {
  let out = "";
  let quote: '"' | "'" | null = null;
  for (const ch of command) {
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      } else {
        out += QUOTE_NEUTRALIZED_OPERATORS.has(ch) ? " " : ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    out += ch;
  }
  return out;
};

// Named separately (not inlined in AUTO_SHELL_RULES below) so the dedicated
// `env -S`/`--split-string` check further down — which cannot be expressed as
// a plain regex over stripQuoted text, since the assignment lives inside a
// quoted argument that stripQuoted deliberately blanks out — can return this
// exact rule object instead of duplicating its name/reason.
const ENV_ASSIGNMENT_ASK_RULE: AutoShellRule = {
  name: "env-assignment",
  effect: "ask",
  reason:
    "This command sets an environment variable inline (a NAME=value prefix or export) instead of through project shell env settings. It needs explicit operator approval and never runs unattended in auto mode.",
  patterns: [
    // A NAME=value token or `export` at command position. Deliberately fires
    // on the raw, unpeeled subject: expandShellSubjects still peels a bare
    // `env`/`nice`/`timeout` wrapper through to its inner command (so `env
    // cmd` alone is unaffected), but the original subject retains the
    // literal assignment text for `FOO=bar cmd`.
    inCmd(String.raw`(?:\w+=\S*\s+|export\s+)`),
    // The `env` command itself used to set a variable (`env FOO=bar cmd`) —
    // as opposed to the bare `env cmd` transparent-wrapper form, which has
    // no assignment and is left to peel through untouched.
    inCmd(String.raw`env\s+\w+=\S*`),
  ],
};

export const AUTO_SHELL_RULES: AutoShellRule[] = [
  {
    name: "file-mutation",
    effect: "deny",
    reason:
      "File creation and edits must go through the write_file and edit_file tools, not shell tooling (python, sed -i, awk, perl, tee, or output redirection). Re-do this change with edit_file for a surgical replacement or write_file for the full contents.",
    patterns: [
      // `>` / `>>` (optionally fd-qualified, optionally clobber-forced with a
      // trailing `|` as in `>|` / `>>|`) to a target that is not an fd dup
      // (`2>&1`) or a safe pseudo-device (`> /dev/null`, a TTY).
      /[0-9]?>>?\|?\s*(?!&|\/dev\/(?:null|stdout|stderr|stdin|tty|pts\/|fd\/))[^\s|;&)]/,
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
  ENV_ASSIGNMENT_ASK_RULE,
  {
    name: "network-upload",
    effect: "ask",
    reason:
      "This command sends data to a remote destination (curl/wget with a payload, a remote scp/rsync target, or netcat). It needs explicit operator approval and never runs unattended in auto mode.",
    patterns: [
      // curl with a data-carrying flag; a plain GET has none of these.
      inCmd(
        String.raw`curl\b[^\n]*\s(?:-d|--data|--data-ascii|--data-binary|--data-raw|--data-urlencode|-F|--form|-T|--upload-file)\b`,
      ),
      // wget posting a file or inline payload.
      inCmd(String.raw`wget\b[^\n]*\s(?:--post-file|--post-data)\b`),
      // scp/rsync targeting a remote host (user@host:path or host:path).
      inCmd(String.raw`(?:scp|rsync)\b[^\n]*\s(?:[\w.-]+@)?[\w.-]+:\S`),
      // netcat in any form can exfiltrate arbitrary data over a raw socket.
      inCmd(String.raw`(?:nc|ncat|netcat)\b`),
    ],
  },
  {
    name: "credential-print",
    effect: "ask",
    reason:
      "This command dumps or prints credentials from the OS keychain, a GPG keyring, or a cloud CLI's cached token store. It needs explicit operator approval and never runs unattended in auto mode.",
    patterns: [
      // macOS Keychain: `security find-generic-password` / `find-internet-password`,
      // both of which can print the stored secret with `-w`.
      inCmd(String.raw`security\s+find-(?:generic|internet)-password\b`),
      // GPG secret-key export: --export-secret-keys / --export-secret-subkeys.
      /\bgpg2?\b[^\n]*--export-secret/,
      // Cloud CLI token printers.
      inCmd(String.raw`aws\s+configure\s+get\b`),
      inCmd(String.raw`gcloud\s+auth\s+print-access-token\b`),
    ],
  },
  {
    name: "git-global-config",
    effect: "ask",
    reason:
      "This command mutates git configuration outside the current repository (--global, --system, an arbitrary --file, or GIT_CONFIG_GLOBAL). That state outlives this call and is shared by every other repo and agent on the machine, so it needs explicit operator approval and never runs unattended in auto mode. Use bin/git-push-scoped for an HTTPS push instead of rewriting global config.",
    patterns: [
      // --global / --system write or read the machine-wide config files;
      // --edit opens one in $EDITOR, which can write anything.
      inCmd(String.raw`git\s+config\s+(?:--global|--system|--edit)\b`),
      // --file points config at an arbitrary path, including ~/.gitconfig —
      // ask rather than try to distinguish a repo-local target from that.
      inCmd(String.raw`git\s+config\s+--file\b`),
      // Unsetting GIT_CONFIG_GLOBAL falls back to the real ~/.gitconfig, the
      // same as never having scoped it. (Reassigning it to a new path is
      // already caught by the env-assignment rule above.)
      inCmd(String.raw`unset\s+GIT_CONFIG_GLOBAL\b`),
    ],
  },
];

export function matchAutoShellRule(command: string): AutoShellRule | undefined {
  const scannable = dequoteForMatching(command);
  return AUTO_SHELL_RULES.find((rule) => rule.patterns.some((pattern) => pattern.test(scannable)));
}

const ENV_ASSIGNMENT_TOKEN = /^\w+=/;

// Whether env's own split-string payload begins with (optionally after other
// leading assignments) a NAME=value token — mirroring the plain-command
// check above, but scoped to text env itself will word-split rather than the
// shell, since that word-splitting happens after the shell has already
// handed env one quoted argument.
function payloadStartsWithAssignment(payload: string): boolean {
  return /^\s*(?:\w+=\S*\s+)*\w+=/.test(payload);
}

// Thin ask detection for env forms whose assignment is invisible to the plain
// ENV_ASSIGNMENT_ASK_RULE regexes: `env -S "FOO=bar …"` (assignment lives
// inside a quoted argument that stripQuoted blanks out) and `env -i FOO=bar
// cmd` (`-i` sits between `env` and the assignment). Payload *content*
// scanning no longer lives here — expandShellSubjects peels -S payloads and
// transparent env prefixes, so every rule sees inside them the same way.
function segmentHasEnvAssignmentAsk(segment: string): boolean {
  const tokens = tokenize(segment);
  let i = 0;
  while (i < tokens.length && ENV_ASSIGNMENT_TOKEN.test(tokens[i] ?? "")) i++;
  const envToken = tokens[i];
  if (envToken === undefined || envToken.replace(/^.*\//, "") !== "env") return false;
  i++;
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (t === "--") return false;
    if (t.startsWith("--split-string=")) {
      return payloadStartsWithAssignment(t.slice("--split-string=".length));
    }
    if (t === "-S" || t === "--split-string") {
      const payload = tokens[i + 1];
      return payload !== undefined && payloadStartsWithAssignment(payload);
    }
    // Clustered short flags (`-iS`, `-Si`, …) — `S` still takes the next
    // token as its split-string payload.
    if (/^-[A-Za-z0-9]*S[A-Za-z0-9]*$/.test(t)) {
      const payload = tokens[i + 1];
      return payload !== undefined && payloadStartsWithAssignment(payload);
    }
    if (t.startsWith("-") && t !== "-") {
      i++;
      continue;
    }
    // A bare NAME=value argument to env itself (`env -i FOO=bar cmd`).
    return ENV_ASSIGNMENT_TOKEN.test(t);
  }
  return false;
}

function commandHasEnvAssignmentAsk(command: string): boolean {
  // Walk every expanded subject so a nested `bash -c 'env -S "FOO=bar …"'`
  // still surfaces the assignment ask after the outer wrapper is peeled.
  const { subjects } = expandShellSubjects(command);
  for (const subject of subjects) {
    if (splitChainedCommand(subject).some(segmentHasEnvAssignmentAsk)) return true;
  }
  return false;
}

const WORKTREE_ASK_RULE: AutoShellRule = {
  name: "git-worktree",
  effect: "ask",
  reason:
    "This git worktree command uses a force flag, an uncontained path, or a subcommand that still needs explicit operator approval in auto mode. Contained non-force add/remove/prune and read-only list can run unattended.",
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

const OPAQUE_WRAPPER_ASK_RULE: AutoShellRule = {
  name: "opaque-wrapper",
  effect: "ask",
  reason:
    "This command wraps a shell payload that cannot be statically inspected (variable expansion or command substitution). It needs explicit operator approval and never runs unattended in auto mode.",
  patterns: [],
};

const OUTSIDE_WORKSPACE_ASK_RULE: AutoShellRule = {
  name: "outside-workspace",
  effect: "ask",
  reason:
    "This command references a path outside the workspace. It needs explicit operator approval and never runs unattended in auto mode.",
  patterns: [],
};

// Recursive ls / unbounded tree can walk huge trees and OOM the host — same
// class as open-ended find/rg. Shallow ls and depth-bounded tree stay free.
const UNBOUNDED_LISTING_ASK_RULE: AutoShellRule = {
  name: "unbounded-listing",
  effect: "ask",
  reason:
    "Unbounded recursive directory listing (ls -R, tree without a safe -L / --max-depth, or depth over 10) can walk huge trees and OOM the host. Use a shallow ls, tree -L N (N ≤ 10), or list_dir, or wait for explicit operator approval.",
  patterns: [],
};

const WORKTREE_LIST_FLAGS = new Set(["--porcelain", "-v", "--verbose", "-z"]);
const WORKTREE_PRUNE_FLAGS = new Set(["-n", "--dry-run", "-v", "--verbose"]);
// Flags that take a following value on `git worktree add` (branch name, lock reason).
const WORKTREE_ADD_VALUE_FLAGS = new Set(["-b", "-B", "--reason"]);

function isWorktreeForceFlag(arg: string): boolean {
  return arg === "-f" || arg === "--force";
}

// True when the path is safe for unattended worktree add/remove: inside the
// session workspace (the unified containment authority's normal notion), or a
// not-yet-registered sibling location the same authority's narrow
// isPermittedSiblingWorktreePath rule allows (path-restriction.ts). No
// bespoke denylist or depth counter here — everything routes through that one
// authority so a path is never judged "contained" under a looser or stricter
// rule than the one gate.ts uses to decide restriction.
function isContainedWorktreePath(
  pathArg: string,
  isRestricted: (path: string, isWrite: boolean) => boolean,
  cwd: string,
  rootsProvider: RootsProvider,
): boolean {
  if (!pathArg) return false;
  // Shell-syntax `isRestricted` below cannot resolve correctly: `resolve()`
  // treats a leading `~` as a literal path segment rather than expanding it,
  // so a home-relative path would otherwise read as "inside cwd" on the very
  // next line; a glob is not a single concrete destination at all. This
  // duplicates isPermittedSiblingWorktreePath's own guard against the same
  // two forms, but that duplication is required, not incidental: this check
  // has to run before the isRestricted() shortcut below even executes, while
  // isPermittedSiblingWorktreePath's copy protects direct/standalone callers
  // of that exported function.
  if (/[*?[]/.test(pathArg)) return false;
  if (pathArg.startsWith("~")) return false;

  // Workspace (cwd + registered worktree roots) — always contained.
  if (!isRestricted(pathArg, true)) return true;

  return isPermittedSiblingWorktreePath(cwd, pathArg, rootsProvider);
}

// Walks worktree args, recording force and every positional path. Value-taking
// flags consume the next token so branch names are not mistaken for paths.
function worktreePathArgs(
  args: string[],
  valueFlags: Set<string>,
): { force: boolean; paths: string[] } {
  const paths: string[] = [];
  let force = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      paths.push(...args.slice(i + 1));
      break;
    }
    if (isWorktreeForceFlag(arg)) {
      force = true;
      continue;
    }
    if (arg.startsWith("-") && arg !== "-") {
      // `--flag=value` carries its value inline; no following token to skip.
      if (arg.includes("=")) continue;
      if (valueFlags.has(arg)) {
        i += 1;
        continue;
      }
      continue;
    }
    paths.push(arg);
  }
  return { force, paths };
}

// `true` = auto-allow, `false` = ask, `undefined` = not a worktree command.
// Contained non-force add/remove and ordinary prune/list auto-allow so dispatch
// can create sibling worktrees without a human click; force flags, uncontained
// paths, and uncommon subcommands still ask.
// Exported for gate.ts's pre-grant restricted-path guard: a contained or
// permitted-sibling `git worktree add/remove` destination must not force an
// operator ask ahead of grant matching (CL-5638) the same way it already
// skips the auto-mode ask below — one authority for "is this worktree
// destination safe," used by both auto mode and the standing-grant guard.
export function safeWorktreeCommand(
  command: string,
  isRestricted: (path: string, isWrite: boolean) => boolean,
  cwd: string,
  rootsProvider: RootsProvider,
): boolean | undefined {
  const tokens = tokenize(command);
  if (tokens[0] !== "git" || !tokens.slice(1).includes("worktree")) return undefined;
  // Worktree policy applies only to one plain command with no git cwd override;
  // composed forms and global git options conservatively fall back to ask.
  if (/[&;<>|`$(){}]|\\\n|\n/.test(command) || tokens[1] !== "worktree") return false;
  const subcommand = tokens[2];
  const args = tokens.slice(3);

  if (subcommand === "list") return args.every((arg) => WORKTREE_LIST_FLAGS.has(arg));

  if (subcommand === "prune") {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (WORKTREE_PRUNE_FLAGS.has(arg)) continue;
      if (arg.startsWith("--expire=")) continue;
      if (arg === "--expire") {
        i += 1;
        continue;
      }
      return false;
    }
    return true;
  }

  if (subcommand === "add" || subcommand === "remove") {
    const valueFlags = subcommand === "add" ? WORKTREE_ADD_VALUE_FLAGS : new Set<string>();
    const { force, paths } = worktreePathArgs(args, valueFlags);
    if (force) return false;
    // add/remove require a path; no path → ask rather than guess.
    if (paths.length === 0) return false;
    // First positional is the worktree path; later tokens on add are commit-ish.
    return isContainedWorktreePath(paths[0]!, isRestricted, cwd, rootsProvider);
  }

  // move / lock / unlock / repair / unknown — still ask until proven safe.
  return false;
}

// Prefer deny over ask when multiple expanded subjects match different effects.
function preferRule(
  a: AutoShellRule | undefined,
  b: AutoShellRule | undefined,
): AutoShellRule | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  if (a.effect === "deny") return a;
  if (b.effect === "deny") return b;
  return a;
}

const NO_ROOTS: RootsProvider = () => [];

export function autoShellRuleForCall(
  call: ToolCall,
  isRestricted: (path: string, isWrite: boolean) => boolean = () => false,
  cwd: string = process.cwd(),
  rootsProvider: RootsProvider = NO_ROOTS,
): AutoShellRule | undefined {
  if (call.name !== "run_shell") return undefined;
  const command = call.arguments.command;
  if (typeof command !== "string") return undefined;

  // Peel bash/sh/zsh -c, xargs, env -S/--split-string, and transparent
  // prefixes so rules see the real payload. `stripQuoted` alone would delete
  // a quoted -c body and miss every rule. Content inside an -S payload is
  // scanned here exactly as if written plainly — never a weaker tier.
  const { subjects, opaque } = expandShellSubjects(command);

  if (commandHasRecursiveRm(command)) return RECURSIVE_RM_ASK_RULE;

  // Deny rules (file-mutation) beat every ask: `bash -c 'echo x > .env'` must
  // stay hard-denied in auto, not demoted because a secret path or opaque flag
  // is also present.
  let matched: AutoShellRule | undefined;
  for (const subject of subjects) {
    matched = preferRule(matched, matchAutoShellRule(subject));
  }
  if (matched?.effect === "deny") return matched;

  // Thin fallback for env forms whose assignment is invisible to the plain
  // regexes (quoted -S payload, or flags between `env` and NAME=value).
  if (commandHasEnvAssignmentAsk(command)) {
    matched = preferRule(matched, ENV_ASSIGNMENT_ASK_RULE);
  }

  for (const subject of subjects) {
    if (commandReferencesSensitivePath(subject) !== undefined) return SENSITIVE_PATH_ASK_RULE;
  }

  // Even inside the workspace: unbounded listing must ask so auto mode cannot OOM.
  for (const subject of subjects) {
    if (commandHasUnboundedDirectoryListing(subject)) return UNBOUNDED_LISTING_ASK_RULE;
  }

  // Containment: a command whose path arguments resolve outside the workspace
  // (including through a symlink) must ask rather than auto-run, the same way
  // path-arg tool calls already do. Contained worktree ops are exempt — their
  // destinations are often intentional siblings (`../corbits-dispatch-wts/…`)
  // and are judged by the worktree path policy below instead.
  for (const subject of subjects) {
    if (safeWorktreeCommand(subject, isRestricted, cwd, rootsProvider) === true) continue;
    if (commandTargetsRestricted(subject, isRestricted)) return OUTSIDE_WORKSPACE_ASK_RULE;
  }

  for (const subject of subjects) {
    if (safeWorktreeCommand(subject, isRestricted, cwd, rootsProvider) === false)
      return WORKTREE_ASK_RULE;
  }

  if (matched !== undefined) return matched;
  if (opaque) return OPAQUE_WRAPPER_ASK_RULE;
  return undefined;
}
