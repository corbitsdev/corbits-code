import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { OAuthError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  createOAuthProvider,
  type CorbitsOAuthProvider,
} from "./oauth-provider.js";
import { startCallbackServer, type CallbackServer } from "./callback-server.js";
import { normalizeMCPServerURL } from "./auth-store.js";
import type { ResolvedMCPServerConfig } from "./exa.js";
import type { McpToolAnnotations } from "./tool-permissions.js";
import { buildStdioMcpProcessEnv } from "./stdio-env.js";
import { isHttpServer } from "./is-http-server.js";
import type { ShellSandbox } from "../shell/sandbox-config.js";
import {
  classifyMcpConnectResult,
  classifyMcpOAuthResult,
  classifyMcpTransport,
} from "../telemetry/classify.js";
import {
  captureMcpConnect,
  captureMcpOAuth,
} from "../telemetry/product-events.js";
import { liveTelemetry } from "../telemetry/singleton.js";
import { MCP_CLIENT_NAME } from "../branding.js";
import { closeQuietly, isAbortError } from "./quiet.js";

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: McpToolAnnotations;
}
export interface MCPContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

/**
 * Pinned SDK CallToolResult: `{ content: blocks[] (default []),
 * structuredContent?, isError? }` — a tool-level failure still succeeds at
 * the protocol layer, so the envelope carries all three. structuredContent
 * reaches the model JSON-serialized into the content string under
 * MCP_STRUCTURED_CONTENT_MARKER (see plugin.ts).
 */
export interface MCPToolResultEnvelope {
  blocks: MCPContentBlock[];
  isError: boolean;
  structuredContent?: Record<string, unknown>;
}

export interface MCPClient {
  serverName: string;
  tools: MCPTool[];
  /** Full tool-result envelope: blocks plus tool-level
   * isError/structuredContent. */
  callResult(
    toolName: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<MCPToolResultEnvelope>;
  close(): Promise<void>;
}

export type MCPConnectResult =
  | { ok: true; client: MCPClient }
  | {
      ok: false;
      serverName: string;
      error: string;
      /**
       * Browser authorization was offered but never finished — a standing
       * operator action, not a dead server.
       */
      authPending?: boolean;
    };
export interface MCPConnectOptions {
  stderr?: "inherit" | "ignore" | "pipe";
  onAuthURL?: (serverName: string, authorizationUrl: string) => void;
  /**
   * Interactive OAuth finished and the retried operation succeeded. Callers
   * can re-emit connected so standing "needs auth" chrome clears mid-session.
   */
  onAuthorized?: (serverName: string) => void;
  signal?: AbortSignal;
  // Wired to transport.onclose after connect so the owner learns the
  // transport died under a live client; close() disarms it before
  // intentional teardown.
  onDisconnect?: () => void;
  // Session OS-sandbox handle: a model-reachable stdio server spawn runs
  // wrapped; an unwrappable command fails the connect (fail closed). Omitted
  // keeps the direct spawn path byte-identical.
  sandbox?: ShellSandbox;
}

export function unwrapToolContent(content: unknown): string {
  if (!Array.isArray(content) || content.length === 0) return "";
  return content
    .map((block) => {
      if (
        block !== null &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text"
      ) {
        return String((block as { text?: unknown }).text ?? "");
      }
      return JSON.stringify(block);
    })
    .join("\n");
}

export function validateMcpContentBlocks(content: unknown): MCPContentBlock[] {
  if (!Array.isArray(content)) return [];
  const out: MCPContentBlock[] = [];
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    const type = (block as { type?: unknown }).type;
    if (typeof type !== "string") continue;
    const copy: MCPContentBlock = { type };
    for (const [key, value] of Object.entries(block)) {
      if (key === "type") continue;
      copy[key] = value;
    }
    out.push(copy);
  }
  return out;
}

interface HTTPAuthContext {
  url: URL;
  authProvider: CorbitsOAuthProvider;
  callback: CallbackServer;
  coordinator: SdkAuthFinish;
  interactive: boolean;
  serverName: string;
  client: Client;
  /** Builds the next HTTP transport and records it as the live session. */
  openTransport: () => Transport;
  onAuthorized?: (serverName: string) => void;
}

interface BrowserAuthFlow {
  attempt: { clear(): void };
  promptEmitted: Promise<void>;
}

interface SdkAuthFinish {
  lifecycle: AbortController;
  inFlight?: Promise<void>;
  refreshInFlight?: Promise<boolean>;
  browserFlow?: BrowserAuthFlow;
  pkceFrozen?: boolean;
  pkceSavePromise?: Promise<void>;
  pendingAttempt?: { clear(): void };
  notified?: boolean;
  recoveryGeneration?: number;
  waiters?: number;
  /**
   * Transport that finishAuth must use. A probe dial replaces the pre-failure
   * transport with the instance that called redirectToAuthorization, so the
   * code exchange sends that instance's resource metadata and scope.
   */
  transport?: StreamableHTTPClientTransport;
}

function isRecoverableAuthError(
  err: unknown,
): err is UnauthorizedError | OAuthError {
  return err instanceof UnauthorizedError || err instanceof OAuthError;
}

export const MAX_BROWSER_AUTH_ATTEMPTS = 1;
export const BROWSER_AUTH_COOLDOWN_MS = 5 * 60_000;
export const BROWSER_AUTH_WAIT_MS = 2 * 60_000;

interface BrowserAuthAttempts {
  count: number;
  cooldownUntil?: number | undefined;
}
// Keyed by server identity, not provider instance, so it survives the
// provider re-creation each reconnect performs.
const browserAuthAttempts = new Map<string, BrowserAuthAttempts>();
let browserAuthWaitMs = BROWSER_AUTH_WAIT_MS;

export function resetBrowserAuthState(): void {
  browserAuthAttempts.clear();
  browserAuthWaitMs = BROWSER_AUTH_WAIT_MS;
}

export function setBrowserAuthWaitMs(ms: number): void {
  browserAuthWaitMs = ms;
}

/**
 * Browser authorization was offered but never finished (wait timeout or
 * attempt cap). The TUI keeps the prompt-box auth marker for these instead
 * of a generic connect-failure row.
 */
export class BrowserAuthPendingError extends Error {}

function browserAuthCapError(serverName: string): Error {
  const minutes = Math.round(BROWSER_AUTH_COOLDOWN_MS / 60_000);
  const attempts =
    MAX_BROWSER_AUTH_ATTEMPTS === 1
      ? "1 attempt"
      : `${String(MAX_BROWSER_AUTH_ATTEMPTS)} attempts`;
  return new BrowserAuthPendingError(
    `MCP authorization for ${serverName} failed after ${attempts}; ` +
      `retrying paused for ${minutes} minutes. Retry later after the cooldown.`,
  );
}

function browserAuthWaitError(serverName: string): Error {
  return new BrowserAuthPendingError(
    `MCP authorization for ${serverName} timed out waiting for the browser; ` +
      `the server is disconnected. Retry later after the cooldown.`,
  );
}

async function waitForBrowserAuthCode(
  context: HTTPAuthContext,
): Promise<string> {
  const lifecycle = context.coordinator.lifecycle.signal;
  const deadline = AbortSignal.any([
    lifecycle,
    AbortSignal.timeout(browserAuthWaitMs),
  ]);
  try {
    const code = await context.callback.waitForCode(deadline);
    captureMcpOAuth(liveTelemetry, { result: "completed" });
    return code;
  } catch (err) {
    // waitForCode rejects with "aborted" for both expiries, so the signals
    // tell them apart: a deadline abort with the lifecycle alive is an
    // expired wait; anything else (lifecycle abort, close(), provider denial)
    // is the operator not completing the flow. Denial text is
    // provider-authored, never shipped.
    captureMcpOAuth(liveTelemetry, {
      result:
        !lifecycle.aborted && deadline.aborted
          ? "timeout"
          : classifyMcpOAuthResult(err),
    });
    if (lifecycle.aborted) throw err;
    if (deadline.aborted) throw browserAuthWaitError(context.serverName);
    throw err;
  }
}

function browserAuthKey(context: HTTPAuthContext): string {
  return `${context.serverName}|${context.url.toString()}`;
}

function beginBrowserAuth(context: HTTPAuthContext): { clear(): void } {
  const key = browserAuthKey(context);
  const entry = browserAuthAttempts.get(key) ?? { count: 0 };
  const now = Date.now();
  if (entry.cooldownUntil !== undefined) {
    if (now < entry.cooldownUntil)
      throw browserAuthCapError(context.serverName);
    entry.cooldownUntil = undefined;
    entry.count = 0;
  }
  if (entry.count >= MAX_BROWSER_AUTH_ATTEMPTS) {
    throw browserAuthCapError(context.serverName);
  }
  entry.count += 1;
  if (entry.count === MAX_BROWSER_AUTH_ATTEMPTS) {
    entry.cooldownUntil = now + BROWSER_AUTH_COOLDOWN_MS;
  }
  browserAuthAttempts.set(key, entry);
  return {
    clear: () => browserAuthAttempts.delete(key),
  };
}

function unfreezePkce(coordinator: SdkAuthFinish): void {
  coordinator.pkceFrozen = false;
  delete coordinator.pkceSavePromise;
}

async function tryTokenRefresh(context: HTTPAuthContext): Promise<boolean> {
  const refreshToken = (await context.authProvider.tokens?.())?.refresh_token;
  if (refreshToken === undefined) return false;
  try {
    await context.authProvider.refreshToken(refreshToken);
    return true;
  } catch (err) {
    if (context.coordinator.lifecycle.signal.aborted) throw err;
    return false;
  }
}

function getOrStartRefresh(context: HTTPAuthContext): Promise<boolean> {
  const coordinator = context.coordinator;
  if (coordinator.refreshInFlight !== undefined)
    return coordinator.refreshInFlight;
  const shared = Promise.resolve().then(() => tryTokenRefresh(context));
  coordinator.refreshInFlight = shared;
  const clear = () => {
    if (coordinator.refreshInFlight === shared)
      delete coordinator.refreshInFlight;
  };
  void shared.then(clear, clear);
  return shared;
}

function gateRedirectToAuthorization(context: HTTPAuthContext): void {
  const inner = context.authProvider.redirectToAuthorization.bind(
    context.authProvider,
  );
  const innerSave = context.authProvider.saveCodeVerifier?.bind(
    context.authProvider,
  );
  if (innerSave !== undefined) {
    context.authProvider.saveCodeVerifier = (codeVerifier: string) => {
      const coordinator = context.coordinator;
      if (coordinator.pkceFrozen) {
        const pending = coordinator.pkceSavePromise;
        if (pending === undefined)
          throw new Error(
            "PKCE verifier save is frozen without a pending write",
          );
        return pending;
      }
      coordinator.pkceFrozen = true;
      coordinator.pkceSavePromise = Promise.resolve(innerSave(codeVerifier));
      return coordinator.pkceSavePromise;
    };
  }
  context.authProvider.redirectToAuthorization = async (
    authorizationUrl: URL,
  ) => {
    const coordinator = context.coordinator;
    const browserFlowBeforeRefresh = coordinator.browserFlow;
    if (browserFlowBeforeRefresh !== undefined)
      return browserFlowBeforeRefresh.promptEmitted;
    const refresh = coordinator.refreshInFlight;
    if (refresh !== undefined && (await refresh)) {
      unfreezePkce(coordinator);
      return;
    }
    const concurrentBrowserFlow =
      coordinator.browserFlow ?? browserFlowBeforeRefresh;
    if (concurrentBrowserFlow !== undefined)
      return concurrentBrowserFlow.promptEmitted;
    if (!context.interactive) {
      unfreezePkce(coordinator);
      throw new Error(
        "Authorization required but no interactive handler is available.",
      );
    }

    try {
      const attempt = beginBrowserAuth(context);
      const startPrompt = Promise.withResolvers<undefined>();
      const promptEmitted = startPrompt.promise.then(() =>
        inner(authorizationUrl),
      );
      coordinator.browserFlow = { attempt, promptEmitted };
      startPrompt.resolve(undefined);
      return promptEmitted;
    } catch (err) {
      unfreezePkce(coordinator);
      throw err;
    }
  };
}

/**
 * Fetch that always attaches the connect AbortSignal. SDK 403 upscoping
 * calls `auth()` with raw `_fetch` (no signal); `_fetchWithInit` uses this
 * same function, so both paths abort when connect is cancelled.
 */
export function fetchWithConnectAbort(
  connectSignal: AbortSignal,
  baseFetch: (
    url: string | URL,
    init?: RequestInit,
  ) => Promise<Response> = fetch,
): (url: string | URL, init?: RequestInit) => Promise<Response> {
  return (url, init) => {
    const requestSignal = init?.signal ?? undefined;
    const signal =
      requestSignal === undefined || requestSignal === connectSignal
        ? connectSignal
        : AbortSignal.any([connectSignal, requestSignal]);
    return baseFetch(url, { ...init, signal });
  };
}

/**
 * SDK SSE resume: 1s start, double each attempt, 30s cap. Same envelope as
 * stdio `mcpReconnectDelayMs` without a random factor — the SDK option has
 * no jitter hook. maxRetries stays finite so a dead stream cannot pin the
 * process forever; stdio death still redials in the owner loop.
 */
export const MCP_HTTP_RECONNECTION_OPTIONS = {
  initialReconnectionDelay: 1_000,
  maxReconnectionDelay: 30_000,
  reconnectionDelayGrowFactor: 2,
  maxRetries: 1_000,
} as const;

export function streamableHTTPTransportOptions(
  authProvider: CorbitsOAuthProvider | undefined,
  signal: AbortSignal | undefined,
) {
  // Pin same-origin explicitly rather than relying on the SDK default:
  // `follow` also wraps OAuth discovery and token requests, so a 307/308
  // could post refresh tokens or auth codes to another host. Aligned with
  // the ^1.32.1 SDK range in package.json, where `same-origin` follows
  // within-origin chains (capped) for discovery, token, and SSE traffic.
  return {
    redirectPolicy: "same-origin" as const,
    reconnectionOptions: MCP_HTTP_RECONNECTION_OPTIONS,
    ...(authProvider === undefined ? {} : { authProvider }),
    ...(signal === undefined
      ? {}
      : { requestInit: { signal }, fetch: fetchWithConnectAbort(signal) }),
  };
}

/**
 * Run interactive OAuth, retry the failed operation, and notify when the
 * retry succeeds or is aborted after auth — a failed re-auth must leave
 * standing "needs auth" chrome alone.
 */
export async function retryAfterInteractiveAuth<T>(
  completeAuth: () => Promise<void>,
  operation: () => Promise<T>,
  onAuthorized: (() => void) | undefined,
): Promise<T> {
  await completeAuth();
  try {
    const value = await operation();
    onAuthorized?.();
    return value;
  } catch (err) {
    if (isAbortError(err)) onAuthorized?.();
    throw err;
  }
}

async function dialForFreshAuthorization(
  context: HTTPAuthContext,
): Promise<void> {
  // InvalidScope / access_denied / invalid_request / unsupported_grant arrive
  // before the SDK calls redirectToAuthorization. resetAuthorization already
  // dropped the bad client, so this dial is the same attempt's browser path:
  // the SDK registers again and redirects. A separate client avoids
  // "Already connected" on the transport that just failed.
  const coordinator = context.coordinator;
  const probeClient = new Client({
    name: MCP_CLIENT_NAME,
    version: "1.0.0",
  });
  const transport = new StreamableHTTPClientTransport(
    context.url,
    streamableHTTPTransportOptions(
      context.authProvider,
      coordinator.lifecycle.signal,
    ),
  );
  let redirected = false;
  try {
    await probeClient.connect(transport as unknown as Transport, {
      signal: coordinator.lifecycle.signal,
    });
  } catch (probeErr) {
    if (!isRecoverableAuthError(probeErr)) throw probeErr;
    if (coordinator.browserFlow === undefined) throw probeErr;
    redirected = true;
  } finally {
    await closeQuietly(() => probeClient.close());
  }
  // The probe, not the pre-failure transport, holds the resource metadata and
  // scope the authorize URL was built from. finishAuth has to run on it.
  if (redirected) coordinator.transport = transport;
}

async function driveRecovery(
  err: UnauthorizedError | OAuthError,
  context: HTTPAuthContext,
) {
  const coordinator = context.coordinator;
  if (err instanceof OAuthError)
    await context.authProvider.resetAuthorization();
  // The SDK already tried the token, refreshed, and redirected before throwing.
  // A 401 that arrived without that redirect gets one shared refresh; anything
  // else finishes the browser flow the provider already started.
  let refreshed = false;
  if (
    err instanceof UnauthorizedError &&
    coordinator.browserFlow === undefined
  ) {
    refreshed = await getOrStartRefresh(context);
    // Redirects waiting on this refresh must reserve the browser flow
    // before we decide the episode failed.
    await Promise.resolve();
  }

  // Credential wipe without a redirect logs the user out. Continue this
  // attempt into the browser flow instead of failing the connect. A dial
  // that succeeds with no redirect is the old probe success: return so the
  // real client retries instead of rethrowing the wiped error.
  if (err instanceof OAuthError && coordinator.browserFlow === undefined) {
    await dialForFreshAuthorization(context);
    if (coordinator.browserFlow === undefined) return;
  }

  const browserFlow = coordinator.browserFlow;
  if (browserFlow === undefined) {
    if (refreshed) return;
    throw err;
  }

  await browserFlow.promptEmitted;
  const code = await waitForBrowserAuthCode(context);
  const transport = coordinator.transport;
  if (transport === undefined)
    throw new Error("no live HTTP transport to finish authorization");
  await transport.finishAuth(code);
  // The probe is a second client. After its close, the live session still
  // carries the mcp-session-id from before resetAuthorization wiped tokens.
  const liveSession = context.client.transport;
  if (
    liveSession !== undefined &&
    liveSession !== transport &&
    liveSession.sessionId !== undefined
  ) {
    await context.client.close();
    await context.client.connect(context.openTransport(), {
      signal: coordinator.lifecycle.signal,
    });
  }
}

function completeVerifiedRecovery(
  context: HTTPAuthContext,
  generation: number,
): void {
  const coordinator = context.coordinator;
  if (coordinator.recoveryGeneration !== generation) return;
  if (coordinator.notified) return;
  coordinator.notified = true;
  coordinator.pendingAttempt?.clear();
  delete coordinator.pendingAttempt;
  browserAuthAttempts.delete(browserAuthKey(context));
  context.onAuthorized?.(context.serverName);
}

function getOrStartRecovery(
  err: UnauthorizedError | OAuthError,
  context: HTTPAuthContext,
): Promise<void> {
  const coordinator = context.coordinator;
  if (coordinator.inFlight !== undefined) return coordinator.inFlight;
  coordinator.recoveryGeneration = (coordinator.recoveryGeneration ?? 0) + 1;
  coordinator.notified = false;
  delete coordinator.pendingAttempt;
  const shared = Promise.resolve().then(() => driveRecovery(err, context));
  coordinator.inFlight = shared;
  const clear = () => {
    if (coordinator.inFlight !== shared) return;
    if (coordinator.browserFlow?.attempt !== undefined)
      coordinator.pendingAttempt = coordinator.browserFlow.attempt;
    unfreezePkce(coordinator);
    delete coordinator.inFlight;
    delete coordinator.refreshInFlight;
    delete coordinator.browserFlow;
  };
  void shared.then(() => {
    clear();
    if ((coordinator.waiters ?? 0) === 0) {
      completeVerifiedRecovery(context, coordinator.recoveryGeneration ?? 0);
    }
  }, clear);
  return shared;
}

function abortReason(signal: AbortSignal): unknown {
  return (
    signal.reason ?? new DOMException("The operation was aborted", "AbortError")
  );
}

function awaitRecovery(
  recovery: Promise<void>,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal === undefined) return recovery;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void recovery.then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

async function withHTTPAuthorizationRecovery<T>(
  context: HTTPAuthContext | undefined,
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  try {
    return await operation();
  } catch (err) {
    if (context === undefined || !isRecoverableAuthError(err)) throw err;
    const coordinator = context.coordinator;
    coordinator.waiters = (coordinator.waiters ?? 0) + 1;
    let generation = 0;
    try {
      return await retryAfterInteractiveAuth(
        async () => {
          await awaitRecovery(getOrStartRecovery(err, context), signal);
          generation = coordinator.recoveryGeneration ?? 0;
        },
        operation,
        () => completeVerifiedRecovery(context, generation),
      );
    } finally {
      coordinator.waiters = (coordinator.waiters ?? 1) - 1;
    }
  }
}

async function finishClient(
  client: Client,
  serverName: string,
  authContext?: HTTPAuthContext,
  signal?: AbortSignal,
  closeLifecycle?: () => void,
  live?: { current?: { onclose?: () => void } },
): Promise<MCPClient> {
  const result = await withHTTPAuthorizationRecovery(authContext, () =>
    signal === undefined
      ? client.listTools()
      : client.listTools(undefined, { signal }),
  );
  const tools: MCPTool[] = result.tools.map((t) => {
    const annotations = t.annotations as McpToolAnnotations | undefined;
    const tool: MCPTool = {
      name: t.name,
      description: t.description ?? "",
      inputSchema: (t.inputSchema as Record<string, unknown>) ?? {
        type: "object",
        properties: {},
      },
    };
    if (annotations !== undefined) tool.annotations = annotations;
    return tool;
  });
  return {
    serverName,
    tools,
    async callResult(toolName, args, signal) {
      const result = await withHTTPAuthorizationRecovery(
        authContext,
        () =>
          client.callTool({ name: toolName, arguments: args }, undefined, {
            signal,
          }),
        signal,
      );
      const envelope: MCPToolResultEnvelope = {
        blocks: validateMcpContentBlocks(result.content),
        isError: result.isError === true,
      };
      if (
        result.structuredContent !== null &&
        typeof result.structuredContent === "object"
      ) {
        envelope.structuredContent = result.structuredContent as Record<
          string,
          unknown
        >;
      }
      return envelope;
    },
    async close() {
      // Disarm first: the owner's hook reports unintentional death only.
      if (live?.current !== undefined) live.current.onclose = () => undefined;
      closeLifecycle?.();
      authContext?.callback.close();
      await closeQuietly(() => client.close());
    },
  };
}

async function connectStdio(
  config: ResolvedMCPServerConfig,
  options: MCPConnectOptions,
): Promise<MCPConnectResult> {
  if (config.command === undefined)
    return {
      ok: false,
      serverName: config.name,
      error: "stdio MCP server requires a command",
    };
  const transportOptions: {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    stderr?: "inherit" | "ignore" | "pipe";
  } = {
    command: config.command,
    env: buildStdioMcpProcessEnv(process.env, config.env),
  };
  if (config.args !== undefined) transportOptions.args = config.args;
  if (options.stderr !== undefined) transportOptions.stderr = options.stderr;
  // Sandbox wrap: the wrapped argv is [binShell, "-c", wrapped], executed
  // without a shell so the caller's env staylist still governs the process
  // env; the sandbox's own filesystem/network policy governs its access.
  if (options.sandbox !== undefined) {
    try {
      const { argv } = await options.sandbox.wrapExecArgv(
        config.command,
        transportOptions.args ?? [],
      );
      const [head, ...rest] = argv;
      if (head === undefined) throw new Error("sandbox wrap returned no argv");
      transportOptions.command = head;
      transportOptions.args = rest;
    } catch (err) {
      return {
        ok: false,
        serverName: config.name,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
  const client = new Client({ name: MCP_CLIENT_NAME, version: "1.0.0" });
  try {
    const transport = new StdioClientTransport(transportOptions);
    await client.connect(
      transport,
      options.signal === undefined ? undefined : { signal: options.signal },
    );
    // Child exit is the only death the owner redials. Chain the protocol
    // handler so in-flight requests still reject; HTTP SSE resume stays
    // inside the SDK and must not start a second dial.
    if (options.onDisconnect !== undefined) {
      const prior = transport.onclose;
      transport.onclose = () => {
        prior?.();
        options.onDisconnect?.();
      };
    }
    const live = { current: transport };
    return {
      ok: true,
      client: await finishClient(
        client,
        config.name,
        undefined,
        options.signal,
        undefined,
        live,
      ),
    };
  } catch (err) {
    await closeQuietly(() => client.close());
    return {
      ok: false,
      serverName: config.name,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function connectHttp(
  config: ResolvedMCPServerConfig,
  options: MCPConnectOptions,
): Promise<MCPConnectResult> {
  if (config.url === undefined)
    return {
      ok: false,
      serverName: config.name,
      error: "http MCP server requires a url",
    };
  let callback: CallbackServer | undefined;
  let client: Client | undefined;
  const lifecycle = new AbortController();
  const abortLifecycle = () => lifecycle.abort(options.signal?.reason);
  const closeLifecycle = () => {
    lifecycle.abort();
    options.signal?.removeEventListener("abort", abortLifecycle);
  };
  if (options.signal?.aborted) abortLifecycle();
  else
    options.signal?.addEventListener("abort", abortLifecycle, { once: true });
  try {
    const normalizedURL = normalizeMCPServerURL(config.url);
    const url = new URL(normalizedURL);
    let authContext: HTTPAuthContext | undefined;
    const live: { current?: { onclose?: () => void } } = {};
    const connectedClient = new Client({
      name: MCP_CLIENT_NAME,
      version: "1.0.0",
    });
    client = connectedClient;
    let makeTransport: () => Transport;
    if (config.oauth === false) {
      makeTransport = () => {
        const transport = new StreamableHTTPClientTransport(
          url,
          streamableHTTPTransportOptions(undefined, options.signal),
        );
        live.current = transport;
        return transport as unknown as Transport;
      };
    } else {
      callback = await startCallbackServer(config.name);
      const authProvider = await createOAuthProvider({
        serverName: config.name,
        serverURL: normalizedURL,
        redirectUrl: callback.redirectUrl,
        onAuthURL: (name, authUrl) => options.onAuthURL?.(name, authUrl),
        onAuthorizationState: callback.expectState,
        fetchFn: fetchWithConnectAbort(lifecycle.signal),
      });
      const coordinator: SdkAuthFinish = {
        lifecycle,
      };
      makeTransport = () => {
        const transport = new StreamableHTTPClientTransport(
          url,
          streamableHTTPTransportOptions(authProvider, lifecycle.signal),
        );
        coordinator.transport = transport;
        live.current = transport;
        return transport as unknown as Transport;
      };
      authContext = {
        url,
        authProvider,
        callback,
        coordinator,
        interactive: options.onAuthURL !== undefined,
        serverName: config.name,
        client: connectedClient,
        openTransport: () => makeTransport(),
        ...(options.onAuthorized !== undefined
          ? { onAuthorized: options.onAuthorized }
          : {}),
      };
      gateRedirectToAuthorization(authContext);
    }
    // Recovery may dial again after finishAuth; the last transport wins.
    await withHTTPAuthorizationRecovery(
      authContext,
      () => {
        const transport = makeTransport();
        return connectedClient.connect(transport, {
          signal: lifecycle.signal,
        });
      },
      lifecycle.signal,
    );
    return {
      ok: true,
      client: await finishClient(
        connectedClient,
        config.name,
        authContext,
        options.signal,
        closeLifecycle,
        live,
      ),
    };
  } catch (err) {
    closeLifecycle();
    await closeQuietly(() => client?.close() ?? Promise.resolve());
    await closeQuietly(() => Promise.resolve(callback?.close()));
    return {
      ok: false,
      serverName: config.name,
      error: err instanceof Error ? err.message : String(err),
      ...(err instanceof BrowserAuthPendingError ? { authPending: true } : {}),
    };
  }
}

export async function connectMCPServer(
  config: ResolvedMCPServerConfig,
  options: MCPConnectOptions = {},
): Promise<MCPConnectResult> {
  const result = await (isHttpServer(config)
    ? connectHttp(config, options)
    : connectStdio(config, options));
  // Single funnel for every connect path (startup, late add, retry, backoff
  // redial, web-search): one settled attempt reports one enum-only outcome.
  // Transport is the connect-path predicate that actually ran, never the
  // server name, URL, or command; error text is never attached.
  captureMcpConnect(liveTelemetry, {
    transport: classifyMcpTransport(config),
    result: classifyMcpConnectResult(result),
  });
  return result;
}

export async function connectMCPServers(
  configs: ResolvedMCPServerConfig[],
  onWarning: (message: string) => void,
  options: MCPConnectOptions = {},
): Promise<MCPClient[]> {
  const results = await Promise.all(
    configs.map((c) => connectMCPServer(c, options)),
  );
  const clients: MCPClient[] = [];
  for (const result of results) {
    if (result.ok) clients.push(result.client);
    else
      onWarning(
        `[mcp] Warning: failed to connect to MCP server "${result.serverName}": ${result.error}`,
      );
  }
  return clients;
}
