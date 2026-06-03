import type { ToolPlugin } from "@intx/tools-posix";

// A command-position anchor: start of the command, or immediately after a shell
// separator (newline, ; & |) or subshell open. This keeps a word like "exec" or
// "format" from matching when it merely appears inside a URL, comment, or string
// argument — only the program actually being invoked is matched.
const CMD = String.raw`(?:^|[\n;&|(`+"`"+String.raw`]\s*)`;

const cmd = (name: string): RegExp => new RegExp(`${CMD}${name}\\b`);

// Redirecting to /dev/null, /dev/stdout, /dev/stderr, /dev/tty and /dev/fd/* is
// routine and harmless; only redirects to real device nodes (e.g. /dev/sda) are
// destructive. The negative lookahead exempts the safe pseudo-devices.
const SAFE_DEV = String.raw`(?!(?:null|stdout|stderr|stdin|tty|fd/)\b)`;

const BLOCKED_PATTERNS: RegExp[] = [
  // Recursive force-remove anywhere in the command.
  /rm\s+-rf\s+/,
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
  // Piping a network download straight into a shell.
  /(curl|wget|fetch)\b.*\|\s*(bash|sh|zsh)\b/,
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

export function authzPlugin(): ToolPlugin {
  return {
    middleware: (next) => async (call, signal) => {
      if (call.name === "run_shell") {
        const command = String(call.arguments.command ?? "");
        for (const pattern of BLOCKED_PATTERNS) {
          if (pattern.test(command)) {
            return {
              callId: call.id,
              content: `Destructive command blocked by policy: ${command}`,
              isError: true,
            };
          }
        }
      }
      return next(call, signal);
    },
  };
}
