import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { callbackPageHtml } from "../auth/callback-page.js";

export interface CallbackServer {
  // The redirect_uri to register with the authorization server.
  redirectUrl: string;
  expectState: (state: string) => void;
  // Resolves once the authorization server redirects back with a code, or rejects
  // if the signal aborts, the server reports an error, or close() runs.
  waitForCode: (signal: AbortSignal) => Promise<string>;
  close: () => void;
}

type CallbackResult = { code: string } | { error: Error };
interface CallbackWaiter {
  resolve: (code: string) => void;
  reject: (error: Error) => void;
}

const CALLBACK_PATH = "/callback";
const CLOSED_ERROR =
  "OAuth callback server closed before authorization completed.";

// Start a loopback server to receive the OAuth redirect. close() fail-closes
// waitForCode so disposing the toolset cannot leave authorization hung.
// `serverName` only names the authorization on the page the browser lands on.
export async function startCallbackServer(
  serverName?: string,
): Promise<CallbackServer> {
  let closed = false;
  let expectedState: string | undefined;
  let pendingResult: CallbackResult | undefined;
  let waiter: CallbackWaiter | undefined;

  const clearAuthorization = (): void => {
    expectedState = undefined;
    waiter = undefined;
  };

  const deliver = (result: CallbackResult): void => {
    if (closed) return;
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
    if (
      expectedState === undefined ||
      url.searchParams.get("state") !== expectedState
    ) {
      res.statusCode = 400;
      res.end("Authorization callback state did not match.");
      return;
    }

    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    const failure =
      error ?? (code === null ? "the redirect carried no code" : undefined);
    res.statusCode = failure === undefined ? 200 : 400;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(
      callbackPageHtml({
        ...(serverName !== undefined ? { subject: serverName } : {}),
        ...(failure !== undefined ? { error: failure } : {}),
      }),
    );
    if (error !== null)
      deliver({ error: new Error(`Authorization failed: ${error}`) });
    else if (code === null)
      deliver({ error: new Error("Authorization redirect carried no code.") });
    else deliver({ code });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", (err) => {
      reject(
        new Error(`Could not start the OAuth callback server: ${err.message}`),
      );
    });
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
        if (closed) {
          reject(new Error(CLOSED_ERROR));
          return;
        }
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
        signal.addEventListener(
          "abort",
          () => {
            if (waiter === undefined || waiter.resolve !== resolve) return;
            clearAuthorization();
            reject(new Error("aborted"));
          },
          { once: true },
        );
      }),
    close: () => {
      // Rejecting the waiter here is what unblocks toolset disposal: a server
      // that merely stops listening would leave a pending waitForCode hung.
      if (closed) return;
      closed = true;
      pendingResult = undefined;
      if (waiter !== undefined) {
        const activeWaiter = waiter;
        clearAuthorization();
        activeWaiter.reject(new Error(CLOSED_ERROR));
      }
      server.close();
    },
  };
}
