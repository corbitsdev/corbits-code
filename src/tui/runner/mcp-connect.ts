import {
  armExecMcpHandshakeAbort,
  bindDeferredMcpHandshake,
  EXEC_MCP_HANDSHAKE_TIMEOUT_MS,
  followExecMcpHandshake,
} from "../../exec/mcp-handshake.js";

/**
 * Bound one TUI MCP dial (or the startup batch) the same way headless does.
 * The timer starts on the first dial after trust filtering, then aborts
 * handshakes still in flight. A server that reaches interactive browser auth
 * drops this abort and keeps the browser-auth budget; a dial that never gets
 * that far still fails closed. The toolset detaches each server's forward on
 * settle, and this disarms the timer when the dial fulfills, so a live sibling
 * is not torn down.
 */
export function runTuiMcpDial(
  dial: (signal: AbortSignal) => Promise<void>,
  exitSignal: AbortSignal,
  timeoutMs: number = EXEC_MCP_HANDSHAKE_TIMEOUT_MS,
): Promise<void> {
  const handshake = armExecMcpHandshakeAbort(timeoutMs, "later");
  const signal = AbortSignal.any([exitSignal, handshake.signal]);
  bindDeferredMcpHandshake(signal, handshake.start);
  return followExecMcpHandshake(dial(signal), handshake);
}
