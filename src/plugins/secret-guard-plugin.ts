import { isAbsolute } from "node:path";
import type { ToolPlugin } from "@intx/tools-posix";
import { realpathNearestOr, UNRESOLVABLE } from "../permission/path-restriction.js";
import { looksLikePath } from "./path-escape-plugin.js";

// Files that hold secrets and must never be read or written by path-keyed tools
// (read_file, write_file, …), even inside the working directory. Content from a
// direct file tool lands in the model context; that is a hard deny, not an ask.
// Shell commands that merely *reference* these paths are different — see
// commandReferencesSensitivePath — and are gated as ask (permission gate +
// auto-shell policy) so the operator can approve legitimate uses like
// `bun --env-file=.env run …`.
const SENSITIVE_PATTERNS: RegExp[] = [
  // .env, .env.local, .env.production — but not template files like
  // .env.example / .env.sample / .env.template / .env.dist.
  /(^|\/)\.env($|\.(?!example|sample|template|dist))/,
  /(^|\/)\.dev\.vars$/, // Cloudflare Workers secrets
  /(^|\/)\.npmrc$/,
  /(^|\/)\.netrc$/,
  /(^|\/)\.git-credentials$/,
  // Corbits Code's own settings hold provider credentials. Covers both the
  // global (~/.corbits/settings.json) and per-repo (.corbits/settings.json)
  // locations.
  /(^|\/)\.corbits\/settings\.json$/,
  /(^|\/)\.pgpass$/,
  /(^|\/)\.htpasswd$/,
  /(^|\/)\.ssh\//,
  /(^|\/)\.aws\/credentials$/,
  /(^|\/)\.aws\/config$/,
  /(^|\/)gcloud\/application_default_credentials\.json$/,
  /(^|\/)\.kube\/config$/,
  /(^|\/)\.docker\/config\.json$/,
  /(^|\/)gh\/hosts\.ya?ml$/,
  /(^|\/)\.gnupg\//,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/,
  /\.pem$/,
  /\.p12$/,
  /\.pfx$/,
  /\.key$/,
  /\.p8$/,
  /\.jks$/,
  /\.keystore$/,
  /\.ppk$/,
  /\.tfstate(\.backup)?$/,
  // GCP service-account key files, e.g. service-account.json, my-service_account-key.json.
  /service[-_]account[^/]*\.json$/,
  // Shell history files. Operators paste secrets into interactive shells
  // constantly (export TOKEN=…, curl -H "Authorization: …", psql with an
  // inline password); the history file is a durable log of that. Previously
  // the workspace boundary kept ~/.bash_history etc. out of reach even though
  // this list didn't cover it. Now that @mentions can reach outside the
  // workspace, the list has to carry that weight itself.
  /(^|\/)\.bash_history$/,
  /(^|\/)\.zsh_history$/,
  /(^|\/)\.sh_history$/,
  /(^|\/)fish_history$/,
  // System account and privilege files. Not "secrets" in the API-key sense,
  // but /etc/shadow is password hashes and /etc/sudoers is the privilege
  // escalation policy — both are direct system-compromise material.
  /(^|\/)etc\/shadow$/,
  /(^|\/)etc\/sudoers(\.d\/.*)?$/,
  // macOS Keychain databases — every saved Wi-Fi password, website login, and
  // app credential on the machine lives here.
  /(^|\/)Library\/Keychains\//,
  /\.keychain(-db)?$/,
  // Browser cookie jars and saved-login stores. A cookie store alone is often
  // enough to hijack an authenticated session without ever seeing a password.
  /(^|\/)Cookies$/, // Chrome/Chromium/Edge profile cookie DB (no extension)
  /(^|\/)Login Data$/, // Chrome/Chromium/Edge saved passwords DB (no extension)
  /(^|\/)cookies\.sqlite$/, // Firefox
  /(^|\/)logins\.json$/, // Firefox saved logins
  /(^|\/)key4\.db$/, // Firefox's key store for the above
  // Broaden the existing single-file gcloud pattern to the whole config
  // directory — legacy_credentials/, credentials.db, and access_tokens.db
  // all live alongside application_default_credentials.json there.
  /(^|\/)\.config\/gcloud\//,
  // Azure CLI's credential cache — the equivalent of ~/.aws/credentials.
  /(^|\/)\.azure\/(accessTokens|azureProfile)\.json$/,
];

export function isSensitivePath(value: string): boolean {
  const normalized = value.replace(/\\/g, "/");
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(normalized));
}

// Secret-guard floor (CL-6971): match the lexical path AND its realpath. Under
// yolo, pathEscape absolutizes outside paths without resolving symlinks, so an
// innocuous name (config.txt → .env, or cache/ → ~/.aws) would otherwise pass
// the denylist. realpathNearestOr also covers write targets that don't exist
// yet when a parent component is a symlink into a sensitive directory.
// Absolute-only for the realpath leg — pathEscape absolutizes in the live
// stack; relative unit-test args still match on the lexical form.
export function isSensitivePathResolved(value: string): boolean {
  if (isSensitivePath(value)) return true;
  if (!isAbsolute(value)) return false;
  const real = realpathNearestOr(value);
  return real !== UNRESOLVABLE && isSensitivePath(real);
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
//
// Callers (auto-shell policy, classify) use this to force an operator ask rather
// than auto-allowing. The secret-guard plugin itself no longer hard-denies shell
// commands: an explicit approval (or --dangerously-skip-permissions) lets a
// command that references a secret path run, so workflows like
// `bun --env-file=.env.staging run …` can proceed when the operator says yes.
// Path-keyed tools stay hard-denied below.
//
// RESIDUAL THREAT MODEL: shell detection is best-effort. Token matching defeats
// quoting/escaping and the common env-assignment and redirection forms, but not
// dynamic construction of a path the matcher never sees as one token — e.g.
// indirection through an unrelated variable (`F=.en; cat ${F}v`), character-by-
// character assembly (`printf`), or reading via an interpreter that builds the
// name at runtime. Perfect shell sandboxing is out of scope; the goal is to
// force a prompt for the trivial, single-token references that make exfiltration
// easy. Tool-result secret scrub still redacts credential-shaped output.
export function commandReferencesSensitivePath(command: string): string | undefined {
  for (const token of shellPathTokens(command)) {
    if (isSensitivePath(token)) return token;
  }
  return undefined;
}

// Hard-deny path-keyed tool calls that would put a secret file's contents into
// (or write them from) the model context. Shell commands that merely mention a
// secret path are not blocked here — they require operator approval via the
// permission gate (and auto-shell policy in auto mode).
//
// Path-arg hard deny runs before the permission plugin, so it holds even under
// --dangerously-skip-permissions. Symlink resolution is part of that floor
// (CL-6971): yolo must not let an innocuous link name defeat the denylist.
export function secretGuardPlugin(): ToolPlugin {
  return {
    middleware: (next) => async (call, signal) => {
      for (const [key, value] of Object.entries(call.arguments)) {
        if (typeof value === "string" && looksLikePath(key) && isSensitivePathResolved(value)) {
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
