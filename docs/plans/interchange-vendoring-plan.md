# Interchange vendoring plan

Read-only research, verified against the real upstream clone at
`/Users/thegreataxios/abklabs/interchange` (HEAD `cd7c5a37`), not the npm
registry. Companion to `docs/plans/interchange-upgrade-assessment.md`, which
covers the original registry-only pass; this document supersedes that one's
ledger and adds the vendoring-scope decision, the approval-primitive
analysis, and the staged execution plan. Nothing in this repo or in the
upstream clone was modified to produce it. Upstream is never modified or
pushed to from this repo — patches live only in `vendor/intx-inference`
here, and are dropped the moment upstream carries the same fix.

## 1. Why vendor at scale

We consume Interchange as published `@intx/*` npm packages pinned at
`0.2.2` (2026-07-15). The npm registry has nothing published past `0.2.2` —
upstream `main` is 416 commits and about three weeks ahead with no newer
release. Waiting for upstream releases is not an option if we want the
reactor correctness fixes and the new approval primitive (§4). The only way
to reach upstream head is to vendor the packages as source, the same way we
already vendor `@intx/inference` in `vendor/intx-inference`. This is
approved: staying cutting-edge matters more than staying on published
releases, provided the vendoring is legible (§6) and upstream is never
touched.

## 2. Verified patch ledger — `vendor/intx-inference`

Diffed `vendor/intx-inference/src` against `packages/inference/src` at
upstream HEAD (not just `v0.2.2`) for all 9 files the prior assessment
flagged as diverging.

| File | Patch purpose | Verdict at HEAD | Disposition |
|---|---|---|---|
| `adapter.ts` | `StreamTerminalDetector`/`isStreamTerminal` so OpenAI Responses streaming ends on a semantic completion event instead of hanging on socket close | Absent (`isStreamTerminal`: 0 hits) | **Carry** |
| `assembly.ts` | `resolvedContextTransforms = contextTransforms ?? deps.contextTransforms` fallback, since published `@intx/agent` forwards `deps` verbatim with no dedicated transforms field | Absent, and the surrounding shape is unchanged since `0.2.2` — re-applies cleanly, no rework needed | **Carry** (prior assessment's "needs closer diff" hedge was unnecessary) |
| `errors.ts` / `harness.ts` | `classifyAbortError(reason)` takes the abort reason so callers get `origin` (`user-stop` vs `internal-recovery`) | `classifyAbortError()` still takes 0 args at HEAD, called with 0 args at all 4 sites in `harness.ts` | **Carry** |
| `providers/google-genai-files.ts` | `opts.bytes as unknown as BodyInit` cast to satisfy DOM lib's `BodyInit` vs Node's `Uint8Array` typing | HEAD line 172 still passes `opts.bytes` uncast | **Carry** (worth filing upstream as a real typing gap) |
| `reactor.ts` — `correlatingIds` leak | Wraps the correlated-resume critical section in `try/finally` so the id is cleared on the success path too | Confirmed live leak at HEAD: `tryCorrelate` (`reactor.ts:451-548`) deletes `correlatingIds` on the three failure exits (467, 471, 486) but none of the three success dispatch modes (`redispatch`/`error_result`/`gate-cleared`, 494-547) delete it before returning — unbounded `Set` growth on every successful correlated resume, for the life of the process | **Carry** |
| `sse.ts` | `MAX_LINE_LENGTH` caps the unterminated SSE line buffer at 16 MiB, throws instead of growing unbounded | Absent (0 hits) — OOM vector still open | **Carry** |
| `state.ts` | `deepFreeze` on appended turns + `turnsRevision` counter so persistence skips re-serializing unchanged history on checkpoint | Absent (0 hits) | **Carry** |
| `index.ts` | Re-exports the patches above | Mechanical; re-derives itself once the source patches are re-applied | **Carry** (no independent work) |
| `reactor.ts` — `ephemeralTurns` on `ExtendedInferenceOptions` | Per-call turns appended to the materialized prompt but never persisted, for transient director guidance without touching the cached prefix | Absent everywhere in `packages/inference/src/*.ts` at HEAD, including `director.ts` and `default-director.ts` — no native equivalent exists | **Carry** (prior assessment's "may be superseded by the director split" does not hold) |

**Count: 9/9 carry, 0 drop, 0 rework.** Every substantive patch (8 of the 9
rows; `index.ts` is mechanical) is a real fix still absent upstream — not
dead weight from a prior workaround. Re-applying them on any upgrade is not
optional cleanup: skipping them reintroduces a memory leak
(`correlatingIds`), an OOM vector (unbounded SSE line growth), and a hang
(OpenAI Responses streaming never terminating on socket-only close).

One correction to the prior assessment, framing only, no ledger impact:
`director.ts` is not new since `0.2.2` — it predates it by many commits
(`657618d9`, `efa2f98b` visible in `git log --oneline -- packages/inference/src/director.ts`).
Our vendored `director.ts` is byte-identical to upstream HEAD. None of the 9
patched files touch `director.ts`, `default-director.ts`, or
`correlation.ts`, so the restructuring in that area doesn't affect re-apply
cost for any of the above.

## 3. Vendoring scope

Upstream has 30 packages (`ls packages/` at HEAD; prior assessment's "~31"
was close). We consume 7: `@intx/authz`, `@intx/inference`, `@intx/agent`,
`@intx/tools-posix`, `@intx/storage-isogit`, `@intx/log`, `@intx/types`.

**Recommendation: vendor all 7 as source, not just `@intx/inference`.**
Mixing a vendored-at-head `@intx/inference` against published-at-0.2.2
`@intx/agent`/`@intx/types`/`@intx/storage-isogit` is not viable —
`@intx/inference` HEAD's reactor suspend/resume path (§4) depends on the
`PendingOperation` type added to `packages/types/src/runtime.ts` and a
`store.ts` change in `@intx/storage-isogit`, both landed in the same commit
(`06d39dc6`) as the `@intx/inference` change. Vendoring `@intx/inference`
alone without its type and storage counterparts would leave the suspend
path referencing types that don't exist in our pinned `@intx/types`.
`@intx/authz`, `@intx/tools-posix`, `@intx/log` have no direct coupling to
the suspend/resume change and could stay published — but since they're
small and the whole point is coherence with head, vendor them too rather
than tracking two different sync cadences.

### Does vendoring resolve the arktype duplication (root cause of `instanceof` narrowing breaking)?

**Yes, and it's confirmed as a real duplication today, not a hypothetical.**
Root `corbits-code/package.json:72` pins `"arktype": "^2.2.3"` directly.
`bun.lock:222` resolves that to `arktype@2.2.3` with
`@ark/schema@0.56.2`/`@ark/util@0.56.2`. But every published `@intx/*`
package we consume (`bun.lock:606-616`: `@intx/agent`,
`@intx/inference-discovery`, `@intx/inference-testing`, `@intx/mime`,
`@intx/storage-isogit`, `@intx/types`) carries its own **nested**
`arktype@2.2.0` with `@ark/schema@0.56.0`/`@ark/util@0.56.0` — a distinct
minor version with distinct `@ark/*` internals, hence a distinct
`ArkErrors`/type prototype from the root's. Any `instanceof` check against a
type constructed by the nested instance and evaluated against the root's
`arktype` (or vice versa) silently returns `false`. Upstream's own
`package.json` files declare `"arktype": "catalog:"` (a workspace catalog
reference, not a literal version) for `inference`, `agent`,
`storage-isogit`, `types` — so at upstream HEAD, within the interchange
monorepo itself, there is exactly one `arktype` instance shared by every
package.

Vendoring these packages as source under our own workspace, rather than
installing them as independent npm packages, collapses them onto our root
`arktype` — there is no nested `node_modules/@intx/*/node_modules/arktype`
once the package isn't installed from the registry, so every import
resolves to the single root instance. That removes the duplication
entirely, provided the root `arktype` version stays compatible with what
the vendored source expects (the source doesn't pin a version at all once
it's ours — only `import "arktype"` calls remain, resolved via our root
`package.json`).

## 4. What changes for us — the approval primitive

Commit `06d39dc6` ("Suspend the reactor on an ask authz decision",
2026-07-16, one day after our `v0.2.2` pin, +659/-92 across 4 files) changes
`packages/inference/src/authz-extension.ts` so the `ask` authz effect no
longer blocks with an error — it suspends the reactor. On
`result.effect === "ask"` it mints a `correlationId`, computes a
`timeoutAt` from `DEFAULT_APPROVAL_TIMEOUT_MS` (1 hour, overridable via
`opts.approvalTimeoutMs`), builds a `gateId` (`pending-${correlationId}`),
and returns `{ type: "suspend", gate: {...}, pendingOp }` instead of an
error string. `packages/types/src/runtime.ts` adds the `PendingOperation`
type and extends `BeforeToolExtension`'s return contract with the `suspend`
variant. `packages/inference/src/reactor.ts` wires the suspend action into
the dispatch loop — this is the same function (`tryCorrelate`) audited for
the `correlatingIds` leak in §2, so adopting this primitive and carrying our
leak fix are the same piece of work, not two. `packages/storage-isogit/src/store.ts`
persists the pending-operation record. Three follow-ups refine it through
early August: `c5d31268` (capture suspended tool call on park), `7310711f`
(single-use approval bypass), `f563ab60` (approval snapshot construction).

**Our current architecture was built without this primitive and does not
call it.** `src/permission/gate.ts` (625 lines) is our own durable
pending-approval gate — it owns the block/ask decision, has its own
headless-fallback policy (unresolved ask + no operator attached → denial,
`gate.ts:198`), and its own command-deny path stricter than authz grants
(`gate.ts:387`). `src/permission/queue.ts` and `store.ts` are our own
queue/persistence for pending approvals. `src/permission/classify.ts`
defines our own `Tier = "allow" | "ask"` classifier, independent of
`@intx/authz` grants. None of these call `createAuthzExtension`,
`PendingOperation`, or `ApprovalSnapshot` — a repo-wide grep for those
symbols under `src/permission/` and `src/agent/director.ts` returns zero
hits. `src/agent/director.ts` (808 lines) has its own `ask_operator` tool
and task/goal state machine, with no reference to reactor-level suspend.

This is not incremental overlap — it is a parallel mechanism, built because
upstream lacked one. Adopting upstream's primitive concretely means:

- Replacing `gate.ts`'s pending-record bookkeeping with the reactor-level
  `PendingOperation`/correlation-id flow the suspend action returns.
- Rewiring `director.ts`'s ask-handling to consume `suspend` reactor
  actions (via `createAuthzExtension`) instead of managing its own queue.
- Deciding whether `classify.ts`'s allow/ask tiering still sits above
  authz grants as a pre-filter, or gets re-expressed as authz policy that
  resolves to `ask` and lets the reactor's suspend path own the rest.
- Deciding what happens to our stricter-than-authz command-deny path
  (`gate.ts:387`) and headless-denial policy (`gate.ts:198`) — neither has
  an upstream equivalent; both need to be re-homed somewhere in the new
  flow, not dropped silently.

Upstream's `director.ts`/`default-director.ts`/`correlation.ts` are
`@intx/inference`-internal reactor plumbing (a pure `ReactorCapabilities`
factory and the built-in `DefaultDirector`), not something our
`src/agent/director.ts` subclasses or parallels in shape — there is no
"split" on our side to reconcile against theirs. The delta that matters for
us is entirely the suspend/resume path in `reactor.ts`, not `director.ts`'s
structure.

`@intx/inference-discovery` exists at `packages/inference-discovery/` and is
confirmed (per its `README.md` and `src/index.ts`) to be a capture/replay
test rig — `ProviderPlugin`, `runCapture`, a CI guard that aborts if `CI` is
set, writing `request.json`/`response.{json,sse}` bundles for
`@intx/inference-testing` to replay — not a runtime model registry. Its
`catalog` submodule (`Capability`, `INTENTS`, `SUPPORT_MATRIX`,
`catalogCapabilitiesFor`) is the right shape to answer "what
provider/model/capability triples exist" for onboarding (CL-5499/5494), but
whether it's meant to be imported at CLI runtime versus only as a
fixture-seeding data source for tests is still unconfirmed and out of scope
for this vendoring pass.

## 5. Staged, independently-landable sequence

Each stage lands on `main`, keeps the build/typecheck/test gates green, and
is independently releasable — no stage depends on a later one being merged
first for main to stay shippable.

**Correction, post-implementation:** this claim does not hold for stages 2
and 3. Vendoring `@intx/types` alone (stage 2) does not typecheck against
the already-vendored `@intx/inference` (which still targets the old,
npm-published type shapes) — the approval-suspend primitive's
`PendingOperation` type and `BeforeToolDecision` return contract changed
shape between the npm-published `@intx/types` and upstream head, and
`@intx/inference`'s vendored source is pinned to the old shapes until it is
also re-synced. The two packages are typed against each other via the same
upstream commit (`06d39dc6`) and cannot be split across two separately
landable PRs without an intermediate broken-build state. Stages 2 and 3 were
merged into a single PR as a result; see `docs/VENDORING.md` for the
resulting vendoring record.

1. **Approval-primitive RFC** (CL-5683). Read `06d39dc6` and its three
   follow-ups in full, decide whether `src/permission` adopts the reactor
   suspend primitive, adapts it, or keeps the current design with an
   explicit reason. This is a design decision, not code — it gates stage 4
   and must land before CL-5643 builds anything on the current "ask blocks
   with an error" model.
2. **Vendor `@intx/types` and `@intx/storage-isogit` at head**, replacing
   the published npm installs. Smallest-blast-radius packages, no patch
   history to carry, and they're the dependency floor everything else in
   this sequence needs (`PendingOperation` lives in `@intx/types`).
3. **Vendor `@intx/inference` at head**, re-applying all 9 carried patches
   from §2 against the new file shapes. This is the highest-risk stage —
   budget for it as its own review pass, not a mechanical bump. Confirms or
   fixes the arktype duplication (§3) once `@intx/types` is also vendored
   (stage 2).
4. **Vendor `@intx/agent`, `@intx/authz`, `@intx/tools-posix`, `@intx/log`
   at head**, completing the coherent set. Lower risk than stage 3 — these
   have no known local patches.
5. **Adopt the approval primitive** in `src/permission` and
   `src/agent/director.ts`, per the design from stage 1. Depends on stages
   2-4 landing so `createAuthzExtension`'s suspend path and
   `PendingOperation` are actually available. This is the stage CL-5643
   should be built against, not the current gate.
6. **Docs and patch-ledger process** (§6) — can land any time after stage 3
   establishes the vendoring pattern for `@intx/inference`; earlier is
   better since it documents the pattern the later stages follow.

`@intx/inference-discovery` (onboarding catalog, CL-5499/5494) is
deliberately not in this sequence — it needs the runtime-vs-test-fixture
question answered first (§4, last paragraph), and isn't required by the
approval primitive or the arktype fix.

## 6. Docs plan

Once vendoring is at the scale of 7 packages instead of 1, the existing
informal pattern (a single `vendor/intx-inference` directory with patches
implied by diffing) stops scaling. `docs/` needs:

- **`docs/VENDORING.md`** (new): what's vendored and why, one row per
  package (`@intx/types`, `@intx/inference`, etc.) with vendor path, source
  commit/tag it was synced from, and whether it carries local patches.
  Explains the re-sync procedure: how to pull a new upstream commit into a
  vendored package, how to re-run the patch ledger check, what "coherent"
  means when only some packages have moved.
- **Patch ledger lives in-repo, not only in `docs/plans/`**: a
  `vendor/intx-inference/PATCHES.md` (or equivalent per vendored package)
  listing each local patch, the file(s) it touches, why it exists, and the
  upstream issue/commit to watch for it landing. `docs/plans/*.md` is a
  point-in-time investigation; the ledger that must stay current belongs
  next to the code it describes, linked from `docs/VENDORING.md`.
  `docs/plans/interchange-vendoring-plan.md` (this file) becomes historical
  once the stages land — `docs/VENDORING.md` is the document that stays
  current after.
- **Vendored-and-patched vs. vendored-verbatim**: make this visible at a
  glance — e.g. a patched file carries a header comment naming the patch
  entry in `PATCHES.md`; `docs/VENDORING.md`'s table marks each package
  patched/verbatim. Anyone diffing a vendored file against upstream should
  be able to tell in one grep whether a divergence is intentional (documented
  patch) or accidental (missed re-sync).
- **`AGENTS.md`'s "Building on Interchange" table** gets a one-line pointer
  to `docs/VENDORING.md` once it exists, so agents checking "does Interchange
  already have this" land on the sync-state doc, not just the package list.

## Recommendation on sequencing against TUI stabilisation

Stage 1 (the approval-primitive RFC, CL-5683) should happen now, in
parallel with TUI work — it's a read-and-decide task, not implementation,
and it directly gates whether CL-5643 is safe to start. Stages 2-4 (the
vendoring bump itself) should follow the existing recommendation: after the
current TUI stabilisation work, not interleaved with it, since stage 3 in
particular is a real review-weight change to the reactor's core file.
Stage 5 (adopting the primitive in `src/permission`) should not start until
stage 1's decision is made and stages 2-4 are on `main` — building against
the current gate in the meantime is the throwaway-work risk the original
assessment flagged for CL-5643.

Nothing in this document was implemented. Vendoring at this scope requires
the same operator approval given for the original `@intx/inference`
vendoring before any stage begins landing code.
