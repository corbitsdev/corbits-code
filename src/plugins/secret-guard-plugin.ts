import type { ToolPlugin } from "@intx/tools-posix";
import { looksLikePath } from "./path-escape-plugin.js";

// Files that hold secrets and must never be read or written by the agent, even
// inside the working directory. This is a hard deny (not an ask): the operator
// should not be one keystroke away from leaking credentials to the model.
const SENSITIVE_PATTERNS: RegExp[] = [
  // .env, .env.local, .env.production — but not template files like
  // .env.example / .env.sample / .env.template / .env.dist.
  /(^|\/)\.env($|\.(?!example|sample|template|dist))/,
  /(^|\/)\.dev\.vars$/, // Cloudflare Workers secrets
  /(^|\/)\.npmrc$/,
  /(^|\/)\.netrc$/,
  /(^|\/)\.git-credentials$/,
  // Intercode's own settings hold provider credentials. Covers both the
  // global (~/.intercode/settings.json) and per-repo (.intercode/settings.json)
  // locations.
  /(^|\/)\.intercode\/settings\.json$/,
  /(^|\/)\.pgpass$/,
  /(^|\/)\.htpasswd$/,
  /(^|\/)\.ssh\//,
  /(^|\/)\.aws\/credentials$/,
  /(^|\/)\.gnupg\//,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/,
  /\.pem$/,
  /\.p12$/,
  /\.pfx$/,
];

export function isSensitivePath(value: string): boolean {
  const normalized = value.replace(/\\/g, "/");
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(normalized));
}

// Break a shell command into the bare path-like tokens it references so each can
// be matched against the secret-file denylist. Quote, backtick and backslash
// characters are stripped first so split obfuscations (`.e''nv`, `'.env'`,
// `\.env`) collapse back to the real path; the command is then split on
// whitespace, shell separators, redirections, parens and `=` so that
// env-assignment and redirection forms (`FILE=.env cat $FILE`, `dd of=.env`)
// expose the path token too.
function shellPathTokens(command: string): string[] {
  const cleaned = command.replace(/['"`\\]/g, "");
  return cleaned.split(/[\s;&|()<>=]+/).filter((token) => token.length > 0);
}

// Return the first token in a shell command that names a secret file, or
// undefined if none do. Matching on the file token (not the utility) means any
// read tool is covered uniformly — `cat`, `less`, `xxd`, `base64`, `grep`, a
// custom script — without enumerating them.
export function commandReferencesSensitivePath(command: string): string | undefined {
  for (const token of shellPathTokens(command)) {
    if (isSensitivePath(token)) return token;
  }
  return undefined;
}

// Deny any tool call that would expose a secret file. Two surfaces are guarded:
// path-keyed tool arguments (read_file, write_file, ...) on the resolved path
// after the path-escape plugin, and run_shell command strings, which are
// tokenised and matched so `cat .env` or `cat ~/.intercode/settings.json` are
// blocked the same as a direct read.
//
// This is a hard deny that runs before the permission plugin, so it holds even
// under --dangerously-skip-permissions.
//
// RESIDUAL THREAT MODEL: shell containment is not airtight. Token matching
// defeats quoting/escaping and the common env-assignment and redirection forms,
// but not dynamic construction of a path the matcher never sees as one token —
// e.g. indirection through an unrelated variable (`F=.en; cat ${F}v`),
// character-by-character assembly (`printf`), or reading via an interpreter that
// builds the name at runtime. Perfect shell sandboxing is out of scope here; the
// goal is to close the trivial, single-token reads that make exfiltration easy.
export function secretGuardPlugin(): ToolPlugin {
  return {
    middleware: (next) => async (call, signal) => {
      // Only act on a real command string. A missing or non-string argument is
      // not coerced to "" — that would silently skip the scan (fail-open); the
      // shell tool's own argument validation rejects malformed input downstream.
      if (call.name === "run_shell" && typeof call.arguments.command === "string") {
        const hit = commandReferencesSensitivePath(call.arguments.command);
        if (hit !== undefined) {
          return {
            callId: call.id,
            content: `Access to sensitive file blocked by policy: ${hit}`,
            isError: true,
          };
        }
      }
      for (const [key, value] of Object.entries(call.arguments)) {
        if (typeof value === "string" && looksLikePath(key) && isSensitivePath(value)) {
          return {
            callId: call.id,
            content: `Access to sensitive file blocked by policy: ${value}`,
            isError: true,
          };
        }
      }
      return next(call, signal);
    },
  };
}
