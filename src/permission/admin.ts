import type { Approval, GrantScope } from "./types.js";
import type { PermissionGate } from "./gate.js";
import {
  loadProjectApprovals,
  loadGlobalApprovals,
  loadProviderModelApprovals,
  removeProjectApproval,
  removeGlobalApproval,
  removeProviderModelApproval,
} from "./store.js";

export type ScopedApproval = { scope: GrantScope; tool: string; pattern: string; providerModel?: string };

export type PermissionsAdmin = {
  list: () => Promise<ScopedApproval[]>;
  revoke: (entry: ScopedApproval) => Promise<void>;
};

function toApproval(entry: ScopedApproval): Approval {
  return entry.providerModel !== undefined
    ? { tool: entry.tool, pattern: entry.pattern, providerModel: entry.providerModel }
    : { tool: entry.tool, pattern: entry.pattern };
}

function tag(scope: GrantScope, approvals: readonly Approval[]): ScopedApproval[] {
  return approvals.map((a) => ({ scope, ...a }));
}

// Reads from the persistent stores and the gate's in-memory session grants, and
// writes revocations back through both — keeping the live gate in sync with the
// stores so a change through /permissions takes effect without a restart.
export function createPermissionsAdmin(gate: PermissionGate, cwd: string): PermissionsAdmin {
  const loadPersisted = (): Promise<[Approval[], Approval[], Approval[]]> =>
    Promise.all([loadProjectApprovals(cwd), loadGlobalApprovals(), loadProviderModelApprovals()]);

  const reseed = async (): Promise<void> => {
    const [project, global, providerModel] = await loadPersisted();
    gate.setSeededApprovals([...project, ...global, ...providerModel]);
  };

  const list = async (): Promise<ScopedApproval[]> => {
    const [project, global, providerModel] = await loadPersisted();
    return [
      ...tag("session", gate.getSessionApprovals()),
      ...tag("project", project),
      ...tag("global", global),
      ...tag("provider-model", providerModel),
    ];
  };

  const revoke = async (entry: ScopedApproval): Promise<void> => {
    const approval = toApproval(entry);
    if (entry.scope === "session") {
      gate.removeSessionApproval(approval);
      return;
    }
    if (entry.scope === "project") {
      await removeProjectApproval(cwd, approval);
    } else if (entry.scope === "global") {
      await removeGlobalApproval(approval);
    } else if (entry.scope === "provider-model" && entry.providerModel !== undefined) {
      await removeProviderModelApproval(entry.providerModel, approval);
    }
    await reseed();
  };

  return { list, revoke };
}
