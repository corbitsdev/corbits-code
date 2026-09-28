import { lstatSync } from "node:fs";
import { homedir } from "node:os";
import {
  isAbsolute,
  join as joinPath,
  resolve as resolvePath,
} from "node:path";
import type { ToolPlugin } from "@intx/tools-posix";
import {
  realpathNearestOr,
  UNRESOLVABLE,
} from "../permission/path-restriction.js";
import { buildCredentialPatterns } from "../auth/credential-surface.js";
import { productMutationPaths } from "../agent/product-mutation-tools.js";
import {
  inspectLiteralPathArgumentCommands,
  nativeShellDialect,
  type ShellDialect,
} from "../shell/literal-path-arguments.js";
import {
  FILE_OPTION_GRAMMARS,
  inspectShortOptions,
  isLongFileOption,
} from "../shell/file-option-grammar.js";
import { expandShellSubjects } from "../shell/run-shell-authz.js";
import { peelTransparentCommand } from "../shell/transparent-command.js";
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
  /(^|\/)\.(envrc|flaskenv)$/,
  /(^|\/)\.dev\.vars$/, // Cloudflare Workers secrets
  /(^|\/)\.npmrc$/,
  /(^|\/)\.netrc$/,
  /(^|\/)\.git-credentials$/,
  // Corbits Code's own settings hold provider credentials. Covers both the
  // global (~/.corbits/settings.json) and per-repo (.corbits/settings.json)
  // locations. The grant store next to them is not a credential file, but a
  // write becomes a standing auto-approval on the next run — same path deny.
  /(^|\/)\.corbits\/settings\.json$/,
  /(^|\/)\.corbits\/permissions\.json$/,
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
  // The product's own OAuth token stores and credential sidecars come from the
  // auth-owned registry, not literals here, so a new store cannot drift off
  // the denylist. settings.json/permissions.json keep their hand-written
  // patterns above; the registry only adds their lock/temp sidecars.
  ...buildCredentialPatterns(),
];

export function isSensitivePath(
  value: string,
  dialect: ShellDialect = nativeShellDialect(process.platform),
): boolean {
  const slashNormalized = dialect === "cmd" ? value.replace(/\\/g, "/") : value;
  const normalized =
    dialect === "cmd" ? normalizeWin32Path(slashNormalized) : slashNormalized;
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function normalizeWin32Path(value: string): string {
  const withoutDefaultStream = value.replace(/::\$DATA$/i, "");
  const ordinary = !/^\/\/[?.]\//.test(withoutDefaultStream);
  const aliasNormalized = ordinary
    ? withoutDefaultStream
        .split("/")
        .map((component) => component.replace(/[ .]+$/, ""))
        .join("/")
    : withoutDefaultStream;
  return aliasNormalized.replace(/^([A-Za-z]:)(?!\/)/, "$1/").toLowerCase();
}

// Secret-guard floor (CL-6971): match the lexical path AND its realpath. Under
// yolo, pathEscape absolutizes outside paths without resolving symlinks, so an
// innocuous name (config.txt → .env, or cache/ → ~/.aws) would otherwise pass
// the denylist. realpathNearestOr also covers write targets that don't exist
// yet when a parent component is a symlink into a sensitive directory.
// Absolute-only for the realpath leg — pathEscape absolutizes in the live
// stack; relative unit-test args still match on the lexical form.
export function isSensitivePathResolved(
  value: string,
  dialect: ShellDialect = nativeShellDialect(process.platform),
): boolean {
  if (isSensitivePath(value, dialect)) return true;
  if (!isAbsolute(value)) return false;
  const real = realpathNearestOr(value);
  return real !== UNRESOLVABLE && isSensitivePath(real, dialect);
}

// CL-9386: the active --config path is an operator-chosen settings source that
// can live anywhere — including inside the workspace, where the static
// .corbits/settings.json patterns above never match — while carrying standing
// skip-permissions (/yolo persists the active settings source). Static
// patterns cannot cover an arbitrary runtime path, so entry points thread the
// resolved active path in here and path-keyed tools hard-deny it exactly like
// the default settings file: reads and writes, lexical and realpath legs,
// even under --dangerously-skip-permissions.
export interface SecretGuardPluginOptions {
  extraDeniedPaths?: readonly string[];
}

// Exact-path matcher over runtime-denied paths. Mirrors
// isSensitivePathResolved's two legs: the lexical form (covers a value passed
// as the identical string, including a target that does not exist yet) and
// the realpath form (covers access through a symlink name, the CL-6971
// floor). Relative entries match lexically only — production entries are
// absolute (--config is resolved at parse; globalSettingsPath() is absolute).
export function createExtraDeniedPathMatcher(
  extraDeniedPaths: readonly string[],
): (value: string) => boolean {
  const lexical = new Set<string>();
  const resolved = new Set<string>();
  for (const entry of extraDeniedPaths) {
    const normalized = entry.replace(/\\/g, "/");
    lexical.add(normalized);
    if (isAbsolute(entry)) {
      const absolute = resolvePath(entry).replace(/\\/g, "/");
      lexical.add(absolute);
      const real = realpathNearestOr(entry);
      if (real !== UNRESOLVABLE) resolved.add(real.replace(/\\/g, "/"));
    }
  }
  if (lexical.size === 0) return () => false;
  return (value: string) => {
    if (lexical.has(value.replace(/\\/g, "/"))) return true;
    if (!isAbsolute(value)) return false;
    const real = realpathNearestOr(value);
    return real !== UNRESOLVABLE && resolved.has(real.replace(/\\/g, "/"));
  };
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
// quoting/escaping, the common env-assignment and redirection forms, and direct
// variable references — `$VAR`, `${VAR}`, `${VAR:-default}`, and `~` expand
// against process.env before matching, so `cat $HOME/.env` prompts — but not
// dynamic construction of a path the matcher never sees as one token — e.g.
// indirection through an unrelated variable (`F=.en; cat ${F}v`), character-by-
// character assembly (`printf`), or reading via an interpreter that builds the
// name at runtime. Unexpanded globs are narrowed, not closed: `?`/`[` prompt
// only on file-operand-shaped tokens — URLs (`…?q=…`), regex operands
// (`grep -E colou?r`), and bare `[`/`]` test syntax are exempt, and a pattern
// with no `.`, `/`, or `\` cannot match a dotfile secret anyway — while `*`
// prompts only when dotfile-rooted (`.*`, `.env*`) or lexically sensitive
// (`*.pem`). What stays allowed, and why: bare `*` / `*.txt` cannot match a
// leading dot and would fire on every benign `cat *`; non-dotfile-rooted `*`
// (`.config/*`) and dotless-secret `?`/`[` forms (`id_rs?`) are already
// reachable through bare `*`, so closing them alone buys nothing. Perfect
// shell sandboxing is out of scope; the goal is to force a prompt for the
// trivial, single-token references that make exfiltration easy. Tool-result secret scrub still redacts credential-shaped output.
// Programs that only print directory names / metadata — listing a name never
// dumps file contents. Single owner for this set: the resolve-leg skip below
// and classify.ts's pure-listing exemption both read it, so a new names-only
// program cannot drift into one list without the other.
export const PURE_DIRECTORY_LISTING_PROGRAMS = new Set(["ls", "tree"]);

// Worth spending a realpath on: shaped like a path the shell could open
// (a slash, an extension dot, or absolute), not a flag, glob, or fd
// number — those can never name a file the shell opens, so they skip the
// stat and the hot auto-allow path stays syscall-free for them. Shell
// variables reach here already expanded (see expandShellToken), so there is
// no `$` exemption: an unexpandable token fails closed before this filter.
// `*` globs are skipped here for a different reason: the matcher only sees the
// unexpanded pattern, so `cat *.txt` cannot resolve without running the
// shell — but a glob CAN expand into a symlink at runtime, which stays a
// stated residual (see the threat model above), not something this filter
// disproves. The one exception lives in isSensitiveShellToken: dotfile-rooted
// `*` patterns (`.*`, `.env*`) deterministically match `.env`, so they fail
// closed to a prompt there. `?` and `[…]` patterns are likewise not skipped:
// `cat .en?` reads `.env` while the matcher only ever sees the pattern, so
// file-operand-shaped ones fail closed to a prompt in isSensitiveShellToken
// instead of resolving here (URLs, regex operands, and bare `[`/`]` test
// syntax are exempt — see that check).
function isPathLikeShellToken(token: string): boolean {
  if (token.startsWith("-") || token.includes("*") || token.includes("`"))
    return false;
  return (
    isAbsolute(token) ||
    token.includes("/") ||
    token.includes("\\") ||
    token.includes(".")
  );
}

// `~` / `~/…` mean the operator's home to the shell, not a literal
// cwd-relative name — expand before both matcher legs so `cat ~/notes`
// resolves the home symlink instead of a (usually missing) cwd child.
// classify.ts's outside-workspace rule would ask anyway; the expansion fixes
// the *reason* (sensitive-path) rather than relying on that coincidence.
export function expandHome(token: string): string {
  if (token === "~") return homedir();
  if (token.startsWith("~/")) return joinPath(homedir(), token.slice(2));
  return token;
}

// Expand a shell token's `~` and `$` references against process.env only —
// never shells out. Handles `$VAR`, `${VAR}`, `${VAR:-default}` /
// `${VAR-default}`, `${VAR:=default}`, and `${VAR:+alt}` / `${VAR+alt}`,
// plus a single layer of surrounding quotes; `\$` is a
// literal dollar and unset variables expand to empty. A `$` followed by any
// other character (or at end of token) is a literal dollar, matching shell
// behavior for `$.`, `$"`, and friends. A backtick or `$(` the tokenizer left
// whole comes from single quotes, where the shell never substitutes — it is
// matched as literal text. Returns expandable=false only when the token
// cannot be resolved statically: a malformed `${…}` or an unsupported
// operator (`:?`, `#`, `%`, `/`). Callers fail closed on
// expandable=false: the shell would compute the value at runtime, so the
// matcher must assume the worst.
export interface ExpandedShellToken {
  expanded: string;
  expandable: boolean;
}

const SHELL_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*/;
const SHELL_BRACED_VAR =
  /^([A-Za-z_][A-Za-z0-9_]*)(:=(.*)|:-(.*)|-(.*)|:\+(.*)|\+(.*)|)$/s;

export function expandShellToken(
  token: string,
  dialect: ShellDialect = "posix",
): ExpandedShellToken {
  let text = token;
  if (
    text.length >= 2 &&
    ((text.startsWith('"') && text.endsWith('"')) ||
      (text.startsWith("'") && text.endsWith("'")))
  ) {
    text = text.slice(1, -1);
  }
  if (text.includes("`") || text.includes("$(")) {
    return { expanded: text, expandable: true };
  }
  if (text === "~") text = homedir();
  else if (text.startsWith("~/")) text = joinPath(homedir(), text.slice(2));
  // In cmd `$` is literal (`type .flaskenv::$DATA` names the default ADS
  // stream — there is no `$VAR` expansion, only `%VAR%`), so expanding would
  // corrupt the token before matching. Only posix-style dialects expand.
  if (dialect === "cmd") return { expanded: text, expandable: true };
  let expanded = "";
  for (let i = 0; i < text.length;) {
    const char = text[i] ?? "";
    if (char === "\\" && text[i + 1] === "$") {
      expanded += "$";
      i += 2;
      continue;
    }
    if (char !== "$") {
      expanded += char;
      i += 1;
      continue;
    }
    const rest = text.slice(i + 1);
    if (rest.startsWith("{")) {
      const close = text.indexOf("}", i + 2);
      if (close === -1) return { expanded: token, expandable: false };
      const match = SHELL_BRACED_VAR.exec(text.slice(i + 2, close));
      if (match === null) return { expanded: token, expandable: false };
      const value = process.env[match[1] ?? ""];
      const fallback = match[3] ?? match[4] ?? match[5];
      const alternate = match[6] ?? match[7];
      if (fallback === undefined && alternate === undefined) {
        expanded += value ?? "";
      } else if (
        fallback !== undefined &&
        (value === undefined || (match[5] === undefined && value === ""))
      ) {
        const inner = expandShellToken(fallback, dialect);
        if (!inner.expandable) return { expanded: token, expandable: false };
        expanded += inner.expanded;
      } else if (
        alternate !== undefined &&
        value !== undefined &&
        (match[6] === undefined || value !== "")
      ) {
        const inner = expandShellToken(alternate, dialect);
        if (!inner.expandable) return { expanded: token, expandable: false };
        expanded += inner.expanded;
      } else if (fallback !== undefined) {
        expanded += value;
      }
      // Otherwise the alternate form expands to empty — append nothing.
      i = close + 1;
      continue;
    }
    const name = SHELL_VAR_NAME.exec(rest)?.[0];
    if (name !== undefined) {
      expanded += process.env[name] ?? "";
      i += 1 + name.length;
      continue;
    }
    expanded += "$";
    i += 1;
  }
  return { expanded, expandable: true };
}

// A bare token the shell could open as a cwd-relative file: not a flag,
// glob, or command substitution — same exclusions as the path-like
// filter, minus the dot/slash shape requirement, so extensionless names
// (`notes`, or `notes` split out of `--file=notes` / `cat -n notes`) still
// get an existence probe below. Shell variables reach here already expanded,
// so there is no `$` exemption (see expandShellToken).
function isBareProbeCandidate(token: string): boolean {
  return (
    token.length > 0 &&
    !token.startsWith("-") &&
    !token.includes("*") &&
    !token.includes("`")
  );
}

// Final path segment starts with a literal dot and holds a `*`: `.*`,
// `.env*`, `sub/.*`. Bare `*` / `*.txt` never match a leading dot under
// default shell semantics, so they stay out — as does anything rooted outside
// a dotfile name (`.config/*`).
function isDotfileRootedGlob(token: string): boolean {
  if (!token.includes("*")) return false;
  const segment = token.split(/[/\\]/).at(-1) ?? token;
  return segment.startsWith(".") && segment.includes("*");
}

// `file:` URLs are local reads (`curl file:///home/u/.env` opens `.env`),
// so only non-file URL schemes receive the `?`/`[` fatigue exemption below.
// Scheme matching is case-insensitive and covers `file:`, `file://`, and
// `FILE://` variants.
function isFileSchemeURL(token: string): boolean {
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:/.exec(token)?.[0];
  return scheme?.toLowerCase() === "file:";
}

type FileURLPaths =
  | { localPaths: readonly string[]; failClosed: false }
  | { failClosed: true };

type BracePart = string | readonly BraceSequence[];
type BraceSequence = readonly BracePart[];

const MAX_BRACE_INPUT_LENGTH = 4_096;
const MAX_BRACE_OUTPUT_LENGTH = 4_096;
const MAX_BRACE_EXPANSIONS = 64;
const MAX_BRACE_DEPTH = 16;
const FILE_SCHEME = "file:";

interface BraceParseResult {
  sequence?: BraceSequence;
}

function parseBraceSequence(token: string): BraceParseResult {
  if (token.length > MAX_BRACE_INPUT_LENGTH) return {};
  let index = 0;

  function parseSequence(
    depth: number,
    stopAtAlternative: boolean,
  ): { parts: BracePart[]; separator?: "," | "}" } | undefined {
    if (depth > MAX_BRACE_DEPTH) return undefined;
    const parts: BracePart[] = [];
    let literal = "";
    const flushLiteral = () => {
      if (literal.length > 0) parts.push(literal);
      literal = "";
    };

    while (index < token.length) {
      const char = token[index] ?? "";
      if (stopAtAlternative && (char === "," || char === "}")) {
        flushLiteral();
        index++;
        return { parts, separator: char };
      }
      if (char === "}") return undefined;
      if (char !== "{") {
        literal += char;
        index++;
        continue;
      }

      flushLiteral();
      index++;
      const alternatives: BraceSequence[] = [];
      let hasComma = false;
      while (true) {
        const alternative = parseSequence(depth + 1, true);
        if (alternative === undefined) return undefined;
        alternatives.push(alternative.parts);
        if (alternative.separator === ",") {
          hasComma = true;
          continue;
        }
        if (alternative.separator !== "}" || !hasComma) return undefined;
        break;
      }
      parts.push(alternatives);
    }

    flushLiteral();
    return { parts };
  }

  const parsed = parseSequence(0, false);
  if (parsed === undefined || index !== token.length) return {};
  return { sequence: parsed.parts };
}

function sequenceCanStartWithFileScheme(sequence: BraceSequence): boolean {
  function consume(parts: BraceSequence, positions: ReadonlySet<number>) {
    let current = positions;
    for (const part of parts) {
      const next = new Set<number>();
      if (typeof part === "string") {
        for (const start of current) {
          let position = start;
          for (const char of part) {
            if (position === FILE_SCHEME.length) break;
            if (char.toLowerCase() !== FILE_SCHEME[position]) {
              position = -1;
              break;
            }
            position++;
          }
          if (position >= 0) next.add(position);
        }
      } else {
        for (const alternative of part) {
          for (const position of consume(alternative, current)) {
            next.add(position);
          }
        }
      }
      current = next;
      if (current.size === 0 || current.has(FILE_SCHEME.length)) break;
    }
    return current;
  }

  return consume(sequence, new Set([0])).has(FILE_SCHEME.length);
}

function repairMissingBraceClosers(token: string): string | undefined {
  let depth = 0;
  for (const char of token) {
    if (char === "{") depth++;
    else if (char === "}") {
      if (depth === 0) return undefined;
      depth--;
    }
  }
  if (depth === 0 || depth > MAX_BRACE_DEPTH) return undefined;
  return `${token}${"}".repeat(depth)}`;
}

function expandBraceSequence(sequence: BraceSequence): string[] | undefined {
  let expanded = [""];
  for (const part of sequence) {
    let values: readonly string[];
    if (typeof part === "string") {
      values = [part];
    } else {
      const alternatives: string[] = [];
      for (const alternative of part) {
        const valuesForAlternative = expandBraceSequence(alternative);
        if (
          valuesForAlternative === undefined ||
          alternatives.length + valuesForAlternative.length >
            MAX_BRACE_EXPANSIONS
        ) {
          return undefined;
        }
        alternatives.push(...valuesForAlternative);
      }
      values = alternatives;
    }
    if (values.length === 0) return undefined;
    const next: string[] = [];
    for (const prefix of expanded) {
      for (const value of values) {
        if (
          next.length === MAX_BRACE_EXPANSIONS ||
          prefix.length + value.length > MAX_BRACE_OUTPUT_LENGTH
        ) {
          return undefined;
        }
        next.push(prefix + value);
      }
    }
    expanded = next;
  }
  return expanded;
}

function normalizedFileURLPath(
  token: string,
  dialect: ShellDialect,
): FileURLPaths {
  if (dialect === "cmd") return { failClosed: true };
  try {
    const url = new URL(token);
    if (url.host !== "") return { failClosed: true };
    const localPath = decodeURIComponent(url.pathname);
    if (/[{}]/.test(url.pathname) || /[{}]/.test(localPath)) {
      return { failClosed: true };
    }
    return { localPaths: [localPath], failClosed: false };
  } catch {
    return { failClosed: true };
  }
}

// WHATWG parsing handles slash counts, relative file paths, localhost, and
// dot-segment normalization. Decode each pathname exactly once to match URL
// transport semantics. Brace alternatives are parsed independently of the
// invoking program because either curl or a shell can expand them. The prefix
// matcher proves remote-only patterns without enumerating their path braces;
// file-capable patterns expand under strict size, depth, and count limits.
// Ambiguous or overflowing file-capable patterns prompt rather than guessing.
// Existing file-URL pathname braces retain their conservative prompt behavior.
function hasFixedNonFileScheme(token: string): boolean {
  const braceIndex = token.search(/[{}]/);
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:/.exec(token)?.[0];
  return (
    scheme !== undefined &&
    scheme.toLowerCase() !== FILE_SCHEME &&
    (braceIndex === -1 || scheme.length <= braceIndex)
  );
}

function literalPrefixCouldBecomeFileScheme(token: string): boolean {
  const braceIndex = token.search(/[{}]/);
  const literalPrefix = token.slice(
    0,
    braceIndex === -1 ? token.length : braceIndex,
  );
  return FILE_SCHEME.startsWith(literalPrefix.toLowerCase());
}

function normalizeFileURLPaths(
  token: string,
  dialect: ShellDialect,
): FileURLPaths | undefined {
  if (isFileSchemeURL(token)) return normalizedFileURLPath(token, dialect);
  if (!/[{}]/.test(token) || hasFixedNonFileScheme(token)) return undefined;

  let parsed = parseBraceSequence(token);
  if (parsed.sequence === undefined) {
    const repaired = repairMissingBraceClosers(token);
    if (repaired === undefined) {
      return literalPrefixCouldBecomeFileScheme(token)
        ? { failClosed: true }
        : undefined;
    }
    parsed = parseBraceSequence(repaired);
    if (parsed.sequence === undefined) {
      return literalPrefixCouldBecomeFileScheme(token)
        ? { failClosed: true }
        : undefined;
    }
    if (!sequenceCanStartWithFileScheme(parsed.sequence)) return undefined;
    return { failClosed: true };
  }
  if (!sequenceCanStartWithFileScheme(parsed.sequence)) return undefined;

  const candidates = expandBraceSequence(parsed.sequence);
  if (candidates === undefined) return { failClosed: true };
  const localPaths: string[] = [];
  for (const candidate of candidates) {
    if (!isFileSchemeURL(candidate)) continue;
    const normalized = normalizedFileURLPath(candidate, dialect);
    if (normalized.failClosed) return normalized;
    localPaths.push(...normalized.localPaths);
  }
  return { localPaths, failClosed: false };
}

// CL-7790: the ONE shell-token matcher both secret-guard call sites share —
// commandReferencesSensitivePath below and classify.ts's per-arg sensitive
// check. The cheap lexical denylist runs first so the hot auto-allow path
// never touches the filesystem; only survivors pay for filesystem access, in
// two bounded tiers: path-like tokens pay for a realpath via the CL-6971
// helper, which catches a benign-named symlink into a secret file (notes.txt
// -> .env) exactly like the secret name itself, while bare extensionless
// tokens first pay a single lstat existence probe against the cwd-resolved
// path — a miss (the common `cat Makefile` case) costs exactly that one
// lstat and skips the resolve, a hit (file or symlink, dangling included)
// pays the realpath and matches on the target. Flags, globs, and
// backticks never probe, so the worst case per command is one lstat per bare
// token plus one realpath per existing entry. Relative tokens resolve
// against cwd first because the helper takes absolute paths; `~` and
// `$VAR`/`${VAR}` expand against process.env before resolving (see
// expandShellToken) for the same reason. That cwd is the
// session/process cwd, not a `cd` prefix inside the command —
// `cd sub && cat notes.txt` resolves `notes.txt` against the session cwd
// (absent) rather than cwd/sub (present). The chain still fails closed
// because `cd` is not a safe program, but no secret reason fires;
// per-segment `cd` modeling is deliberately out of scope.
// Pass resolveSymlinks=false for pure name-listings: listing a name is not
// dumping its contents (CL-5420), so `ls notes.txt` still lists freely while
// `cat notes.txt` asks.
//
// `isExtraDenied` extends both legs to the extras-denied config paths
// (CL-9386): the custom config path asks in shell commands exactly like the
// default settings file. The listing leg resolves cwd-relative tokens because
// extras entries are exact paths, not name patterns — a lexical match alone
// would miss `ls operator-config.json` while catching the absolute form.
export function isSensitiveShellToken(
  token: string,
  cwd: string = process.cwd(),
  resolveSymlinks = true,
  isExtraDenied: (value: string) => boolean = () => false,
  dialect: ShellDialect = nativeShellDialect(process.platform),
): boolean {
  const { expanded, expandable } = expandShellToken(token, dialect);
  if (!expandable) return true;
  const fileURLPaths = normalizeFileURLPaths(expanded, dialect);
  if (fileURLPaths?.failClosed) return true;
  if (
    fileURLPaths !== undefined &&
    fileURLPaths.localPaths.some((localPath) =>
      isSensitiveExpandedShellToken(
        localPath,
        cwd,
        resolveSymlinks,
        isExtraDenied,
        dialect,
      ),
    )
  ) {
    return true;
  }
  return isSensitiveExpandedShellToken(
    expanded,
    cwd,
    resolveSymlinks,
    isExtraDenied,
    dialect,
  );
}

function isSensitiveExpandedShellToken(
  expanded: string,
  cwd: string,
  resolveSymlinks: boolean,
  isExtraDenied: (value: string) => boolean,
  dialect: ShellDialect,
): boolean {
  if (isSensitivePath(expanded, dialect)) return true;
  if (isExtraDenied(expanded)) return true;
  if (!resolveSymlinks) {
    if (!isBareProbeCandidate(expanded)) return false;
    return isExtraDenied(
      isAbsolute(expanded) ? expanded : resolvePath(cwd, expanded),
    );
  }
  if (dialect === "cmd" && /^\\\\[?.]\\/.test(expanded)) return false;
  // A `?` or `[` glob expands at runtime into whatever names match, so the
  // matcher only ever sees the pattern while the shell can open a secret
  // (`cat .en?` and `cat .en[v]` both read `.env`). Fail closed to a prompt —
  // but only for file-operand-shaped tokens. The unscoped rule fired on
  // non-file operands: query strings (`curl …/search?q=term`), regex operands
  // (`grep -E colou?r`, `grep [0-9]`), and the `[` test builtin itself
  // (`[ -f Makefile ]`). Three exemptions, each too narrow to reopen a
  // bypass: tokens containing `://` with a non-file URL scheme receive the
  // fatigue exemption, while `file:` URLs are local reads and stay guarded
  // (see isFileSchemeURL); bare
  // `[`/`]`/`[[`/`]]` are test syntax, not globs; and a `?`/`[` pattern with
  // no `.`, `/`, or `\` cannot name a dotfile secret — `?`/`[…]` never match
  // a leading dot under default shell semantics, so the literal dot must be
  // present. Dotless secrets (`id_rsa`, `Cookies`) stay reachable through the
  // accepted bare-`*` residual below, so exempting their `?`/`[` forms adds
  // no new bypass. After the cmd device-path exemption so `\\?\…` names keep
  // working.
  if (
    (expanded.includes("?") || expanded.includes("[")) &&
    (!expanded.includes("://") || isFileSchemeURL(expanded)) &&
    expanded !== "[" &&
    expanded !== "]" &&
    expanded !== "[[" &&
    expanded !== "]]" &&
    (expanded.includes(".") ||
      expanded.includes("/") ||
      expanded.includes("\\"))
  )
    return true;
  // Dotfile-rooted `*` globs (`.*`, `.env*`) deterministically match `.env`
  // in any realistic cwd, so they prompt — the carve-out from the `*`
  // exclusions in the filters above. Bare `*` / `*.txt` cannot match a
  // leading dot and stay allowed, as do `*` globs rooted outside a dotfile
  // name (`.config/*`). Runs post-expansion, so `${UNKNOWN_X:=.env*}`
  // prompts while `${UNKNOWN_X:=fallback.txt}` stays free.
  if (isDotfileRootedGlob(expanded)) return true;
  if (isPathLikeShellToken(expanded)) {
    if (isAbsolute(expanded)) {
      return (
        isSensitivePathResolved(expanded, dialect) || isExtraDenied(expanded)
      );
    }
    const abs = resolvePath(cwd, expanded);
    return isSensitivePathResolved(abs, dialect) || isExtraDenied(abs);
  }
  if (!isBareProbeCandidate(expanded)) return false;
  const abs = isAbsolute(expanded) ? expanded : resolvePath(cwd, expanded);
  try {
    lstatSync(abs);
  } catch {
    return false;
  }
  return isSensitivePathResolved(abs, dialect) || isExtraDenied(abs);
}

const LEADING_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=(.*)$/s;

function programName(token: string): string {
  return token.split(/[\\/]/).at(-1) ?? token;
}

const CMD_EXECUTABLE_SUFFIX = /\.(?:com|exe|bat|cmd)$/i;

function cmdProgramName(token: string): string {
  return programName(token)
    .replace(/^@+/, "")
    .replace(CMD_EXECUTABLE_SUFFIX, "")
    .toLowerCase();
}

function fileOptionProgramName(token: string, dialect: ShellDialect): string {
  const native = dialect === "cmd" ? cmdProgramName(token) : programName(token);
  return native === "egrep" || native === "fgrep" ? "grep" : native;
}

interface FileOptionValues {
  values: string[];
  opaque: boolean;
}

function commandFileOptionValues(
  command: readonly string[],
  executableIndex: number,
  program: string,
): FileOptionValues {
  const grammar = FILE_OPTION_GRAMMARS[program];
  if (grammar === undefined) return { values: [], opaque: false };

  const values: string[] = [];
  let opaque = false;
  for (let index = executableIndex + 1; index < command.length; index++) {
    const token = command[index] ?? "";
    if (token === "--") break;
    if (token === "-f") {
      const value = command[index + 1];
      if (value !== undefined) {
        values.push(value);
        index++;
      }
      continue;
    }
    if (isLongFileOption(token, grammar)) {
      const equalsIndex = token.indexOf("=");
      if (equalsIndex >= 0) {
        values.push(token.slice(equalsIndex + 1));
      } else {
        const value = command[index + 1];
        if (value !== undefined) {
          values.push(value);
          index++;
        }
      }
      continue;
    }
    const inspection = inspectShortOptions(token, grammar);
    if (inspection.ambiguousFileOption) opaque = true;
    const valueOption = inspection.valueOption;
    if (valueOption === undefined) continue;
    if (valueOption.option === "f") {
      const value = valueOption.attachedValue ?? command[index + 1];
      if (value !== undefined) values.push(value);
    }
    if (valueOption.attachedValue === undefined) index++;
  }
  return { values, opaque };
}

interface LiteralPathCandidates {
  candidates: string[];
  opaque: boolean;
}

function literalPathCandidates(
  commands: string[][],
  dialect: ShellDialect,
): LiteralPathCandidates {
  const tokens = commands.flat();
  const candidates = [...tokens];
  let opaque = false;

  if (dialect === "posix") {
    for (const command of commands) {
      const transparent = peelTransparentCommand(command, {
        acceptsWrapper: (token, program) =>
          program !== "env" || token === "env" || token === "/usr/bin/env",
      });
      candidates.push(...transparent.assignmentValues);
      const executable = command[transparent.executableIndex] ?? "";
      const program = fileOptionProgramName(executable, dialect);
      const fileOptions = commandFileOptionValues(
        command,
        transparent.executableIndex,
        program,
      );
      candidates.push(...fileOptions.values);
      opaque ||= fileOptions.opaque;
      for (const token of command) {
        if (token.startsWith("--env-file=")) {
          candidates.push(token.slice("--env-file=".length));
        }
        if (
          program === "dd" &&
          (token.startsWith("if=") || token.startsWith("of="))
        ) {
          candidates.push(token.slice(3));
        }
      }
    }
    return { candidates, opaque };
  }

  for (const command of commands) {
    let commandIndex = 0;
    while (commandIndex < command.length) {
      const assignment = LEADING_ASSIGNMENT.exec(command[commandIndex] ?? "");
      if (assignment === null) break;
      candidates.push(assignment[1] ?? "");
      commandIndex++;
    }

    const program = fileOptionProgramName(command[commandIndex] ?? "", dialect);
    const fileOptions = commandFileOptionValues(command, commandIndex, program);
    candidates.push(...fileOptions.values);
    opaque ||= fileOptions.opaque;
    for (const token of command) {
      if (token.startsWith("--env-file=")) {
        candidates.push(token.slice("--env-file=".length));
      }
      if (
        program === "dd" &&
        (token.startsWith("if=") || token.startsWith("of="))
      ) {
        candidates.push(token.slice(3));
      }
    }
  }

  return { candidates, opaque };
}

function unsupportedCmdConstruct(command: string): string | undefined {
  const expansion = /%[^%\r\n]+%|![^!\r\n]+!/.exec(command)?.[0];
  if (expansion !== undefined) return expansion;
  const unescapedQuotes = command.replace(/\^./g, "").match(/"/g)?.length ?? 0;
  if (unescapedQuotes % 2 !== 0 || /\^(?:\r?\n)?$/.test(command))
    return command;
  return undefined;
}

function subjectReferencesSensitivePath(
  command: string,
  cwd: string,
  dialect: ShellDialect,
  isExtraDenied: (value: string) => boolean = () => false,
): ShellSecretInspection {
  if (dialect === "cmd") {
    const unsupported = unsupportedCmdConstruct(command);
    if (unsupported !== undefined) {
      return { reference: unsupported, opaque: false };
    }
  }

  const literalInspection = inspectLiteralPathArgumentCommands(
    command,
    dialect,
  );
  const tokens = literalInspection.commands.flat();
  const inspection = literalPathCandidates(literalInspection.commands, dialect);
  inspection.opaque ||= literalInspection.opaque;
  // Dump vs list: a lone name-listing never dumps file contents, so only the
  // cheap lexical leg applies and `ls notes.txt` still lists freely. Anything
  // composed (pipes, chains, redirects, subshells) takes the resolve leg —
  // `ls && cat notes.txt` must not ride the listing exemption.
  const program = tokens.find((token) => !LEADING_ASSIGNMENT.test(token)) ?? "";
  const listingOnly =
    PURE_DIRECTORY_LISTING_PROGRAMS.has(programName(program)) &&
    !/[;&|()<>\n]/.test(command);
  for (const token of inspection.candidates) {
    if (
      isSensitiveShellToken(token, cwd, !listingOnly, isExtraDenied, dialect)
    ) {
      return { reference: token, opaque: inspection.opaque };
    }
  }
  return { reference: undefined, opaque: inspection.opaque };
}

export interface ShellSecretInspection {
  reference: string | undefined;
  opaque: boolean;
}

export function shellSecretInspectionRequiresApproval(
  inspection: ShellSecretInspection,
): boolean {
  return inspection.reference !== undefined || inspection.opaque;
}

export function inspectShellSecretReference(
  command: string,
  cwd: string | undefined = process.cwd(),
  isExtraDenied: (value: string) => boolean = () => false,
  dialect: ShellDialect = nativeShellDialect(process.platform),
): ShellSecretInspection {
  const resolvedCwd = cwd ?? process.cwd();
  const expanded = expandShellSubjects(command);
  let opaque = expanded.opaque;
  for (const subject of expanded.subjects) {
    const inspection = subjectReferencesSensitivePath(
      subject,
      resolvedCwd,
      dialect,
      isExtraDenied,
    );
    opaque ||= inspection.opaque;
    if (inspection.reference !== undefined) {
      return { reference: inspection.reference, opaque };
    }
  }
  return { reference: undefined, opaque };
}

export function commandReferencesSensitivePath(
  command: string,
  cwd: string = process.cwd(),
  isExtraDenied: (value: string) => boolean = () => false,
  dialect: ShellDialect = nativeShellDialect(process.platform),
): string | undefined {
  return inspectShellSecretReference(command, cwd, isExtraDenied, dialect)
    .reference;
}

// Hard-deny path-keyed tool calls that would put a secret file's contents into
// (or write them from) the model context. Shell commands that merely mention a
// secret path are not blocked here — they require operator approval via the
// permission gate (and auto-shell policy in auto mode).
//
// Path-arg hard deny runs before the permission plugin, so it holds even under
// --dangerously-skip-permissions. Symlink resolution is part of that floor
// (CL-6971): yolo must not let an innocuous link name defeat the denylist.
export function secretGuardPlugin(
  options?: SecretGuardPluginOptions,
): ToolPlugin {
  const isExtraDenied = createExtraDeniedPathMatcher(
    options?.extraDeniedPaths ?? [],
  );
  return {
    middleware: (next) => async (call, signal) => {
      for (const [key, value] of Object.entries(call.arguments)) {
        if (
          typeof value === "string" &&
          looksLikePath(key) &&
          (isSensitivePathResolved(value) || isExtraDenied(value))
        ) {
          return {
            callId: call.id,
            content: `Access to sensitive file blocked by policy: ${value}`,
            isError: true,
          };
        }
      }
      for (const path of productMutationPaths(call.name, call.arguments)) {
        if (isSensitivePathResolved(path) || isExtraDenied(path)) {
          return {
            callId: call.id,
            content: `Access to sensitive file blocked by policy: ${path}`,
            isError: true,
          };
        }
      }
      return next(call, signal);
    },
  };
}
