# CL-9713 — Decision record: cut custom watchdog back to native HITL baseline

**Status:** Resolved (won't-build / wont-fix) per operator decision.
**Date:** Reverted from working tree; working tree back to HEAD baseline + pre-existing env noise.

## Decision

CL-9713 resolved per operator decision: rely on native Interchange HITL approve/confirm. All custom watchdog machinery shipped by CL-9713 (per-gate `openGates` metadata, `stuckState`/`lastProgressAt` on TurnState, `gateOpened`/`gateClosed` re-keyed by gateId, `bag.gateById`, `approvalTimeout()`/watchdog-settings mapper, `classifyStuckLevel`/`toolCallLastProgressAt`, `stuckStateRampPhase`/`stuckState` UI surfacing, watchdog telemetry capture/recovery/cancel, watchdog recovery coordinator, watchdog e2e/settings/recovery tests, runner wiring, and docs edits) has been removed from the tree. `approvalTimeout()` stays unarmed — it returns `undefined` in the baseline. Functional outcome: **native Interchange HITL, no custom watchdog.**

- **Approval gates wait indefinitely for the operator**: `approvalTimeout()` returns `undefined` (src/tui/runner/session.ts), so gate-wire autoDeny/autoCancel timers arm only `if (ev.timeoutMs !== undefined)`; no product path ever sets `timeoutMs`, so no auto-settle in product.
- **Exit + resume reloads pending approvals**: `PendingOperation` / `resolveParkedCallIdFromStore` (src/session/approval-resume.ts:93-104) re-parks pending approvals on the resumed generation — existing baseline behavior, verified.
- **Pinning test**: a `gate with no timeout waits indefinitely` test was added to src/tui/gate-wire.test.ts (permission + operator cases). Baseline already armed timers only when `timeoutMs` was provided, but no test asserted the no-timeout case, so the guard was added.
- **Recommendation**: close the Linear CL-9713 issue as wont-fix/wont-build with this rationale.
- **Related**: see CL-10234 (HITL approval gates wait indefinitely — pin behavior + decision record) and PR #1361 (bwachman) for the actual bug fix pending review fleet, recommended for release 0.3.36.

## Removed / reverted

- Reverted to HEAD (git checkout): docs (ARCHITECTURE, IMPLEMENTATION, PRODUCT, TUI), settings.ts + settings.test.ts, telemetry (index, product-events, + tests), chrome-state.ts, gate-wire.ts (+ test), product-host.ts, runner (host, index, session, state), runtime-bridge.ts (+ test), stall-watchdog.ts (+ test), turn-state.ts (+ test), agent-ask-wake / allow-once-reprompt / ramp-paint / turn-monitor tests (gateId threading).
- Deleted (untracked CL-9713 files): src/tui/watchdog-recovery.ts, src/tui/watchdog-recovery.test.ts, src/tui/watchdog.e2e.test.ts, src/config/watchdog-settings.test.ts.

## Kept (pre-existing baseline, MUST stay)

stall-watchdog.ts, tool-execution-watchdog.ts, run-liveness.ts, budget-race.ts, `MAX_TOOL_EXECUTION_TIMEOUT_MS`, `STALL_TIMEOUT_MS`. vendor/ zero diff.