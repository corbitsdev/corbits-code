export type RuntimeShutdownDeps = {
  disposeHost: () => void
  cancelWorkers: () => void
  closeAgent: () => Promise<void>
}

/** Start every process-owned teardown path once, even when exit races a signal. */
export function createRuntimeShutdown(deps: RuntimeShutdownDeps): () => Promise<void> {
  let started = false
  let completion = Promise.resolve()

  return (): Promise<void> => {
    if (started) return completion
    started = true

    try {
      deps.disposeHost()
    } catch {
      // Every teardown leg is best-effort; one failure must not strand the rest.
    }
    try {
      deps.cancelWorkers()
    } catch {
      // The primary agent still needs its abort even if a worker hook misbehaves.
    }
    try {
      completion = deps.closeAgent().catch(() => undefined)
    } catch {
      completion = Promise.resolve()
    }
    return completion
  }
}
