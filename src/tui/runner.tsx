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

  // Start agent run in background
  const agentPromise = runAgent(config, undefined, undefined, sink);

  // Render TUI
  const { waitUntilExit } = render(<App eventEmitter={emitter} maxTurns={config.maxTurns} />);

  // Wait for agent to finish
  const code = await agentPromise;

  // Keep TUI alive until user exits
  await waitUntilExit();

  return code;
}
