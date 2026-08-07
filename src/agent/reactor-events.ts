/**
 * `inference.done` and `reactor.done` read as near-synonyms at a call site
 * but mean opposite things: `inference.done` fires once per turn (the
 * boundary code that reacts "between turns" needs), while `reactor.done`
 * fires once, at reactor shutdown. Three shipped defects (queued messages
 * never dispatching, `run.json`'s `turnsUsed` freezing for a whole session,
 * and the shell not returning to idle between turns) all came from code
 * keying off `reactor.done` when it meant `inference.done`. These guards
 * make the two impossible to confuse: name the question, not the string.
 *
 * Generic over the event's own type so this narrows both `ReactorInboundEvent`
 * (`@intx/types/runtime`) and `ReactorEmittedEvent` (`@intx/inference`)
 * call sites without re-declaring the union here.
 */

/** True when `event` is the turn boundary — fires once per turn, every turn. */
export const onTurnBoundary = <E extends { type: string }>(
  event: E,
): event is Extract<E, { type: "inference.done" }> => event.type === "inference.done";

/** True when `event` is reactor shutdown — fires once, at the end of the run. */
export const onReactorShutdown = <E extends { type: string }>(
  event: E,
): event is Extract<E, { type: "reactor.done" }> => event.type === "reactor.done";
