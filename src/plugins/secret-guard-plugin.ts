import { lstatSync } from "node:fs";
import { homedir } from "node:os";
import {
  isAbsolute,
  join as joinPath,
  resolve as resolvePath,
} from "node:path";
import type { ToolPlugin } from "@intx/tools-posix";
import {
  realpathFollowingDangling,
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

// Secret files: path-keyed tools (read_file, write_file, …) hard-deny them —
// content would land in the model context. Shell commands that merely
// reference them are ask-gated (commandReferencesSensitivePath), so
// legitimate uses like `bun --env-file=.env run …` can be approved.
const SENSITIVE_PATTERNS: RegExp[] = [
  // .env variants, not templates (.env.example, .env.sample, …).
  /(^|\/)\.env($|\.(?!example|sample|template|dist))/,
  /(^|\/)\.(envrc|flaskenv)$/,
  /(^|\/)\.dev\.vars$/, // Cloudflare Workers secrets
  /(^|\/)\.npmrc$/,
  /(^|\/)\.netrc$/,
  /(^|\/)\.git-credentials$/,
  // Corbits Code's settings hold provider credentials (global and per-repo).
  // The grant store is not a credential file, but writing it grants standing
  // auto-approval — same deny.
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
  // Shell history: operators paste secrets into shells constantly
  // (export TOKEN=…, curl -H "Authorization: …"), and the file is a
  // durable log. @mentions can reach outside the workspace, so this
  // entry matters.
  /(^|\/)\.bash_history$/,
  /(^|\/)\.zsh_history$/,
  /(^|\/)\.sh_history$/,
  /(^|\/)fish_history$/,
  // System account/privilege files — /etc/shadow (password hashes) and
  // /etc/sudoers (escalation policy): direct system-compromise material.
  /(^|\/)etc\/shadow$/,
  /(^|\/)etc\/sudoers(\.d\/.*)?$/,
  // macOS Keychain: every saved Wi-Fi password and login on the machine.
  /(^|\/)Library\/Keychains\//,
  /\.keychain(-db)?$/,
  // Browser cookie jars and saved logins — a cookie store alone can hijack
  // an authenticated session.
  /(^|\/)Cookies$/, // Chrome/Chromium/Edge profile cookie DB (no extension)
  /(^|\/)Login Data$/, // Chrome/Chromium/Edge saved passwords DB (no extension)
  /(^|\/)cookies\.sqlite$/, // Firefox
  /(^|\/)logins\.json$/, // Firefox saved logins
  /(^|\/)key4\.db$/, // Firefox's key store for the above
  // Whole ~/.config/gcloud dir: legacy_credentials/, credentials.db, and
  // access_tokens.db live alongside the credentials JSON.
  /(^|\/)\.config\/gcloud\//,
  // Azure CLI's credential cache — the equivalent of ~/.aws/credentials.
  /(^|\/)\.azure\/(accessTokens|azureProfile)\.json$/,
  // OAuth token stores and sidecars come from the auth-owned registry, not
  // literals, so new stores cannot drift off the denylist; the registry only
  // adds their lock/temp sidecars.
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

// Secret-guard floor: match the lexical path and its realpath, so a symlink
// alias (config.txt → .env) cannot beat the denylist and write targets whose
// parent is a symlink into a sensitive dir are covered. Realpath leg is
// absolute-only: live paths are absolutized; test args match lexically.
export function isSensitivePathResolved(
  value: string,
  dialect: ShellDialect = nativeShellDialect(process.platform),
): boolean {
  if (isSensitivePath(value, dialect)) return true;
  if (!isAbsolute(value)) return false;
  const real = realpathFollowingDangling(value);
  return real !== UNRESOLVABLE && isSensitivePath(real, dialect);
}

// Extra hard-deny paths. The active --config path can live anywhere — even
// inside the workspace, outside the static patterns above — and carries
// standing skip-permissions, so entry points thread it in here and
// path-keyed tools deny it like the default settings file.
export interface SecretGuardPluginOptions {
  extraDeniedPaths?: readonly string[];
}

// Exact-path matcher over runtime-denied paths, same two legs as
// isSensitivePathResolved: lexical (target may not exist yet) and realpath.
// Relative entries match lexically only — production entries are absolute.
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
    const real = realpathFollowingDangling(value);
    return real !== UNRESOLVABLE && resolved.has(real.replace(/\\/g, "/"));
  };
}

// First token in a shell command that names a secret file, or undefined.
// Matching the file token, not the utility, covers every read tool (`cat`,
// `less`, `grep`, a custom script) without enumerating them.
//
// Callers (auto-shell policy, classify) force an operator ask; approval (or
// --dangerously-skip-permissions) lets the reference run, e.g.
// `bun --env-file=.env.staging run …`. Path-keyed tools stay hard-denied.
//
// Best-effort: token matching beats quoting, env-assignment, and redirection,
// but not dynamic path construction it never sees as one token (variable
// indirection, `printf`, runtime assembly) or unexpanded globs (`cat *` can
// open a symlink). The goal is a prompt for trivial single-token references;
// tool-result scrub still redacts credential-shaped output. A leading
// $HOME/$USER expands before matching; other path-shaped $-tokens fail
// closed to ask.
//
// Programs that only list names never dump contents. Single owner for this
// set: the resolve-leg skip below and classify.ts's pure-listing exemption
// both read it, so a new names-only program cannot drift into one list
// without the other.
export const PURE_DIRECTORY_LISTING_PROGRAMS = new Set(["ls", "tree"]);

// The shell expands a leading $HOME (or ${HOME}) before opening the path;
// expand it here, string-only from the environment — never shell eval — and
// let the normal legs judge. $USER (or ${USER}) gets the same treatment.
// Other variables stay unexpanded and fail closed to ask below.
function expandLeadingDollarToken(token: string): string {
  const home = process.env.HOME;
  if (home !== undefined && home.length > 0) {
    if (token === "$HOME" || token === "${HOME}") return home;
    if (token.startsWith("$HOME/")) return home + token.slice("$HOME".length);
    if (token.startsWith("${HOME}/"))
      return home + token.slice("${HOME}".length);
  }
  const user = process.env.USER ?? process.env.USERNAME;
  if (user !== undefined && user.length > 0) {
    if (token === "$USER" || token === "${USER}") return user;
    if (token.startsWith("$USER/")) return user + token.slice("$USER".length);
    if (token.startsWith("${USER}/"))
      return user + token.slice("${USER}".length);
  }
  return token;
}

// Path-shaped token the shell could open (slash, extension dot, or
// absolute), not a flag, variable, or fd number — those can never name a
// file, so they skip the stat and the hot auto-allow path stays
// syscall-free. Globs are skipped too: the matcher only sees the unexpanded
// pattern, and a glob CAN expand into a symlink at runtime (a stated
// residual, see the threat model above).
function isPathLikeShellToken(token: string): boolean {
  if (
    token.startsWith("-") ||
    token.includes("$") ||
    token.includes("*") ||
    token.includes("`")
  )
    return false;
  return (
    isAbsolute(token) ||
    token.includes("/") ||
    token.includes("\\") ||
    token.includes(".")
  );
}

// `~` is the operator's home, not a cwd-relative name — expand first so
// `cat ~/notes` resolves the home symlink, not a usually-missing cwd child.
export function expandHome(token: string): string {
  if (token === "~") return homedir();
  if (token.startsWith("~/")) return joinPath(homedir(), token.slice(2));
  return token;
}

// Extensionless token the shell could open as a cwd-relative file: the
// path-like exclusions minus the dot/slash shape requirement, so `notes`
// (from `--file=notes` / `cat -n notes`) still gets an existence probe.
function isBareProbeCandidate(token: string): boolean {
  return (
    token.length > 0 &&
    !token.startsWith("-") &&
    !token.includes("$") &&
    !token.includes("*") &&
    !token.includes("`")
  );
}

// One shell-token matcher shared by both secret-guard call sites —
// commandReferencesSensitivePath below and classify.ts's per-arg check. The
// cheap lexical denylist runs first so the hot auto-allow path never touches
// the filesystem; survivors pay in two bounded tiers: path-like tokens pay a
// realpath (catches a benign-named symlink into a secret file), bare
// extensionless tokens pay one lstat probe — a miss (the common `cat
// Makefile` case) costs that lstat, a hit pays the realpath. Flags,
// variables, globs, and backticks never probe. Relative tokens resolve
// against cwd (the session cwd, not a `cd` prefix inside the command);
// `~` expands to home first.
// Pass resolveSymlinks=false for pure name-listings: listing a name is not
// dumping contents, so `ls notes.txt` lists freely while `cat notes.txt`
// asks. `isExtraDenied` extends both legs to the extras-denied config paths;
// the listing leg resolves cwd-relative tokens because extras entries are
// exact paths, not name patterns.
export function isSensitiveShellToken(
  token: string,
  cwd: string = process.cwd(),
  resolveSymlinks = true,
  isExtraDenied: (value: string) => boolean = () => false,
  dialect: ShellDialect = nativeShellDialect(process.platform),
): boolean {
  const expanded = expandHome(expandLeadingDollarToken(token));
  if (isSensitivePath(expanded, dialect)) return true;
  if (isExtraDenied(expanded)) return true;
  // Path-shaped live expansions ($VAR/${VAR} joined to a path separator, e.g.
  // $BASE/mylink) skip both legs below — fail closed to ask. Quoted dollars,
  // command substitutions, special parameters ($?, $$, $1), ADS streams, and
  // bare `$VAR` with no path shape never match: they cannot name a file.
  if (
    expanded.includes("$") &&
    /\$[{]?[A-Za-z_]/.test(expanded) &&
    (expanded.includes("/") || expanded.includes("\\"))
  )
    return true;
  if (!resolveSymlinks) {
    if (!isBareProbeCandidate(expanded)) return false;
    return isExtraDenied(
      isAbsolute(expanded) ? expanded : resolvePath(cwd, expanded),
    );
  }
  if (dialect === "cmd" && /^\\\\[?.]\\/.test(expanded)) return false;
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
  // Dump vs list: a lone name-listing never dumps contents, so only the cheap
  // lexical leg applies and `ls notes.txt` lists freely. Anything composed
  // (pipes, chains, redirects, subshells) takes the resolve leg — `ls && cat
  // notes.txt` must not ride the listing exemption.
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

// Hard-deny path-keyed tool calls that would put a secret file's contents
// into (or write them from) the model context. Shell commands that merely
// mention a secret path need operator approval instead (permission gate,
// auto-shell policy in auto mode).
//
// Runs before the permission plugin, so it holds even under
// --dangerously-skip-permissions; symlink resolution is part of that floor.
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
