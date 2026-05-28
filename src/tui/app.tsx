import { Box, useInput, useApp } from "ink";
import type { EventEmitter } from "node:events";
import type { ReactNode } from "react";
import { useState } from "react";
import { useAgentStream } from "./use-stream.js";
import { Header } from "./components/header.js";
import { EventLog } from "./components/event-log.js";
import { StatusBar } from "./components/status-bar.js";
import { TaskInput } from "./components/task-input.js";

export type AppProps = {
  eventEmitter: EventEmitter;
  maxTurns: number;
  onTaskSubmit?: ((task: string) => void) | undefined;
};

export function App({ eventEmitter, maxTurns, onTaskSubmit }: AppProps): ReactNode {
  const state = useAgentStream(eventEmitter);
  const { exit } = useApp();
  const [hasTask, setHasTask] = useState(onTaskSubmit === undefined);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      exit();
      return;
    }
    if (key.escape) {
      exit();
    }
  });

  const handleTaskSubmit = (task: string) => {
    setHasTask(true);
    onTaskSubmit?.(task);
  };

  return (
    <Box flexDirection="column" height="100%">
      <Header
        turnsUsed={state.turnsUsed}
        status={state.status}
        totalCost={state.formattedCost}
        maxTurns={maxTurns}
      />
      <Box flexGrow={1} flexDirection="column">
        {!hasTask ? (
          <TaskInput onSubmit={handleTaskSubmit} />
        ) : (
          <EventLog events={state.events} />
        )}
      </Box>
      <StatusBar />
    </Box>
  );
}
