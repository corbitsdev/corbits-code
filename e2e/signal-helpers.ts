import { createTempDirs } from "../testkit/temporary-dirs.js";

/**
 * Reads a spawned fixture's stdout pipe until the first chunk containing
 * `\n` (or EOF) and returns the raw decoded buffer. Fixture children print
 * their session dir as the very first line, so signal tests split this on
 * `"\n"` to learn the run dir before sending a signal.
 */
export async function readLine(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (!buffer.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
  }
  reader.releaseLock();
  return buffer;
}

function spawnFixtureProc(
  fixture: string,
  cwd: string,
  home: string,
  sessionEnv: Record<string, string>,
) {
  return Bun.spawn(["bun", "run", fixture], {
    cwd,
    env: {
      ...process.env,
      HOME: home,
      ...sessionEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

export type SignalFixtureProc = ReturnType<typeof spawnFixtureProc>;

export interface SpawnedSignalFixture {
  readonly proc: SignalFixtureProc;
  readonly cwd: string;
  readonly home: string;
  /** Raw first-chunk stdout output; split on "\n" for the run dir. */
  readonly output: string;
  cleanup(): void;
}

export interface SpawnSignalFixtureOptions {
  readonly fixture: string;
  readonly cwdPrefix: string;
  readonly homePrefix: string;
  /** Optional session id, handed to the fixture child in `sessionIdEnv`. */
  readonly sessionId?: string;
  /** Env var name carrying `sessionId` (default `SIGNAL_TEST_SESSION_ID`). */
  readonly sessionIdEnv?: string;
  /**
   * Extra child env for fixture variants (rotation ids, reap tokens). As a
   * function it receives the spawned cwd/home so files can live inside the
   * isolated pair; HOME is already set to `home`.
   */
  readonly extraEnv?:
    | Record<string, string>
    | ((dirs: { readonly cwd: string; readonly home: string }) => {
        readonly [key: string]: string;
      });
}

/**
 * Creates an isolated cwd/home pair, spawns a crash/signal fixture child,
 * and reads its first stdout chunk. Callers keep their own run-dir
 * validation, signal matrix, kill, and exit-code assertions; call `cleanup`
 * from a `finally` block.
 */
export async function spawnSignalFixture(
  options: SpawnSignalFixtureOptions,
): Promise<SpawnedSignalFixture> {
  const dirs = createTempDirs(options.cwdPrefix, options.homePrefix);
  const extra =
    typeof options.extraEnv === "function"
      ? options.extraEnv({ cwd: dirs.cwd, home: dirs.home })
      : options.extraEnv;
  const sessionEnv =
    options.sessionId === undefined
      ? {}
      : {
          [options.sessionIdEnv ?? "SIGNAL_TEST_SESSION_ID"]: options.sessionId,
        };
  const proc = spawnFixtureProc(options.fixture, dirs.cwd, dirs.home, {
    ...sessionEnv,
    ...extra,
  });
  const output = await readLine(proc.stdout);
  return {
    proc,
    cwd: dirs.cwd,
    home: dirs.home,
    output,
    cleanup: () => dirs.cleanup(),
  };
}
