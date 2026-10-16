import type { Approval, GrantScope } from "./types.js";
import type { PermissionGate } from "./gate.js";
import {
  flattenProcessGrantLayers,
  loadProcessGrantLayers,
  loadProjectApprovals,
  removePermissionsFileApproval,
  removeProjectApproval,
  removeGlobalApproval,
  removeProviderModelApproval,
} from "./store.js";

export interface ScopedApproval {
  scope: GrantScope;
  tool: string;
  pattern: string;
  providerModel?: string;
}

export interface PermissionsAdmin {
  list: () => Promise<ScopedApproval[]>;
  revoke: (entry: ScopedApproval) => Promise<void>;
}

export interface PermissionsAdminOptions {
  /**
   * When set, global and provider-model rows come from this file. Reseed
   * reloads it and does not read or write the user grant stores.
   */
  permissionsPath?: string | undefined;
  /** Temp home for tests. Production omits it and uses the real user home. */
  home?: string | undefined;
}

function toApproval(entry: ScopedApproval): Approval {
  return entry.providerModel !== undefined
    ? {
        tool: entry.tool,
        pattern: entry.pattern,
        providerModel: entry.providerModel,
      }
    : { tool: entry.tool, pattern: entry.pattern };
}

function tag(
  scope: GrantScope,
  approvals: readonly Approval[],
): ScopedApproval[] {
  return approvals.map((a) => ({ scope, ...a }));
}

// File rows carry providerModel only when the grant itself is scoped. Tagging
// by that field matches the user-store split without reordering the file.
function tagFileApprovals(approvals: readonly Approval[]): ScopedApproval[] {
  return approvals.map((approval) => ({
    scope:
      approval.providerModel !== undefined
        ? ("provider-model" as const)
        : ("global" as const),
    ...approval,
  }));
}

// Read/write both the persistent stores and the live gate so /permissions
// changes take effect without a restart. A --permissions file is the whole
// global/provider-model list for this process: reseed reloads it, and revoke
// edits that file rather than ~/.corbits/permissions.json.
export function createPermissionsAdmin(
  gate: PermissionGate,
  cwd: string,
  opts?: PermissionsAdminOptions,
): PermissionsAdmin {
  const permissionsPath = opts?.permissionsPath;
  const home = opts?.home;

  const loadPersisted = async (): Promise<{
    project: Approval[];
    layers: Awaited<ReturnType<typeof loadProcessGrantLayers>>;
  }> => {
    const [project, layers] = await Promise.all([
      loadProjectApprovals(cwd, home),
      loadProcessGrantLayers(permissionsPath, home),
    ]);
    return { project, layers };
  };

  const reseed = async (): Promise<void> => {
    const { project, layers } = await loadPersisted();
    gate.setSeededApprovals([...project, ...flattenProcessGrantLayers(layers)]);
  };

  const list = async (): Promise<ScopedApproval[]> => {
    const { project, layers } = await loadPersisted();
    const replaced =
      layers.source === "file"
        ? tagFileApprovals(layers.approvals)
        : [
            ...tag("global", layers.global),
            ...tag("provider-model", layers.providerModel),
          ];
    return [
      ...tag("session", gate.getSessionApprovals()),
      ...tag("project", project),
      ...replaced,
    ];
  };

  const revoke = async (entry: ScopedApproval): Promise<void> => {
    const approval = toApproval(entry);
    if (entry.scope === "session") {
      gate.removeSessionApproval(approval);
      return;
    }
    if (entry.scope === "project") {
      await removeProjectApproval(cwd, approval, home);
    } else if (permissionsPath !== undefined) {
      // The file is the active global/provider-model store. Removing the row
      // there is what makes the following reseed keep it gone.
      if (
        entry.scope === "global" ||
        (entry.scope === "provider-model" && entry.providerModel !== undefined)
      ) {
        await removePermissionsFileApproval(permissionsPath, approval);
      }
    } else if (entry.scope === "global") {
      if (home === undefined) await removeGlobalApproval(approval);
      else await removeGlobalApproval(approval, home);
    } else if (
      entry.scope === "provider-model" &&
      entry.providerModel !== undefined
    ) {
      if (home === undefined) {
        await removeProviderModelApproval(entry.providerModel, approval);
      } else {
        await removeProviderModelApproval(entry.providerModel, approval, home);
      }
    }
    await reseed();
  };

  return { list, revoke };
}
