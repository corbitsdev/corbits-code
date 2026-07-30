import type { ApprovalScope } from "./types.js";
import { escapeGlobLiteral } from "./matcher.js";

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
      let j = i + 2;
      if (command[j] === "-") j++; // <<- strips leading tabs
      // Skip whitespace between << and the marker word.
      while (j < command.length && (command[j] === " " || command[j] === "\t")) j++;
      // The marker may be quoted ('EOF', "EOF", or bare EOF).
      let markerQuote: string | null = null;
      if (command[j] === "'" || command[j] === '"') {
        markerQuote = command[j] as string;
        j++;
      }
      let marker = "";
      while (
        j < command.length &&
        command[j] !== "\n" &&
        command[j] !== markerQuote &&
        // A bare (unquoted) marker is a single word; stop at whitespace so a
        // trailing redirect like `<<EOF > out.txt` is not folded into the
        // marker (which would leave the heredoc unterminated).
        !(markerQuote === null && (command[j] === " " || command[j] === "\t"))
      ) {
        marker += command[j++];
      }
      if (markerQuote !== null && command[j] === markerQuote) j++;
      // Advance j to the end of the line that opened the heredoc. This loop
      // previously tested command[j] but advanced i, so a marker followed by
      // trailing text (e.g. `<< 'EOF' > out.txt`) never terminated. The opening
      // line is appended exactly once via the slice below.
      while (j < command.length && command[j] !== "\n") j++;
      current += command.slice(i, j);
      i = j - 1;
      heredocMarker = marker;
      continue;
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
// quoted run as one token. Backtick is not treated as a quote delimiter here:
// unlike '...' and "...", a backtick pair is command substitution, not
// literal text — stripping it would hide the substituted command from every
// caller that inspects tokens (classify's dangerous-flag and path checks),
// letting it slip past as if it were quoted argument text.
export function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  const push = (): void => {
    if (current.length > 0) tokens.push(current);
    current = "";
  };

  for (const ch of command.trim()) {
    if (quote !== null) {
      if (ch === quote) quote = null;
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

// `&` is the background operator when it stands alone as a word — followed by
// whitespace or end of input. Anywhere else it is part of a redirect token:
// `2>&1`, `<&-`, `&>file`.
function isRedirectAmpersand(next: string | undefined): boolean {
  return !(next === undefined || next === " " || next === "\t");
}

const MAX_PREFIX_SCOPES = 3;

// Commands that multiplex many subcommands of wildly different risk under one
// program name. A bare "git *" or "npm *" approval would silently cover
// `git push`, `git reset --hard`, `npm publish`, etc. — so for these the prefix
// ladder starts at two tokens (`git push *`), never the program alone.
const MULTIPLEXERS = new Set([
  "git", "npm", "pnpm", "yarn", "npx", "bun", "bunx", "docker", "kubectl",
  "cargo", "go", "make", "gh", "brew", "pip", "pip3", "python", "python3", "node",
]);

// Build the ladder of approval scopes for a shell command segment, broad to
// specific: "git commit *", "git commit -m *", then the exact command. The
// caller prepends a "just once" option.
export function deriveCommandScopes(command: string): ApprovalScope[] {
  const tokens = tokenize(command);
  if (tokens.length === 0) return [];

  // A segment still carrying subshell syntax has no meaningful program prefix —
  // a persisted "(cd *" would match any subshell starting with cd, far broader
  // than what the operator saw. Offer only the exact command.
  if (command.startsWith("(")) {
    return [{ id: "exact", label: "Always allow this exact command", pattern: escapeGlobLiteral(command) }];
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
