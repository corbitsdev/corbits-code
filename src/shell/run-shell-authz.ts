// Shared run_shell authorization policy used by the authz plugin (hard deny at
// execution) and the permission gate (do not auto-allow what authz would reject).

// A command-position anchor: the start of the command, or immediately after a
// shell separator or subshell open, optionally preceded by a run of NAME=value
// environment assignments (so `X=1 sudo …` is still recognised as `sudo` in
// command position). This keeps a word like "exec" or "format" from matching
// when it merely appears inside a URL, comment, or string argument.
const CMD = String.raw`(?:^|[\n;&|(` + "`" + String.raw`]\s*)(?:\w+=\S*\s+)*`;

const cmd = (name: string): RegExp => new RegExp(`${CMD}${name}\\b`);

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
  // Fork bombs and busy-loops.
  /:\(\)\s*\{\s*:\|:\&\s*\};/,
  /bash\s+-c\s+.*while\s+:\s*;\s*do/,
  /perl\s+-e\s+.*fork\s+while\s+fork/,
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

// Open-ended tree walks via the shell OOM the host: `find | tail` still forces
// the full stream through the collector, and recursive grep/rg walks huge trees
// before any pipe limit applies. Route those through the bounded tools instead.
// (`git log | tail` and similar non-walk pipes are fine — the 512KB shell
// output cap is the backstop for those.)
const OPEN_ENDED_SEARCH_PATTERNS: RegExp[] = [
  // `find` is almost always a full-tree walk.
  cmd("find"),
  // ripgrep via shell — the `grep` tool already routes through rg with caps.
  cmd("rg"),
  // Recursive grep/egrep/fgrep (flag form -r/-R/--recursive, alone or clustered).
  new RegExp(
    String.raw`${CMD}(?:grep|egrep|fgrep)\b[^\n|;]*?(?:\s-[A-Za-z0-9]*[rR][A-Za-z0-9]*\b|\s--recursive\b)`,
  ),
];

// Commands that follow forever or page interactively never exit under the agent
// (stdin is not a terminal and nothing consumes the pager), so they hang the run
// until the shell timeout kills them. Deny them at any command position so a
// piped pager (`… | less`) is caught as well as a bare one.
const NEVER_TERMINATING_PATTERNS: RegExp[] = [
  // `tail -f` / `-F` follow a file forever (flag alone or clustered).
  new RegExp(
    String.raw`${CMD}tail\b[^\n|;]*?\s-[A-Za-z]*[fF][A-Za-z]*\b`,
  ),
  // GNU long form `--follow` / `--follow=name` never matches the clustered
  // short-flag pattern above, so match it explicitly.
  new RegExp(
    String.raw`${CMD}tail\b[^\n|;]*?\s--follow\b`,
  ),
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
const STDIN_READERS = new Set([
  "cat",
  "tac",
  "nl",
  "rev",
  "head",
  "tail",
  "sort",
  "uniq",
  "wc",
]);

// Short flags that consume the following token as their value, so the value is
// not mistaken for a file operand (e.g. the `50` in `tail -n 50`). These are
// value-taking only for `head` and `tail`; for the other stdin readers the same
// letters are boolean flags (e.g. `wc -c`, `uniq -c`, `sort -c`), so consuming a
// following token there would wrongly drop a real file operand.
const HEAD_TAIL_VALUE_FLAGS = new Set(["-n", "-c", "-C", "--lines", "--bytes"]);
const GREP_VALUE_FLAGS = new Set([
  "-e",
  "-f",
  "-m",
  "-A",
  "-B",
  "-C",
  "--regexp",
  "--file",
]);

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

function tokenizeSegment(segment: string): string[] {
  const tokens = segment.trim().split(/\s+/).filter((t) => t.length > 0);
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
  String.raw`(^|[\n;&|(` +
    "`" +
    String.raw`]\s*)(?:\w+=\S*\s+|${STRIP_WRAPPER}\s+)*(/\S*/)?`,
  "g",
);

function normalizeCommand(command: string): string {
  return command.replace(NORMALIZE_COMMAND_POSITION, "$1");
}

const CHAIN = /[\n;]|&&|\|\||\|/;
const ENV_ASSIGNMENT = /^\w+=/;
const RM_WRAPPER = /^(sudo|command|env|exec|builtin|time|nice|nohup)$/;
const RECURSIVE_FLAG = /^(--recursive|-[A-Za-z]*[rR][A-Za-z]*)$/;

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
  if (/^\/(etc|usr|bin|sbin|var|sys|dev|lib|boot|root|home|opt|Applications|System|Library|Users)(\/|$)/.test(t)) {
    return true;
  }
  return false;
}

function isCatastrophicRm(segment: string): boolean {
  const tokens = segment.trim().split(/\s+/).filter((t) => t.length > 0);
  let i = 0;
  while (i < tokens.length && ENV_ASSIGNMENT.test(tokens[i]!)) i++;
  while (i < tokens.length && RM_WRAPPER.test(tokens[i]!)) i++;
  if (tokens[i] !== "rm") return false;
  const args = tokens.slice(i + 1);
  if (!args.some((a) => RECURSIVE_FLAG.test(a))) return false;
  const targets = args.filter((a) => !a.startsWith("-"));
  // No target, or a dangerous root → catastrophic.
  return targets.length === 0 || targets.some(isDangerousTarget);
}

function isDestructive(command: string): boolean {
  if (BLOCKED_PATTERNS.some((pattern) => pattern.test(command))) return true;
  return command.split(CHAIN).some(isCatastrophicRm);
}

function isOpenEndedSearch(command: string): boolean {
  return OPEN_ENDED_SEARCH_PATTERNS.some((pattern) => pattern.test(command));
}

function openEndedSearchReason(command: string): string | undefined {
  if (!isOpenEndedSearch(normalizeCommand(command))) return undefined;
  return (
    `Open-ended shell search blocked — use the grep, search_files, or list_dir tools ` +
    `(they time out and cap output). Do not use find, rg, or grep -r via the shell. ` +
    `Command: ${command}`
  );
}

// Pipeline segments are judged in isolation for open-ended/destructive rules only.
// Stdin and never-terminating checks apply to the full command string.
export function runShellAuthzSegmentBlockReason(segment: string): string | undefined {
  const trimmed = segment.trim();
  if (trimmed.length === 0) return undefined;
  const normalized = normalizeCommand(trimmed);
  if (isDestructive(normalized)) {
    return `Destructive command blocked by policy: ${trimmed}`;
  }
  return openEndedSearchReason(trimmed);
}

export function runShellAuthzBlockReason(command: string): string | undefined {
  const normalized = normalizeCommand(command);
  if (isDestructive(normalized)) {
    return `Destructive command blocked by policy: ${command}`;
  }
  const openEnded = openEndedSearchReason(command);
  if (openEnded !== undefined) return openEnded;
  if (isNeverTerminating(normalized)) {
    return (
      `Never-terminating command blocked — follow/pager/watch commands (tail -f, watch, ` +
      `top, less, more) never exit under the agent and hang the run. Use a bounded ` +
      `alternative (e.g. tail -n 50 file). Command: ${command}`
    );
  }
  if (blocksOnStdin(normalized)) {
    return (
      `Command reads standard input with no file operand and would hang, since stdin is ` +
      `not connected. Pass a file operand (e.g. tail -n 50 file.log, grep pattern file). ` +
      `Command: ${command}`
    );
  }
  return undefined;
}
