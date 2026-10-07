import type { ApprovalScope } from "./types.js";
import { escapeGlobLiteral } from "./matcher.js";
import {
  isHeredocTerminator,
  parseHeredocOpener,
} from "../shell/command-segments.js";

export { splitChainedCommand } from "../shell/command-segments.js";

// Remove genuine top-level full-line shell comments before deriving or
// matching a persisted grant scope: a kept `# why` line makes an identical
// command with a different (or absent) comment re-prompt forever. Only a line
// whose first non-whitespace char is "#" at top level is removed:
//   - "#" inside quotes or backticks is data, not a comment
//   - a backslash-continued line can never start a comment — payload smuggled
//     in that way must stay visible to scope matching
//   - a heredoc body is verbatim payload, never shell syntax
// A backslash inside an already-open comment is ordinary text (shells do not
// honor line continuation there), so it never extends past its own line.
export function stripCommentLines(command: string): string {
  let out = "";
  let line = "";
  // Comment state of the current line: "unknown" until its first
  // non-whitespace, top-level character is seen.
  let commentState: "unknown" | "yes" | "no" = "unknown";
  let quote: '"' | "'" | "`" | null = null;
  let heredocMarker: string | null = null;
  let heredocStripTabs = false;

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
        if (isHeredocTerminator(lastLine, heredocMarker, heredocStripTabs)) {
          heredocMarker = null;
          heredocStripTabs = false;
        }
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
        heredocStripTabs = opener.stripTabs;
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

// A full-line shell comment (or empty line) is a no-op: pasted markdown
// headings must not become approval subjects or allow-pattern prefixes.
export function isShellCommentOnly(segment: string): boolean {
  const trimmed = segment.trim();
  return trimmed.length === 0 || trimmed.startsWith("#");
}

// Segments with no program payload for approval purposes: agents append
// `|| true` constantly, and naive chain-splitting strands bare control-flow
// keywords as their own segments — neither should become approval subjects.
// Only the exact bare word counts (no args, redirects, or quoted forms).
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

// Split a command segment into whitespace-separated tokens, treating a quoted
// run as one token. Backtick and `$(` are not literal text even inside double
// quotes: command substitution still runs there, and treating it as literal
// quoting would glue the substituted command onto the surrounding text as one
// opaque token, hiding a plain path from token consumers (classify's
// dangerous-flag and path checks, commandTargetsRestricted's target scan).
// So a backtick — and the start of a `$(` — is a bare token boundary whether
// or not a double quote is open. Single quotes suppress substitution, so
// '...' keeps swallowing backticks and `$(` as literal characters.
export function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  // Nested "(" depth since the last unmatched "$(" opener, and the quote
  // state to restore once the substitution closes. Inside a substitution,
  // content parses like top-level shell text even within double quotes —
  // "..." only suppresses word-splitting of the literal text around it.
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
      i++; // consume "(" as part of the boundary, not a token
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

// Commands whose subcommands vary widely in risk: a bare "git *" or "npm *"
// approval would silently cover `git push`, `git reset --hard`, `npm publish`,
// etc. — so the prefix ladder starts at two tokens, never the program alone.
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
// specific: "git commit *", "git commit -m *", then the exact command.
export function deriveCommandScopes(rawCommand: string): ApprovalScope[] {
  // Strip model-authored comment lines first, so the same command yields the
  // same scopes regardless of any explanation wrapped around it.
  const command = stripCommentLines(rawCommand).trim();
  const tokens = tokenize(command);
  if (tokens.length === 0) return [];

  // A segment still carrying subshell syntax has no meaningful program prefix:
  // a persisted "(cd *" would match any subshell starting with cd. Offer only
  // the exact command.
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
  const firstToken = tokens[0];
  const minPrefix =
    firstToken !== undefined && MULTIPLEXERS.has(firstToken) ? 2 : 1;
  const prefixLimit = Math.min(
    tokens.length - 1,
    minPrefix + MAX_PREFIX_SCOPES - 1,
  );
  for (let n = minPrefix; n <= prefixLimit; n++) {
    const prefix = tokens.slice(0, n).join(" ");
    const pattern = `${prefix} *`;
    scopes.push({
      id: `prefix-${n}`,
      label: `Always allow ${pattern}`,
      pattern,
    });
  }

  // Escape token text only: a shell-expanded glob character (e.g. the `*` in
  // `rm -rf build/*`) must persist as a literal match, never a wildcard the
  // grant did not actually grant.
  const exact = tokens.map(escapeGlobLiteral).join(" ");
  if (!scopes.some((s) => s.pattern === exact)) {
    scopes.push({
      id: "exact",
      label: `Always allow this exact command`,
      pattern: exact,
    });
  }
  return scopes;
}
