import { Box, useInput, useApp } from "ink";
import type { EventEmitter } from "node:events";
import type { Agent } from "@intx/agent";
import { useState, type ReactNode } from "react";
import { useAgentStream } from "./use-stream.js";
import { Header } from "./components/header.js";
import { EventLog } from "./components/event-log.js";
import { StatusBar } from "./components/status-bar.js";
import { ChatInput } from "./components/chat-input.js";
import { TaskPrompt } from "./components/task-prompt.js";

export type AppProps = {
  eventEmitter: EventEmitter;
  agent: Agent;
  initialTask: string;
};

async function sendTask(agent: Agent, task: string): Promise<void> {
  try {
    await agent.send(task);
  } catch (err) {
    process.stderr.write(`interchange-code: failed to send task: ${err}\n`);
  }
}

export function App({ eventEmitter, agent, initialTask }: AppProps): ReactNode {
  const state = useAgentStream(eventEmitter);
  const { exit } = useApp();
  const [planCollapsed, setPlanCollapsed] = useState(false);
  const [task, setTask] = useState(initialTask);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      exit();
      return;
    }
    if (key.ctrl && input === "o") {
      setPlanCollapsed((c) => !c);
      return;
    }
    if (key.escape) {
      exit();
    }
  });

  const handleTaskSubmit = (submitted: string) => {
    setTask(submitted);
    void sendTask(agent, submitted);
  };

  const handleSend = (message: string) => {
    void sendTask(agent, message);
  };

  if (task.length === 0) {
    return (
      <Box flexDirection="column" height="100%">
        <Header
          turnsUsed={state.turnsUsed}
          status={state.status}
          totalCost={state.formattedCost}
          sessionTitle=""
          latestUserMessage={state.latestUserMessage}
        />
        <Box flexGrow={1} flexDirection="column" justifyContent="center">
          <TaskPrompt onSubmit={handleTaskSubmit} />
        </Box>
        <StatusBar />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" height="100%">
      <Header
        turnsUsed={state.turnsUsed}
        status={state.status}
        totalCost={state.formattedCost}
        sessionTitle={task}
        latestUserMessage={state.latestUserMessage}
      />
      <Box flexGrow={1} flexDirection="column">
        <EventLog contentBlocks={state.contentBlocks} planCollapsed={planCollapsed} />
      </Box>
      <ChatInput onSubmit={handleSend} />
      <StatusBar />
    </Box>
  );
}
