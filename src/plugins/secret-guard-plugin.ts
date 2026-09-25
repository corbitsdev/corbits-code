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
// name at runtime. Unexpanded globs are the same class: `cat *` can open a
// symlink the matcher only ever saw as `*`. Perfect shell sandboxing is out
// of scope; the goal is to force a prompt for the trivial, single-token
// references that make exfiltration easy. Tool-result secret scrub still redacts credential-shaped output.
// Programs that only print directory names / metadata — listing a name never
// dumps file contents. Single owner for this set: the resolve-leg skip below
// and classify.ts's pure-listing exemption both read it, so a new names-only
// program cannot drift into one list without the other.
export const PURE_DIRECTORY_LISTING_PROGRAMS = new Set(["ls", "tree"]);

// Worth spending a realpath on: shaped like a path the shell could open
// (a slash, an extension dot, or absolute), not a flag, variable, or fd
// number — those can never name a file the shell opens, so they skip the
// stat and the hot auto-allow path stays syscall-free for them. Globs are
// skipped here for a different reason: the matcher only sees the unexpanded
// pattern, so `cat *.txt` cannot resolve without running the shell — but a
// glob CAN expand into a symlink at runtime, which stays a stated residual
// (see the threat model below), not something this filter disproves.
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

// A bare token the shell could open as a cwd-relative file: not a flag,
// variable, glob, or command substitution — same exclusions as the path-like
// filter, minus the dot/slash shape requirement, so extensionless names
// (`notes`, or `notes` split out of `--file=notes` / `cat -n notes`) still
// get an existence probe below.
function isBareProbeCandidate(token: string): boolean {
  return (
    token.length > 0 &&
    !token.startsWith("-") &&
    !token.includes("$") &&
    !token.includes("*") &&
    !token.includes("`")
  );
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
// pays the realpath and matches on the target. Flags, variables, globs, and
// backticks never probe, so the worst case per command is one lstat per bare
// token plus one realpath per existing entry. Relative tokens resolve
// against cwd first because the helper takes absolute paths; `~` expands to
// the home directory before resolving for the same reason. That cwd is the
// session/process cwd, not a `cd` prefix inside the command —
// `cd sub && cat notes.txt` resolves `notes.txt` against the session cwd
// (absent) rather than cwd/sub (present). The chain still fails closed
// because `cd` is not a safe program, but no secret reason fires;
// per-segment `cd` modeling is deliberately out of scope.
// Pass resolveSymlinks=false for pure name-listings: listing a name is not
// dumping its contents (CL-5420), so `ls notes.txt` still lists freely while
// `cat notes.txt` asks.
export function isSensitiveShellToken(
  token: string,
  cwd: string = process.cwd(),
  resolveSymlinks = true,
  dialect: ShellDialect = nativeShellDialect(process.platform),
): boolean {
  const expanded = expandHome(token);
  if (isSensitivePath(expanded, dialect)) return true;
  if (!resolveSymlinks) return false;
  if (dialect === "cmd" && /^\\\\[?.]\\/.test(expanded)) return false;
  if (isPathLikeShellToken(expanded)) {
    if (isAbsolute(expanded)) return isSensitivePathResolved(expanded, dialect);
    return isSensitivePathResolved(resolvePath(cwd, expanded), dialect);
  }
  if (!isBareProbeCandidate(expanded)) return false;
  const abs = isAbsolute(expanded) ? expanded : resolvePath(cwd, expanded);
  try {
    lstatSync(abs);
  } catch {
    return false;
  }
  return isSensitivePathResolved(abs, dialect);
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
    if (isSensitiveShellToken(token, cwd, !listingOnly, dialect)) {
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
  cwd: string = process.cwd(),
  dialect: ShellDialect = nativeShellDialect(process.platform),
): ShellSecretInspection {
  if (dialect === "cmd") {
    return subjectReferencesSensitivePath(command, cwd, dialect);
  }

  const expanded = expandShellSubjects(command);
  let opaque = expanded.opaque;
  for (const subject of expanded.subjects) {
    const inspection = subjectReferencesSensitivePath(subject, cwd, dialect);
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
  dialect: ShellDialect = nativeShellDialect(process.platform),
): string | undefined {
  return inspectShellSecretReference(command, cwd, dialect).reference;
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
        if (
          typeof value === "string" &&
          looksLikePath(key) &&
          isSensitivePathResolved(value)
        ) {
          return {
            callId: call.id,
            content: `Access to sensitive file blocked by policy: ${value}`,
            isError: true,
          };
        }
      }
      for (const path of productMutationPaths(call.name, call.arguments)) {
        if (isSensitivePathResolved(path)) {
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
