// A module-level slot mirroring active-run.ts's pattern: the top-level
// process handlers in src/index.ts (a detached-throw handler today, a signal
// handler alongside it) need to reach runTUI's terminal-restore routine even
// though it is a closure local to runTUI, bound only once the OpenTUI host
// has mounted. Cleared the moment runTUI itself finalizes (normally or via
// its own crash path) so a signal arriving after teardown has nothing left
// to call.
let activeDisposeHost: (() => void) | null = null;

export function setActiveDisposeHost(disposeHost: () => void): void {
  activeDisposeHost = disposeHost;
}

export function clearActiveDisposeHost(): void {
  activeDisposeHost = null;
}

export function getActiveDisposeHost(): (() => void) | null {
  return activeDisposeHost;
}
