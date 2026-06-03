import type { ApprovalScope } from "./types.js";

// Split a shell command into the individual commands it chains together, so each
// is classified and approved on its own. Operators recognised: && || | ; and a
// newline. Splitting is quote-aware — operators inside '...', "..." or `...` are
// part of an argument, not a separator.
export function splitChainedCommand(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: '"' | "'" | "`" | null = null;

  const push = (): void => {
    const trimmed = current.trim();
    if (trimmed.length > 0) segments.push(trimmed);
    current = "";
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string;
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

// Build the ladder of approval scopes for a shell command segment, broad to
// specific: "npm *", "npm exec *", "npm exec --vite *", then the exact command.
// The caller prepends a "just once" option.
export function deriveCommandScopes(command: string): ApprovalScope[] {
  const tokens = tokenize(command);
  if (tokens.length === 0) return [];

  const scopes: ApprovalScope[] = [];
  const prefixLimit = Math.min(tokens.length - 1, MAX_PREFIX_SCOPES);
  for (let n = 1; n <= prefixLimit; n++) {
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
