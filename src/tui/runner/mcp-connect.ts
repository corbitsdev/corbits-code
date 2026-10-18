import {
  armExecMcpHandshakeAbort,
  EXEC_MCP_HANDSHAKE_TIMEOUT_MS,
  followExecMcpHandshake,
} from "../../exec/mcp-handshake.js";

/**
 * Bound one TUI MCP dial (or the startup batch) the same way headless does.
 * The timer aborts only while the handshake is still in flight: the toolset
 * detaches each server's forward on settle, and this disarms the timer when
 * the dial fulfills, so a live sibling is not torn down. A hung dial fails
 * through that abort instead of leaving the batch pending forever.
 */
export function runTuiMcpDial(
  dial: (signal: AbortSignal) => Promise<void>,
  exitSignal: AbortSignal,
  timeoutMs: number = EXEC_MCP_HANDSHAKE_TIMEOUT_MS,
): Promise<void> {
  const handshake = armExecMcpHandshakeAbort(timeoutMs);
  const signal = AbortSignal.any([exitSignal, handshake.signal]);
  return followExecMcpHandshake(dial(signal), handshake);
}
