import type { ApprovalScope } from "./types.js";

// Split a shell command into the individual commands it chains together, so each
// is classified and approved on its own. Operators recognised: && || | ; and a
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
    if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
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
      push();
      continue;
    }
    current += ch;
  }
  push();
  return coalesceRedirectRemnants(segments);
}

// A chain operator can strand a redirect fd-duplication target as its own
// segment (e.g. a model emitting "cmd ; 1" or "cmd && &1" where the intended
// redirect got split across the operator). Such a fragment tokenizes to
// something that is never a real program: bare digits, a bare "-", or "&"
// paired with digits/"-". Surfacing it as its own "Run shell command" approval
// is spurious, so fold it back into the command it belongs to.
const REDIRECT_REMNANT = /^(-?\d+|&-?\d*)$/;

function isRedirectRemnant(segment: string): boolean {
  return REDIRECT_REMNANT.test(segment.trim());
}

function coalesceRedirectRemnants(segments: string[]): string[] {
  const coalesced: string[] = [];
  for (const segment of segments) {
    if (coalesced.length > 0 && isRedirectRemnant(segment)) {
      coalesced[coalesced.length - 1] = `${coalesced[coalesced.length - 1]} ${segment}`;
      continue;
    }
    coalesced.push(segment);
  }
  return coalesced;
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

// Split a single command segment into whitespace-separated tokens, treating a
// quoted run as one token.
export function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | "`" | null = null;

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
    if (ch === '"' || ch === "'" || ch === "`") {
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
    return [{ id: "exact", label: "Always allow this exact command", pattern: command }];
  }

  const scopes: ApprovalScope[] = [];
  const minPrefix = MULTIPLEXERS.has(tokens[0]!) ? 2 : 1;
  const prefixLimit = Math.min(tokens.length - 1, minPrefix + MAX_PREFIX_SCOPES - 1);
  for (let n = minPrefix; n <= prefixLimit; n++) {
    const prefix = tokens.slice(0, n).join(" ");
    const pattern = `${prefix} *`;
    scopes.push({ id: `prefix-${n}`, label: `Always allow ${pattern}`, pattern });
  }

  const exact = tokens.join(" ");
  if (!scopes.some((s) => s.pattern === exact)) {
    scopes.push({ id: "exact", label: `Always allow this exact command`, pattern: exact });
  }
  return scopes;
}
