// DEC synchronized-output (mode 2026) wrapper for the handful of TUI writes
// that go straight to `process.stdout` outside Ink's own render loop (alt-screen
// enter/exit, mouse-reporting toggles in src/tui/runner.ts). Ink 7 already
// wraps every one of its own frame writes in `\x1b[?2026h` / `\x1b[?2026l`
// (node_modules/ink/build/write-synchronized.js), so this exists only for
// writes Ink never sees, not as a replacement for Ink's own wrapping.

const BEGIN_SYNCHRONIZED_UPDATE = "\x1b[?2026h";
const END_SYNCHRONIZED_UPDATE = "\x1b[?2026l";

export function supportsSynchronizedOutput(stream: NodeJS.WriteStream): boolean {
  return stream.isTTY === true;
}

export function createSyncOutputWriter(stream: NodeJS.WriteStream) {
  let depth = 0;

  return function withSyncOutput(write: () => void): void {
    if (!supportsSynchronizedOutput(stream)) {
      write();
      return;
    }

    // A DEC-2026-aware terminal ignores a nested begin/end pair, but guarding
    // here keeps this writer correct even against terminals that don't.
    const isOutermost = depth === 0;
    depth += 1;
    try {
      if (isOutermost) stream.write(BEGIN_SYNCHRONIZED_UPDATE);
      write();
    } finally {
      depth -= 1;
      if (isOutermost) stream.write(END_SYNCHRONIZED_UPDATE);
    }
  };
}
