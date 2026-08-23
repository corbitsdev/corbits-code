import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-async-context overlay for eval-only fixture env (EVAL_HTTP_URL /
 * EVAL_HTTP_TOKEN). Capability cells run in-process and can overlap under
 * --concurrency; a shared process.env write/restore would let one cell clobber
 * or delete a sibling's origin. ALS is the in-process source of truth; process.env
 * remains a fallback for tests that set it directly.
 */
const evalHttpEnvAls = new AsyncLocalStorage<Readonly<Record<string, string>>>();

export function runWithEvalHttpEnv<T>(
  vars: Record<string, string>,
  fn: () => Promise<T>,
): Promise<T> {
  const parent = evalHttpEnvAls.getStore();
  return evalHttpEnvAls.run({ ...parent, ...vars }, fn);
}

export function evalHttpEnvGet(key: string): string | undefined {
  return evalHttpEnvAls.getStore()?.[key] ?? process.env[key];
}
