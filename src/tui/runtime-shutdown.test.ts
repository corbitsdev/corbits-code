import { describe, expect, test } from "bun:test"

import { createRuntimeShutdown } from "./runtime-shutdown.js"

describe("runtime shutdown", () => {
  test("restores the terminal, cancels workers, and closes the primary agent", async () => {
    const calls: string[] = []
    const shutdown = createRuntimeShutdown({
      disposeHost: () => calls.push("host"),
      cancelWorkers: () => calls.push("workers"),
      closeAgent: async () => {
        calls.push("agent")
      },
    })

    await shutdown()

    expect(calls).toEqual(["host", "workers", "agent"])
  })

  test("runs teardown only once when exit and a signal race", async () => {
    const calls: string[] = []
    const shutdown = createRuntimeShutdown({
      disposeHost: () => calls.push("host"),
      cancelWorkers: () => calls.push("workers"),
      closeAgent: async () => {
        calls.push("agent")
      },
    })

    await Promise.all([shutdown(), shutdown()])

    expect(calls).toEqual(["host", "workers", "agent"])
  })

  test("still aborts workers and the primary agent when host disposal fails", async () => {
    const calls: string[] = []
    const shutdown = createRuntimeShutdown({
      disposeHost: () => {
        calls.push("host")
        throw new Error("renderer failure")
      },
      cancelWorkers: () => calls.push("workers"),
      closeAgent: async () => {
        calls.push("agent")
      },
    })

    await shutdown()

    expect(calls).toEqual(["host", "workers", "agent"])
  })
})
