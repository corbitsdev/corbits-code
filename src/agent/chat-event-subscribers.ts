/**
 * Shared chat-director reactor subscriber for the TUI and exec stream sinks.
 * Parse, validation, and invalid-payload handling live here so the two sinks
 * cannot drift apart.
 */

import { type } from "arktype";
import {
  CHAT_TASKS_CHANGED_EVENT,
  CHAT_TOOLS_ACTIVATE_EVENT,
  COMPACTION_FOLD_NONCONVERGED_EVENT,
  ChatTasksChangedDataSchema,
  ChatToolsActivateDataSchema,
  CompactionFoldNonConvergedDataSchema,
} from "./director.js";
import type { Task } from "./tasks.js";

export interface ChatDirectorEventHandlers {
  onTasksChanged: (tasks: Task[]) => void;
  onToolsActivate: (names: string[]) => void;
  onFoldNonConverged?: (notice: string) => void;
}

export type ChatDirectorEventDebugLog = (
  message: string,
  fields?: Record<string, unknown>,
) => void;

/**
 * Dispatch one chat-director stream event to the handlers. Returns true for
 * any chat-director event (valid or not) so sinks fall through otherwise.
 * Invalid payloads are dropped with a debug log naming the failure.
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
  if (event.type === COMPACTION_FOLD_NONCONVERGED_EVENT) {
    const parsed = CompactionFoldNonConvergedDataSchema(event.data);
    if (parsed instanceof type.errors) {
      logDebug(
        "chat fold-nonconverged event dropped invalid payload: {error}",
        { error: parsed.summary },
      );
      return true;
    }
    handlers.onFoldNonConverged?.(parsed.notice);
    return true;
  }
  return false;
}
