import { createServer, type Server } from "node:http";
import { callbackPageHtml } from "../callback-page.js";

export interface CallbackServer {
  // Resolves with the validated authorization code once the browser redirects
  // back, or rejects if the server reports an error, the state mismatches, or
  // the signal aborts.
  waitForCode: (signal: AbortSignal) => Promise<string>;
  close: () => void;
}

export interface CallbackServerConfig {
  port: number;
  path: string;
  // Host used in the listen bind (always loopback).
  bindHost?: string;
  // Host used only when constructing the request URL for path matching.
  publicHost?: string;
  // HTML body returned on a successful authorization redirect.
  doneHtml: string;
  // Product label for the EADDRINUSE error ("Codex", "xAI", …).
  label: string;
}

// Start a fixed-port loopback server that receives an OAuth redirect. The port
// is fixed because authorization servers only accept the registered redirect_uri
// for the client, so a random port would be rejected. A bind failure here means
// the port is already in use (e.g. a concurrent login or another CLI), which is
// surfaced as a clear error rather than silently picking another port.
//
// `expectedState` is bound at construction (before the server listens) so the
// CSRF check is always armed: a redirect that arrives the instant the socket
// opens is validated, never accepted unchecked.
export async function startCallbackServer(
  expectedState: string,
  config: CallbackServerConfig,
): Promise<CallbackServer> {
  const bindHost = config.bindHost ?? "127.0.0.1";
  const publicHost = config.publicHost ?? "127.0.0.1";

  // Wire the promise resolver before the server listens so a redirect that
  // arrives the instant the socket opens has a closure to settle against.
  let resolveCode: ((code: string) => void) | undefined;
  let rejectCode: ((err: Error) => void) | undefined;
  let settled = false;

  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const finish = (outcome: { code: string } | { error: Error }): void => {
    if (settled) return;
    settled = true;
    if ("error" in outcome) rejectCode?.(outcome.error);
    else resolveCode?.(outcome.code);
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${publicHost}:${String(config.port)}`);
    if (url.pathname !== config.path) {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    const state = url.searchParams.get("state");

    // A state mismatch (or absent state) means this redirect does not belong to
    // the flow we started; reject the request and the wait rather than trusting
    // the code. The check is armed from construction, so it never fails open.
    if (state !== expectedState) {
      res.statusCode = 400;
      res.end("Authorization failed: state mismatch");
      finish({
        error: new Error("Authorization state did not match; possible CSRF — login aborted."),
      });
      return;
    }

    res.statusCode = error !== null || code === null ? 400 : 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(
      error !== null || code === null
        ? `Authorization failed: ${error ?? "no code returned"}`
        : config.doneHtml,
    );

    if (error !== null) finish({ error: new Error(`Authorization failed: ${error}`) });
    else if (code === null) finish({ error: new Error("Authorization redirect carried no code.") });
    else finish({ code });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(
          new Error(
            `Port ${String(config.port)} is already in use. Close any other ${config.label} login and try again.`,
          ),
        );
      } else {
        reject(err);
      }
    });
    server.listen(config.port, bindHost, resolve);
  });

  return {
    waitForCode: (signal: AbortSignal) => {
      if (signal.aborted) finish({ error: new Error("aborted") });
      else
        signal.addEventListener("abort", () => finish({ error: new Error("aborted") }), {
          once: true,
        });
      return codePromise;
    },
    close: () => server.close(),
  };
}

export function authorizationDoneHtml(providerName: string): string {
  return callbackPageHtml({ subject: providerName, pendingSetup: true });
}
