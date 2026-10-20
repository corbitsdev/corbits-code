/**
 * The node isogit entry builds its runtime and storage at module scope.
 * Keep that off the import path until a session is actually opened.
 */

export type IsogitNodeModule = typeof import("@intx/storage-isogit/node");

let loading: Promise<IsogitNodeModule> | undefined;

export function isogitNodeLoadStarted(): boolean {
  return loading !== undefined;
}

export function loadIsogitNode(): Promise<IsogitNodeModule> {
  loading ??= import("@intx/storage-isogit/node");
  return loading;
}
