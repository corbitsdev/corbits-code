import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { OAuthError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createOAuthProvider, type CorbitsOAuthProvider } from "./oauth-provider.js";
import { startCallbackServer, type CallbackServer } from "./callback-server.js";
import { normalizeMCPServerURL } from "./auth-store.js";
import type { ResolvedMCPServerConfig } from "./exa.js";
import type { McpToolAnnotations } from "./tool-permissions.js";
import { buildStdioMcpProcessEnv } from "./stdio-env.js";
import { MCP_CLIENT_NAME } from "../branding.js";

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: McpToolAnnotations;
}
export interface MCPClient {
  serverName: string;
  tools: MCPTool[];
  call(toolName: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string>;
  close(): Promise<void>;
}
export type MCPConnectResult =
  { ok: true; client: MCPClient } | { ok: false; serverName: string; error: string };
export interface MCPConnectOptions {
  stderr?: "inherit" | "ignore" | "pipe";
  onAuthURL?: (serverName: string, authorizationUrl: string) => void;
  /**
   * Interactive OAuth finished and the retried operation succeeded. Callers
   * that already registered tools for this server can re-emit a connected
   * status so standing "needs auth" chrome clears mid-session.
   */
  onAuthorized?: (serverName: string) => void;
  signal?: AbortSignal;
}

function isHttpServer(config: ResolvedMCPServerConfig): boolean {
  return config.type === "http" || (config.type === undefined && config.url !== undefined);
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

interface HTTPAuthContext {
  url: URL;
  authProvider: CorbitsOAuthProvider;
  callback: CallbackServer;
  coordinator: HTTPAuthCoordinator;
  interactive: boolean;
  serverName: string;
  onAuthorized?: (serverName: string) => void;
}

interface BrowserAuthFlow {
  attempt: { clear(): void };
  promptEmitted: Promise<void>;
}

interface HTTPAuthCoordinator {
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
  probe(): Promise<void>;
}

function isRecoverableAuthError(err: unknown): err is UnauthorizedError | OAuthError {
  return err instanceof UnauthorizedError || err instanceof OAuthError;
}

export const MAX_BROWSER_AUTH_ATTEMPTS = 3;
export const BROWSER_AUTH_COOLDOWN_MS = 5 * 60_000;

interface BrowserAuthAttempts {
  count: number;
  cooldownUntil?: number | undefined;
}
// Keyed by server identity, not provider instance, so the cap survives the
// provider re-creation that every reconnect performs.
const browserAuthAttempts = new Map<string, BrowserAuthAttempts>();

export function resetBrowserAuthState(): void {
  browserAuthAttempts.clear();
}

function browserAuthCapError(serverName: string): Error {
  const minutes = Math.round(BROWSER_AUTH_COOLDOWN_MS / 60_000);
  return new Error(
    `MCP authorization for ${serverName} failed after ${MAX_BROWSER_AUTH_ATTEMPTS} attempts; ` +
      `retrying paused for ${minutes} minutes. Retry later after the cooldown.`,
  );
}

function browserAuthKey(context: HTTPAuthContext): string {
  return `${context.serverName}|${context.url.toString()}`;
}

function beginBrowserAuth(context: HTTPAuthContext): { clear(): void } {
  const key = browserAuthKey(context);
  const entry = browserAuthAttempts.get(key) ?? { count: 0 };
  const now = Date.now();
  if (entry.cooldownUntil !== undefined) {
    if (now < entry.cooldownUntil) throw browserAuthCapError(context.serverName);
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

function unfreezePkce(coordinator: HTTPAuthCoordinator): void {
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
  if (coordinator.refreshInFlight !== undefined) return coordinator.refreshInFlight;
  const shared = Promise.resolve().then(() => tryTokenRefresh(context));
  coordinator.refreshInFlight = shared;
  const clear = () => {
    if (coordinator.refreshInFlight === shared) delete coordinator.refreshInFlight;
  };
  void shared.then(clear, clear);
  return shared;
}

function gateRedirectToAuthorization(context: HTTPAuthContext): void {
  const inner = context.authProvider.redirectToAuthorization.bind(context.authProvider);
  const innerSave = context.authProvider.saveCodeVerifier?.bind(context.authProvider);
  if (innerSave !== undefined) {
    context.authProvider.saveCodeVerifier = (codeVerifier: string) => {
      const coordinator = context.coordinator;
      if (coordinator.pkceFrozen) {
        const pending = coordinator.pkceSavePromise;
        if (pending === undefined)
          throw new Error("PKCE verifier save is frozen without a pending write");
        return pending;
      }
      coordinator.pkceFrozen = true;
      coordinator.pkceSavePromise = Promise.resolve(innerSave(codeVerifier));
      return coordinator.pkceSavePromise;
    };
  }
  context.authProvider.redirectToAuthorization = async (authorizationUrl: URL) => {
    const coordinator = context.coordinator;
    const browserFlowBeforeRefresh = coordinator.browserFlow;
    if (browserFlowBeforeRefresh !== undefined) return browserFlowBeforeRefresh.promptEmitted;
    const refresh = coordinator.refreshInFlight;
    if (refresh !== undefined && (await refresh)) {
      unfreezePkce(coordinator);
      return;
    }
    const concurrentBrowserFlow = coordinator.browserFlow ?? browserFlowBeforeRefresh;
    if (concurrentBrowserFlow !== undefined) return concurrentBrowserFlow.promptEmitted;
    if (!context.interactive) {
      unfreezePkce(coordinator);
      throw new Error("Authorization required but no interactive handler is available.");
    }

    try {
      const attempt = beginBrowserAuth(context);
      const startPrompt = Promise.withResolvers<undefined>();
      const promptEmitted = startPrompt.promise.then(() => inner(authorizationUrl));
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
 * Fetch that always attaches the connect AbortSignal. SDK 403 upscoping calls
 * `auth()` with raw `_fetch` (no `requestInit.signal`); `_fetchWithInit` still
 * uses this same function, so both paths abort when connect is cancelled.
 */
export function fetchWithConnectAbort(
  connectSignal: AbortSignal,
  baseFetch: (url: string | URL, init?: RequestInit) => Promise<Response> = fetch,
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

function streamableHTTPTransportOptions(
  authProvider: CorbitsOAuthProvider | undefined,
  signal: AbortSignal | undefined,
) {
  if (authProvider === undefined && signal === undefined) return undefined;
  return {
    ...(authProvider === undefined ? {} : { authProvider }),
    ...(signal === undefined
      ? {}
      : { requestInit: { signal }, fetch: fetchWithConnectAbort(signal) }),
  };
}

/**
 * Run interactive OAuth, retry the failed operation, and notify only when the
 * retry itself succeeded — a failed re-auth must leave standing "needs auth"
 * chrome alone.
 */
export async function retryAfterInteractiveAuth<T>(
  completeAuth: () => Promise<void>,
  operation: () => Promise<T>,
  onAuthorized: (() => void) | undefined,
): Promise<T> {
  await completeAuth();
  const value = await operation();
  onAuthorized?.();
  return value;
}

async function driveRecovery(err: UnauthorizedError | OAuthError, context: HTTPAuthContext) {
  const coordinator = context.coordinator;
  if (err instanceof OAuthError) await context.authProvider.resetAuthorization();
  if (err instanceof UnauthorizedError && coordinator.browserFlow === undefined) {
    await getOrStartRefresh(context);
    // SDK redirects waiting on this refresh must reserve the browser flow before the probe.
    await Promise.resolve();
  }

  if (coordinator.browserFlow === undefined) {
    try {
      await coordinator.probe();
      return;
    } catch (probeErr) {
      if (!isRecoverableAuthError(probeErr)) throw probeErr;
      if (coordinator.browserFlow === undefined) throw probeErr;
    }
  }

  const browserFlow = coordinator.browserFlow;
  await browserFlow.promptEmitted;
  const code = await context.callback.waitForCode(coordinator.lifecycle.signal);
  await new StreamableHTTPClientTransport(
    context.url,
    streamableHTTPTransportOptions(context.authProvider, coordinator.lifecycle.signal),
  ).finishAuth(code);
  await coordinator.probe();
}

function completeVerifiedRecovery(context: HTTPAuthContext, generation: number): void {
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
  void shared.then(
    () => {
      clear();
      if ((coordinator.waiters ?? 0) === 0) {
        completeVerifiedRecovery(context, coordinator.recoveryGeneration ?? 0);
      }
    },
    clear,
  );
  return shared;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function awaitRecovery(recovery: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
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
): Promise<MCPClient> {
  const result = await withHTTPAuthorizationRecovery(authContext, () =>
    signal === undefined ? client.listTools() : client.listTools(undefined, { signal }),
  );
  const tools: MCPTool[] = result.tools.map((t) => {
    const annotations = t.annotations as McpToolAnnotations | undefined;
    const tool: MCPTool = {
      name: t.name,
      description: t.description ?? "",
      inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
    };
    if (annotations !== undefined) tool.annotations = annotations;
    return tool;
  });
  return {
    serverName,
    tools,
    async call(toolName, args, signal) {
      const result = await withHTTPAuthorizationRecovery(
        authContext,
        () => client.callTool({ name: toolName, arguments: args }, undefined, { signal }),
        signal,
      );
      return unwrapToolContent(result.content);
    },
    async close() {
      closeLifecycle?.();
      authContext?.callback.close();
      await client.close().catch(() => undefined);
    },
  };
}

async function connectStdio(
  config: ResolvedMCPServerConfig,
  options: MCPConnectOptions,
): Promise<MCPConnectResult> {
  if (config.command === undefined)
    return { ok: false, serverName: config.name, error: "stdio MCP server requires a command" };
  const transportOptions: {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    stderr?: "inherit" | "ignore" | "pipe";
  } = { command: config.command, env: buildStdioMcpProcessEnv(process.env, config.env) };
  if (config.args !== undefined) transportOptions.args = config.args;
  if (options.stderr !== undefined) transportOptions.stderr = options.stderr;
  const client = new Client({ name: MCP_CLIENT_NAME, version: "1.0.0" });
  try {
    await client.connect(
      new StdioClientTransport(transportOptions),
      options.signal === undefined ? undefined : { signal: options.signal },
    );
    return { ok: true, client: await finishClient(client, config.name, undefined, options.signal) };
  } catch (err) {
    await client.close().catch(() => undefined);
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
    return { ok: false, serverName: config.name, error: "http MCP server requires a url" };
  let callback: CallbackServer | undefined;
  let client: Client | undefined;
  const lifecycle = new AbortController();
  const abortLifecycle = () => lifecycle.abort(options.signal?.reason);
  const closeLifecycle = () => {
    lifecycle.abort();
    options.signal?.removeEventListener("abort", abortLifecycle);
  };
  if (options.signal?.aborted) abortLifecycle();
  else options.signal?.addEventListener("abort", abortLifecycle, { once: true });
  try {
    const normalizedURL = normalizeMCPServerURL(config.url);
    const url = new URL(normalizedURL);
    let authContext: HTTPAuthContext | undefined;
    let makeTransport: () => Transport;
    if (config.oauth === false) {
      makeTransport = () =>
        new StreamableHTTPClientTransport(
          url,
          streamableHTTPTransportOptions(undefined, options.signal),
        ) as unknown as Transport;
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
      makeTransport = () =>
        new StreamableHTTPClientTransport(
          url,
          streamableHTTPTransportOptions(authProvider, lifecycle.signal),
        ) as unknown as Transport;
      const coordinator: HTTPAuthCoordinator = {
        lifecycle,
        probe: async () => {
          const probeClient = new Client({ name: MCP_CLIENT_NAME, version: "1.0.0" });
          try {
            await probeClient.connect(makeTransport(), { signal: lifecycle.signal });
          } finally {
            await probeClient.close().catch(() => undefined);
          }
        },
      };
      authContext = {
        url,
        authProvider,
        callback,
        coordinator,
        interactive: options.onAuthURL !== undefined,
        serverName: config.name,
        ...(options.onAuthorized !== undefined ? { onAuthorized: options.onAuthorized } : {}),
      };
      gateRedirectToAuthorization(authContext);
    }
    const connectedClient = new Client({ name: MCP_CLIENT_NAME, version: "1.0.0" });
    client = connectedClient;
    await withHTTPAuthorizationRecovery(
      authContext,
      () => connectedClient.connect(makeTransport(), { signal: lifecycle.signal }),
      lifecycle.signal,
    );
    if (authContext !== undefined) {
      authContext.coordinator.probe = () =>
        connectedClient.listTools(undefined, { signal: lifecycle.signal }).then(() => undefined);
    }
    return {
      ok: true,
      client: await finishClient(
        connectedClient,
        config.name,
        authContext,
        options.signal,
        closeLifecycle,
      ),
    };
  } catch (err) {
    closeLifecycle();
    await client?.close().catch(() => undefined);
    try {
      callback?.close();
    } catch {
      // Setup has already failed; callback teardown is best effort.
    }
    return {
      ok: false,
      serverName: config.name,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function connectMCPServer(
  config: ResolvedMCPServerConfig,
  options: MCPConnectOptions = {},
): Promise<MCPConnectResult> {
  return isHttpServer(config) ? connectHttp(config, options) : connectStdio(config, options);
}

export async function connectMCPServers(
  configs: ResolvedMCPServerConfig[],
  onWarning: (message: string) => void,
  options: MCPConnectOptions = {},
): Promise<MCPClient[]> {
  const results = await Promise.all(configs.map((c) => connectMCPServer(c, options)));
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
