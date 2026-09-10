import { AsyncLocalStorage } from "node:async_hooks";

// Authorization and tool dispatch share this async-local identity so concurrent
// workers resolve relative permission subjects against their own cwd.
export interface SubAgentIdentity {
  description: string;
  cwd: string;
}

const subAgentIdentityAls = new AsyncLocalStorage<SubAgentIdentity>();

export function runWithSubAgentIdentity<T>(
  identity: SubAgentIdentity,
  fn: () => T,
): T {
  return subAgentIdentityAls.run(identity, fn);
}

export function getSubAgentIdentity(): SubAgentIdentity | undefined {
  return subAgentIdentityAls.getStore();
}
