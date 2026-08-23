/**
 * System clipboard port for app-owned copy paths.
 *
 * Used by drag-select auto-copy (OpenTUI selection on mouse-up), Alt+C copy
 * mode, and related keyboard paths. Native terminal drag-select is still
 * unavailable while DEC mouse reporting is on — Alt+M hands the mouse back
 * when that is wanted. Native helpers are preferred; OSC 52 is the fallback
 * for remote sessions where no helper binary exists.
 */

import type { ClipboardPort } from "./copy-path.js";

export type SpawnClipboard = (argv: readonly string[], text: string) => Promise<boolean>;

/** Candidate write commands, most specific platform first. */
export function clipboardCommands(platform: NodeJS.Platform): readonly (readonly string[])[] {
  if (platform === "darwin") return [["pbcopy"]];
  if (platform === "win32") return [["clip"]];
  return [["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]];
}

/** OSC 52 clipboard-set sequence for `text`. */
export function osc52(text: string): string {
  return `]52;c;${Buffer.from(text, "utf8").toString("base64")}`;
}

async function spawnWrite(argv: readonly string[], text: string): Promise<boolean> {
  try {
    const proc = Bun.spawn([...argv], {
      stdin: new TextEncoder().encode(text),
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

export interface SystemClipboardOptions {
  readonly platform?: NodeJS.Platform;
  readonly spawn?: SpawnClipboard;
  /** Where OSC 52 is written when no helper binary works. */
  readonly writeEscape?: (seq: string) => void;
}

/**
 * Clipboard port that writes through a platform helper, falling back to OSC 52.
 * Every attempt is guarded: a missing helper must degrade, never throw into the
 * key handler.
 */
export function createSystemClipboard(options?: SystemClipboardOptions): ClipboardPort {
  const platform = options?.platform ?? process.platform;
  const spawn = options?.spawn ?? spawnWrite;
  const writeEscape =
    options?.writeEscape ??
    ((seq: string) => {
      process.stdout.write(seq);
    });
  const commands = clipboardCommands(platform);

  return {
    writeText: async (text: string) => {
      for (const argv of commands) {
        if (await spawn(argv, text)) return;
      }
      writeEscape(osc52(text));
    },
  };
}
