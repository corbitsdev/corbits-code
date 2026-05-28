import { Box, Text } from "ink";
import type { ReactorEmittedEvent } from "@intx/inference";
import type { ReactNode } from "react";

export type EventLogProps = {
  events: ReactorEmittedEvent[];
};

function eventColor(event: ReactorEmittedEvent): string {
  switch (event.type) {
    case "inference.tool_call.start":
      return "cyan";
    case "inference.tool_call.end":
      return "blue";
    case "tool.start":
      return "yellow";
    case "tool.done":
      return "green";
    case "tool.update":
      return "yellow";
    case "inference.error":
    case "reactor.error":
      return "red";
    case "inference.done":
      return "magenta";
    case "reactor.done":
      return "green";
    default:
      return "gray";
  }
}

function formatEvent(event: ReactorEmittedEvent): string {
  switch (event.type) {
    case "inference.tool_call.start":
      return `[tool] ${(event.data as { name: string }).name}`;
    case "inference.tool_call.end":
      return `[tool] ${(event.data as { name: string }).name} done`;
    case "tool.start":
      return `[exec] ${(event.data as { call: { name: string } }).call.name}`;
    case "tool.done": {
      const result = (event.data as { result: { callId: string; content: string; isError: boolean } }).result;
      const prefix = result.isError ? "[error]" : "[done]";
      return `${prefix} ${result.callId} ${result.content.slice(0, 40)}`;
    }
    case "inference.error": {
      const err = (event.data as { error: { category: string; message: string } }).error;
      return `[error] ${err.category}: ${err.message}`;
    }
    case "reactor.error": {
      const data = event.data as { fatal: boolean; error: string };
      return `[reactor-error] fatal=${data.fatal}: ${data.error}`;
    }
    case "inference.done":
      return `[turn]`;
    case "reactor.done":
      return `[done]`;
    default:
      return `[${event.type}]`;
  }
}

export function EventLog({ events }: EventLogProps): ReactNode {
  if (events.length === 0) {
    return (
      <Box paddingX={1}>
        <Text color="gray">Waiting for events...</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      {events.map((event, index) => (
        <Text key={index} color={eventColor(event)}>
          {formatEvent(event)}
        </Text>
      ))}
    </Box>
  );
}
