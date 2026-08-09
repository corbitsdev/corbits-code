import { realpathSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { SHELL_PWD_MARKER } from "../branding.js";

export { SHELL_PWD_MARKER };

/**
 * Wrap a user command so a successful subshell run can report its final cwd
 * without parsing `cd`. The marker line is stripped before returning output.
 */
export function wrapCommandWithPwdProbe(command: string): string {
  return `${command}
__ic_ec=$?
printf '%s%s\\n' '${SHELL_PWD_MARKER}' "$(pwd -P 2>/dev/null || pwd)"
exit $__ic_ec`;
}

export type PwdProbeParse = {
  output: string;
  finalCwd?: string;
};

/** Remove the pwd probe line and return the reported directory when present. */
export function parsePwdProbeOutput(raw: string): PwdProbeParse {
  const lines = raw.split("\n");
  let finalCwd: string | undefined;
  let markerIndex = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (line.startsWith(SHELL_PWD_MARKER)) {
      markerIndex = i;
      const path = line.slice(SHELL_PWD_MARKER.length).trim();
      if (path.length > 0) {
        try {
          finalCwd = realpathSync(path);
        } catch {
          finalCwd = resolve(path);
        }
      }
      break;
    }
  }
  if (markerIndex < 0) {
    return { output: raw };
  }
  const kept = [...lines.slice(0, markerIndex), ...lines.slice(markerIndex + 1)];
  while (kept.length > 0 && kept[kept.length - 1] === "") {
    kept.pop();
  }
  const output = kept.join("\n");
  return finalCwd !== undefined ? { output, finalCwd } : { output };
}

/** Clear error when the shell cannot start because the working directory is gone. */
export function missingShellCwdMessage(cwd: string): string {
  return `Shell working directory does not exist or is not a directory: ${cwd}. Use an explicit cwd argument or cd to a valid path first.`;
}

/** True when `candidate` resolves to the session root or a subdirectory of it. */
export function isShellCwdWithinSession(
  sessionRoot: string,
  candidate: string,
): boolean {
  const rel = relative(sessionRoot, candidate);
  return rel === "" || !rel.startsWith("..");
}

export function shellCwdEscapesSessionMessage(cwd: string): string {
  return `Shell cannot retain working directory outside the session workspace: ${cwd}. Stay within the project tree or use an explicit cwd argument.`;
}

export type ResolvePerCallShellCwdOptions = {
  // When true (--dangerously-skip-permissions), accept a cwd outside the session
  // root. Default false keeps the hard session fence.
  allowOutsideSession?: boolean;
};

/** Resolve a per-call `cwd` argument against the session root (not process.cwd()). */
export function resolvePerCallShellCwd(
  sessionRoot: string,
  cwdArg: string,
  options: ResolvePerCallShellCwdOptions = {},
): string {
  const root = realpathSync(sessionRoot);
  const candidate = resolve(root, cwdArg);
  let resolved: string;
  try {
    resolved = realpathSync(candidate);
  } catch {
    resolved = candidate;
  }
  if (
    options.allowOutsideSession !== true &&
    !isShellCwdWithinSession(root, resolved)
  ) {
    throw new Error(shellCwdEscapesSessionMessage(resolved));
  }
  return resolved;
}

export function assertShellCwdUsable(cwd: string): void {
  try {
    const st = statSync(cwd);
    if (!st.isDirectory()) {
      throw new Error(missingShellCwdMessage(cwd));
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Shell working directory")) {
      throw err;
    }
    throw new Error(missingShellCwdMessage(cwd));
  }
}
