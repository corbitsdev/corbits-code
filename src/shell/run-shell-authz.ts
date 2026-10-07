// Shared run_shell authorization policy: the permission gate is the sole
// enforcement owner (hard deny at the top of its verdict path).

import { splitChainedCommand, tokenize } from "../permission/command.js";
import {
  FILE_OPTION_GRAMMARS,
  firstShortValueOption,
} from "./file-option-grammar.js";
import {
  peelTransparentCommand,
  programBasename,
  skipEnvArguments,
} from "./transparent-command.js";

export { programBasename } from "./transparent-command.js";

function skipMatching(
  tokens: readonly string[],
  start: number,
  pred: (token: string) => boolean,
): number {
  let i = start;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token === undefined || !pred(token)) break;
    i++;
  }
  return i;
}

// Command-position anchor: command start or after a separator/subshell open,
// optionally preceded by NAME=value assignments (`X=1 sudo` → `sudo`). Keeps a
// word like "exec" from matching inside a URL, comment, or string argument.
const CMD = String.raw`(?:^|[\n;&|(` + "`" + String.raw`]\s*)(?:\w+=\S*\s+)*`;

const cmd = (name: string): RegExp => new RegExp(`${CMD}${name}\\b`);

// Command-head anchor: like CMD, but a bare `|` is not a boundary — a stage
// downstream of a single pipe reads bounded piped data (e.g. `git show … | rg`),
// not a tree walk. `&&`/`||` stay boundaries, matched as two-char operators so
// a lone `|` inside them is not mistaken for the single-pipe case.
const CMD_HEAD =
  String.raw`(?:^|[\n;(` + "`" + String.raw`]\s*|&&\s*|\|\|\s*)(?:\w+=\S*\s+)*`;

const cmdHead = (name: string): RegExp => new RegExp(`${CMD_HEAD}${name}\\b`);

// Safe pseudo-device redirects are routine; only real device nodes are
// destructive. The lookahead exempts the pseudo-devices, anchored to a token
// terminator so /dev/null/../sda is NOT exempted.
const SAFE_DEV = String.raw`(?!(?:null|stdout|stderr|stdin|tty|fd/)(?:$|[\s;&|]))`;

// Wrappers that can sit between a pipe and the shell it feeds (`curl x | sudo
// bash` is caught as well as `curl x | bash`).
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
  // Fork bombs and busy-loops. They inspect quoted interpreter payloads
  // (`bash -c 'while :; do'`, `perl -e 'fork while fork'`) on the original
  // subject — command-position matchers neutralize in-quote separators and
  // would miss the `;` these patterns need.
  /:\(\)\s*\{\s*:\|:&\s*\};/,
  // Piping a network download straight into a shell (through any wrappers).
  new RegExp(
    String.raw`(curl|wget|fetch)\b[^\n;|]*\|\s*${SHELL_WRAPPERS}(bash|sh|zsh)\b`,
  ),
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

// Open-ended tree walks OOM the host: `find | tail` still forces the full
// stream through the collector, and recursive grep/rg walks huge trees.
// Hard-deny those; the bounded grep/glob tools are the alternative (the 512KB
// output cap backstops `git log | tail` and similar non-walk pipes).
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

// Follow/pager commands never exit under the agent (stdin is not a terminal and
// nothing consumes the pager), so they hang the run. Deny at any command
// position so `… | less` is caught as well as bare `less`.
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

// Programs that read stdin when given no file operand. Bare (not piped, no
// file) they block on a terminal that never arrives. `git log | tail` and
// `tail -n 50 file.log` are fine; bare `tail`/`cat`/`grep pattern` is not.
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

// Flags that consume the next token as their value (`tail -n 50`). Value-taking
// only for head/tail — for the other readers the same letters are boolean
// (`wc -c`), so consuming a token there would drop a real file operand.
export const HEAD_TAIL_VALUE_FLAGS = new Set([
  "-n",
  "-c",
  "-C",
  "--lines",
  "--bytes",
]);
export const GREP_VALUE_FLAGS = new Set([
  "-e",
  "-f",
  "-m",
  "-A",
  "-B",
  "-C",
  "--regexp",
  "--file",
]);

// The head of each pipeline (stage before the first `|`) is the only stage
// that reads terminal stdin. Split on unquoted `;`, newline, `&&`, `||`; end
// each head at its first unquoted `|` — a naive regex split would break on
// `|` inside quotes (e.g. `grep 'a|b' file`).
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
    const ch = command[i];
    if (ch === undefined) break;
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
// classification. A naive whitespace split miscounts `grep 'a b'` as two
// operands.
export function tokenizeSegment(segment: string): string[] {
  const tokens = tokenize(segment);
  let i = skipMatching(tokens, 0, (t) => ENV_ASSIGNMENT.test(t));
  i = skipMatching(tokens, i, (t) => RM_WRAPPER.test(t));
  return tokens.slice(i);
}

// Count file operands, skipping flags and their values.
function fileOperandCount(args: string[], valueFlags: Set<string>): number {
  let count = 0;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "--") continue;
    if (arg.startsWith("-")) {
      if (valueFlags.has(arg)) i++;
      continue;
    }
    count++;
  }
  return count;
}

function grepOperandSummary(args: string[]): {
  count: number;
  suppliesPatternViaFlag: boolean;
} {
  const grammar = FILE_OPTION_GRAMMARS.grep;
  if (grammar === undefined) {
    return {
      count: fileOperandCount(args, GREP_VALUE_FLAGS),
      suppliesPatternViaFlag: false,
    };
  }

  let count = 0;
  let suppliesPatternViaFlag = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg === "--") continue;
    if (arg === "--regexp" || arg === "--file") {
      suppliesPatternViaFlag = true;
      index++;
      continue;
    }
    if (arg.startsWith("--regexp=") || arg.startsWith("--file=")) {
      suppliesPatternViaFlag = true;
      continue;
    }
    const valueOption = firstShortValueOption(arg, grammar);
    if (valueOption !== undefined) {
      if (valueOption.option === "e" || valueOption.option === "f") {
        suppliesPatternViaFlag = true;
      }
      if (valueOption.attachedValue === undefined) index++;
      continue;
    }
    if (arg.startsWith("-")) continue;
    count++;
  }
  return { count, suppliesPatternViaFlag };
}

function readsStdinWithoutInput(head: string): boolean {
  const tokens = tokenizeSegment(head);
  const exec = tokens[0];
  if (exec === undefined) return false;
  const args = tokens.slice(1);
  if (exec === "grep" || exec === "egrep" || exec === "fgrep") {
    // grep reads stdin unless given a file in addition to the pattern; a `-e`
    // or `-f` flag supplies the pattern, so then a single operand is the file.
    const summary = grepOperandSummary(args);
    return summary.suppliesPatternViaFlag
      ? summary.count < 1
      : summary.count < 2;
  }
  if (STDIN_READERS.has(exec)) {
    const valueFlags =
      exec === "head" || exec === "tail"
        ? HEAD_TAIL_VALUE_FLAGS
        : new Set<string>();
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

// Transparent wrappers that pass their argument through (`command find`,
// `builtin cd`). Unlike `sudo`/`exec` they are not blocked, so stripping them
// exposes the real executable to the deny patterns.
const STRIP_WRAPPER = String.raw`(?:command|env|builtin)`;

// At each command position drop NAME=value assignments, transparent wrappers,
// and an absolute path off the executable so `/usr/bin/find`, `command find`,
// and `env FOO=bar find` all reduce to `find`. Only the executable token is
// rewritten; redirect targets and later args stay intact.
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

// Interpreters whose `-c` / `--command` / cmd `/c` payload is an independent
// shell subject. Basename-based, ignores Windows suffixes (`cmd.exe` → `cmd`).
export const SHELL_INTERPRETERS = new Set([
  "bash",
  "sh",
  "zsh",
  "dash",
  "ksh",
  "ash",
  "fish",
  "csh",
  "tcsh",
  "pwsh",
  "powershell",
  "cmd",
]);
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

// A recursive rm is catastrophic only when it targets an unrecoverable root — /,
// home, a system tree, or a cwd-wide glob. Recursive rm of an ordinary relative
// path (./build, node_modules) is routine and left to the permission gate.
function isDangerousTarget(token: string): boolean {
  const t = token.replace(/['"]/g, "");
  if (["/", "~", "~/", "$HOME", "*", ".", "..", "./", "../"].includes(t))
    return true;
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

// Payload we cannot statically inspect: empty, a bare expansion, or a leading
// command substitution. `rm -rf $HOME` stays parseable so target checks fire.
function isOpaquePayload(payload: string): boolean {
  const trimmed = payload.trim();
  if (trimmed.length === 0) return true;
  if (/^\$[{(]?[\w*@#?$!-]+[)}]?$/.test(trimmed)) return true;
  if (/^\$\(/.test(trimmed) || /^`/.test(trimmed)) return true;
  return false;
}

type PeelOutcome =
  | { kind: "inner"; command: string }
  | { kind: "opaque" }
  | { kind: "none" };

// Tokens that survive rejoining without quotes. Anything else is re-quoted so a
// quoted payload token is not re-split one peel level down — rejoining dequoted
// tokens with bare spaces is how the xargs → shell -c bypass slipped through.
const SAFE_REJOIN_TOKEN = /^[A-Za-z0-9_@%+=:,./-]+$/;

// IMPORTANT: output must round-trip through this project's `tokenize()` as a
// single token — not through a POSIX shell. `tokenize()` has no backslash
// escape support, so the bash `'\''` idiom re-splits the token and drops the
// dangerous tail. Wrap in the delimiter the token does not contain; if it
// contains both, return null and the caller treats the wrapper as opaque.
function quoteTokenForRejoin(token: string): string | null {
  if (SAFE_REJOIN_TOKEN.test(token)) return token;
  if (!token.includes("'")) return `'${token}'`;
  if (!token.includes('"')) return `"${token}"`;
  return null;
}

// Rebuild a command from tokens so a later tokenize() preserves boundaries.
// Null when any token cannot be safely quoted. Opacity checks run on the raw
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

// True when a token is a plain positional after `bash -c 'script'`. Anything
// else after the -c payload suggests the quoted body was split by a tokenizer
// that does not honor backslash-escapes (`bash -c "…\"…"` degradation).
function isSafeShellPositional(token: string): boolean {
  if (token.startsWith("-") && token !== "-") return false;
  if (token.includes("\\")) return false;
  if (/[><|&;`$]/.test(token)) return false;
  return SAFE_REJOIN_TOKEN.test(token);
}

const INTERPRETER_SUFFIX = /\.(?:exe|cmd|com|bat)$/i;
const CMD_INTERPRETERS = new Set(["cmd"]);
const PWSH_INTERPRETERS = new Set(["pwsh", "powershell"]);

function shellInterpreterName(token: string): string {
  return programBasename(token).replace(INTERPRETER_SUFFIX, "").toLowerCase();
}

function isInterpreterCommandSwitch(
  interpreter: string,
  token: string,
): boolean {
  if (token === "-c" || token === "--command") return true;
  if (CMD_INTERPRETERS.has(interpreter) && /^\/[ck]$/i.test(token)) return true;
  if (PWSH_INTERPRETERS.has(interpreter) && /^-command$/i.test(token))
    return true;
  return false;
}

// `\bash` / `\sh` — tokenize artifact from peeling through an escaped quote.
function isBackslashInterpreterToken(token: string): boolean {
  const base = programBasename(token);
  if (!base.startsWith("\\")) return false;
  return SHELL_INTERPRETERS.has(shellInterpreterName(base.slice(1)));
}

function shellPayloadReferencesPositional(payload: string): boolean {
  return /\$(?:[0-9@*#]|\{(?:[0-9]+|[@*#])\})/.test(payload);
}

function nestedInterpreterPayloadOpaque(
  payload: string,
  rest: readonly string[],
): boolean {
  if (isBackslashInterpreterToken(payload)) return true;
  const first = tokenize(payload)[0];
  if (first !== undefined && isBackslashInterpreterToken(first)) return true;
  // The payload can execute trailing argv through $0/$1/... substitution, so
  // the payload alone is not a faithful subject for dependency-install policy.
  if (rest.length > 0 && shellPayloadReferencesPositional(payload)) return true;
  // Trailing tokens after the -c payload: allow only plain positionals.
  // `-c`, redirects, backslashes, or flags mean the quoted body was split and
  // the truncated payload must not be trusted on its own under auto.
  if (rest.length > 0 && !rest.every(isSafeShellPositional)) return true;
  return false;
}

const SHELL_SEPARATE_VALUE_FLAGS = new Set(["-O", "-o"]);
const SHELL_COMMAND_OPTION_CLUSTER = /^-[A-Za-z]*c[A-Za-z]*$/;

function isClusteredShellCommandOption(token: string): boolean {
  return SHELL_COMMAND_OPTION_CLUSTER.test(token);
}

function shellWords(segment: string): string[] | undefined {
  const words: string[] = [];
  let word = "";
  let wordStarted = false;
  let quote: "'" | '"' | undefined;

  const push = (): void => {
    if (wordStarted) words.push(word);
    word = "";
    wordStarted = false;
  };

  for (let index = 0; index < segment.length; index++) {
    const char = segment[index] ?? "";
    if (quote === "'") {
      if (char === "'") quote = undefined;
      else word += char;
      continue;
    }
    if (quote === '"') {
      if (char === '"') {
        quote = undefined;
        continue;
      }
      if (char !== "\\") {
        word += char;
        continue;
      }
      const next = segment[index + 1];
      if (next === undefined) return undefined;
      if (next === "$" || next === "`" || next === '"' || next === "\\") {
        word += next;
        index++;
        continue;
      }
      if (next === "\n") {
        index++;
        continue;
      }
      word += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      wordStarted = true;
      continue;
    }
    if (char === "\\") {
      const next = segment[index + 1];
      if (next === undefined) return undefined;
      wordStarted = true;
      if (next !== "\n") word += next;
      index++;
      continue;
    }
    if (/\s/.test(char)) {
      push();
      continue;
    }
    wordStarted = true;
    word += char;
  }
  if (quote !== undefined) return undefined;
  push();
  return words;
}

function shellCommandPayload(
  segment: string,
  optionToken: string,
  optionOccurrence: number,
): string | undefined {
  const words = shellWords(segment);
  if (words === undefined) return undefined;
  let seen = 0;
  for (let index = 0; index < words.length; index++) {
    if (words[index] !== optionToken) continue;
    seen++;
    if (seen === optionOccurrence) return words[index + 1];
  }
  return undefined;
}

function peelShellDashC(
  tokens: string[],
  start: number,
  rawSegment: string,
  interpreter: string,
): PeelOutcome {
  let i = start;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === undefined) break;
    if (t === "--") {
      i++;
      break;
    }
    if (isInterpreterCommandSwitch(interpreter, t)) {
      const tokenPayload = tokens[i + 1];
      if (tokenPayload === undefined) return { kind: "opaque" };
      const optionOccurrence = tokens
        .slice(0, i + 1)
        .filter((token) => token === t).length;
      const payload =
        shellCommandPayload(rawSegment, t, optionOccurrence) ?? tokenPayload;
      if (isOpaquePayload(payload)) return { kind: "opaque" };
      const rest = tokens.slice(i + 2);
      if (nestedInterpreterPayloadOpaque(payload, rest))
        return { kind: "opaque" };
      return { kind: "inner", command: payload };
    }
    if (t.startsWith("--command=")) {
      const payload = t.slice("--command=".length);
      if (isOpaquePayload(payload)) return { kind: "opaque" };
      // Glued `--command=` has no separate rest tokens; still reject `\bash`.
      if (nestedInterpreterPayloadOpaque(payload, []))
        return { kind: "opaque" };
      return { kind: "inner", command: payload };
    }
    if (SHELL_SEPARATE_VALUE_FLAGS.has(t)) {
      i += 2;
      continue;
    }
    if (isClusteredShellCommandOption(t)) {
      const tokenPayload = tokens[i + 1];
      if (tokenPayload === undefined) return { kind: "opaque" };
      const optionOccurrence = tokens
        .slice(0, i + 1)
        .filter((token) => token === t).length;
      const payload =
        shellCommandPayload(rawSegment, t, optionOccurrence) ?? tokenPayload;
      if (isOpaquePayload(payload)) return { kind: "opaque" };
      const rest = tokens.slice(i + 2);
      if (nestedInterpreterPayloadOpaque(payload, rest))
        return { kind: "opaque" };
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
    const t = tokens[i];
    if (t === undefined) break;
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
      if (i < tokens.length) {
        const next = tokens[i];
        if (next !== undefined && !next.startsWith("-")) i++;
      }
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

// Env boolean short options (no value) that may cluster with -S: `-Si` (S takes
// the next argv) vs glued `-Sfind` (payload is the rest of the token).
const ENV_BOOL_SHORT = new Set(["i", "0", "v"]);

// Env flags that consume the next argv token as a value.
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

// Advance past one env value-taking flag (+ its separate value); null when
// `tokens[i]` is not such a flag.
function advancePastEnvValueFlag(tokens: string[], i: number): number | null {
  const t = tokens[i];
  if (t === undefined) return null;
  if (ENV_VALUE_FLAGS.has(t)) {
    let j = i + 1;
    if (j < tokens.length) {
      const next = tokens[j];
      if (next !== undefined && !next.startsWith("-")) j++;
    }
    return j;
  }
  if (isEnvValueEqualsFlag(t)) return i + 1;
  return null;
}

// env -S re-parses its payload: quotes and `\_` — inside or outside double
// quotes — act as argument separators, not literal text. Expand them so a
// later tokenize sees real argv boundaries. Only `\_` is modeled; the wider
// GNU escape set (\\, \", \n, \#) differs across implementations, so any
// other backslash makes the payload uninspectable (null → opaque → ask),
// never silently mis-parsed.
function expandEnvSplitSeparators(payload: string): string | null {
  let out = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < payload.length; i++) {
    const c = payload[i];
    if (c === undefined) break;
    if (quote === "'") {
      out += c;
      if (c === "'") quote = null;
      continue;
    }
    if (c === "\\") {
      const n = payload[i + 1];
      if (n === "_") {
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

// Re-parse the -S payload the way env does: expand `\_`, tokenize, then skip
// flags/assignments/end-of-options to land on the program hard-deny expects
// (`env -S -v find /` → `find /`, `env -S "rm '-rf' '/'"` → `rm -rf /`).
function peelEnvSplitUtility(command: string): PeelOutcome {
  const expanded = expandEnvSplitSeparators(command);
  if (expanded === null || isOpaquePayload(expanded)) return { kind: "opaque" };
  const tokens = tokenize(expanded);
  const parsed = skipEnvArguments(tokens, 0, []);
  if (parsed.terminal) return { kind: "opaque" };
  let i = parsed.executableIndex;
  if (i < 0) return { kind: "opaque" };
  while (i < tokens.length && (tokens[i] === "--" || tokens[i] === "-")) i++;
  if (i >= tokens.length) return { kind: "opaque" };
  const utility = rejoinTokens(tokens.slice(i));
  if (utility === null) return { kind: "opaque" };
  return { kind: "inner", command: utility };
}

// Fold trailing utility tokens into the -S payload (`env -S FOO=bar find /` →
// `FOO=bar find /`) so hard-deny sees the real program. An empty/opaque payload
// with a trailing utility still executes it (`env -S " " find /`), so keep the
// trailing tokens instead of opaque-dropping them.
function finishEnvSplitPayload(
  payload: string,
  tokens: string[],
  restStart: number,
): PeelOutcome {
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
    const trailing = rejoinTokens(rest);
    raw = trailing === null ? null : `${payload} ${trailing}`;
  }
  if (raw === null) return { kind: "opaque" };
  return peelEnvSplitUtility(raw);
}

// Peel env -S / --split-string payloads as their own shell subjects so
// `env -S "rm -rf /"` is blocked like the plain form. Uninspectable payloads
// are opaque, never silently dropped (forms handled per branch below).
function peelEnvSplitString(tokens: string[], start: number): PeelOutcome {
  let i = start;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === undefined) break;
    if (t === "--") return { kind: "none" };

    // --split-string=PAYLOAD
    if (t.startsWith("--split-string=")) {
      return finishEnvSplitPayload(
        t.slice("--split-string=".length),
        tokens,
        i + 1,
      );
    }
    // Glued long form without `=`: --split-string"find /" → one token.
    if (t.startsWith("--split-string") && t !== "--split-string") {
      return finishEnvSplitPayload(
        t.slice("--split-string".length),
        tokens,
        i + 1,
      );
    }
    // Separate-arg forms: -S PAYLOAD / --split-string PAYLOAD
    if (t === "-S" || t === "--split-string") {
      const payload = tokens[i + 1];
      if (payload === undefined) return { kind: "opaque" };
      return finishEnvSplitPayload(payload, tokens, i + 2);
    }

    // Short-option cluster containing S: glued payload after S (-Sfind), or S
    // at the end / before only boolean shorts (-iS, -Si, -Sv) taking the next
    // token as payload; a non-bool remainder (-Sifind) is a glued payload.
    if (
      t.startsWith("-") &&
      t !== "-" &&
      t.includes("S") &&
      !t.startsWith("--")
    ) {
      const sIdx = t.indexOf("S", 1);
      if (sIdx >= 1) {
        const afterS = t.slice(sIdx + 1);
        const onlyBoolAfter =
          afterS.length === 0 ||
          [...afterS].every((c) => ENV_BOOL_SHORT.has(c));
        if (onlyBoolAfter) {
          const payload = tokens[i + 1];
          if (payload === undefined) return { kind: "opaque" };
          return finishEnvSplitPayload(payload, tokens, i + 2);
        }
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

// Peel one layer of transparent prefix / shell -c / xargs / env -S from a
// single segment.
function peelOnce(segment: string): PeelOutcome {
  const tokens = tokenize(segment);
  const transparent = peelTransparentCommand(tokens);
  for (const wrapperIndex of transparent.wrapperIndexes) {
    if (programBasename(tokens[wrapperIndex] ?? "") !== "env") continue;
    const splitPeel = peelEnvSplitString(tokens, wrapperIndex + 1);
    if (splitPeel.kind !== "none") return splitPeel;
  }
  const i = transparent.executableIndex;
  const strippedPrefix = transparent.wrapperIndexes.length > 0;

  if (i >= tokens.length)
    return strippedPrefix ? { kind: "opaque" } : { kind: "none" };

  const current = tokens[i];
  if (current === undefined)
    return strippedPrefix ? { kind: "opaque" } : { kind: "none" };
  const prog = shellInterpreterName(current);
  if (SHELL_INTERPRETERS.has(prog)) {
    // A backtick or `$(` means tokenize() surfaces the -c payload as bare
    // tokens; peeling a truncated fragment would mislead, so treat as opaque.
    if (segment.includes("`") || segment.includes("$("))
      return { kind: "opaque" };
    const shellPeel = peelShellDashC(tokens, i + 1, segment, prog);
    if (shellPeel.kind !== "none") return shellPeel;
    // Interpreter without -c (e.g. `bash script.sh`) — not a peelable wrapper.
    return { kind: "none" };
  }
  if (prog === "xargs") return peelXargs(tokens, i + 1);

  // Prefix-only peel: `env FOO=1 rm -rf build` → `FOO=1 rm -rf build`, keeping
  // the NAME=value tokens for the auto-mode ask.
  if (strippedPrefix) {
    const innerTokens =
      transparent.assignmentValues.length === 0
        ? tokens.slice(i)
        : [
            ...tokens.slice(0, i).filter((t) => ENV_ASSIGNMENT.test(t)),
            ...tokens.slice(i),
          ];
    const command = rejoinTokens(innerTokens);
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

// Expand a command into subjects for the auto-shell policy, hard-deny, and
// recursive-rm checks: peel nested interpreters, xargs tails, env -S payloads,
// busybox applets, and transparent prefixes (env/nice/timeout/…), recursing
// with a depth cap so nested wrappers cannot hide a dangerous payload. Chain
// splitting is quote-aware so a pipe inside `bash -c '…|…'` is not an outer
// boundary; end-of-options markers are dropped so hard-deny sees the real
// program (`env -S "-- find /"`), assignments before them preserved.
function dropLeadingEndOfOptionsTokens(tokens: string[]): string[] {
  let i = 0;
  i = skipMatching(tokens, i, (t) => ENV_ASSIGNMENT.test(t));
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

export function expandShellSubjects(
  command: string,
  maxDepth = MAX_PEEL_DEPTH,
): ShellExpandResult {
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
      // Depth exhausted while this subject may still be a wrapper. Mark opaque
      // so auto cannot accept a leaf we never fully peeled.
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
  i = skipMatching(tokens, i, (t) => ENV_ASSIGNMENT.test(t));
  while (i < tokens.length && (tokens[i] === "--" || tokens[i] === "-")) i++;
  i = skipMatching(tokens, i, (t) => RM_WRAPPER.test(t));
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
  return subjects.some((subject) =>
    subject.split(CHAIN).some(segmentHasRecursiveRm),
  );
}

function isCatastrophicRm(segment: string): boolean {
  const args = segmentRmArgs(segment);
  if (args === undefined) return false;
  if (!args.some((a) => RECURSIVE_FLAG.test(a))) return false;
  const targets = args.filter((a) => !a.startsWith("-"));
  // No target, or a dangerous root → catastrophic.
  return targets.length === 0 || targets.some(isDangerousTarget);
}

// Blank quoted interiors so CMD does not treat `;` inside `-m` text as a new
// command. Double-quoted `$(...)`/backticks stay visible — their contents are
// real commands.
function skipQuotedSpans(command: string): string {
  let out = "";
  let quote: '"' | "'" | undefined;
  // Quote to restore when each `$(...)` closes. Extra `(` inside a substitution
  // is a "paren" frame so its `)` does not restore the quote.
  const substStack: ('"' | "'" | undefined | "paren")[] = [];
  let inBacktick = false;

  const enterSubst = (): void => {
    substStack.push(quote);
    quote = undefined;
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === undefined) break;
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
// pass a pre-normalized form so `/usr/bin/sudo` still matches command position.
function isDestructiveExpanded(command: string): boolean {
  const { subjects } = expandShellSubjects(command);
  return subjects.some((subject) => {
    if (
      BLOCKED_PATTERNS.some((pattern) => pattern.test(skipQuotedSpans(subject)))
    )
      return true;
    if (
      BLOCKED_QUOTED_PAYLOAD_PATTERNS.some((pattern) => pattern.test(subject))
    )
      return true;
    return subject.split(CHAIN).some(isCatastrophicRm);
  });
}

// Expand the raw command so `env -S "…"` stays peelable — normalizing first
// would strip `env` and hide the payload. Also expand the normalized form so
// `/usr/bin/sudo` → `sudo` still matches.
function isDestructive(command: string): boolean {
  if (isDestructiveExpanded(command)) return true;
  const normalized = normalizeCommand(command);
  return normalized !== command && isDestructiveExpanded(normalized);
}

function isOpenEndedSearch(command: string): boolean {
  return OPEN_ENDED_SEARCH_PATTERNS.some((pattern) => pattern.test(command));
}

// Scan expanded subjects (each normalized) so wrappers cannot hide the real
// program in a quoted payload (`env -S "find /"`); path-qualified binaries
// still match command position.
function subjectsHit(
  command: string,
  pred: (normalizedSubject: string) => boolean,
): boolean {
  const { subjects } = expandShellSubjects(command);
  if (subjects.some((subject) => pred(normalizeCommand(subject)))) return true;
  const normalized = normalizeCommand(command);
  if (normalized === command) return false;
  const { subjects: normalizedSubjects } = expandShellSubjects(normalized);
  return normalizedSubjects.some((subject) => pred(normalizeCommand(subject)));
}

function openEndedSearchReason(command: string): string | undefined {
  if (!subjectsHit(command, isOpenEndedSearch)) return undefined;
  // The patterns catch three shapes only; the message carries the general
  // prohibition so fd, ls -R, and scripted walks are not used instead.
  return (
    `Open-ended shell search blocked — shell find, head-position rg, and recursive ` +
    `grep -r can walk huge trees and OOM the host. Prefer the bounded grep/glob ` +
    `tools (timeout + output caps). Do not substitute another unbounded walk ` +
    `(fd, ls -R, scripted os.walk). Command: ${command}`
  );
}

// Segments are judged in isolation for destructive/open-ended rules; stdin and
// never-terminating checks apply across expanded subjects so wrapper payloads
// (env -S, bash -c, …) stay visible.
export function runShellAuthzSegmentBlockReason(
  segment: string,
): string | undefined {
  const trimmed = segment.trim();
  if (trimmed.length === 0) return undefined;
  // Pass the raw segment: isDestructive expands both raw and normalized forms.
  if (isDestructive(trimmed)) {
    return `Destructive command blocked by policy: ${trimmed}`;
  }
  return openEndedSearchReason(trimmed);
}

export interface RunShellAuthzBlock {
  kind: "destructive" | "open-ended" | "never-terminating" | "stdin";
  reason: string;
}

export function runShellAuthzBlock(
  command: string,
): RunShellAuthzBlock | undefined {
  // All four checks scan expanded subjects so env -S / shell -c payloads
  // cannot hide a blocked program.
  if (isDestructive(command)) {
    return {
      kind: "destructive",
      reason: `Destructive command blocked by policy: ${command}`,
    };
  }
  const openEnded = openEndedSearchReason(command);
  if (openEnded !== undefined) return { kind: "open-ended", reason: openEnded };
  if (subjectsHit(command, isNeverTerminating)) {
    return {
      kind: "never-terminating",
      reason:
        `Never-terminating command blocked — follow/pager/watch commands (tail -f, watch, ` +
        `top, less, more) never exit under the agent and hang the run. Use a bounded ` +
        `alternative (e.g. tail -n 50 file). Command: ${command}`,
    };
  }
  if (subjectsHit(command, blocksOnStdin)) {
    return {
      kind: "stdin",
      reason:
        `Command reads standard input with no file operand and would hang, since stdin is ` +
        `not connected. Pass a file operand (e.g. tail -n 50 file.log, grep pattern file). ` +
        `Command: ${command}`,
    };
  }
  return undefined;
}

export function runShellAuthzBlockReason(command: string): string | undefined {
  return runShellAuthzBlock(command)?.reason;
}
