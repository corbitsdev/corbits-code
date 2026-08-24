// --- Shell file evidence (CL-6937) -----------------------------------------
//
// The stop policy's requireEvidence gate (CritiqueDirector) measures whether
// a worker read anything by counting typed tool calls. Work done through
// run_shell was invisible to it, so a worker that read with `cat`/`rg`
// salvaged as incomplete-report. The prompt does prohibit shell file work,
// but a prompt violation should produce a correction, not a verdict that the
// work never happened.
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

export interface ShellFileEvidence {
  /** Keys for paths (or programs) the command read. */
  reads: string[];
}

function evidenceKey(program: string, operand: string | undefined): string {
  return operand !== undefined && operand.length > 0 ? operand : `shell:${program}`;
}

/**
 * Flags whose value is a separate token, so `head -n 5 f` does not read "5".
 * Union of the reader flag sets above plus the common script ones.
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

function classifySegment(segment: string, evidence: ShellFileEvidence): void {
  const tokens = tokenizeSegment(segment);
  if (tokens.length === 0) return;

  const program = programBasename(tokens[0]!);
  const args = tokens.slice(1);

  if (SHELL_READ_PROGRAMS.has(program)) {
    // grep-likes take the pattern first, so their file operand is the second.
    const skip = program === "grep" || program === "egrep" || program === "fgrep" ? 1 : 0;
    evidence.reads.push(evidenceKey(program, firstOperand(args, skip)));
  }
}

/**
 * Reads a run_shell command performs on files, for the stop policy's
 * requireEvidence check. Best effort by design: a missed read costs a
 * worker nothing (the typed tools remain the primary evidence).
 */
export function classifyShellFileEvidence(command: string): ShellFileEvidence {
  const evidence: ShellFileEvidence = { reads: [] };
  const { subjects } = expandShellSubjects(command);
  for (const subject of subjects) {
    for (const segment of splitChainedCommand(subject)) {
      classifySegment(segment, evidence);
    }
  }
  return {
    reads: [...new Set(evidence.reads)],
  };
}
