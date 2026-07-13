import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type CallbackServer = {
  // The redirect_uri to register with the authorization server.
  redirectUrl: string;
  expectState: (state: string) => void;
  // Resolves once the authorization server redirects back with a code, or rejects
  // if the signal aborts or the server reports an error.
  waitForCode: (signal: AbortSignal) => Promise<string>;
  close: () => void;
};

type CallbackResult = { code: string } | { error: Error };
type CallbackWaiter = { resolve: (code: string) => void; reject: (error: Error) => void };

const CALLBACK_PATH = "/callback";

const DONE_HTML =
  "<!doctype html><meta charset=utf-8><title>Authorized</title>" +
  "<body style=\"font-family:system-ui;padding:3rem;text-align:center\">" +
  "<h1>Authorization complete</h1><p>You can close this tab and return to Intercode.</p>";

// Start an ephemeral loopback server to receive the OAuth redirect. Binds to a
// random port on 127.0.0.1 so it never collides with anything and is only
// reachable locally.
export async function startCallbackServer(): Promise<CallbackServer> {
  let expectedState: string | undefined;
  let pendingResult: CallbackResult | undefined;
  let waiter: CallbackWaiter | undefined;

  const clearAuthorization = (): void => {
    expectedState = undefined;
    waiter = undefined;
  };

  const deliver = (result: CallbackResult): void => {
    if (waiter === undefined) {
      pendingResult = result;
      return;
    }
    const activeWaiter = waiter;
    clearAuthorization();
    if ("code" in result) activeWaiter.resolve(result.code);
    else activeWaiter.reject(result.error);
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== CALLBACK_PATH) {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }
    if (expectedState === undefined || url.searchParams.get("state") !== expectedState) {
      res.statusCode = 400;
      res.end("Authorization callback state did not match.");
      return;
    }

    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    res.statusCode = error !== null || code === null ? 400 : 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(error !== null || code === null ? `Authorization failed: ${error ?? "no code returned"}` : DONE_HTML);
    if (error !== null) deliver({ error: new Error(`Authorization failed: ${error}`) });
    else if (code === null) deliver({ error: new Error("Authorization redirect carried no code.") });
    else deliver({ code });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address() as AddressInfo;
  const redirectUrl = `http://127.0.0.1:${String(address.port)}${CALLBACK_PATH}`;

  return {
    redirectUrl,
    expectState: (state) => {
      expectedState = state;
      pendingResult = undefined;
    },
    waitForCode: (signal: AbortSignal) =>
      new Promise<string>((resolve, reject) => {
        if (signal.aborted) {
          reject(new Error("aborted"));
          return;
        }
        if (pendingResult !== undefined) {
          const result = pendingResult;
          pendingResult = undefined;
          clearAuthorization();
          if ("code" in result) resolve(result.code);
          else reject(result.error);
          return;
        }
        waiter = { resolve, reject };
        signal.addEventListener("abort", () => {
          if (waiter === undefined || waiter.resolve !== resolve) return;
          clearAuthorization();
          reject(new Error("aborted"));
        }, { once: true });
      }),
    close: () => server.close(),
  };
}
