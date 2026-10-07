/**
 * `inference.done` and `reactor.done` read as near-synonyms but mean opposite
 * things: `inference.done` fires once per turn, `reactor.done` once at
 * reactor shutdown. Three shipped defects came from keying off `reactor.done`
 * when the code meant `inference.done`; these guards make the two impossible
 * to confuse. Generic over the event's own type so the same guard narrows
 * both `ReactorInboundEvent` and `ReactorEmittedEvent` call sites.
 */

import { type } from "arktype";

/** True when `event` is the turn boundary — fires once per turn, every turn. */
export const onTurnBoundary = <E extends { type: string }>(
  event: E,
): event is Extract<E, { type: "inference.done" }> =>
  event.type === "inference.done";

/** True when `event` is reactor shutdown — fires once, at the end of the run. */
export const onReactorShutdown = <E extends { type: string }>(
  event: E,
): event is Extract<E, { type: "reactor.done" }> =>
  event.type === "reactor.done";

/**
 * Explicit non-fatal reactor.error payload. Only `fatal: false` continues;
 * missing, malformed, or any other value stays terminal.
 */
const NonFatalReactorErrorData = type({
  fatal: "false",
});

/**
 * Whether a `reactor.error` payload should terminate the turn/shell.
 * Returns false only when the payload explicitly carries `fatal: false`.
 */
export function isReactorErrorFatal(data: unknown): boolean {
  return NonFatalReactorErrorData(data) instanceof type.errors;
}
