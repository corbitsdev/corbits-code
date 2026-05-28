import { Box, useInput, useApp } from "ink";
import type { EventEmitter } from "node:events";
import type { ReactNode } from "react";
import { useAgentStream } from "./use-stream.js";
import { Header } from "./components/header.js";
import { EventLog } from "./components/event-log.js";
import { StatusBar } from "./components/status-bar.js";

export type AppProps = {
  eventEmitter: EventEmitter;
  maxTurns: number;
};

export function App({ eventEmitter, maxTurns }: AppProps): ReactNode {
  const state = useAgentStream(eventEmitter);
  const { exit } = useApp();

  useInput((input, key) => {
    if (input === "q" || key.escape) {
      exit();
    }
  });

  return (
    <Box flexDirection="column" height="100%">
      <Header
        turnsUsed={state.turnsUsed}
        status={state.status}
        totalCost={state.formattedCost}
        maxTurns={maxTurns}
      />
      <Box flexGrow={1} flexDirection="column">
        <EventLog events={state.events} />
      </Box>
      <StatusBar />
    </Box>
  );
}
