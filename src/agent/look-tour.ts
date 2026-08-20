/**
 * After a worker hard-block salvage, nudge Skywalker once.
 * Event-driven — not a look-count quota. Unique reads are legal at any volume.
 */

export const PRIMARY_SALVAGE_NUDGE =
  "A worker stopped without finishing. Synthesize Blockers for the operator. Do not search the repo yourself. Change the brief (success_criteria / do_not / agent) before starting another worker, or stop.";
