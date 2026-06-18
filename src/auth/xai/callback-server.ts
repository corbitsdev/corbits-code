import { createServer, type Server } from "node:http";

import { XAI_CALLBACK_PATH, XAI_CALLBACK_PORT } from "./constants.js";

export type XaiCallbackServer = {
  waitForCode: (signal: AbortSignal) => Promise<string>;
  close: () => void;
};

const DONE_HTML =
  "<!doctype html><meta charset=utf-8><title>Authorized</title>" +
  '<body style="font-family:system-ui;padding:3rem;text-align:center">' +
  "<h1>xAI authorization complete</h1><p>You can close this tab and return to Intercode.</p>";

export async function startXaiCallbackServer(expectedState: string): Promise<XaiCallbackServer> {
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
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${String(XAI_CALLBACK_PORT)}`);
    if (url.pathname !== XAI_CALLBACK_PATH) {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    const state = url.searchParams.get("state");

    if (state !== expectedState) {
      res.statusCode = 400;
      res.end("Authorization failed: state mismatch");
      finish({ error: new Error("Authorization state did not match; possible CSRF - login aborted.") });
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
        reject(new Error(`Port ${String(XAI_CALLBACK_PORT)} is already in use. Close any other xAI login and try again.`));
      } else {
        reject(err);
      }
    });
    server.listen(XAI_CALLBACK_PORT, "127.0.0.1", resolve);
  });

  return {
    waitForCode: (signal: AbortSignal) => {
      if (signal.aborted) finish({ error: new Error("aborted") });
      else signal.addEventListener("abort", () => finish({ error: new Error("aborted") }), { once: true });
      return codePromise;
    },
    close: () => server.close(),
  };
}
