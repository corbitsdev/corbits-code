// Serial promise chain for session-scoped operations (reload, interrupt, deliver).
// Each task runs after the previous one settles; failures do not block the tail.
// awaitTail from inside the current op must not wait for that op (self-deadlock);
// callers outside the chain still wait for the full tail.

import { AsyncLocalStorage } from "node:async_hooks";

const onSessionOp = new AsyncLocalStorage<true>();

export interface SessionOperationQueue {
  /** Enqueue an async operation; returns a promise for this operation's settlement. */
  enqueue: (op: () => Promise<void>) => Promise<void>;
  /** Await the tail of the queue (all prior operations finished or failed). */
  awaitTail: () => Promise<void>;
}

export function createSessionOperationQueue(): SessionOperationQueue {
  let tail: Promise<void> = Promise.resolve();

  const enqueue = (op: () => Promise<void>): Promise<void> => {
    const run = (): Promise<void> => onSessionOp.run(true, op);
    tail = tail.then(run, run);
    return tail;
  };

  return {
    enqueue,
    awaitTail: () =>
      onSessionOp.getStore() === true
        ? Promise.resolve()
        : tail.catch(() => undefined),
  };
}
