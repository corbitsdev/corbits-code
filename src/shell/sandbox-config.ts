import { mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  SandboxManager,
  SandboxRuntimeConfigSchema,
  getDefaultWritePaths,
  type SandboxAskCallback,
  type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";
import { sandboxFromSettings, type Settings } from "../config/settings.js";
import type { ToolCall } from "@intx/types/runtime";
import type { PermissionGate } from "../permission/gate.js";

// Opt-in OS sandbox over shell and stdio MCP spawns via
// @anthropic-ai/sandbox-runtime (srt). Off by default: with
// shell.sandbox.enabled unset the spawn paths run byte-identically — no
// SandboxManager state, no wrap, no ask.

/**
 * Structural half of srt's SandboxManager this module needs. Tests inject a
 * fake; production uses the real singleton.
 */
export interface SandboxManagerLike {
  initialize(
    config: SandboxRuntimeConfig,
    askCallback?: SandboxAskCallback,
  ): Promise<void>;
  wrapWithSandbox(command: string): Promise<string>;
  wrapWithSandboxArgv(
    command: string,
  ): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }>;
  isSupportedPlatform(): boolean;
  reset(): Promise<void>;
  // srt exposes the live config; used to detect a torn-down manager when the
  // refcounted teardown ran underneath a still-live handle.
  getConfig?(): SandboxRuntimeConfig | undefined;
}

/** Wrap seam consumed by the shell-guard, background-shell, and MCP stdio spawn sites. */
export interface ShellSandbox {
  /** Wrap a shell:true command string; the caller spawns the result unchanged. */
  wrapShellCommand: (command: string) => Promise<string>;
  /**
   * Wrap a direct (no shell) argv spawn: the return is the full argv to spawn
   * with shell:false, wrapped so the original argv runs inside the sandbox.
   */
  wrapExecArgv: (
    command: string,
    args: readonly string[],
  ) => Promise<{ argv: readonly string[] }>;
  /** Teardown of srt proxies/state; errors are suppressed (session is dying). */
  dispose: () => Promise<void>;
}

/**
 * Sensitive paths as srt denyRead entries, mirroring secret-guard-plugin's
 * SENSITIVE_PATTERNS (filename classes expressed as globs). Reads are allowed
 * by default in srt, so a denyRead that drifts narrower than the denylist
 * only relaxes the OS layer, never the secret-guard policy check — keep the
 * two lists in step when a sensitive class is added. The active --config
 * settings path and other runtime denies arrive as extraDeniedPaths literal
 * entries. `*.tfstate` etc pattern via srt's glob, `(.env)` variants limit to
 * the concrete secret variants so .env.example stays readable.
 */
const SENSITIVE_DENY_READ: readonly string[] = [
  // .env variants, not templates — mirrors secret-guard.
  "**/.env",
  "**/.env.local",
  "**/.env.development",
  "**/.env.production",
  "**/.env.staging",
  "**/.env.dev",
  "**/.envrc",
  "**/.flaskenv",
  "**/.dev.vars",
  "**/.npmrc",
  "**/.netrc",
  "**/.git-credentials",
  "**/.pgpass",
  "**/.htpasswd",
  // Corbits Code's own credential-bearing settings.
  "**/.corbits/settings.json",
  "**/.corbits/permissions.json",
  "**/.ssh/**",
  "**/.aws/**",
  "**/.gnupg/**",
  "**/.config/gcloud/**",
  "**/.kube/config",
  "**/.docker/config.json",
  "**/.azure/accessTokens.json",
  "**/.azure/azureProfile.json",
  "**/id_rsa",
  "**/id_dsa",
  "**/id_ecdsa",
  "**/id_ed25519",
  "**/*.pem",
  "**/*.p12",
  "**/*.pfx",
  "**/*.key",
  "**/*.p8",
  "**/*.jks",
  "**/*.keystore",
  "**/*.ppk",
  "**/*.tfstate",
  "**/*.tfstate.backup",
  "**/application_default_credentials.json",
  "**/*service*account*.json",
  "**/.bash_history",
  "**/.zsh_history",
  "**/.sh_history",
  "**/fish_history",
  // System account/privilege files.
  "/etc/shadow",
  "/etc/sudoers",
  // macOS Keychains, browser cookie stores, saved logins.
  "**/Library/Keychains/**",
  "**/*.keychain",
  "**/*.keychain-db",
  "**/Cookies",
  "**/Login Data",
  "**/cookies.sqlite",
  "**/logins.json",
  "**/key4.db",
];

/**
 * Known credential env vars, unset inside the sandbox (srt credentials.envVars
 * mode "deny"). Static names so the deny cannot be widened by whatever
 * happens to sit in the environment; the classes mirror
 * tool-result-secret-scrub's SECRET/TOKEN/API_KEY classification.
 */
const CREDENTIAL_ENV_VARS: readonly string[] = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "XAI_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "DEEPSEEK_API_KEY",
  "OPENROUTER_API_KEY",
  "COHERE_API_KEY",
  "TOGETHER_API_KEY",
  "FIREWORKS_API_KEY",
  "HF_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "CORBITS_WEB_SEARCH_API_KEY",
  "EXA_API_KEY",
];

/** claude-sandbox convention scratch dir srt grants write access to. */
const CLAUDE_TMP_DIR = "/tmp/claude";

export interface SandboxConfigInput {
  sessionRoot: string;
  /** Runtime denylist entries (e.g. the active --config settings path). */
  extraDeniedPaths?: readonly string[];
  /** Settings.shell.sandbox.network — the allowlist; everything else asks. */
  allowedHosts?: readonly string[];
}

/**
 * Pure sandbox-runtime config builder: workspace-and-tmp-only writes, srt's
 * own convenience write paths, the secret denylist as denyRead globs, and the
 * credential env deny. Exported for tests; parses against srt's own schema so
 * a drift fails loudly instead of initializing with a weaker config.
 */
export function buildSandboxRuntimeConfig(
  input: SandboxConfigInput,
): SandboxRuntimeConfig {
  const denyRead: (string | { path: string; literal: true })[] = [
    ...SENSITIVE_DENY_READ,
    ...(input.extraDeniedPaths ?? []).map((path) => ({
      path,
      literal: true as const,
    })),
  ];
  // Writes: the session workspace, the OS tmpdir, plus srt's own defaults
  // (stdio devices and /tmp/claude, which we pre-create at init below).
  const allowWrite = [
    input.sessionRoot,
    tmpdir(),
    ...getDefaultWritePaths({ denyRead }),
  ];
  // srt routes an unmatched host to the registered ask callback, so an
  // operator allowlist of [] is a deny-all-except-approved network, never an
  // all-open one.
  const config: SandboxRuntimeConfig = {
    network: {
      allowedDomains: [...(input.allowedHosts ?? [])],
      deniedDomains: [],
    },
    filesystem: {
      denyRead,
      denyWrite: [],
      allowWrite,
    },
    credentials: {
      envVars: CREDENTIAL_ENV_VARS.map((name) => ({ name, mode: "deny" })),
    },
  };
  return SandboxRuntimeConfigSchema.parse(config);
}

/** POSIX-single-quote every argv entry so `sh -c` re-derives the exact argv. */
export function quotePosixArgv(args: readonly string[]): string {
  return args.map((arg) => `'${arg.replace(/'/g, `'\\''`)}'`).join(" ");
}

export const SANDBOX_UNAVAILABLE_PREFIX =
  "shell sandbox is enabled but unavailable";

/** Fail-closed wrap error: the command never ran, never spawns raw. */
export async function wrapWithShellSandbox(
  sandbox: ShellSandbox,
  command: string,
): Promise<string> {
  try {
    return await sandbox.wrapShellCommand(command);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${SANDBOX_UNAVAILABLE_PREFIX}: ${reason}. The command was not run. ` +
        `Set shell.sandbox.enabled=false to disable the sandbox.`,
      { cause: err },
    );
  }
}

// Wired once per session at the composition roots (exec, TUI) from the
// already-resolved global settings. Resolution lives in config/settings.ts
// (sandboxFromSettings), next to shellTimeoutFromSettings.
//
// srt's SandboxManager is a process-global singleton: initialize() installs
// one process-wide config and reset() clears it. A second live composition
// must therefore fail loud on a differing config (it would otherwise
// silently inherit the first), and a teardown must reset the singleton via
// the owner refcount so a remaining owner keeps working. Injected managers
// coordination keys the shared state by the manager object itself, so an
// injected fake can be exercised the same way the real singleton would be.

interface SandboxRuntimeState {
  initPromise: Promise<void> | undefined;
  configKey: string | undefined;
  ownerCount: number;
}

// One state per manager object: the real SandboxManager singleton is a key
// like any other, so injected fakes (tests) get the same coordination while
// different fakes stay isolated.
const statesByManager = new WeakMap<SandboxManagerLike, SandboxRuntimeState>();

function stateFor(manager: SandboxManagerLike): SandboxRuntimeState {
  const existing = statesByManager.get(manager);
  if (existing !== undefined) return existing;
  const state: SandboxRuntimeState = {
    initPromise: undefined,
    configKey: undefined,
    ownerCount: 0,
  };
  statesByManager.set(manager, state);
  return state;
}

/** Composition identity: everything the srt config will carry. */
function sandboxCompositionKey(options: {
  sessionRoot: string;
  extraDeniedPaths?: readonly string[];
  allowedHosts?: readonly string[];
}): string {
  return JSON.stringify({
    sessionRoot: options.sessionRoot,
    extraDeniedPaths: options.extraDeniedPaths ?? null,
    allowedHosts: options.allowedHosts ?? null,
  });
}

export function createShellSandbox(options: {
  sessionRoot: string;
  extraDeniedPaths?: readonly string[];
  settings: Settings | null | undefined;
  gate: Pick<PermissionGate, "evaluate">;
  manager?: SandboxManagerLike;
}): ShellSandbox | undefined {
  const { enabled, network } = sandboxFromSettings(options.settings);
  if (!enabled) return undefined;
  const manager = options.manager ?? (SandboxManager as SandboxManagerLike);
  const state = stateFor(manager);
  const configKey = sandboxCompositionKey({
    sessionRoot: options.sessionRoot,
    ...(options.extraDeniedPaths !== undefined
      ? { extraDeniedPaths: options.extraDeniedPaths }
      : {}),
    ...(network?.allowedHosts !== undefined
      ? { allowedHosts: network.allowedHosts }
      : {}),
  });
  if (state.ownerCount > 0 && state.configKey !== configKey) {
    throw new Error(
      "shell sandbox is already active in this process with a different " +
        "configuration; only one sandboxed composition per process is " +
        "supported. Refuse rather than inherit the active sandbox.",
    );
  }
  if (state.ownerCount === 0) {
    state.configKey = configKey;
    state.ownerCount = 1;
  } else {
    state.ownerCount += 1;
  }
  let disposed = false;

  const ensureReady = (): Promise<void> => {
    if (state.initPromise === undefined) {
      state.initPromise = (async () => {
        if (!manager.isSupportedPlatform()) {
          throw new Error("platform is not supported by sandbox-runtime");
        }
        // /tmp/claude is embedder-owned scratch within the sandbox's writable
        // tmp; a missing dir breaks every sandboxed write into it, so failing
        // here fails closed before anything spawns.
        try {
          mkdirSync(CLAUDE_TMP_DIR, { recursive: true });
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          throw new Error(
            `cannot create sandbox scratch dir ${CLAUDE_TMP_DIR}: ${reason}`,
            { cause: err },
          );
        }
        const config = buildSandboxRuntimeConfig({
          sessionRoot: options.sessionRoot,
          ...(options.extraDeniedPaths !== undefined
            ? { extraDeniedPaths: options.extraDeniedPaths }
            : {}),
          ...(network?.allowedHosts !== undefined
            ? { allowedHosts: network.allowedHosts }
            : {}),
        });
        // macOS resolves /tmp under /private/tmp; the canonical spelling is
        // what seatbelt checks, so add it next to the /tmp form (a belt for
        // getDefaultWritePaths, which embeds the static spellings).
        try {
          config.filesystem.allowWrite.push(realpathSync(CLAUDE_TMP_DIR));
        } catch (err) {
          throw new Error(
            `cannot resolve sandbox scratch dir ${CLAUDE_TMP_DIR}`,
            { cause: err },
          );
        }
        await manager.initialize(config, sandboxAsk);
      })();
    }
    return state.initPromise;
  };

  // Unmatched hosts ask through the shared permission gate: the same Tier
  // machinery (classify → ask/allow) as a web_fetch to that host. Yolo
  // auto-allows here (skipPermissions) — the OS sandbox itself never lifts.
  const sandboxAsk: SandboxAskCallback = async ({ host, port }) => {
    const call: ToolCall = {
      id: randomUUID(),
      name: "web_fetch",
      arguments: {
        url: `https://${host}${port !== undefined ? `:${port}` : ""}`,
      },
    };
    const verdict = await options.gate.evaluate(call);
    return verdict.allowed === true;
  };

  // Fail-closed relatives: an unwrappable runtime (wrap threw), a manager
  // whose config was torn down underneath us, or a handle already disposed
  // all produce the same shape — the command did not run, nothing raw-spawns.
  const unavailable = (err: unknown): Error => {
    const reason = err instanceof Error ? err.message : String(err);
    return new Error(
      `${SANDBOX_UNAVAILABLE_PREFIX}: ${reason}. The command was not run. ` +
        `Set shell.sandbox.enabled=false to disable the sandbox.`,
      { cause: err },
    );
  };

  const guardAlive = async (): Promise<void> => {
    if (disposed) {
      throw new Error(
        `${SANDBOX_UNAVAILABLE_PREFIX}: this session already tore down its ` +
          `sandbox. The command was not run.`,
      );
    }
    await ensureReady();
    // Torn-down detection: only meaningful on managers that report their own
    // config (the real singleton does); fakes without the getter skip it.
    const getConfig = manager.getConfig;
    if (getConfig !== undefined && getConfig.call(manager) === undefined) {
      throw new Error(
        `${SANDBOX_UNAVAILABLE_PREFIX}: the sandbox runtime lost its ` +
          `configuration (teardown or re-initialization). The command was ` +
          `not run.`,
      );
    }
  };

  return {
    wrapShellCommand: async (command) => {
      await guardAlive();
      try {
        return await manager.wrapWithSandbox(command);
      } catch (err) {
        throw unavailable(err);
      }
    },
    wrapExecArgv: async (command, args) => {
      await guardAlive();
      try {
        const { argv } = await manager.wrapWithSandboxArgv(
          quotePosixArgv([command, ...args]),
        );
        return { argv };
      } catch (err) {
        throw unavailable(err);
      }
    },
    dispose: async () => {
      disposed = true;
      state.ownerCount -= 1;
      if (state.ownerCount > 0) return;
      // Last owner out: the srt state (proxies, stamps) is the singleton's to
      // reset; drop the init memo so a later same-composition handle can
      // re-initialize cleanly instead of wrapping config-less.
      try {
        await manager.reset();
      } catch {
        // Teardown best-effort: the process exit path cleans up the rest.
      }
      state.initPromise = undefined;
      state.configKey = undefined;
      state.ownerCount = 0;
    },
  };
}
