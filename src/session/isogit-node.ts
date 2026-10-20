export type IsogitNodeModule = typeof import("@intx/storage-isogit/node");

let loading: Promise<IsogitNodeModule> | undefined;

export function loadIsogitNode(): Promise<IsogitNodeModule> {
  loading ??= import("@intx/storage-isogit/node");
  return loading;
}
