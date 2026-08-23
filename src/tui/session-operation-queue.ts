// Serial promise chain for session-scoped operations (reload, interrupt, deliver).
// Each task runs after the previous one settles; failures do not block the tail.

export interface SessionOperationQueue {
  /** Enqueue an async operation; returns a promise for this operation's settlement. */
  enqueue: (op: () => Promise<void>) => Promise<void>;
  /** Await the tail of the queue (all prior operations finished or failed). */
  awaitTail: () => Promise<void>;
}

export function createSessionOperationQueue(): SessionOperationQueue {
  let tail: Promise<void> = Promise.resolve();

  const enqueue = (op: () => Promise<void>): Promise<void> => {
    tail = tail.then(op, op);
    return tail;
  };

  return {
    enqueue,
    awaitTail: () => tail.catch(() => undefined),
  };
}
