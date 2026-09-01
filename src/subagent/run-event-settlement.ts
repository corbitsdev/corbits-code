import type { ReactorEmittedEvent } from "@intx/inference";

export interface PendingRunSettlement {
  readonly settled: Promise<void>;
  cancel: () => void;
}

export interface RunEventSettlement {
  beginSend: () => PendingRunSettlement;
  handleEvent: (event: ReactorEmittedEvent) => void;
  endStream: () => void;
}

/**
 * Coordinates Agent.send() with its streamed connector.reply. Agent.send resolves
 * when the connector reply is produced, which can precede consumption of earlier
 * inference.error events from the same run.
 */
export function createRunEventSettlement(): RunEventSettlement {
  const pending: { resolve: () => void }[] = [];
  let streamEnded = false;

  return {
    beginSend: () => {
      const entry: { resolve: () => void } = {
        resolve: () => {
          throw new Error("Run settlement resolver was not initialized");
        },
      };
      const settled = new Promise<void>((resolve) => {
        entry.resolve = resolve;
      });
      if (streamEnded) entry.resolve();
      else pending.push(entry);
      return {
        settled,
        cancel: () => {
          const index = pending.indexOf(entry);
          if (index >= 0) pending.splice(index, 1);
        },
      };
    },
    handleEvent: (event) => {
      if (event.type !== "connector.reply") return;
      pending.shift()?.resolve();
    },
    endStream: () => {
      streamEnded = true;
      for (const entry of pending.splice(0)) entry.resolve();
    },
  };
}
