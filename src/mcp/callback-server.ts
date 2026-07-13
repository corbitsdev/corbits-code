import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type CallbackServer = {
  // The redirect_uri to register with the authorization server.
  redirectUrl: string;
  // Resolves once the authorization server redirects back with a code, or rejects
  // if the signal aborts or the server reports an error.
  waitForCode: (signal: AbortSignal) => Promise<string>;
  close: () => void;
};

const CALLBACK_PATH = "/callback";

const DONE_HTML =
  "<!doctype html><meta charset=utf-8><title>Authorized</title>" +
  "<body style=\"font-family:system-ui;padding:3rem;text-align:center\">" +
  "<h1>Authorization complete</h1><p>You can close this tab and return to Intercode.</p>";

// Start an ephemeral loopback server to receive the OAuth redirect. Binds to a
// random port on 127.0.0.1 so it never collides with anything and is only
// reachable locally.
export async function startCallbackServer(): Promise<CallbackServer> {
  let resolveCode: ((code: string) => void) | undefined;
  let rejectCode: ((err: Error) => void) | undefined;
  let result: { code: string } | { error: Error } | undefined;

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== CALLBACK_PATH) {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }
    if (result !== undefined) {
      res.statusCode = 409;
      res.end("Authorization callback already received.");
      return;
    }
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    res.statusCode = error !== null || code === null ? 400 : 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(error !== null || code === null ? `Authorization failed: ${error ?? "no code returned"}` : DONE_HTML);
    if (error !== null) {
      const authorizationError = new Error(`Authorization failed: ${error}`);
      result = { error: authorizationError };
      rejectCode?.(authorizationError);
    } else if (code === null) {
      const authorizationError = new Error("Authorization redirect carried no code.");
      result = { error: authorizationError };
      rejectCode?.(authorizationError);
    } else {
      result = { code };
      resolveCode?.(code);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address() as AddressInfo;
  const redirectUrl = `http://127.0.0.1:${String(address.port)}${CALLBACK_PATH}`;

  return {
    redirectUrl,
    waitForCode: (signal: AbortSignal) =>
      new Promise<string>((resolve, reject) => {
        if (result !== undefined) {
          if ("code" in result) resolve(result.code);
          else reject(result.error);
          return;
        }
        resolveCode = resolve;
        rejectCode = reject;
        if (signal.aborted) {
          reject(new Error("aborted"));
          return;
        }
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    close: () => server.close(),
  };
}
