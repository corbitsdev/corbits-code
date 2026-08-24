// Shared run_shell authorization policy used by the authz plugin (hard deny at
// execution) and the permission gate (do not auto-allow what authz would reject).

import { splitChainedCommand, tokenize } from "../permission/command.js";

// A command-position anchor: the start of the command, or immediately after a
// shell separator or subshell open, optionally preceded by a run of NAME=value
// environment assignments (so `X=1 sudo …` is still recognised as `sudo` in
// command position). This keeps a word like "exec" or "format" from matching
// when it merely appears inside a URL, comment, or string argument.
const CMD = String.raw`(?:^|[\n;&|(` + "`" + String.raw`]\s*)(?:\w+=\S*\s+)*`;

const cmd = (name: string): RegExp => new RegExp(`${CMD}${name}\\b`);

// A command-*head* anchor: like CMD, but a bare `|` does not count as a
// boundary. A stage downstream of a single pipe consumes already-bounded piped
// data (or, for `rg`/`grep`, ripgrep's own bounded stdin read) rather than
// walking the filesystem, so it carries none of the OOM risk the open-ended
// search patterns exist to catch (e.g. `git show sha:path | rg -n foo` reads
// one blob through rg, not a tree walk). `&&` and `||` are still boundaries —
// neither carries piped data to the following stage — matched as explicit
// two-character operators so a lone `|` inside them is not mistaken for the
// single-pipe case.
const CMD_HEAD = String.raw`(?:^|[\n;(` + "`" + String.raw`]\s*|&&\s*|\|\|\s*)(?:\w+=\S*\s+)*`;

const cmdHead = (name: string): RegExp => new RegExp(`${CMD_HEAD}${name}\\b`);

// Redirecting to /dev/null, /dev/stdout, /dev/stderr, /dev/tty and /dev/fd/* is
// routine and harmless; only redirects to real device nodes (e.g. /dev/sda) are
// destructive. The negative lookahead exempts the safe pseudo-devices, anchored
// to a token terminator so a path like /dev/null/../sda is NOT exempted.
const SAFE_DEV = String.raw`(?!(?:null|stdout|stderr|stdin|tty|fd/)(?:$|[\s;&|]))`;

// Wrapper words that can sit between a pipe and the shell it feeds, so
// `curl x | sudo bash` is caught as well as `curl x | bash`.
const SHELL_WRAPPERS = String.raw`(?:(?:sudo|env|command|exec|nice|nohup|time)\s+)*`;

const BLOCKED_PATTERNS: RegExp[] = [
  // Redirects that clobber system trees (but not safe /dev/ pseudo-devices).
  new RegExp(String.raw`>{1,2}\s*/dev/${SAFE_DEV}`),
  />{1,2}\s*\/etc\//,
  />{1,2}\s*\/sys\//,
  />{1,2}\s*\/proc\//,
  />{1,2}\s*\/var\//,
  // Copying/moving/tee-ing into system trees.
  /\btee\s+\/(etc|sys|proc|dev|var)\//,
  /\bcp\s+.*\/(etc|sys|proc|dev|var)\//,
  /\bmv\s+.*\/(etc|sys|proc|dev|var)\//,
  // Raw disk writes and filesystem creation.
  /\bdd\b.*\bof=\s*\/dev\//,
  /\bmkfs(\.\w+)?\b/,
  // chmod/chown against system binaries and config trees.
  /\bchmod\s+.*\/(etc|sys|proc|dev|bin|sbin|usr\/bin|usr\/sbin)/,
  /\bchown\s+.*\/(etc|sys|proc|dev|bin|sbin|usr\/bin|usr\/sbin)/,
  // Fork bombs and busy-loops. These inspect quoted interpreter payloads
  // (`bash -c 'while :; do'`, `perl -e 'fork while fork'`), so they run on
  // the original subject — command-position matchers neutralize separators
  // inside quotes and would otherwise miss the `;` these patterns need.
  /:\(\)\s*\{\s*:\|:&\s*\};/,
  // Piping a network download straight into a shell (through any wrappers).
  new RegExp(String.raw`(curl|wget|fetch)\b[^\n;|]*\|\s*${SHELL_WRAPPERS}(bash|sh|zsh)\b`),
  // Privilege escalation and shell replacement, only in command position.
  cmd("sudo"),
  /(?:^|[\n;&|(])\s*su\s+-/,
  cmd("eval"),
  cmd("exec"),
  cmd("fdisk"),
  cmd("format"),
  // Power-state changes.
  cmd("shutdown"),
  cmd("reboot"),
  cmd("poweroff"),
  /(?:^|[\n;&|(])\s*init\s+[06]\b/,
];

const BLOCKED_QUOTED_PAYLOAD_PATTERNS: RegExp[] = [
  /bash\s+-c\s+.*while\s+:\s*;\s*do/,
  /perl\s+-e\s+.*fork\s+while\s+fork/,
];

// Open-ended tree walks via the shell OOM the host: `find | tail` still forces
// the full stream through the collector, and recursive grep/rg walks huge trees
// before any pipe limit applies. Hard-deny those shapes for host safety; the
// bounded grep/search_files tools remain practical alternatives (timeout +
// output caps). (`git log | tail` and similar non-walk pipes are fine — the
// 512KB shell output cap is the backstop for those.)
const OPEN_ENDED_SEARCH_PATTERNS: RegExp[] = [
  // `find` is almost always a full-tree walk — keep full CMD so
  // `… | find …` cannot bypass (find does not treat the pipe as search domain).
  cmd("find"),
  // ripgrep via shell — the `grep` tool already routes through rg with caps.
  // CMD_HEAD so `git show … | rg` (bounded stdin) is allowed.
  cmdHead("rg"),
  // Recursive grep/egrep/fgrep (flag form -r/-R/--recursive, alone or clustered).
  new RegExp(
    String.raw`${CMD_HEAD}(?:grep|egrep|fgrep)\b[^\n|;]*?(?:\s-[A-Za-z0-9]*[rR][A-Za-z0-9]*\b|\s--recursive\b)`,
  ),
];

// Commands that follow forever or page interactively never exit under the agent
// (stdin is not a terminal and nothing consumes the pager), so they hang the run
// until the shell timeout kills them. Deny them at any command position so a
// piped pager (`… | less`) is caught as well as a bare one.
const NEVER_TERMINATING_PATTERNS: RegExp[] = [
  // `tail -f` / `-F` follow a file forever (flag alone or clustered).
  new RegExp(String.raw`${CMD}tail\b[^\n|;]*?\s-[A-Za-z]*[fF][A-Za-z]*\b`),
  // GNU long form `--follow` / `--follow=name` never matches the clustered
  // short-flag pattern above, so match it explicitly.
  new RegExp(String.raw`${CMD}tail\b[^\n|;]*?\s--follow\b`),
  cmd("watch"),
  cmd("top"),
  cmd("htop"),
  cmd("less"),
  cmd("more"),
];

// Programs that read standard input when given no file operand. Invoked with no
// file (and not downstream of a pipe) they block on a terminal that never
// arrives. `git log | tail` is fine (tail reads the pipe); `tail -n 50 file.log`
// is fine (it has a file); a bare `tail`, `cat`, or `grep pattern` is not.
const STDIN_READERS = new Set(["cat", "tac", "nl", "rev", "head", "tail", "sort", "uniq", "wc"]);

// Short flags that consume the following token as their value, so the value is
// not mistaken for a file operand (e.g. the `50` in `tail -n 50`). These are
// value-taking only for `head` and `tail`; for the other stdin readers the same
// letters are boolean flags (e.g. `wc -c`, `uniq -c`, `sort -c`), so consuming a
// following token there would wrongly drop a real file operand.
export const HEAD_TAIL_VALUE_FLAGS = new Set(["-n", "-c", "-C", "--lines", "--bytes"]);
export const GREP_VALUE_FLAGS = new Set(["-e", "-f", "-m", "-A", "-B", "-C", "--regexp", "--file"]);

// The head of each pipeline (the stage before the first `|`) is the only stage
// that reads the terminal's stdin; later stages read the pipe. A naive regex
// split breaks on separators that appear inside a quoted argument (e.g. the `|`
// in `grep 'a|b' file`), truncating the command and dropping real operands. Walk
// the command tracking quote state, break pipelines only on unquoted `;`,
// newline, `&&`, `||`, and end each head at its first unquoted `|`.
function pipelineHeads(command: string): string[] {
  const heads: string[] = [];
  let head = "";
  let headClosed = false;
  let quote: '"' | "'" | undefined;

  const flush = () => {
    heads.push(head);
    head = "";
    headClosed = false;
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
      if (!headClosed) head += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      if (!headClosed) head += ch;
      continue;
    }
    const next = command[i + 1];
    if (ch === "\n" || ch === ";") {
      flush();
      continue;
    }
    if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
      flush();
      i++;
      continue;
    }
    if (ch === "|") {
      headClosed = true;
      continue;
    }
    if (!headClosed) head += ch;
  }
  flush();
  return heads;
}

// Quote-aware tokenization for stdin-operand counting only — not security
// classification (classifiers use other paths). A naive whitespace split
// miscounts operands when a pattern or path contains spaces inside quotes
// (e.g. `grep 'a b'` has one operand, not two).
export function tokenizeSegment(segment: string): string[] {
  const tokens = tokenize(segment);
  let i = 0;
  while (i < tokens.length && ENV_ASSIGNMENT.test(tokens[i]!)) i++;
  while (i < tokens.length && RM_WRAPPER.test(tokens[i]!)) i++;
  return tokens.slice(i);
}

// Count file operands, skipping flags and the values that value-taking flags
// consume. For grep the first operand is the pattern, so callers require one
// more operand than for the plain readers.
function fileOperandCount(args: string[], valueFlags: Set<string>): number {
  let count = 0;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") continue;
    if (arg.startsWith("-")) {
      if (valueFlags.has(arg)) i++;
      continue;
    }
    count++;
  }
  return count;
}

function readsStdinWithoutInput(head: string): boolean {
  const tokens = tokenizeSegment(head);
  const exec = tokens[0];
  if (exec === undefined) return false;
  const args = tokens.slice(1);
  if (exec === "grep" || exec === "egrep" || exec === "fgrep") {
    // grep reads stdin unless given a file in addition to the pattern; a `-e`
    // or `-f` flag supplies the pattern, so then a single operand is the file.
    const suppliesPatternViaFlag = args.some(
      (a) =>
        a === "-e" ||
        a === "-f" ||
        a === "--regexp" ||
        a === "--file" ||
        a.startsWith("-f") ||
        a.startsWith("--file="),
    );
    const operands = fileOperandCount(args, GREP_VALUE_FLAGS);
    return suppliesPatternViaFlag ? operands < 1 : operands < 2;
  }
  if (STDIN_READERS.has(exec)) {
    const valueFlags =
      exec === "head" || exec === "tail" ? HEAD_TAIL_VALUE_FLAGS : new Set<string>();
    return fileOperandCount(args, valueFlags) < 1;
  }
  return false;
}

function isNeverTerminating(command: string): boolean {
  return NEVER_TERMINATING_PATTERNS.some((pattern) => pattern.test(command));
}

function blocksOnStdin(command: string): boolean {
  return pipelineHeads(command).some(readsStdinWithoutInput);
}

// Transparent exec wrappers that pass their argument straight through to another
// program: `command find`, `env find`, `builtin cd`. Unlike `sudo`/`exec`, these
// are not themselves blocked, so stripping them at command position exposes the
// real executable to the deny patterns. `env` may also carry NAME=value prefixes.
const STRIP_WRAPPER = String.raw`(?:command|env|builtin)`;

// At every command position, drop leading NAME=value assignments and transparent
// wrappers, then strip an absolute directory path off the executable so
// `/usr/bin/find`, `command find`, and `env FOO=bar find` all reduce to `find`
// before the deny patterns run. Only the executable token is rewritten, so
// redirect targets and later arguments are left intact.
const NORMALIZE_COMMAND_POSITION = new RegExp(
  String.raw`(^|[\n;&|(` + "`" + String.raw`]\s*)(?:\w+=\S*\s+|${STRIP_WRAPPER}\s+)*(/\S*/)?`,
  "g",
);

function normalizeCommand(command: string): string {
  return command.replace(NORMALIZE_COMMAND_POSITION, "$1");
}

const CHAIN = /[\n;]|&&|\|\||\|/;
const ENV_ASSIGNMENT = /^\w+=/;
const RM_WRAPPER = /^(sudo|command|env|exec|builtin|time|nice|nohup)$/;
const RECURSIVE_FLAG = /^(--recursive|-[A-Za-z]*[rR][A-Za-z]*)$/;

// Interpreters whose `-c` / `--command` payload is an independent shell subject.
// Exported so tests and callers share one explicit list with the peeler.
export const SHELL_INTERPRETERS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
// Transparent prefixes that sit in front of a real program without changing it.
const PREFIX_WRAPPERS = new Set(["command", "env", "builtin", "time", "nice", "nohup", "timeout"]);
// Max recursive peel depth for nested wrappers. Exported so the depth cap is a
// named policy knob tests can assert against, not a magic number.
export const MAX_PEEL_DEPTH = 4;

// xargs flags that consume the following token as a value.
const XARGS_VALUE_FLAGS = new Set([
  "-I",
  "-i",
  "-n",
  "-P",
  "-s",
  "-E",
  "-e",
  "-L",
  "-l",
  "-d",
  "-a",
  "--max-args",
  "--max-procs",
  "--replace",
  "--delimiter",
  "--max-chars",
  "--arg-file",
  "--exit",
]);

// A recursive rm is catastrophic only when it targets a root the agent can never
// recover from — /, the home directory, a system tree, or a bare cwd-wide glob.
// A recursive rm of an ordinary relative path (e.g. ./build, node_modules) is
// routine and is left to the permission gate to ask about, not hard-denied here.
function isDangerousTarget(token: string): boolean {
  const t = token.replace(/['"]/g, "");
  if (["/", "~", "~/", "$HOME", "*", ".", "..", "./", "../"].includes(t)) return true;
  if (/^\$HOME\b/.test(t)) return true;
  if (/^~\//.test(t)) return true;
  if (/^\/\*/.test(t)) return true;
  if (
    /^\/(etc|usr|bin|sbin|var|sys|dev|lib|boot|root|home|opt|Applications|System|Library|Users)(\/|$)/.test(
      t,
    )
  ) {
    return true;
  }
  return false;
}

export function programBasename(token: string): string {
  const bare = token.replace(/['"]/g, "");
  const slash = bare.lastIndexOf("/");
  return slash >= 0 ? bare.slice(slash + 1) : bare;
}

// Payload we cannot statically inspect: empty, a bare expansion, or a leading
// command substitution. Argument-position expansions like `rm -rf $HOME` stay
// parseable so catastrophic-target checks still fire.
function isOpaquePayload(payload: string): boolean {
  const trimmed = payload.trim();
  if (trimmed.length === 0) return true;
  if (/^\$[{(]?[\w*@#?$!-]+[)}]?$/.test(trimmed)) return true;
  if (/^\$\(/.test(trimmed) || /^`/.test(trimmed)) return true;
  return false;
}

type PeelOutcome = { kind: "inner"; command: string } | { kind: "opaque" } | { kind: "none" };

// Tokens that survive rejoining without quotes. Anything else is re-quoted so
// a payload token that originally carried quotes (e.g. the argument of a
// nested `sh -c 'rm -rf {}'`) is not re-split when the rejoined command is
// tokenized again one peel level down — rejoining dequoted tokens with bare
// spaces is exactly how the xargs → shell -c bypass slipped through.
const SAFE_REJOIN_TOKEN = /^[A-Za-z0-9_@%+=:,./-]+$/;

// IMPORTANT: the output of this function must round-trip through THIS project's
// `tokenize()` (src/permission/command.ts) as a single token — not through a
// POSIX shell. `tokenize()` is a naive quote-toggle with NO backslash escape
// support, so the bash `'\''` idiom does not work: an embedded quote would
// re-split the token and drop the dangerous tail. Instead we wrap in whichever
// delimiter (' or ") the token does not itself contain. If the token contains
// both, no representation round-trips, so we return null and the caller treats
// the whole wrapper as opaque (→ ask), never emitting a mis-parsed command.
function quoteTokenForRejoin(token: string): string | null {
  if (SAFE_REJOIN_TOKEN.test(token)) return token;
  if (!token.includes("'")) return `'${token}'`;
  if (!token.includes('"')) return `"${token}"`;
  return null;
}

// Rebuild a command string from tokens, preserving token boundaries through a
// subsequent tokenize(). Returns null when any token cannot be safely quoted
// (see quoteTokenForRejoin). Opacity checks must run on the raw (unquoted)
// join — quoting would disguise `$CMD`-style payloads from isOpaquePayload.
function rejoinTokens(tokens: string[]): string | null {
  const quoted: string[] = [];
  for (const token of tokens) {
    const q = quoteTokenForRejoin(token);
    if (q === null) return null;
    quoted.push(q);
  }
  return quoted.join(" ");
}

// True when a token is a safe `$0`/`$1` positional after `bash -c 'script'` —
// a plain word with no shell syntax. Anything else after the -c payload is
// treated as evidence the quoted body was split by a tokenizer that does not
// honor backslash-escapes (classic `bash -c "…\"…"` degradation).
function isSafeShellPositional(token: string): boolean {
  if (token.startsWith("-") && token !== "-") return false;
  if (token.includes("\\")) return false;
  if (/[><|&;`$]/.test(token)) return false;
  return SAFE_REJOIN_TOKEN.test(token);
}

// `\bash` / `\sh` — tokenize artifact from peeling through an escaped quote.
function isBackslashInterpreterToken(token: string): boolean {
  const base = programBasename(token);
  return base.startsWith("\\") && SHELL_INTERPRETERS.has(base.slice(1));
}

function nestedInterpreterPayloadOpaque(payload: string, rest: readonly string[]): boolean {
  if (isBackslashInterpreterToken(payload)) return true;
  const first = tokenize(payload)[0];
  if (first !== undefined && isBackslashInterpreterToken(first)) return true;
  // Trailing tokens after the -c payload: allow only plain positionals.
  // `-c`, redirects, backslashes, or flags mean the quoted body was split and
  // the truncated payload must not be trusted on its own under auto.
  if (rest.length > 0 && !rest.every(isSafeShellPositional)) return true;
  return false;
}

function peelShellDashC(tokens: string[], start: number): PeelOutcome {
  let i = start;
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (t === "--") {
      i++;
      break;
    }
    if (t === "-c" || t === "--command") {
      const payload = tokens[i + 1];
      if (payload === undefined || isOpaquePayload(payload)) return { kind: "opaque" };
      const rest = tokens.slice(i + 2);
      if (nestedInterpreterPayloadOpaque(payload, rest)) return { kind: "opaque" };
      return { kind: "inner", command: payload };
    }
    if (t.startsWith("--command=")) {
      const payload = t.slice("--command=".length);
      if (isOpaquePayload(payload)) return { kind: "opaque" };
      // Glued `--command=` has no separate rest tokens; still reject `\bash`.
      if (nestedInterpreterPayloadOpaque(payload, [])) return { kind: "opaque" };
      return { kind: "inner", command: payload };
    }
    // Clustered short flags that include `c` (`-lc`, `-ic`, …): `c` takes the
    // next token as the command string, matching bash/sh/zsh.
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(t)) {
      const payload = tokens[i + 1];
      if (payload === undefined || isOpaquePayload(payload)) return { kind: "opaque" };
      const rest = tokens.slice(i + 2);
      if (nestedInterpreterPayloadOpaque(payload, rest)) return { kind: "opaque" };
      return { kind: "inner", command: payload };
    }
    if (t.startsWith("-") && t !== "-") {
      i++;
      continue;
    }
    break;
  }
  return { kind: "none" };
}

function peelXargs(tokens: string[], start: number): PeelOutcome {
  let i = start;
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (t === "--") {
      i++;
      break;
    }
    if (!t.startsWith("-") || t === "-") break;
    if (t.includes("=") && t.startsWith("--")) {
      i++;
      continue;
    }
    if (XARGS_VALUE_FLAGS.has(t)) {
      i++;
      if (i < tokens.length && !tokens[i]!.startsWith("-")) i++;
      continue;
    }
    // Clustered short options; -I/-i/-n/… with glued values are treated as one token.
    i++;
  }
  if (i >= tokens.length) return { kind: "opaque" };
  const utilityTokens = tokens.slice(i);
  if (isOpaquePayload(utilityTokens.join(" "))) return { kind: "opaque" };
  const command = rejoinTokens(utilityTokens);
  if (command === null) return { kind: "opaque" };
  return { kind: "inner", command };
}

// Env short options that are boolean (no value) and may cluster with -S.
// Used to tell clustered `-Si` (S takes the next argv) from glued `-Sfind`
// (payload is the rest of the same token).
const ENV_BOOL_SHORT = new Set(["i", "0", "v"]);

// Env flags that consume the following argv token as a value. Shared by the
// -S peel walker and the transparent-prefix skip so they cannot drift.
const ENV_VALUE_FLAGS = new Set([
  "-u",
  "--unset",
  "-C",
  "--chdir",
  "--argv0",
  "-f",
  "--file",
  // Darwin / FreeBSD: -P altpath for utility lookup.
  "-P",
]);

function isEnvValueEqualsFlag(t: string): boolean {
  return (
    t.startsWith("--unset=") ||
    t.startsWith("--chdir=") ||
    t.startsWith("--argv0=") ||
    t.startsWith("--file=")
  );
}

// Advance past one env value-taking flag (+ its value when separate). Returns
// the index after the flag/value, or null when `tokens[i]` is not such a flag.
function advancePastEnvValueFlag(tokens: string[], i: number): number | null {
  const t = tokens[i];
  if (t === undefined) return null;
  if (ENV_VALUE_FLAGS.has(t)) {
    let j = i + 1;
    if (j < tokens.length && !tokens[j]!.startsWith("-")) j++;
    return j;
  }
  if (isEnvValueEqualsFlag(t)) return i + 1;
  return null;
}

// env -S re-parses its payload: quotes, `\_` as an argument separator (not a
// literal underscore), then more env flags/assignments before the utility.
// Expand separators so a later tokenize sees real argv boundaries.
//
// Only `\_` is modeled. GNU env's -S grammar has a wider escape set (\\, \",
// \n, \#, ...) whose expansion differs across implementations; passing an
// unmodeled escape through garbles the subjects the hard-deny matchers see,
// so any other backslash makes the payload uninspectable (null → opaque →
// ask) instead of silently mis-parsed.
function expandEnvSplitSeparators(payload: string): string | null {
  let out = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < payload.length; i++) {
    const c = payload[i]!;
    if (quote === "'") {
      out += c;
      if (c === "'") quote = null;
      continue;
    }
    if (c === "\\") {
      const n = payload[i + 1];
      if (n === "_") {
        // `\_` is env's arg separator outside and inside double quotes.
        out += " ";
        i++;
        continue;
      }
      return null;
    }
    if (quote === '"') {
      out += c;
      if (c === '"') quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      out += c;
      continue;
    }
    out += c;
  }
  return out;
}

// After folding the -S payload with any trailing utility tokens, re-parse the
// result the way env does: expand `\_`, tokenize (dequote), skip env flags /
// assignments / end-of-options, and land on the real program hard-deny matchers
// expect (`env -S -v find /` → `find /`, `env -S "rm '-rf' '/'"` → `rm -rf /`).
function peelEnvSplitUtility(command: string): PeelOutcome {
  const expanded = expandEnvSplitSeparators(command);
  if (expanded === null || isOpaquePayload(expanded)) return { kind: "opaque" };
  const tokens = tokenize(expanded);
  let i = 0;
  while (i < tokens.length && ENV_ASSIGNMENT.test(tokens[i]!)) i++;
  while (i < tokens.length && (tokens[i] === "--" || tokens[i] === "-")) i++;
  i = skipEnvFlagsAndAssignments(tokens, i);
  if (i >= tokens.length) return { kind: "opaque" };
  const utility = rejoinTokens(tokens.slice(i));
  if (utility === null) return { kind: "opaque" };
  return { kind: "inner", command: utility };
}

// After extracting an -S / --split-string payload, fold any trailing utility
// tokens (`env -S FOO=bar find /` → `FOO=bar find /`) so hard-deny sees the
// real program, not just the assignment fragment that -S consumed.
// Empty/opaque payloads with a trailing utility still execute that utility
// (`env -S " " find /`), so prefer the trailing tokens over opaque-dropping them.
function finishEnvSplitPayload(payload: string, tokens: string[], restStart: number): PeelOutcome {
  const rest = tokens.slice(restStart);
  let raw: string | null;
  if (isOpaquePayload(payload)) {
    if (rest.length === 0) return { kind: "opaque" };
    if (isOpaquePayload(rest.join(" "))) return { kind: "opaque" };
    raw = rejoinTokens(rest);
  } else if (rest.length === 0) {
    raw = payload;
  } else {
    if (isOpaquePayload(rest.join(" "))) return { kind: "opaque" };
    raw = rejoinTokens([payload, ...rest]);
  }
  if (raw === null) return { kind: "opaque" };
  return peelEnvSplitUtility(raw);
}

// Peel env's -S / --split-string payload as its own shell subject. Unlike the
// auto-mode assignment ask (which only cares about NAME=value inside the
// payload), every consumer of expandShellSubjects — hard-deny included — must
// see every payload so `env -S "rm -rf /"` is blocked the same way as the
// plain form. Uninspectable payloads are opaque rather than silently dropped.
//
// Forms covered:
//   -S PAYLOAD / --split-string PAYLOAD
//   --split-string=PAYLOAD
//   glued -SPAYLOAD / --split-stringPAYLOAD (no `=`, one shell token)
//   clustered short flags with S (`-iS`, `-Si`) taking the next token
//   trailing utility after the -S argument (`env -S FOO=bar find /`)
function peelEnvSplitString(tokens: string[], start: number): PeelOutcome {
  let i = start;
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (t === "--") return { kind: "none" };

    // --split-string=PAYLOAD
    if (t.startsWith("--split-string=")) {
      return finishEnvSplitPayload(t.slice("--split-string=".length), tokens, i + 1);
    }
    // Glued long form without `=`: --split-string"find /" → one token.
    if (t.startsWith("--split-string") && t !== "--split-string") {
      return finishEnvSplitPayload(t.slice("--split-string".length), tokens, i + 1);
    }
    // Separate-arg forms: -S PAYLOAD / --split-string PAYLOAD
    if (t === "-S" || t === "--split-string") {
      const payload = tokens[i + 1];
      if (payload === undefined) return { kind: "opaque" };
      return finishEnvSplitPayload(payload, tokens, i + 2);
    }

    // Short-option cluster that contains S.
    //   -Sfind / -S"find /"  → glued payload after S (same token)
    //   -iS / -0S            → S at end of cluster; next token is payload
    //   -Si / -Sv            → S then only boolean shorts; next token is payload
    //   -Sifind              → S then non-bool remainder; treat as glued payload
    if (t.startsWith("-") && t !== "-" && t.includes("S") && !t.startsWith("--")) {
      const sIdx = t.indexOf("S", 1);
      if (sIdx >= 1) {
        const afterS = t.slice(sIdx + 1);
        const onlyBoolAfter =
          afterS.length === 0 || [...afterS].every((c) => ENV_BOOL_SHORT.has(c));
        if (onlyBoolAfter) {
          // Clustered flags; S consumes the following argv token.
          const payload = tokens[i + 1];
          if (payload === undefined) return { kind: "opaque" };
          return finishEnvSplitPayload(payload, tokens, i + 2);
        }
        // Glued payload in the same token (e.g. -Sfind, -S"find /").
        return finishEnvSplitPayload(afterS, tokens, i + 1);
      }
    }

    // Value-taking env flags: skip so `env -u HOME -S "find /"` reaches -S.
    const afterValue = advancePastEnvValueFlag(tokens, i);
    if (afterValue !== null) {
      i = afterValue;
      continue;
    }

    if (t.startsWith("-") && t !== "-") {
      i++;
      continue;
    }
    // Bare NAME=value or the utility — not a split-string form at this layer.
    if (ENV_ASSIGNMENT.test(t)) {
      i++;
      continue;
    }
    return { kind: "none" };
  }
  return { kind: "none" };
}

// Skip env's own flags and NAME=value arguments so a transparent
// `env -i FOO=bar cmd` peel lands on `cmd`, not on the `-i` flag token.
function skipEnvFlagsAndAssignments(tokens: string[], start: number): number {
  let i = start;
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (t === "--") return i + 1;
    if (ENV_ASSIGNMENT.test(t)) {
      i++;
      continue;
    }
    const afterValue = advancePastEnvValueFlag(tokens, i);
    if (afterValue !== null) {
      i = afterValue;
      continue;
    }
    if (t.startsWith("-") && t !== "-") {
      i++;
      continue;
    }
    break;
  }
  return i;
}

// Peel one layer of transparent prefix / shell -c / xargs / env -S from a
// single segment.
function peelOnce(segment: string): PeelOutcome {
  const tokens = tokenize(segment);
  let i = 0;
  while (i < tokens.length && ENV_ASSIGNMENT.test(tokens[i]!)) i++;

  let strippedPrefix = false;
  while (i < tokens.length) {
    const base = programBasename(tokens[i]!);
    if (base === "env") {
      // Prefer split-string peel: the whole payload is one quoted argument
      // that env re-splits itself, so the transparent-prefix path below
      // would only rejoin `-S '…'` and leave the real command invisible.
      const splitPeel = peelEnvSplitString(tokens, i + 1);
      if (splitPeel.kind !== "none") return splitPeel;
      strippedPrefix = true;
      i = skipEnvFlagsAndAssignments(tokens, i + 1);
      continue;
    }
    if (base === "timeout") {
      strippedPrefix = true;
      i++;
      // Optional duration (10, 30s, 1m, …) and common long/short flags.
      while (i < tokens.length) {
        const t = tokens[i]!;
        if (/^\d/.test(t)) {
          i++;
          continue;
        }
        if (t.startsWith("-") && t !== "-") {
          // Flags that take a value: -k / --kill-after / -s / --signal.
          if (
            t === "-k" ||
            t === "--kill-after" ||
            t === "-s" ||
            t === "--signal" ||
            t.startsWith("--kill-after=") ||
            t.startsWith("--signal=")
          ) {
            i++;
            if (!t.includes("=") && i < tokens.length && !tokens[i]!.startsWith("-")) i++;
            continue;
          }
          i++;
          continue;
        }
        break;
      }
      continue;
    }
    if (PREFIX_WRAPPERS.has(base) && base !== "env" && base !== "timeout") {
      strippedPrefix = true;
      i++;
      continue;
    }
    break;
  }

  if (i >= tokens.length) return strippedPrefix ? { kind: "opaque" } : { kind: "none" };

  const prog = programBasename(tokens[i]!);
  if (SHELL_INTERPRETERS.has(prog)) {
    // A backtick or `$(` anywhere in the raw segment means the -c payload may
    // contain command substitution. tokenize() surfaces substitution content as
    // its own bare tokens (so the security scanner can see substituted paths),
    // which means the payload token peelShellDashC would read back is only the
    // first fragment of the original quoted argument, not the whole string —
    // reconstructing it accurately is not possible from tokens alone. Treat the
    // wrapper as opaque rather than risk peeling a truncated, misleading payload.
    if (segment.includes("`") || segment.includes("$(")) return { kind: "opaque" };
    const shellPeel = peelShellDashC(tokens, i + 1);
    if (shellPeel.kind !== "none") return shellPeel;
    // Interpreter without -c (e.g. `bash script.sh`) — not a peelable wrapper.
    return { kind: "none" };
  }
  if (prog === "xargs") return peelXargs(tokens, i + 1);

  // Prefix-only peel: `env FOO=1 rm -rf build` → `rm -rf build`.
  if (strippedPrefix) {
    const command = rejoinTokens(tokens.slice(i));
    if (command === null) return { kind: "opaque" };
    return { kind: "inner", command };
  }
  return { kind: "none" };
}

export interface ShellExpandResult {
  /** Original command plus every successfully peeled inner payload. */
  subjects: string[];
  /** True when a wrapper was present but its payload could not be inspected. */
  opaque: boolean;
}

// Expand a shell command into subjects the auto-shell policy, hard-deny, and
// recursive-rm checks should scan. Peels bash/sh/zsh/dash/ksh -c, xargs
// utility tails, env -S/--split-string payloads, and transparent prefixes
// (env/nice/timeout/…), recursing with a depth cap so nested wrappers cannot
// hide a dangerous payload.
//
// Chain splitting is quote-aware (`splitChainedCommand`) so a pipe inside a
// `bash -c '…|…'` payload is not mistaken for an outer pipeline boundary.
// Drop env/shell end-of-options markers so command-position hard-deny still
// sees the real program in subjects like `env -S "-- find /"` or `env -S -- find /`.
// Assignments before the marker are preserved (`FOO=1 -- find /` → `FOO=1 find /`).
function dropLeadingEndOfOptionsTokens(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length && ENV_ASSIGNMENT.test(tokens[i]!)) i++;
  const head = tokens.slice(0, i);
  while (i < tokens.length && (tokens[i] === "--" || tokens[i] === "-")) i++;
  return head.concat(tokens.slice(i));
}

function stripEndOfOptionsCommand(command: string): string {
  const tokens = tokenize(command);
  const next = dropLeadingEndOfOptionsTokens(tokens);
  if (next.length === tokens.length) {
    let same = true;
    for (let i = 0; i < tokens.length; i++) {
      if (next[i] !== tokens[i]) {
        same = false;
        break;
      }
    }
    if (same) return command;
  }
  if (next.length === 0) return command;
  return rejoinTokens(next) ?? next.join(" ");
}

export function expandShellSubjects(command: string, maxDepth = MAX_PEEL_DEPTH): ShellExpandResult {
  const subjects: string[] = [];
  const seen = new Set<string>();
  let opaque = false;

  const visit = (cmd: string, depth: number): void => {
    const trimmed = cmd.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) return;
    seen.add(trimmed);
    subjects.push(trimmed);
    // Surface end-of-options-stripped forms so command-position matchers hit
    // `find` in subjects that still carry a leading `--` / `-` from env -S.
    const stripped = stripEndOfOptionsCommand(trimmed);
    if (stripped !== trimmed && !seen.has(stripped)) {
      seen.add(stripped);
      subjects.push(stripped);
    }
    if (depth >= maxDepth) {
      // Depth exhausted while this subject may still be a nested interpreter
      // wrapper. Mark opaque so auto cannot accept a leaf we never fully peeled.
      for (const segment of splitChainedCommand(trimmed)) {
        const peeled = peelOnce(segment);
        if (peeled.kind === "inner" || peeled.kind === "opaque") opaque = true;
      }
      return;
    }

    for (const segment of splitChainedCommand(trimmed)) {
      const peeled = peelOnce(segment);
      if (peeled.kind === "opaque") opaque = true;
      if (peeled.kind === "inner") visit(peeled.command, depth + 1);
    }
  };

  visit(command, 0);
  return { subjects, opaque };
}

function segmentRmArgs(segment: string): string[] | undefined {
  // Quote-aware: env -S payloads often carry quoted flags (`rm '-rf' '/'`).
  const tokens = tokenize(segment);
  let i = 0;
  while (i < tokens.length && ENV_ASSIGNMENT.test(tokens[i]!)) i++;
  while (i < tokens.length && (tokens[i] === "--" || tokens[i] === "-")) i++;
  while (i < tokens.length && RM_WRAPPER.test(tokens[i]!)) i++;
  while (i < tokens.length && (tokens[i] === "--" || tokens[i] === "-")) i++;
  if (programBasename(tokens[i] ?? "") !== "rm") return undefined;
  return tokens.slice(i + 1);
}

export function segmentHasRecursiveRm(segment: string): boolean {
  const args = segmentRmArgs(segment);
  if (args === undefined) return false;
  return args.some((a) => RECURSIVE_FLAG.test(a));
}

export function commandHasRecursiveRm(command: string): boolean {
  const trimmed = command.trim();
  if (trimmed.length === 0) return false;
  const { subjects } = expandShellSubjects(trimmed);
  return subjects.some((subject) => subject.split(CHAIN).some(segmentHasRecursiveRm));
}

function isCatastrophicRm(segment: string): boolean {
  const args = segmentRmArgs(segment);
  if (args === undefined) return false;
  if (!args.some((a) => RECURSIVE_FLAG.test(a))) return false;
  const targets = args.filter((a) => !a.startsWith("-"));
  // No target, or a dangerous root → catastrophic.
  return targets.length === 0 || targets.some(isDangerousTarget);
}

// Blank quoted interiors so CMD does not treat `;` inside `-m` text as a new command.
// Double-quoted `$(...)` / backticks stay visible: their contents are real commands.
function skipQuotedSpans(command: string): string {
  let out = "";
  let quote: '"' | "'" | undefined;
  // Quote to restore when each `$(...)` closes. Extra `(` inside a substitution
  // is a `"paren"` frame so its `)` does not restore quote. A depth counter that
  // only restores at 0 treats the `"` after inner `"$(...)"` as an opener and
  // blanks sibling eval.
  const substStack: ('"' | "'" | undefined | "paren")[] = [];
  let inBacktick = false;

  const enterSubst = (): void => {
    substStack.push(quote);
    quote = undefined;
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote === "'") {
      if (ch === "'") {
        quote = undefined;
        out += ch;
      } else {
        out += ch === "\n" ? "\n" : " ";
      }
      continue;
    }
    if (quote === '"') {
      if (ch === "\\") {
        const next = command[i + 1];
        if (next !== undefined && next !== "\n") {
          out += "  ";
          i++;
          continue;
        }
      }
      if (ch === "`") {
        inBacktick = true;
        quote = undefined;
        out += ch;
        continue;
      }
      if (ch === "$" && command[i + 1] === "(") {
        enterSubst();
        out += "$(";
        i++;
        continue;
      }
      if (ch === '"') {
        quote = undefined;
        out += ch;
      } else {
        out += ch === "\n" ? "\n" : " ";
      }
      continue;
    }
    if (inBacktick && ch === "`") {
      inBacktick = false;
      quote = '"';
      out += ch;
      continue;
    }
    if (substStack.length > 0 && ch === "$" && command[i + 1] === "(") {
      enterSubst();
      out += "$(";
      i++;
      continue;
    }
    if (substStack.length > 0 && ch === "(") {
      substStack.push("paren");
      out += ch;
      continue;
    }
    if (substStack.length > 0 && ch === ")") {
      const frame = substStack.pop();
      out += ch;
      if (frame !== "paren") quote = frame;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    out += ch;
  }
  return out;
}

// Scan expanded subjects for blocked patterns / catastrophic rm. Callers may
// pass a pre-normalized form so path-qualified binaries (`/usr/bin/sudo`) still
// match command-position patterns.
function isDestructiveExpanded(command: string): boolean {
  const { subjects } = expandShellSubjects(command);
  return subjects.some((subject) => {
    if (BLOCKED_PATTERNS.some((pattern) => pattern.test(skipQuotedSpans(subject)))) return true;
    if (BLOCKED_QUOTED_PAYLOAD_PATTERNS.some((pattern) => pattern.test(subject))) return true;
    return subject.split(CHAIN).some(isCatastrophicRm);
  });
}

// Hard-deny must expand the *raw* command so `env -S "…"` stays peelable —
// normalizeCommand strips bare `env` as a transparent wrapper, which would
// turn the command into `-S "…"` and hide the payload. Also expand the
// normalized form so path-stripped BLOCKED_PATTERNS (`/usr/bin/sudo` → `sudo`)
// still fire.
function isDestructive(command: string): boolean {
  if (isDestructiveExpanded(command)) return true;
  const normalized = normalizeCommand(command);
  return normalized !== command && isDestructiveExpanded(normalized);
}

function isOpenEndedSearch(command: string): boolean {
  return OPEN_ENDED_SEARCH_PATTERNS.some((pattern) => pattern.test(command));
}

// Open-ended / never-terminating / stdin hard-deny must scan expanded subjects
// so `env -S "find /"`, `bash -c 'watch ls'`, and similar wrappers cannot hide
// the real program inside a quoted payload. Normalize each subject so path-
// qualified binaries still match command-position patterns.
function subjectsHit(command: string, pred: (normalizedSubject: string) => boolean): boolean {
  const { subjects } = expandShellSubjects(command);
  if (subjects.some((subject) => pred(normalizeCommand(subject)))) return true;
  const normalized = normalizeCommand(command);
  if (normalized === command) return false;
  const { subjects: normalizedSubjects } = expandShellSubjects(normalized);
  return normalizedSubjects.some((subject) => pred(normalizeCommand(subject)));
}

function openEndedSearchReason(command: string): string | undefined {
  if (!subjectsHit(command, isOpenEndedSearch)) return undefined;
  // The patterns catch three command shapes only, so the message has to carry
  // the general prohibition: fd, ls -R, and scripted walks are equally unbounded
  // and would otherwise look like sanctioned ways to do the same thing.
  return (
    `Open-ended shell search blocked — shell find, head-position rg, and recursive ` +
    `grep -r can walk huge trees and OOM the host. Prefer the bounded grep/search_files ` +
    `tools (timeout + output caps). Do not substitute another unbounded walk ` +
    `(fd, ls -R, scripted os.walk). Command: ${command}`
  );
}

// Pipeline segments are judged in isolation for open-ended/destructive rules only.
// Stdin and never-terminating checks apply across expanded subjects so wrapper
// payloads (env -S, bash -c, …) are visible.
export function runShellAuthzSegmentBlockReason(segment: string): string | undefined {
  const trimmed = segment.trim();
  if (trimmed.length === 0) return undefined;
  // Pass the raw segment: isDestructive expands both raw and normalized forms.
  if (isDestructive(trimmed)) {
    return `Destructive command blocked by policy: ${trimmed}`;
  }
  return openEndedSearchReason(trimmed);
}

export function runShellAuthzBlockReason(command: string): string | undefined {
  // Destructive / open-ended / never-terminating / stdin all expand subjects so
  // env -S and shell -c payloads cannot hide a blocked program.
  if (isDestructive(command)) {
    return `Destructive command blocked by policy: ${command}`;
  }
  const openEnded = openEndedSearchReason(command);
  if (openEnded !== undefined) return openEnded;
  if (subjectsHit(command, isNeverTerminating)) {
    return (
      `Never-terminating command blocked — follow/pager/watch commands (tail -f, watch, ` +
      `top, less, more) never exit under the agent and hang the run. Use a bounded ` +
      `alternative (e.g. tail -n 50 file). Command: ${command}`
    );
  }
  if (subjectsHit(command, blocksOnStdin)) {
    return (
      `Command reads standard input with no file operand and would hang, since stdin is ` +
      `not connected. Pass a file operand (e.g. tail -n 50 file.log, grep pattern file). ` +
      `Command: ${command}`
    );
  }
  return undefined;
}
