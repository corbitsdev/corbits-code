import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";

/** Sentinel line suffix appended after the user command to read the shell's cwd. */
export const SHELL_PWD_MARKER = "__INTERCODE_SHELL_PWD_END__";

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