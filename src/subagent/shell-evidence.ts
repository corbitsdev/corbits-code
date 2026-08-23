// --- Shell file evidence (CL-6937) -----------------------------------------
//
// The stop policy measures whether a worker did real work by counting typed
// tool calls. Work done through run_shell was invisible to it, so a worker that
// edited with `sed -i` salvaged as never-edited (a sticky hard block) and one
// that read with `cat` salvaged as incomplete-report. The prompt does prohibit
// shell file work, but a prompt violation should produce a correction, not a
// verdict that the work never happened.
//
// This reuses the same subject expansion the auto-shell policy uses, so
// `bash -c`, `env -S`, and xargs payloads are inspected rather than trusted.

import { splitChainedCommand } from "../permission/command.js";
import {
  expandShellSubjects,
  GREP_VALUE_FLAGS,
  HEAD_TAIL_VALUE_FLAGS,
  programBasename,
  tokenizeSegment,
} from "../shell/run-shell-authz.js";

const SHELL_READ_PROGRAMS: ReadonlySet<string> = new Set([
  "cat",
  "head",
  "tail",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "ag",
  "ack",
  "awk",
  "sed",
  "diff",
  "find",
  "fd",
  "wc",
  "nl",
  "cut",
  "sort",
  "uniq",
  "od",
  "xxd",
  "strings",
  "jq",
  "yq",
  "file",
  "stat",
  "ls",
]);

/** Programs whose ordinary use rewrites a file operand in place. */
const SHELL_WRITE_PROGRAMS: ReadonlySet<string> = new Set([
  "tee",
  "cp",
  "mv",
  "install",
  "touch",
  "truncate",
  "patch",
  "ln",
]);

/** In-place editors: only a write when the in-place flag is actually present. */
const SHELL_IN_PLACE_PROGRAMS: ReadonlySet<string> = new Set(["sed", "perl", "ruby", "gsed"]);

const IN_PLACE_FLAG = /^-{1,2}(i|in-place)(=.*)?$/;
/** `sed -i.bak`, `perl -pi -e`, `sed -Ei` — the flag is fused with other letters. */
const FUSED_IN_PLACE_FLAG = /^-[A-Za-z]*i/;

export interface ShellFileEvidence {
  /** Keys for paths (or programs) the command read. */
  reads: string[];
  /** Keys for paths (or programs) the command wrote. */
  writes: string[];
}

function evidenceKey(program: string, operand: string | undefined): string {
  return operand !== undefined && operand.length > 0 ? operand : `shell:${program}`;
}

/**
 * Flags whose value is a separate token, so `head -n 5 f` does not read "5".
 * Union of the reader flag sets above plus the common in-place/script ones.
 */
const EVIDENCE_VALUE_FLAGS: ReadonlySet<string> = new Set([
  ...HEAD_TAIL_VALUE_FLAGS,
  ...GREP_VALUE_FLAGS,
  "-e",
  "-E",
  "-d",
  "-t",
  "-s",
  "--expression",
  "--delimiter",
]);

/** First operand that is not a flag or a flag value, skipping `skip` of them. */
function firstOperand(args: readonly string[], skip: number): string | undefined {
  let skipped = 0;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") continue;
    if (arg.startsWith("-")) {
      if (EVIDENCE_VALUE_FLAGS.has(arg)) i += 1;
      continue;
    }
    if (skipped < skip) {
      skipped += 1;
      continue;
    }
    return arg.replace(/['"]/g, "");
  }
  return undefined;
}

/** A redirect target is one word: heredoc bodies arrive in the same string. */
function redirectTarget(raw: string): string | undefined {
  const word = raw.replace(/['"]/g, "").trim().split(/\s/)[0];
  return word !== undefined && word.length > 0 ? word : undefined;
}

function classifySegment(segment: string, evidence: ShellFileEvidence): void {
  const tokens = tokenizeSegment(segment);
  if (tokens.length === 0) return;

  // Output redirection is a write regardless of the program: `echo x > f`,
  // heredocs (`cat <<'EOF' > f`), `>>` appends.
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const match = /^>{1,2}$/.exec(token);
    if (match !== null) {
      const target = tokens[i + 1];
      const named = target === undefined ? undefined : redirectTarget(target);
      if (named !== undefined) evidence.writes.push(named);
      continue;
    }
    const fused = /^>{1,2}(?!$)(.+)$/.exec(token);
    if (fused !== null) {
      const named = redirectTarget(fused[1]!);
      if (named !== undefined) evidence.writes.push(named);
    }
  }

  const program = programBasename(tokens[0]!);
  const args = tokens.slice(1);

  if (SHELL_IN_PLACE_PROGRAMS.has(program)) {
    const inPlace = args.some(
      (arg) => IN_PLACE_FLAG.test(arg) || (arg.startsWith("-") && FUSED_IN_PLACE_FLAG.test(arg)),
    );
    if (inPlace) {
      // sed/perl take the script before the file operand, unless -e already
      // consumed it (`perl -pi -e 's/a/b/' f`).
      const scriptInFlag = args.some((arg) => arg === "-e" || arg === "--expression");
      evidence.writes.push(evidenceKey(program, firstOperand(args, scriptInFlag ? 0 : 1)));
      return;
    }
  }
  if (SHELL_WRITE_PROGRAMS.has(program)) {
    evidence.writes.push(evidenceKey(program, firstOperand(args, 0)));
    return;
  }
  if (SHELL_READ_PROGRAMS.has(program)) {
    // grep-likes take the pattern first, so their file operand is the second.
    const skip = program === "grep" || program === "egrep" || program === "fgrep" ? 1 : 0;
    evidence.reads.push(evidenceKey(program, firstOperand(args, skip)));
  }
}

/**
 * Reads and writes a run_shell command performs on files, for the stop policy's
 * requireEdit / requireEvidence checks. Best effort by design: a missed read
 * costs a worker nothing (the typed tools remain the primary evidence), while a
 * missed write is exactly the false salvage this exists to prevent, so writes
 * are recognized from redirection as well as from the program name.
 */
export function classifyShellFileEvidence(command: string): ShellFileEvidence {
  const evidence: ShellFileEvidence = { reads: [], writes: [] };
  const { subjects } = expandShellSubjects(command);
  for (const subject of subjects) {
    for (const segment of splitChainedCommand(subject)) {
      classifySegment(segment, evidence);
    }
  }
  return {
    reads: [...new Set(evidence.reads)],
    writes: [...new Set(evidence.writes)],
  };
}
