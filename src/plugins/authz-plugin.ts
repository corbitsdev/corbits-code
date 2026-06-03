import type { ToolPlugin } from "@intx/tools-posix";

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

function isBlocked(command: string): boolean {
  if (BLOCKED_PATTERNS.some((pattern) => pattern.test(command))) return true;
  return command.split(CHAIN).some(isCatastrophicRm);
}

export function authzPlugin(): ToolPlugin {
  return {
    middleware: (next) => async (call, signal) => {
      if (call.name === "run_shell") {
        const command = String(call.arguments.command ?? "");
        if (isBlocked(command)) {
          return {
            callId: call.id,
            content: `Destructive command blocked by policy: ${command}`,
            isError: true,
          };
        }
      }
      return next(call, signal);
    },
  };
}
