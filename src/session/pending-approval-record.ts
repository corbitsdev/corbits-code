import { type } from "arktype";
import {
  ApprovalSnapshot,
  type PendingOperation,
  ToolCall,
} from "@intx/types/runtime";

/**
 * A pending operation as it rests in session state (metadata.json, or a turn
 * log record). Validated on read because both files are external input.
 */
export const StoredPendingOperationSchema = type({
  correlationId: "string",
  kind: "'approval'",
  "expectedFrom?": "string",
  registeredAt: "number",
  gateId: "string",
  "timeoutAt?": "number",
  "suspendedCall?": ToolCall,
  "approvalSnapshot?": ApprovalSnapshot,
});

/**
 * A parked call's approval rests in the turn log as its own line, right after
 * the turn that holds the call, so the call's tool_result line is what closes
 * it. The line carries no `role`, so no turn parser can mistake it for a turn.
 */
const PendingApprovalRecordSchema = type({
  pendingApproval: StoredPendingOperationSchema.and({
    suspendedCall: ToolCall,
  }),
  "+": "reject",
});

export type PendingApprovalRecord = { pendingApproval: PendingOperation };

export function pendingApprovalRecord(
  op: PendingOperation,
): PendingApprovalRecord {
  return { pendingApproval: op };
}

/** The approval a turn log line records, or null when the line is not one. */
export function parsePendingApprovalRecord(
  raw: unknown,
): PendingOperation | null {
  const result = PendingApprovalRecordSchema(raw);
  if (result instanceof type.errors) return null;
  return result.pendingApproval;
}
