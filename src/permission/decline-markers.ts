// Model-facing texts that announce a declined tool call, and the seam each
// one comes from. The director classifies tool results by these strings and
// the approval-resume path detects the reactor's timeout settlement with
// them — so a wording change on any producing side must land here in the
// same commit, or rejections silently stop classifying and the model sees a
// plain tool error where an operator decision was made.
//
// The vendored texts are inline literals in vendor/intx-inference with no
// exported constant and no typed outcome on the Reactor surface (which is
// just { start, deliver, abort }) and no pending-operation lookup by
// correlationId. Until upstream exports one of those, the strings below are
// the contract; changing them means re-checking the cited vendor source.

/** vendor/intx-inference authz-extension.ts formatBlockReason — deny effect. */
export const DENIED_BY_POLICY_MARKER = "Denied by policy:";

/** vendor/intx-inference authz-extension.ts formatBlockReason — no grant matched. */
export const NO_MATCHING_GRANTS_MARKER = "No matching grants for ";

/** Corbits middleware path: plugins/permission-plugin.ts prefixes the gate's deny reason. */
export const BLOCKED_BY_POLICY_PREFIX = "Blocked by permission policy: ";

/** Corbits gate.ts evaluate() decline reason prefix. */
export const OPERATOR_DECLINED_PREFIX = "Operator declined: ";

/** Composed middleware text the director matches for an operator decline. */
export const OPERATOR_DECLINED_MARKER = BLOCKED_BY_POLICY_PREFIX + OPERATOR_DECLINED_PREFIX;

/** vendor/intx-inference reactor.ts — rejected approval decision result. */
export const APPROVER_REJECTION_MARKER = "denied by approver";

/** vendor/intx-inference reactor.ts — timed-out approval suspension result. */
export const APPROVAL_TIMEOUT_RESULT_TEXT = "approval timed out";

/** Worker unresolved-ask deny — parent grants the named subject and retries. */
export const WORKER_CANNOT_COMPLETE_APPROVAL = "workers cannot complete operator approval.";
