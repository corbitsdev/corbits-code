// CL-3441 spike: measures how many bytes and writes Ink emits per render tick
// for the TUI's two dominant repaint shapes — an idle spinner (one line
// changes) and streaming assistant text (content keeps growing). Ink cannot be
// driven headlessly through a real TTY without a pty, so this measures Ink's
// own `render()` against a counting stream that reports itself as a TTY, which
// is the boundary Ink's `shouldSynchronize` and `log-update` diffing both key
// off. This is a component-level measurement, not a full `runTUI` drive.

import { Writable } from "node:stream";

import { render as inkRender } from "ink";
import React from "react";

export type TickSample = {
  readonly tick: number;
  readonly bytesWritten: number;
  readonly writeCount: number;
};

export type ScenarioResult = {
  readonly scenario: string;
  readonly incrementalRendering: boolean;
  readonly samples: readonly TickSample[];
  readonly totalBytes: number;
  readonly totalWrites: number;
  readonly avgBytesPerTick: number;
  readonly avgWritesPerTick: number;
};

class CountingStdout extends Writable {
  isTTY = true;
  columns = 100;
  rows = 40;
  bytesWritten = 0;
  writeCount = 0;

  override _write(chunk: unknown, _encoding: string, callback: (error?: Error | null) => void): void {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    this.bytesWritten += buf.byteLength;
    this.writeCount += 1;
    callback();
  }

  // Ink probes these on a real TTY stream; a plain Writable lacks them.
  override on(event: string, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener);
  }
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function IdleSpinner({ frame }: { frame: number }): React.ReactElement {
  return React.createElement(
    "ink-text",
    null,
    `${SPINNER_FRAMES[frame % SPINNER_FRAMES.length]} Working…`,
  );
}

function StreamingText({ text }: { text: string }): React.ReactElement {
  return React.createElement("ink-text", null, text);
}

const STREAM_CHUNK = "The quick brown fox jumps over the lazy dog. ";

async function driveTicks(
  scenario: string,
  incrementalRendering: boolean,
  tickCount: number,
  renderTick: (tick: number) => React.ReactElement,
): Promise<ScenarioResult> {
  const stdout = new CountingStdout();
  const { rerender, unmount } = inkRender(renderTick(0), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: process.stdin,
    exitOnCtrlC: false,
    patchConsole: false,
    incrementalRendering,
  });

  const samples: TickSample[] = [];
  let prevBytes = 0;
  let prevWrites = 0;

  for (let tick = 1; tick < tickCount; tick++) {
    rerender(renderTick(tick));
    // Ink's throttled render flushes on a leading+trailing edge; give the
    // microtask/timer queue a turn so the write actually lands before sampling.
    await new Promise((resolve) => setTimeout(resolve, 5));
    samples.push({
      tick,
      bytesWritten: stdout.bytesWritten - prevBytes,
      writeCount: stdout.writeCount - prevWrites,
    });
    prevBytes = stdout.bytesWritten;
    prevWrites = stdout.writeCount;
  }

  unmount();

  const totalBytes = samples.reduce((sum, s) => sum + s.bytesWritten, 0);
  const totalWrites = samples.reduce((sum, s) => sum + s.writeCount, 0);

  return {
    scenario,
    incrementalRendering,
    samples,
    totalBytes,
    totalWrites,
    avgBytesPerTick: totalBytes / samples.length,
    avgWritesPerTick: totalWrites / samples.length,
  };
}

export async function runIdleSpinnerScenario(
  tickCount: number,
  incrementalRendering: boolean,
): Promise<ScenarioResult> {
  return driveTicks("idle-spinner", incrementalRendering, tickCount, (tick) =>
    React.createElement(IdleSpinner, { frame: tick }),
  );
}

export async function runStreamingTextScenario(
  tickCount: number,
  incrementalRendering: boolean,
): Promise<ScenarioResult> {
  return driveTicks("streaming-text", incrementalRendering, tickCount, (tick) =>
    React.createElement(StreamingText, { text: STREAM_CHUNK.repeat(tick + 1) }),
  );
}

export function formatScenarioResult(result: ScenarioResult): string {
  const mode = result.incrementalRendering ? "incremental" : "standard";
  return [
    `${result.scenario} [${mode}]`,
    `  total bytes:  ${result.totalBytes}`,
    `  total writes: ${result.totalWrites}`,
    `  avg bytes/tick:  ${result.avgBytesPerTick.toFixed(1)}`,
    `  avg writes/tick: ${result.avgWritesPerTick.toFixed(2)}`,
  ].join("\n");
}

if (import.meta.main) {
  const TICKS = 40;
  const results = await Promise.all([
    runIdleSpinnerScenario(TICKS, false),
    runIdleSpinnerScenario(TICKS, true),
    runStreamingTextScenario(TICKS, false),
    runStreamingTextScenario(TICKS, true),
  ]);
  for (const result of results) {
    console.log(formatScenarioResult(result));
    console.log("");
  }
}
