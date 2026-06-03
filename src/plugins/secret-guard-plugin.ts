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

// Deny any tool call whose path argument points at a secret file. Runs on the
// resolved path (after the path-escape plugin), so absolute and relative forms
// are both covered. run_shell is not path-keyed and is gated separately by the
// permission plugin.
export function secretGuardPlugin(): ToolPlugin {
  return {
    middleware: (next) => async (call, signal) => {
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
