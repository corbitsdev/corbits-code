import { Box, useInput, useApp } from "ink";
import type { EventEmitter } from "node:events";
import type { Agent } from "@intx/agent";
import type { ReactNode } from "react";
import { useAgentStream } from "./use-stream.js";
import { Header } from "./components/header.js";
import { EventLog } from "./components/event-log.js";
import { StatusBar } from "./components/status-bar.js";
import { ChatInput } from "./components/chat-input.js";

export type AppProps = {
  eventEmitter: EventEmitter;
  maxTurns: number;
  agent: Agent;
};

export function App({ eventEmitter, maxTurns, agent }: AppProps): ReactNode {
  const state = useAgentStream(eventEmitter);
  const { exit } = useApp();

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      exit();
      return;
    }
    if (key.escape) {
      exit();
    }
  });

  const handleSend = (message: string) => {
    state.addUserMessage(message);
    agent.send(message).catch(() => {});
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
        <EventLog log={state.log} />
      </Box>
      <ChatInput onSubmit={handleSend} />
      <StatusBar />
    </Box>
  );
}
