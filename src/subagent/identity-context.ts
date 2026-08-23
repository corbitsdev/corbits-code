import { AsyncLocalStorage } from "node:async_hooks";

// Identifies which sub-agent a tool call belongs to, so the permission gate
// can attribute an approval prompt to the agent that raised it (its dispatch
// description) and the working directory it is operating in. Set once per
// sub-agent around its own tool-call dispatch (see run.ts's toolsFactory) so
// every awaited call within that sub-agent's turn — including the permission
// gate and its operator prompt — can read it back via getSubAgentIdentity().
export interface SubAgentIdentity {
  description: string;
  cwd: string;
  /**
   * When set, write/edit/delete subjects must match (authz path lock).
   * Omitted = no director path allowlist.
   */
  writePaths?: readonly string[];
}

const subAgentIdentityAls = new AsyncLocalStorage<SubAgentIdentity>();

export function runWithSubAgentIdentity<T>(
  identity: SubAgentIdentity,
  fn: () => Promise<T>,
): Promise<T> {
  return subAgentIdentityAls.run(identity, fn);
}

export function getSubAgentIdentity(): SubAgentIdentity | undefined {
  return subAgentIdentityAls.getStore();
}
