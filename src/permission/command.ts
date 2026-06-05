import type { ApprovalScope } from "./types.js";

// Split a shell command into the individual commands it chains together, so each
// is classified and approved on its own. Operators recognised: && || | ; and a
// newline. Splitting is quote-aware — operators inside '...', "..." or `...` are
// part of an argument, not a separator. Heredoc bodies (<< 'MARKER' ... MARKER)
// are treated as atomic — newlines inside them are not chain boundaries.
export function splitChainedCommand(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: '"' | "'" | "`" | null = null;
  let heredocMarker: string | null = null;

  const push = (): void => {
    const trimmed = current.trim();
    if (trimmed.length > 0) segments.push(trimmed);
    current = "";
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
      while (j < command.length && command[j] !== "\n" && command[j] !== markerQuote) {
        marker += command[j++];
      }
      if (markerQuote !== null && command[j] === markerQuote) j++;
      // Consume the rest of the line that opened the heredoc.
      while (j < command.length && command[j] !== "\n") {
        current += command[i];
        i++;
      }
      // Include everything up to j in current and set heredoc mode.
      current += command.slice(i, j);
      i = j - 1;
      heredocMarker = marker;
      continue;
    }

    const next = command[i + 1];
    if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
      push();
      i++;
      continue;
    }
    if (ch === "|" || ch === ";" || ch === "\n") {
      push();
      continue;
    }
    current += ch;
  }
  push();
  return segments;
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
