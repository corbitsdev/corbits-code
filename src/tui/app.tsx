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
  agent: Agent;
  sessionTitle: string;
};

export function App({ eventEmitter, agent, sessionTitle }: AppProps): ReactNode {
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
    agent.send(message).catch(() => {});
  };

  return (
    <Box flexDirection="column" height="100%" overflowY="hidden">
      <Box height="auto" flexShrink={0}>
        <Header
          turnsUsed={state.turnsUsed}
          status={state.status}
          totalCost={state.formattedCost}
          sessionTitle={sessionTitle}
          latestUserMessage={state.latestUserMessage}
        />
      </Box>
      <Box flexGrow={1} flexShrink={1} flexDirection="column" overflowY="hidden">
        <EventLog contentBlocks={state.contentBlocks} />
      </Box>
      <Box height="auto" flexShrink={0}>
        <ChatInput onSubmit={handleSend} />
      </Box>
      <Box height="auto" flexShrink={0}>
        <StatusBar />
      </Box>
    </Box>
  );
}
