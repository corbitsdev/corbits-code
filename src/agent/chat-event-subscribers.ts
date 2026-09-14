/**
 * Shared subscriber for the chat-director reactor events. The TUI and exec
 * stream sinks both listen for the task-list and tool-activation events the
 * chat director emits in place of the former host closures; the parse,
 * validation, and invalid-payload handling live here so the two sinks cannot
 * drift apart.
 */

import { type } from "arktype";
import {
  CHAT_TASKS_CHANGED_EVENT,
  CHAT_TOOLS_ACTIVATE_EVENT,
  ChatTasksChangedDataSchema,
  ChatToolsActivateDataSchema,
} from "./director.js";
import type { Task } from "./tasks.js";

export interface ChatDirectorEventHandlers {
  onTasksChanged: (tasks: Task[]) => void;
  onToolsActivate: (names: string[]) => void;
}

export type ChatDirectorEventDebugLog = (
  message: string,
  fields?: Record<string, unknown>,
) => void;

/**
 * Dispatch one stream event to the chat-director handlers. Returns true when
 * the event is a chat-director event (valid or not) so sinks can fall through
 * to their own handling otherwise. Invalid payloads are dropped after a
 * debug-level log naming the failure — never silently.
 */
export function handleChatDirectorEvent(
  event: { type: string; data: unknown },
  handlers: ChatDirectorEventHandlers,
  logDebug: ChatDirectorEventDebugLog,
): boolean {
  if (event.type === CHAT_TASKS_CHANGED_EVENT) {
    const parsed = ChatTasksChangedDataSchema(event.data);
    if (parsed instanceof type.errors) {
      logDebug("chat tasks-changed event dropped invalid payload: {error}", {
        error: parsed.summary,
      });
      return true;
    }
    handlers.onTasksChanged(parsed.tasks);
    return true;
  }
  if (event.type === CHAT_TOOLS_ACTIVATE_EVENT) {
    const parsed = ChatToolsActivateDataSchema(event.data);
    if (parsed instanceof type.errors) {
      logDebug("chat tools-activate event dropped invalid payload: {error}", {
        error: parsed.summary,
      });
      return true;
    }
    handlers.onToolsActivate(parsed.names);
    return true;
  }
  return false;
}
