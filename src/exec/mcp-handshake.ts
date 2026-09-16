// Log threshold while MCP connect is still in flight. Workflow resume and first
// inference wait for connecting to settle because capability gates skip MCP
// tools that land after resume; the runner is sequential, so this also delays
// first infer. Hung dials cannot wait forever: the abort cap below is the bound.
export const EXEC_MCP_CONNECT_WAIT_MS = 1_000;
// Cap on the handshake itself. Abort only reaches in-flight dials; a live
// sibling detaches its forward on settle so this timer cannot tear it down.
export const EXEC_MCP_HANDSHAKE_TIMEOUT_MS = 15_000;

export async function awaitExecMcpConnect(
  connecting: Promise<void>,
  timeoutMs: number,
): Promise<"settled" | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      connecting.then(() => "settled" as const),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// Connect-only abort. The MCP client ties `signal` to the transport lifecycle,
// so AbortSignal.timeout would kill a handshake that already succeeded. The
// toolset forwards this signal per server and detaches on settle; abort only
// reaches handshakes still in flight. Disarm only when the batch fulfills —
// a rejected Promise.all still leaves sibling forwards armed.
export function armExecMcpHandshakeAbort(timeoutMs: number): {
  signal: AbortSignal;
  disarm: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  let disarmed = false;
  return {
    signal: controller.signal,
    disarm: () => {
      if (disarmed) return;
      disarmed = true;
      clearTimeout(timer);
    },
  };
}

export function followExecMcpHandshake(
  connecting: Promise<void>,
  handshake: { disarm: () => void },
): Promise<void> {
  return connecting.then(() => {
    handshake.disarm();
  });
}

function whenAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

export async function awaitExecMcpThenResume(
  connecting: Promise<void>,
  resume: () => Promise<void>,
  options: {
    waitMs: number;
    abort: AbortSignal;
    onWaitTimeout?: () => void;
  },
): Promise<void> {
  const outcome = await awaitExecMcpConnect(connecting, options.waitMs);
  if (outcome === "timeout") options.onWaitTimeout?.();
  await Promise.race([connecting, whenAborted(options.abort)]);
  await resume();
}
