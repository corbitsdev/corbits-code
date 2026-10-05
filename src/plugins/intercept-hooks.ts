import type { ToolCall, ToolResult } from "@intx/types/runtime";
import type { ToolPlugin } from "@intx/tools-posix";
import type { PermissionGate } from "../permission/gate.js";
import { scrubSecrets } from "../web/secret-scrub.js";
import { gateToolCall } from "./permission-plugin.js";
import { secretGuardPlugin } from "./secret-guard-plugin.js";
import {
  resolvePluginWarningHandler,
  stderrPluginWarning,
  type PluginLoadDiagnostics,
} from "./diagnostics.js";
import type { PluginModule } from "./loader.js";

// CL-9888: in-process plugin intercept hooks.
//
// File hooks (postTurn/postRun in src/session/hooks.ts) stay observe-only and
// off the hot path. These hooks are the hot-path interception surface:
// beforePrompt rewrites prompt text, beforeModel observes/rewrites a tool
// call (or skips it), afterTool observes/rewrites the tool result.
//
// Ordering plus re-gating is the safety property: the composed middleware
// sits after secret-guard/permission in buildCorePosixToolPlugins, so a
// denied call short-circuits at the gate and never reaches a hook. A hook can
// still rewrite an allowed call into a denied shape, so a hook-replaced call
// is re-run through secret-guard and the permission gate before it executes —
// mutated still gated, denied never reach hooks. Hook-mutated calls also still
// flow through the downstream guards (shell-guard, read-file-guard, …), which
// re-validate the final shape.

export type InterceptHookKind = "beforePrompt" | "beforeModel" | "afterTool";

type MaybePromise<T> = T | Promise<T>;

export interface BeforePromptInput {
  prompt: string;
}

/** Return `{ prompt }` to replace the prompt; return undefined to keep it. */
export type BeforePromptHook = (
  input: BeforePromptInput,
) => MaybePromise<{ prompt?: string } | undefined>;

export interface BeforeModelInput {
  call: ToolCall;
}

/**
 * Return `{ call }` to replace the call downstream, `{ skip }` to answer
 * without executing. Return undefined to pass through unchanged.
 */
export type BeforeModelHook = (
  input: BeforeModelInput,
  signal: AbortSignal,
) => MaybePromise<{ call?: ToolCall; skip?: ToolResult } | undefined>;

export interface AfterToolInput {
  call: ToolCall;
  result: ToolResult;
}

/** Return `{ result }` to replace the tool result; undefined keeps it. */
export type AfterToolHook = (
  input: AfterToolInput,
  signal: AbortSignal,
) => MaybePromise<{ result?: ToolResult } | undefined>;

// What a PluginModule exports as `interceptHooks`: single hooks or lists.
export interface InterceptHookRegistration {
  beforePrompt?: BeforePromptHook | readonly BeforePromptHook[];
  beforeModel?: BeforeModelHook | readonly BeforeModelHook[];
  afterTool?: AfterToolHook | readonly AfterToolHook[];
}

// Flattened registry: every stage is a list, in plugin registration order.
export interface InterceptHookRegistry {
  beforePrompt: BeforePromptHook[];
  beforeModel: BeforeModelHook[];
  afterTool: AfterToolHook[];
}

export const emptyInterceptHookRegistry: InterceptHookRegistry = {
  beforePrompt: [],
  beforeModel: [],
  afterTool: [],
};

function toHookList<TFn extends (...args: never[]) => unknown>(
  value: TFn | readonly TFn[] | undefined,
): TFn[] {
  if (value === undefined) return [];
  if (typeof value === "function") return [value];
  return [...value];
}

export function normalizeInterceptHooks(
  input: InterceptHookRegistration | InterceptHookRegistry | undefined,
): InterceptHookRegistry {
  if (input === undefined) return emptyInterceptHookRegistry;
  return {
    beforePrompt: toHookList<BeforePromptHook>(input.beforePrompt),
    beforeModel: toHookList<BeforeModelHook>(input.beforeModel),
    afterTool: toHookList<AfterToolHook>(input.afterTool),
  };
}

export function hasInterceptHooks(registry: InterceptHookRegistry): boolean {
  return (
    registry.beforePrompt.length > 0 ||
    registry.beforeModel.length > 0 ||
    registry.afterTool.length > 0
  );
}

// Collect hooks from loaded plugin modules. Metadata-only (untrusted) modules
// contribute nothing: intercept hooks are in-process code execution, so they
// follow the tool-plugin trust bar, not the skills/agent-profile bar.
export function collectInterceptHooks(
  modules: readonly PluginModule[],
): InterceptHookRegistry {
  const registry: InterceptHookRegistry = {
    beforePrompt: [],
    beforeModel: [],
    afterTool: [],
  };
  for (const mod of modules) {
    if (mod.metadataOnly === true) continue;
    const registration = mod.interceptHooks;
    if (registration === undefined) continue;
    registry.beforePrompt.push(
      ...toHookList<BeforePromptHook>(registration.beforePrompt),
    );
    registry.beforeModel.push(
      ...toHookList<BeforeModelHook>(registration.beforeModel),
    );
    registry.afterTool.push(
      ...toHookList<AfterToolHook>(registration.afterTool),
    );
  }
  return registry;
}

export interface InterceptHookWarningOptions {
  onWarning?: (msg: string) => void;
  diagnostics?: PluginLoadDiagnostics;
}

function resolveInterceptWarning(
  opts: InterceptHookWarningOptions = {},
): (msg: string) => void {
  if (opts.diagnostics !== undefined)
    return resolvePluginWarningHandler({ diagnostics: opts.diagnostics });
  if (opts.onWarning !== undefined)
    return resolvePluginWarningHandler({ onWarning: opts.onWarning });
  return stderrPluginWarning;
}

function hookFailureText(
  kind: InterceptHookKind,
  index: number,
  err: unknown,
): string {
  const reason = err instanceof Error ? err.message : String(err);
  return `intercept-hook: ${kind} hook ${index} failed: ${scrubSecrets(reason)}`;
}

// Thread the prompt through each hook in order. A throwing hook is reported
// and skipped — prompt assembly must not crash the run.
export async function applyBeforePromptHooks(
  hooks: readonly BeforePromptHook[],
  prompt: string,
  opts: InterceptHookWarningOptions = {},
): Promise<string> {
  const onWarning = resolveInterceptWarning(opts);
  let current = prompt;
  for (let i = 0; i < hooks.length; i++) {
    const hook = hooks[i];
    if (hook === undefined) continue;
    try {
      const outcome = await hook({ prompt: current });
      if (outcome?.prompt !== undefined) current = outcome.prompt;
    } catch (err) {
      onWarning(hookFailureText("beforePrompt", i, err));
    }
  }
  return current;
}

// Run beforeModel hooks in order over the call. The first `{ skip }` wins and
// stops the remaining pre-hooks; the skip result still flows through
// afterTool so results stay observable in one place. `mutated` is true when
// any hook replaced the call — the middleware re-gates exactly then, so an
// untouched call is never evaluated (or re-prompted) twice.
export async function applyBeforeModelHooks(
  hooks: readonly BeforeModelHook[],
  call: ToolCall,
  signal: AbortSignal,
  opts: InterceptHookWarningOptions = {},
): Promise<{ call: ToolCall; skip?: ToolResult; mutated: boolean }> {
  const onWarning = resolveInterceptWarning(opts);
  let current = call;
  let mutated = false;
  for (let i = 0; i < hooks.length; i++) {
    const hook = hooks[i];
    if (hook === undefined) continue;
    try {
      const outcome = await hook({ call: current }, signal);
      if (outcome?.call !== undefined) {
        current = outcome.call;
        mutated = true;
      }
      if (outcome?.skip !== undefined)
        return { call: current, skip: outcome.skip, mutated };
    } catch (err) {
      onWarning(hookFailureText("beforeModel", i, err));
    }
  }
  return { call: current, mutated };
}

// Run afterTool hooks in order over the result. A throwing hook is reported
// and the last good result is kept — post-processing never fails the call.
export async function applyAfterToolHooks(
  hooks: readonly AfterToolHook[],
  call: ToolCall,
  result: ToolResult,
  signal: AbortSignal,
  opts: InterceptHookWarningOptions = {},
): Promise<ToolResult> {
  const onWarning = resolveInterceptWarning(opts);
  let current = result;
  for (let i = 0; i < hooks.length; i++) {
    const hook = hooks[i];
    if (hook === undefined) continue;
    try {
      const outcome = await hook({ call, result: current }, signal);
      if (outcome?.result !== undefined) current = outcome.result;
    } catch (err) {
      onWarning(hookFailureText("afterTool", i, err));
    }
  }
  return current;
}

export interface InterceptHookPluginOptions extends InterceptHookWarningOptions {
  /**
   * Re-gate hook-mutated calls. A beforeModel hook can rewrite an allowed
   * call into a secret-guard/permission-denied shape, so a hook-replaced call
   * is re-run through secret-guard plus this gate before it executes.
   * buildCorePosixToolPlugins always wires the stack gate here; bare stacks
   * pass their gate for the same guarantee. Secret-guard revalidation runs on
   * every mutated call even without a gate.
   */
  permissionGate?: PermissionGate;
  secretGuardExtraDeniedPaths?: readonly string[];
}

// Unique pass-through sentinel: the probes below invoke `next` only on allow,
// so identity against this object tells allow from deny without
// reimplementing either denial shape.
const REGATE_PASS: ToolResult = { callId: "", content: "" };

// Re-run a hook-replaced call through the same two checks the original passed
// upstream. Returns the denial when the mutated shape is denied, undefined
// when it stays allowed.
async function revalidateMutatedCall(
  mutated: ToolCall,
  signal: AbortSignal,
  opts: InterceptHookPluginOptions,
): Promise<ToolResult | undefined> {
  const pass = async (): Promise<ToolResult> => REGATE_PASS;
  const secretGuard = secretGuardPlugin(
    opts.secretGuardExtraDeniedPaths !== undefined
      ? { extraDeniedPaths: opts.secretGuardExtraDeniedPaths }
      : undefined,
  );
  const secretHandler = secretGuard.middleware?.(pass) ?? pass;
  const secretVerdict = await secretHandler(mutated, signal);
  if (secretVerdict !== REGATE_PASS) return secretVerdict;
  if (opts.permissionGate !== undefined) {
    const gateVerdict = await gateToolCall(
      opts.permissionGate,
      mutated,
      signal,
      pass,
    );
    if (gateVerdict !== REGATE_PASS) return gateVerdict;
  }
  return undefined;
}

// Tool middleware for the posix chain. Compose AFTER secret-guard/permission
// (see buildCorePosixToolPlugins): denials short-circuit at the gate above
// this layer, so hooks only ever see allowed calls.
export function interceptHookPlugin(
  input: InterceptHookRegistration | InterceptHookRegistry,
  opts: InterceptHookPluginOptions = {},
): ToolPlugin {
  const registry = normalizeInterceptHooks(input);
  return {
    middleware:
      (next) =>
      async (call, signal): Promise<ToolResult> => {
        const pre = await applyBeforeModelHooks(
          registry.beforeModel,
          call,
          signal,
          opts,
        );
        if (pre.skip !== undefined) {
          return applyAfterToolHooks(
            registry.afterTool,
            pre.call,
            pre.skip,
            signal,
            opts,
          );
        }
        if (pre.mutated) {
          // Like an upstream gate denial, a mutated-to-denied call never
          // executes and never reaches afterTool annotation.
          const denial = await revalidateMutatedCall(pre.call, signal, opts);
          if (denial !== undefined) return denial;
        }
        const raw = await next(pre.call, signal);
        return applyAfterToolHooks(
          registry.afterTool,
          pre.call,
          raw,
          signal,
          opts,
        );
      },
  };
}
