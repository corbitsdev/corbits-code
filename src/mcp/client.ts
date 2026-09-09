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
  signal?: AbortSignal;
  interactive: boolean;
  serverName: string;
  onAuthorized?: (serverName: string) => void;
  promptGuard?: { clear(): void };
  refreshedWithoutPrompt?: boolean;
}

function isRecoverableAuthError(err: unknown): boolean {
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

function beginBrowserAuth(context: HTTPAuthContext): { clear(): void } {
  const key = `${context.serverName}|${context.url.toString()}`;
  const entry = browserAuthAttempts.get(key) ?? { count: 0 };
  const now = Date.now();
  if (entry.cooldownUntil !== undefined) {
    if (now < entry.cooldownUntil) throw browserAuthCapError(context.serverName);
    entry.cooldownUntil = undefined;
    entry.count = 0;
  }
  if (entry.count >= MAX_BROWSER_AUTH_ATTEMPTS) {
    entry.cooldownUntil = now + BROWSER_AUTH_COOLDOWN_MS;
    throw browserAuthCapError(context.serverName);
  }
  entry.count += 1;
  browserAuthAttempts.set(key, entry);
  return {
    clear: () => browserAuthAttempts.delete(key),
  };
}

async function tryTokenRefresh(context: HTTPAuthContext): Promise<boolean> {
  const refreshToken = (await context.authProvider.tokens?.())?.refresh_token;
  if (refreshToken === undefined) return false;
  try {
    const tokens = await context.authProvider.refreshToken(refreshToken);
    return tokens !== undefined;
  } catch {
    // Refresh failure is auth-invalid; the browser flow remains the fallback.
    return false;
  }
}

function gateRedirectToAuthorization(context: HTTPAuthContext): void {
  const inner = context.authProvider.redirectToAuthorization.bind(context.authProvider);
  context.authProvider.redirectToAuthorization = async (authorizationUrl: URL) => {
    if (await tryTokenRefresh(context)) {
      context.refreshedWithoutPrompt = true;
      return;
    }
    context.promptGuard ??= beginBrowserAuth(context);
    await inner(authorizationUrl);
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

async function completeInteractiveAuth(context: HTTPAuthContext): Promise<void> {
  if (!context.interactive)
    throw new Error("Authorization required but no interactive handler is available.");
  const code = await context.callback.waitForCode(context.signal ?? new AbortController().signal);
  await new StreamableHTTPClientTransport(
    context.url,
    streamableHTTPTransportOptions(context.authProvider, context.signal),
  ).finishAuth(code);
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

async function recoverHTTPAuthorization<T>(
  err: unknown,
  context: HTTPAuthContext | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  if (context === undefined || !isRecoverableAuthError(err)) throw err;
  let lastErr: unknown = err;
  let refreshAttempted = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (lastErr instanceof OAuthError) await context.authProvider.resetAuthorization();
    if (lastErr instanceof UnauthorizedError) {
      if (context.refreshedWithoutPrompt === true) {
        context.refreshedWithoutPrompt = false;
        try {
          return await operation();
        } catch (nextErr) {
          if (!isRecoverableAuthError(nextErr)) throw nextErr;
          lastErr = nextErr;
          continue;
        }
      }
      if (context.promptGuard === undefined) {
        if (!refreshAttempted) {
          refreshAttempted = true;
          if (await tryTokenRefresh(context)) {
            try {
              return await operation();
            } catch (nextErr) {
              if (!isRecoverableAuthError(nextErr)) throw nextErr;
              lastErr = nextErr;
              continue;
            }
          }
        }
        context.promptGuard = beginBrowserAuth(context);
      }
      const guard = context.promptGuard;
      const value = await retryAfterInteractiveAuth(
        () => completeInteractiveAuth(context),
        operation,
        context.onAuthorized === undefined
          ? undefined
          : () => context.onAuthorized?.(context.serverName),
      );
      guard.clear();
      delete context.promptGuard;
      return value;
    }
    try {
      return await operation();
    } catch (nextErr) {
      if (!isRecoverableAuthError(nextErr)) throw nextErr;
      lastErr = nextErr;
    }
  }
  throw lastErr;
}

async function withHTTPAuthorizationRecovery<T>(
  context: HTTPAuthContext | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (err) {
    return recoverHTTPAuthorization(err, context, operation);
  }
}

async function finishClient(
  client: Client,
  serverName: string,
  authContext?: HTTPAuthContext,
  signal?: AbortSignal,
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
      const context = authContext === undefined ? undefined : { ...authContext, signal };
      const result = await withHTTPAuthorizationRecovery(context, () =>
        client.callTool({ name: toolName, arguments: args }, undefined, { signal }),
      );
      return unwrapToolContent(result.content);
    },
    async close() {
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
        ...(options.signal === undefined ? {} : { fetchFn: fetchWithConnectAbort(options.signal) }),
      });
      makeTransport = () =>
        new StreamableHTTPClientTransport(
          url,
          streamableHTTPTransportOptions(authProvider, options.signal),
        ) as unknown as Transport;
      authContext = {
        url,
        authProvider,
        callback,
        interactive: options.onAuthURL !== undefined,
        serverName: config.name,
        ...(options.onAuthorized !== undefined ? { onAuthorized: options.onAuthorized } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      };
      gateRedirectToAuthorization(authContext);
    }
    const connectedClient = new Client({ name: MCP_CLIENT_NAME, version: "1.0.0" });
    client = connectedClient;
    await withHTTPAuthorizationRecovery(authContext, () =>
      connectedClient.connect(
        makeTransport(),
        options.signal === undefined ? undefined : { signal: options.signal },
      ),
    );
    return {
      ok: true,
      client: await finishClient(connectedClient, config.name, authContext, options.signal),
    };
  } catch (err) {
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
