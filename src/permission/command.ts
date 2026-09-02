import type { ApprovalScope } from "./types.js";
import { escapeGlobLiteral } from "./matcher.js";
import { isRedirectAmpersand, parseHeredocOpener } from "./shell-tokenizer.js";

// Split a shell command into the individual commands it chains together, so each
// can be classified for security. The operator still approves the full command
// as one block (see buildRequests / gate). Operators recognised: && || | ; and a
// newline. Splitting is quote-aware — operators inside '...', "..." or `...` are
// part of an argument, not a separator. Heredoc bodies (<< 'MARKER' ... MARKER)
// are treated as atomic — newlines inside them are not chain boundaries.
// Parentheses group: operators inside a subshell or command substitution never
// split, and a segment that is exactly one `( ... )` group is unwrapped and its
// inner chain split recursively — so `(cd a && b)` yields `cd a` and `b`, not
// the fragment `(cd a`.
export function splitChainedCommand(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: '"' | "'" | "`" | null = null;
  let heredocMarker: string | null = null;
  let parenDepth = 0;

  const push = (): void => {
    const trimmed = current.trim();
    current = "";
    if (trimmed.length === 0) return;
    const inner = unwrapGroup(trimmed);
    if (inner !== null) {
      segments.push(...splitChainedCommand(inner));
      return;
    }
    segments.push(trimmed);
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string;

    // Inside a heredoc body: scan for the terminating marker on its own line.
    if (heredocMarker !== null) {
      current += ch;
      if (ch === "\n") {
        // Check whether the line just completed is the marker.
        const lines = current.split("\n");
        const lastLine = lines[lines.length - 2] ?? "";
        if (lastLine.trim() === heredocMarker) {
          heredocMarker = null;
        }
      }
      continue;
    }

    if (quote !== null) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      current += ch;
      continue;
    }

    // Shell line continuation: a backslash immediately before a newline is
    // consumed by the shell (elides the newline for chaining purposes). Do not
    // append the \ or split the segment; this prevents fragments like "\" from
    // becoming approval subjects when agents emit continued commands.
    if (ch === "\\") {
      const after = command[i + 1];
      if (after === "\n" || after === "\r") {
        i += 1;
        if (after === "\r" && command[i + 1] === "\n") i += 1;
        continue;
      }
    }

    // Detect heredoc redirect: << or <<-
    if (ch === "<" && command[i + 1] === "<") {
      const opener = parseHeredocOpener(command, i);
      if (opener !== null) {
        current += command.slice(i, opener.lineEnd);
        i = opener.lineEnd - 1;
        heredocMarker = opener.marker;
        continue;
      }
    }

    if (ch === "(") {
      parenDepth++;
      current += ch;
      continue;
    }
    if (ch === ")") {
      if (parenDepth > 0) parenDepth--;
      current += ch;
      continue;
    }
    if (parenDepth > 0) {
      current += ch;
      continue;
    }

    const next = command[i + 1];
    // A chain operator immediately following a dangling redirect operator
    // (`>`, `<`, `>&`, `<&` with no target yet) does not start a new command —
    // the target got separated from its redirect, most often by a stray
    // separator a model inserted mid-redirect (e.g. "cmd 2>& ; 1" meaning
    // "cmd 2>&1"). Treat the operator as whitespace so the target rejoins the
    // command it belongs to, instead of surfacing as its own "Run shell
    // command" approval. A well-formed chain ("sleep 5 ; -1 ; echo end") has
    // no dangling redirect before the separator, so it is never affected.
    if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
      if (endsWithDanglingRedirect(current)) {
        current = `${current.trimEnd()} `;
        i++;
        continue;
      }
      push();
      i++;
      continue;
    }
    // `&` participates in a redirect when it opens a bash combined redirect
    // (`&>file`) or duplicates a fd after `>`/`<` (`2>&1`, `<&-`). In those
    // positions it is not a background operator and must not split the chain —
    // otherwise `bun run build 2>&1` fragments into a real command and a stray
    // `1`, and the operator gets a separate approval prompt for "1".
    if (ch === "&" && isRedirectAmpersand(next)) {
      current += ch;
      continue;
    }
    // A lone "&" backgrounds the preceding command and starts a new one, so it
    // is a chain boundary. Without this, "ls & rm -rf foo" is treated as a
    // single segment and the approval scope is derived from the benign head.
    if (ch === "|" || ch === ";" || ch === "\n" || ch === "&") {
      if (endsWithDanglingRedirect(current)) {
        current = `${current.trimEnd()} `;
        continue;
      }
      push();
      continue;
    }
    current += ch;
  }
  push();
  return segments;
}

// Remove genuine top-level full-line shell comments from command text before
// it is used to derive or match a persisted grant scope. Agents routinely
// prefix a command with a `# why I'm running this` line; if that comment
// stays part of the scope pattern, an identical command with a different (or
// absent) comment never matches a previously granted scope and re-prompts
// forever. Only a line whose first non-whitespace character is "#" at top
// level is removed:
//   - a "#" inside a '...', "..." or `...` quoted span is data, not a comment
//   - a line glued onto the previous one by a trailing backslash continuation
//     can never itself start a comment, however it looks in isolation — the
//     continuation makes it part of the prior (non-comment) line, and a
//     payload smuggled in that way must stay visible to scope matching
//   - a heredoc body is verbatim payload, never shell syntax, so lines
//     inside it are never treated as comments
// A backslash inside an already-open comment is ordinary comment text (real
// shells do not honor line continuation there), so it never extends the
// comment past its own line.
export function stripCommentLines(command: string): string {
  let out = "";
  let line = "";
  // Whether the physical/logical line currently being scanned is a comment:
  // "unknown" until its first non-whitespace, top-level character is seen.
  let commentState: "unknown" | "yes" | "no" = "unknown";
  let quote: '"' | "'" | "`" | null = null;
  let heredocMarker: string | null = null;

  const flushLine = (): void => {
    if (commentState !== "yes") out += line;
    line = "";
    commentState = "unknown";
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string;

    if (heredocMarker !== null) {
      line += ch;
      if (ch === "\n") {
        const lines = line.split("\n");
        const lastLine = lines[lines.length - 2] ?? "";
        if (lastLine.trim() === heredocMarker) heredocMarker = null;
        out += line;
        line = "";
      }
      continue;
    }

    if (quote !== null) {
      line += ch;
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      if (commentState === "unknown") commentState = "no";
      line += ch;
      continue;
    }

    // Line continuation only applies outside an already-open comment — inside
    // one, a backslash is just another comment character.
    if (
      commentState !== "yes" &&
      ch === "\\" &&
      (command[i + 1] === "\n" || command[i + 1] === "\r")
    ) {
      const after = command[i + 1] as string;
      line += ch + after;
      i += 1;
      if (after === "\r" && command[i + 1] === "\n") {
        line += "\n";
        i += 1;
      }
      if (commentState === "unknown") commentState = "no";
      // Deliberately do not flush: the next physical line is glued to this
      // one and must never independently qualify as a comment start.
      continue;
    }

    if (commentState !== "yes" && ch === "<" && command[i + 1] === "<") {
      const opener = parseHeredocOpener(command, i);
      if (opener !== null) {
        if (commentState === "unknown") commentState = "no";
        line += command.slice(i, opener.lineEnd);
        i = opener.lineEnd - 1;
        heredocMarker = opener.marker;
        continue;
      }
    }

    if (ch === "\n") {
      line += ch;
      flushLine();
      continue;
    }

    if (ch === " " || ch === "\t") {
      line += ch;
      continue;
    }

    if (commentState === "unknown") commentState = ch === "#" ? "yes" : "no";
    line += ch;
  }
  flushLine();
  return out;
}

// Whether `text` ends (ignoring trailing whitespace) in a redirect operator
// that has not yet received its target: a bare `>`/`<`, or a fd-duplication
// opener `>&`/`<&` awaiting the fd number.
const DANGLING_REDIRECT = /(?:>&|<&|>|<)$/;

function endsWithDanglingRedirect(text: string): boolean {
  return DANGLING_REDIRECT.test(text.trimEnd());
}

// The inner chain of a segment that is exactly one parenthesised group, or null
// when the segment is not a bare group (trailing redirects like `(a && b) 2>&1`
// keep the segment atomic). Quote-aware so a `)` inside quotes does not close
// the group early.
function unwrapGroup(segment: string): string | null {
  if (segment[0] !== "(" || segment[segment.length - 1] !== ")") return null;
  let quote: '"' | "'" | "`" | null = null;
  let depth = 0;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i] as string;
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(") depth++;
    if (ch === ")") {
      depth--;
      if (depth === 0) return i === segment.length - 1 ? segment.slice(1, -1) : null;
    }
  }
  return null;
}

// A full-line shell comment (or empty line) is a no-op: agents often paste
// markdown headings like `# worktree` into multi-line run_shell arguments, and
// those must not become approval subjects or allow-pattern prefixes.
export function isShellCommentOnly(segment: string): boolean {
  const trimmed = segment.trim();
  return trimmed.length === 0 || trimmed.startsWith("#");
}

// Segments with no program payload for approval purposes. Agents append
// `|| true` constantly, and naive chain-splitting strands bare control-flow
// keywords (`do` / `done` / …) as their own segments — neither should become
// approval subjects. Only the exact bare word counts (no args, redirects, or
// quoted forms that would PATH-lookup a different program).
const SHELL_NO_OPS = new Set([
  "true",
  "false",
  ":",
  "do",
  "done",
  "fi",
  "then",
  "else",
  "elif",
  "esac",
  "continue",
  "break",
]);

export function isShellNoOp(segment: string): boolean {
  return SHELL_NO_OPS.has(segment.trim());
}

// Split a single command segment into whitespace-separated tokens, treating a
// quoted run as one token. Backtick and `$(` are not treated as literal text
// even inside double quotes: shell double-quoting suppresses word-splitting
// and globbing, but command substitution still runs inside "...". Stripping
// a backtick pair as literal quoting (e.g. `cat "`/etc/passwd`"`) would glue
// the substituted command onto the surrounding text as one opaque token,
// hiding the plain path from every caller that inspects tokens (classify's
// dangerous-flag and path checks, commandTargetsRestricted's target scan).
// So a backtick — and the start of a `$(` substitution — acts as a bare
// token boundary, the same way whitespace does, whether or not a double
// quote is currently open; the content inside surfaces as its own visible
// token(s). Single quotes are the one shell construct that suppresses
// substitution entirely, so '...' keeps swallowing backticks and `$(`
// as literal characters.
export function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  // Depth of nested "(" seen since the last unmatched "$(" opener, and the
  // double-quote state to restore once the substitution's closing ")" is
  // reached. While a substitution is open its content is parsed like
  // top-level shell text (whitespace splits, its own quotes nest) even
  // though it may be sitting inside a double-quoted string, matching real
  // shell semantics: "..." suppresses word-splitting of the literal text
  // around a substitution, not the substitution's own parsing.
  let substDepth = 0;
  let savedQuote: '"' | "'" | null = null;

  const push = (): void => {
    if (current.length > 0) tokens.push(current);
    current = "";
  };

  const chars = command.trim();
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i] as string;

    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }

    if (ch === "`") {
      push();
      continue;
    }
    if (ch === "$" && chars[i + 1] === "(") {
      push();
      if (substDepth === 0) savedQuote = quote;
      substDepth++;
      quote = null;
      i++; // consume the "(" as part of the boundary, not a token
      continue;
    }
    if (substDepth > 0 && quote === null) {
      if (ch === "(") {
        substDepth++;
        current += ch;
        continue;
      }
      if (ch === ")") {
        substDepth--;
        if (substDepth === 0) {
          push();
          quote = savedQuote;
          continue;
        }
        current += ch;
        continue;
      }
    }

    if (quote === '"') {
      if (ch === '"') quote = null;
      else current += ch;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === " " || ch === "\t") {
      push();
      continue;
    }
    current += ch;
  }
  push();
  return tokens;
}

const MAX_PREFIX_SCOPES = 3;

// Commands that multiplex many subcommands of wildly different risk under one
// program name. A bare "git *" or "npm *" approval would silently cover
// `git push`, `git reset --hard`, `npm publish`, etc. — so for these the prefix
// ladder starts at two tokens (`git push *`), never the program alone.
const MULTIPLEXERS = new Set([
  "git",
  "npm",
  "pnpm",
  "yarn",
  "npx",
  "bun",
  "bunx",
  "docker",
  "kubectl",
  "cargo",
  "go",
  "make",
  "gh",
  "brew",
  "pip",
  "pip3",
  "python",
  "python3",
  "node",
]);

// Build the ladder of approval scopes for a shell command segment, broad to
// specific: "git commit *", "git commit -m *", then the exact command. The
// caller prepends a "just once" option.
export function deriveCommandScopes(rawCommand: string): ApprovalScope[] {
  // Strip model-authored comment lines before deriving anything, so the same
  // underlying command yields the same scopes regardless of what explanation
  // (if any) an agent wrapped around it.
  const command = stripCommentLines(rawCommand).trim();
  const tokens = tokenize(command);
  if (tokens.length === 0) return [];

  // A segment still carrying subshell syntax has no meaningful program prefix —
  // a persisted "(cd *" would match any subshell starting with cd, far broader
  // than what the operator saw. Offer only the exact command.
  if (command.startsWith("(")) {
    return [
      {
        id: "exact",
        label: "Always allow this exact command",
        pattern: escapeGlobLiteral(command),
      },
    ];
  }

  const scopes: ApprovalScope[] = [];
  const minPrefix = MULTIPLEXERS.has(tokens[0]!) ? 2 : 1;
  const prefixLimit = Math.min(tokens.length - 1, minPrefix + MAX_PREFIX_SCOPES - 1);
  for (let n = minPrefix; n <= prefixLimit; n++) {
    const prefix = tokens.slice(0, n).join(" ");
    const pattern = `${prefix} *`;
    scopes.push({ id: `prefix-${n}`, label: `Always allow ${pattern}`, pattern });
  }

  // Escape token text only — glob metacharacters typed into a real command
  // (e.g. the shell-expanded `*` in `rm -rf build/*`) must persist as a
  // literal match, never as a wildcard the grant did not actually grant.
  const exact = tokens.map(escapeGlobLiteral).join(" ");
  if (!scopes.some((s) => s.pattern === exact)) {
    scopes.push({ id: "exact", label: `Always allow this exact command`, pattern: exact });
  }
  return scopes;
}
