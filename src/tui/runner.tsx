import { EventEmitter } from "node:events";
import { render } from "ink";
import type { ReactorEmittedEvent } from "@intx/inference";
import type { Config } from "../config.js";
import { runAgent } from "../run-agent.js";
import { App } from "./app.js";

export function createTUIEventEmitter(): EventEmitter {
  return new EventEmitter();
}

export async function runTUI(config: Config): Promise<number> {
  const emitter = createTUIEventEmitter();

  const sink = (event: ReactorEmittedEvent): void => {
    emitter.emit("event", event);
  };

  let agentPromise: Promise<number> | null = null;

  const startAgent = (task: string) => {
    agentPromise = runAgent({ ...config, task }, undefined, undefined, sink);
  };

  const needsInput = config.task.length === 0;
  if (!needsInput) {
    startAgent(config.task);
  }

  const { waitUntilExit } = render(
    <App
      eventEmitter={emitter}
      maxTurns={config.maxTurns}
      onTaskSubmit={needsInput ? startAgent : undefined}
    />,
  );

  if (agentPromise) {
    const code = await agentPromise;
    await waitUntilExit();
    return code;
  }

  // Wait for user to submit a task and agent to finish
  await waitUntilExit();
  return 0;
}
