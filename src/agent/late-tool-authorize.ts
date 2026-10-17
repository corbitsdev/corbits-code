import type { AuthorizeFn } from "@intx/agent";

// The reactor authorizes against the definitions it snapshotted at build. A
// tool mounted later has none there, so an `ask` on it cannot build an
// approval prompt and an `allow` would run a tool the agent never offered.
// Deny it with a reason the model can act on; the rebuild that follows the
// current turn makes it callable.
export function denyLateTools(
  authorize: AuthorizeFn,
  isLateTool: (name: string) => boolean,
): AuthorizeFn {
  return async (resource, action, context) => {
    const name = resource.startsWith("tool:") ? resource.slice(5) : undefined;
    if (name !== undefined && isLateTool(name)) {
      return {
        effect: "deny",
        matchingGrants: [],
        resolvedBy: null,
        reason:
          `${name} connected after this turn started and becomes ` +
          `callable once the turn ends. Finish the turn without it.`,
      };
    }
    return authorize(resource, action, context);
  };
}
