import { createServer, type Server } from "node:http";

import { CODEX_CALLBACK_PATH, CODEX_CALLBACK_PORT } from "./constants.js";

export type CodexCallbackServer = {
  // Resolves with the validated authorization code once the browser redirects
  // back, or rejects if the server reports an error, the state mismatches, or
  // the signal aborts.
  waitForCode: (expectedState: string, signal: AbortSignal) => Promise<string>;
  close: () => void;
};

const DONE_HTML =
  "<!doctype html><meta charset=utf-8><title>Authorized</title>" +
  '<body style="font-family:system-ui;padding:3rem;text-align:center">' +
  "<h1>Codex authorization complete</h1><p>You can close this tab and return to Intercode.</p>";

// Start the loopback server that receives the Codex OAuth redirect. Unlike the
// MCP callback server, the port is fixed (1455): the authorization server only
// accepts the one redirect_uri registered for the Codex client, so a random
// port would be rejected. A bind failure here means the port is already in use
// (e.g. a concurrent login or the official Codex CLI), which is surfaced as a
// clear error rather than silently picking another port.
export async function startCodexCallbackServer(): Promise<CodexCallbackServer> {
  let resolveCode: ((code: string) => void) | undefined;
  let rejectCode: ((err: Error) => void) | undefined;
  let expected: string | undefined;
  let settled = false;

  const finish = (outcome: { code: string } | { error: Error }): void => {
    if (settled) return;
    settled = true;
    if ("error" in outcome) rejectCode?.(outcome.error);
    else resolveCode?.(outcome.code);
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${String(CODEX_CALLBACK_PORT)}`);
    if (url.pathname !== CODEX_CALLBACK_PATH) {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    const state = url.searchParams.get("state");

    // A state mismatch means this redirect does not belong to the flow we
    // started; reject the request and the wait rather than trusting the code.
    if (expected !== undefined && state !== expected) {
      res.statusCode = 400;
      res.end("Authorization failed: state mismatch");
      finish({ error: new Error("Authorization state did not match; possible CSRF — login aborted.") });
      return;
    }

    res.statusCode = error !== null || code === null ? 400 : 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(error !== null || code === null ? `Authorization failed: ${error ?? "no code returned"}` : DONE_HTML);

    if (error !== null) finish({ error: new Error(`Authorization failed: ${error}`) });
    else if (code === null) finish({ error: new Error("Authorization redirect carried no code.") });
    else finish({ code });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(
          new Error(
            `Port ${String(CODEX_CALLBACK_PORT)} is already in use. Close any other Codex login (or the codex CLI) and try again.`,
          ),
        );
      } else {
        reject(err);
      }
    });
    server.listen(CODEX_CALLBACK_PORT, "127.0.0.1", resolve);
  });

  return {
    waitForCode: (expectedState: string, signal: AbortSignal) =>
      new Promise<string>((resolve, reject) => {
        expected = expectedState;
        resolveCode = resolve;
        rejectCode = reject;
        if (signal.aborted) {
          finish({ error: new Error("aborted") });
          return;
        }
        signal.addEventListener("abort", () => finish({ error: new Error("aborted") }), { once: true });
      }),
    close: () => server.close(),
  };
}
