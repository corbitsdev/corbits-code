# Vendored Interchange packages

Corbits Code consumes Interchange by vendoring every `@intx/*` package it
imports as source, directly from the upstream Interchange repository, under
`vendor/` at a single pinned upstream commit. The sole exception is
`@intx/tools-lsp`, which remains on published npm. This document is the
authoritative record of what is vendored, from which upstream commit, and
whether it carries local patches.

## Why vendor instead of install

The npm registry lags Interchange's own `main` branch, sometimes by weeks.
When a fix or a new primitive on `main` is needed before the next npm
release, the alternative to waiting is vendoring: copying the package's
source directly into this repo as a Bun workspace member, so it resolves at
whatever upstream commit it was last synced to instead of the last
published version.

Vendored packages are TypeScript source with no build step — Bun loads
`.ts` files natively, so a vendored package's `package.json` `exports` map
points straight at `./src/*.ts` files rather than a `dist/` build.

## What's vendored

| Package                                                                         | Vendor path                                                     | License       | Synced from upstream commit                | Retrieved  | Local patches                                     |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------- | ------------------------------------------ | ---------- | ------------------------------------------------- |
| `@intx/inference`                                                               | `vendor/intx-inference/`                                        | LGPL-2.1-only | `4cc697241fa037244a9164a50aec507c112bc9fb` | 2026-10-14 | Yes — see `vendor/intx-inference/PATCHES.md`      |
| `@intx/types`                                                                   | `vendor/intx-types/`                                            | LGPL-2.1-only | `4cc697241fa037244a9164a50aec507c112bc9fb` | 2026-10-14 | Yes — see `vendor/intx-types/PATCHES.md`          |
| `@intx/storage-isogit`                                                          | `vendor/intx-storage-isogit/`                                   | LGPL-2.1-only | `4cc697241fa037244a9164a50aec507c112bc9fb` | 2026-10-14 | Yes — see `vendor/intx-storage-isogit/PATCHES.md` |
| `@intx/agent`                                                                   | `vendor/intx-agent/`                                            | LGPL-2.1-only | `4cc697241fa037244a9164a50aec507c112bc9fb` | 2026-10-14 | Yes — see `vendor/intx-agent/PATCHES.md`          |
| `@intx/authz`                                                                   | `vendor/intx-authz/`                                            | LGPL-2.1-only | `4cc697241fa037244a9164a50aec507c112bc9fb` | 2026-10-14 | None — verbatim                                   |
| `@intx/log`                                                                     | `vendor/intx-log/`                                              | LGPL-2.1-only | `4cc697241fa037244a9164a50aec507c112bc9fb` | 2026-10-14 | None — verbatim                                   |
| `@intx/tools-posix`                                                             | `vendor/intx-tools-posix/`                                      | LGPL-2.1-only | `4cc697241fa037244a9164a50aec507c112bc9fb` | 2026-10-14 | Yes — see `vendor/intx-tools-posix/PATCHES.md`    |
| `@intx/mailbox`                                                                 | `vendor/intx-mailbox/`                                          | LGPL-2.1-only | `4cc697241fa037244a9164a50aec507c112bc9fb` | 2026-10-14 | None — verbatim                                   |
| `@intx/harness`                                                                 | `vendor/intx-harness/`                                          | LGPL-2.1-only | `4cc697241fa037244a9164a50aec507c112bc9fb` | 2026-10-14 | None — verbatim                                   |
| `@intx/mime`                                                                    | `vendor/intx-mime/`                                             | LGPL-2.1-only | `4cc697241fa037244a9164a50aec507c112bc9fb` | 2026-10-14 | None — verbatim                                   |
| `@intx/workflow-host` (partial — `adapters/` + `workflow-definition-loader.ts`) | `vendor/intx-workflow-host/` (two paths, not the whole package) | LGPL-2.1-only | `4cc697241fa037244a9164a50aec507c112bc9fb` | 2026-10-14 | None — verbatim                                   |

## Provenance, ownership, and kill dates

Every vendored path with its upstream source, why the published npm package
did not cover the need, its owner, and its kill date. A kill date is a
proposal the operator ratifies on review; each ties an observable condition
to a hard backstop date (2027-03-14, six months after this sync). When the
condition is met the vendored tree is dropped in favour of the published
package; the date is the deadline even if it is not.

| Vendor path                                               | Upstream repo           | Upstream commit                            | Patched            | Why not the published package                                                                                                                                                                     | Owner   | Proposed kill date                                                                                     |
| --------------------------------------------------------- | ----------------------- | ------------------------------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------ |
| `vendor/intx-inference/`                                  | `faremeter/interchange` | `4cc697241fa037244a9164a50aec507c112bc9fb` | Yes — `PATCHES.md` | Local fixes not yet upstream                                                                                                                                                                      | runtime | 2027-03-14 or when patches land upstream and publish                                                   |
| `vendor/intx-types/`                                      | `faremeter/interchange` | `4cc697241fa037244a9164a50aec507c112bc9fb` | Yes — `PATCHES.md` | Cross-package coupling with `@intx/inference`                                                                                                                                                     | runtime | 2027-03-14 or when the coupled trio publishes past `0.3.0`                                             |
| `vendor/intx-storage-isogit/`                             | `faremeter/interchange` | `4cc697241fa037244a9164a50aec507c112bc9fb` | Yes — `PATCHES.md` | Cross-package coupling with `@intx/inference`                                                                                                                                                     | runtime | 2027-03-14 or when the coupled trio publishes past `0.3.0`                                             |
| `vendor/intx-agent/`                                      | `faremeter/interchange` | `4cc697241fa037244a9164a50aec507c112bc9fb` | Yes — `PATCHES.md` | Local patches (`vendor/intx-agent/PATCHES.md`); published `@intx/agent@0.4.0` does not include them                                                                                               | runtime | 2027-03-14 or when those patches land upstream and publish                                             |
| `vendor/intx-authz/`                                      | `faremeter/interchange` | `4cc697241fa037244a9164a50aec507c112bc9fb` | No                 | Published at npm `0.4.0` (verbatim). Kept so the vendored set stays one workspace pin with the patched packages                                                                                   | runtime | 2027-03-14 or when patched siblings no longer need the shared vendored pin                             |
| `vendor/intx-log/`                                        | `faremeter/interchange` | `4cc697241fa037244a9164a50aec507c112bc9fb` | No                 | Published at npm `0.4.0` (verbatim). Kept so the vendored set stays one workspace pin with the patched packages                                                                                   | runtime | 2027-03-14 or when patched siblings no longer need the shared vendored pin                             |
| `vendor/intx-tools-posix/`                                | `faremeter/interchange` | `4cc697241fa037244a9164a50aec507c112bc9fb` | Yes — `PATCHES.md` | Local `registry.ts` paging patch (`vendor/intx-tools-posix/PATCHES.md`); `@intx/tools-posix@0.4.0` does not include it                                                                            | runtime | 2027-03-14 or when that patch lands upstream and publishes                                             |
| `vendor/intx-mailbox/`                                    | `faremeter/interchange` | `4cc697241fa037244a9164a50aec507c112bc9fb` | No                 | Published at npm `0.4.0` (verbatim). Kept so the vendored set stays one workspace pin with the patched packages                                                                                   | step-1  | 2027-03-14 or when patched siblings no longer need the shared vendored pin                             |
| `vendor/intx-harness/`                                    | `faremeter/interchange` | `4cc697241fa037244a9164a50aec507c112bc9fb` | No                 | Published `@intx/harness@0.4.0` exports `driveConnectorReplies` (verbatim). Kept on the shared vendored pin                                                                                       | step-1  | 2027-03-14 or when patched siblings no longer need the shared vendored pin                             |
| `vendor/intx-mime/`                                       | `faremeter/interchange` | `4cc697241fa037244a9164a50aec507c112bc9fb` | No                 | `buildMessageHeaders` is past npm `0.3.0` (verified 2026-09-07: absent from the published tarball); `@intx/mailbox` re-exports it                                                                 | step-1  | 2027-03-14 or when a published `@intx/mime` exports `buildMessageHeaders`                              |
| `vendor/intx-workflow-host/adapters/`                     | `faremeter/interchange` | `4cc697241fa037244a9164a50aec507c112bc9fb` | No                 | App-internal: `substrate-mailbox-store.ts` has never been published in any `@intx/workflow-host` release (verified 2026-09-07: absent from the `0.3.0` tarball)                                   | step-1  | 2027-03-14 or when a published `@intx/workflow-host` exports `createSubstrateMailboxStore`             |
| `vendor/intx-workflow-host/workflow-definition-loader.ts` | `faremeter/interchange` | `4cc697241fa037244a9164a50aec507c112bc9fb` | No                 | Director loading from a workflow closure (`loadWorkflowDirectorRegistryFromClosure`); never published in any `@intx/workflow-host` release (verified 2026-09-14: absent from the `0.3.0` tarball) | step-1  | 2027-03-14 or when a published `@intx/workflow-host` exports `loadWorkflowDirectorRegistryFromClosure` |

### The 2026-09-07 step-1 vendor pass

Three needs from the ticket were verified against npm and found already
covered by published packages, so they are **dependencies, not vendored
trees**:

- `@intx/hub-sessions` `./substrate` — `createAgentRepoStore({ dataDir,
  signingKey })` (local disk + keypair, no hub, no database) is present in
  the published `0.3.0` tarball. Root `dependencies` pins `0.3.0`.
- `@intx/mail-memory` — `InMemoryTransport`/`createInMemoryTransport` are
  present in the published `0.3.0`. Root `dependencies` pins `0.3.0`.
- the `@intx/workflow onEvent` seam — the `opts.onEvent` sink on
  `createWorkflowStepInvoker` lives in `@intx/workflow-host`'s
  `adapters/step-invoker.ts`, and the published `@intx/workflow-host@0.3.0`
  tarball already carries it (its `subscribeAgentEvents(agent,
  opts.onEvent)` wiring). Root `dependencies` pins `0.3.0`.

CL-9021 later dropped the `@intx/hub-sessions` root pin: no first-party
tree imports it (the only references are the inert
`vendor/intx-workflow-host/` provenance files), so the published-tarball
coverage above stands as fallback, not as an installed dependency.
`scripts/check-no-hub-sessions.test.ts` locks the removal.

Everything vendored in this pass sits at the same upstream commit
`1ad010463a6bce6034cded3e078b14db482882a8` as the existing trees; no
vendored tree mixes pins.

`vendor/intx-workflow-host/adapters/` is a partial-package vendor: upstream
`packages/workflow-host` has a `package.json`, but this tree carries only
the never-published `substrate-mailbox-store` adapter (the source file alone
is 563 lines, plus its 586-line test, documented on-disk layout, O(delta)
flushes). It is
deliberately **not** a workspace member and nothing in `src/` imports it —
Step 1 decides whether to wire it as a package when it consumes it. Its
`@intx/hub-sessions/substrate` and `@intx/mailbox` imports resolve once
that wiring exists; until then it is inert provenance, not dead weight.

The 2026-09-07 sync moved all three packages together to a single
upstream commit, restoring the single-commit coherence the coupling rule
below assumes. An interim 2026-08-22 sync had moved only `@intx/types`
and `@intx/storage-isogit`; the gap did not regress the coupling — the
`PendingOperation` shape was byte-identical across it — but it was a
staged exception, not the steady state.

### The 2026-09-14 re-sync to `1ad0104`

All eleven paths moved `0205b07b` → `1ad0104` (retrieved 2026-09-14) as a
pristine-then-patches pair: the first commit overwrites every tree
verbatim (including the two upstream deletions,
`packages/types/src/sidecar-placement.ts` and
`packages/inference/src/providers/google-genai.test.ts` — neither carried
a ledger entry), and the second re-applies each `PATCHES.md` entry with an
as-is / adapt / subsumed triage recorded in the ledgers. No entry was
subsumed upstream. Upstream replaced inline provider `apiKey` plumbing
with a `credentialId` + credential-cell model. At sync time no existing
ledger entry touched auth, so the pristine trees needed no auth-patch
migration; first-party callers were migrated to the new model (each built
source registers its secret in `src/config/source-credentials.ts`, handed
to the vendored trees as their resolver).

CL-9347 subsequently adds the coupled `harness-ts-auth-recovery` entry in
`vendor/intx-inference/PATCHES.md` and `runtime-ts-auth-recovery-context` in
`vendor/intx-types/PATCHES.md`; it does not change the upstream pin or
retrieval metadata. Together they atomically resolve bearer material and
credential-derived identity headers, freeze the exact call-start source,
expose per-call credential-failure history to the retry policy, preserve a
classified refresh diagnostic on abort, and make an exhausted credential
failure terminal to automatic source failover. Re-syncs must carry or replace
both entries together so retry identity cannot drift from the credential
material used by the attempt.

`vendor/intx-workflow-host/workflow-definition-loader.ts` is new in this
sync: a second partial-tree path alongside `adapters/`, carrying
`loadWorkflowDirectorRegistryFromClosure` verbatim (674 lines, no local
patches). Like the adapter, it is deliberately **not** a workspace member
and nothing in `src/` imports it — wiring callers is a later ticket's
work, so no workspace/overrides wiring was added; its `@intx/workflow`
and `@intx/hub-sessions/substrate` imports resolve once that wiring
exists. Until then it is inert provenance, not dead weight.

`@intx/tool-packaging` evaluated 2026-09: closure-wide collection
(loader.ts:389) serves tool-package establishment; director-loader need
fully covered by vendored workflow-definition-loader.ts + shared
isAnnotatedDirectorFactory predicate from already-vendored @intx/agent.
No first-party consumer imports tool-packaging; stays on transitive
published 0.3.0. Revisit if a future ticket establishes tool packages
from closures at runtime.

### The 2026-10-14 re-sync to `0.4.0` (`5453d0b0`, CL-10651)

All eleven paths moved `1ad0104` → `5453d0b0` (npm `0.4.0`, retrieved
2026-10-14). Upstream churn in the vendored trees for this range is
small: package version bumps across the board, plus
`packages/inference` test-infra reworks (`reactor.test.ts` adopting
`@intx/types/testing`'s new `waitUntil`; `default-director.test.ts`),
three source files in `@intx/types` (`base64.ts` chunked encoding,
`grants.ts` gaining `ApprovalItem`, `sidecar.ts` widening
`approvedGrants` to `ApprovalItem[]`), a new `@intx/agent` testing helper
(`testing/reactor-waiters.ts`, `waitForReactorDone` moved out of four
agent test files), and a new `@intx/log` probe (`default-sink-probe.ts`).
No vendored production source besides those three `@intx/types` files
changed upstream in this range, so the four patched packages re-carried
every ledger entry against effectively unchanged upstream shapes.

Procedure: `bin/vendor-patch-diff` re-derived the local divergence
against the recorded SHA before anything was overwritten; verbatim trees
were overwritten from the new pin; the two agent test files and the
inference `reactor.test.ts` that had both local patches and upstream
changes were three-way merged (`git merge-file`), and every other
patched file kept its prior state because upstream did not touch it.
Commit `865f63c6` is not a pristine byte-identical snapshot of
`5453d0b0`: local lines remain in that commit, including
`ephemeralTurns` and `Locally patched` in
`vendor/intx-inference/src/reactor.ts`. No exhaustive `cmp` showed
otherwise. The auditable artifact is the branch tip — upstream
`5453d0b0` plus the carried local patches. Replaying the following
commit onto a later pristine pin is not a patch-only replay.

Ledger adjudication (ticket CL-10651, verified against upstream at this
pin — all line-grep evidence below is against pristine `5453d0b0`):

- **All ledger entries KEEP.** None is subsumed upstream at `0.4.0`:
  `isStreamTerminal`, `ephemeralTurns`, `isPollOnlyPendingBatch`,
  `loadErrors`, `turnsRevision`/`deepFreeze`, `isCommitting`,
  `MAX_LINE_LENGTH`, and `ApprovalItem`-independent `stopReason` are all
  absent from the `0.4.0` tree.
- The four carried-forward DROP notes are contradicted by evidence at
  this pin and stay: the **context-transforms pair** survives because
  `@intx/agent` `0.4.0` still exposes no `contextTransforms` field on
  its assembly env (upstream `@intx/inference` `assembly.ts` accepts it
  directly; the published `agent` package does not forward it, so the
  `deps` channel remains the only path); the **agent flush chain**
  survives because `loadErrors` is absent upstream; the
  **commitment-boundary** redesign survives because `isCommitting` is
  absent upstream; the **frozen-turns pair** survives because
  `turnsRevision`/`deepFreeze` are absent upstream.
- Three ticket labels adjudicated **no-match**: no vendored tree or
  upstream `0.4.0` code corresponds to `harness-ts-normok-model-compat`;
  the closest model-compatibility candidate is
  `providers-ts-anthropic-adaptive-fable-5-1` (which stays). "Mailbox
  signed outbound" corresponds to upstream's own signing composition
  (`fcdbc8a5`, "Compose signed outbound mail in one place") carried
  natively by the verbatim `@intx/mime`/`@intx/mailbox` trees — no local
  patch exists to adjudicate. "Adapter manifest" corresponds to upstream
  `4cc697241fa037244a9164a50aec507c112bc9fb` ("Refuse sidecar reuse across an adapter manifest change"),
  past this pin and touching no vendored path.
- `expectedFrom` reconciliation: upstream still carries the field at
  `0.4.0` (reactor marker spread; `runtime.ts`/`store.ts` validators).
  Its removal lands after `0.4.0` (`0f72f95`, "Stop treating a
  correlation id as an authenticated claim"; `1ff8805`, "Stop inventing
  an identity for a message that names none"). Re-syncing past that
  removal drops the field with zero first-party fallout (`grep` of
  first-party `src/` is clean today) because this repo never consumed
  `expectedFrom`; the meaningful change is the correlator-as-capability
  model, which CL-10678 handles app-side.

New 0.4.0 APIs adopted where apt; adoption is deliberately modest:

- `@intx/types/testing` (`waitUntil`) — the subpath export is wired into
  the vendored `@intx/types` tree verbatim; nothing first-party imports
  it yet, and vendored upstream tests consume it directly.
- `ApprovalItem` — arrives verbatim inside `@intx/types`; no first-party
  adoption in this PR (the approval-correlation work CL-10678 is the
  natural adopter).
- `@intx/agent` testing helpers (`waitForReactorDone`) — arrive
  verbatim in the vendored tree; first-party e2e keeps its own helpers.
- `PerCallInferenceOptions`/`mergeInferenceOptions` (`d1835be`) is
  **post-0.4.0** (only on upstream `main`, not `5453d0b0`), so it is
  explicitly out of scope here (CL-10656 owns the HEAD drift). For the
  nudge use-case, `ephemeralTurns` stays: the nudge director needs
  prompt-only turns the per-call-options path does not model.

`vendor/intx-tools-posix/` moves from verbatim to patched in this sync:
the pre-existing (never-ledgered) read_file paging-description
divergence was found by re-running `bin/vendor-patch-diff` during this
sync and is now ledgered in `vendor/intx-tools-posix/PATCHES.md` with
markers, rather than silently dropped or reverted.

The license column records what each package declares in its own
`package.json`; the corresponding `LICENSE` file travels with every vendored
tree and is never edited during a sync. Corbits Code is distributed under
GPLv2, which LGPL-2.1 permits. Retrieval dates are when the copy landed here,
not when the upstream commit was authored — an audit needs both, and the
upstream commit hash supplies the other half.

All three were synced together in one pass because they are not
independently upgradable: the reactor's approval-suspend primitive (upstream
commit `06d39dc6`, "Suspend the reactor on an ask authz decision") spans all
three packages in a single upstream change — `@intx/inference`'s
`authz-extension.ts` and `reactor.ts` return and dispatch a `PendingOperation`
type that lives in `@intx/types`'s `runtime.ts`, and `@intx/storage-isogit`'s
`store.ts` persists it. Vendoring `@intx/inference` at a newer commit than
`@intx/types` (or vice versa) does not typecheck by construction, since the
inference package's exported function signatures reference types that only
exist in the newer `@intx/types`.

The 2026-09-07 sync also vendored the remaining four consumed packages
(`@intx/agent`, `@intx/authz`, `@intx/log`, `@intx/tools-posix`) at the
same upstream commit, completing the set: every `@intx/*` package this
repo imports now resolves to vendored source, except `@intx/crypto` and
`@intx/tools-lsp`, which remain direct published-npm imports at `0.3.0`.
None of the four carried
local patches at vendoring time. `@intx/agent` later gained the error-seq
patches ledgered in `vendor/intx-agent/PATCHES.md`; the other three were
verbatim upstream copies until the 2026-10-14 re-sync, whose
`bin/vendor-patch-diff` re-derivation surfaced a never-ledgered
`registry.ts` paging-description divergence in `@intx/tools-posix`
(companion to the coupled
`size-cap-ts-paged-read-file` patch) — now
ledgered in `vendor/intx-tools-posix/PATCHES.md` instead of silently
dropped. `@intx/tools-lsp` remains on published npm
(`0.3.0`) — it is a thin adapter whose transitive `@intx/*` dependencies
resolve to the
vendored workspaces via root `overrides`, so it tracks the vendored set
without being vendored itself. `@intx/crypto` (root `dependencies`) and
`@intx/inference-testing` (root `devDependencies`) are pinned at `0.3.0`;
`@intx/inference-discovery` resolves transitively at `0.3.0` via `bun.lock`
with no direct root pin, so the lockfile never nests duplicate copies of
them either.

A `version` field of `"0.2.2"` in a vendored package's `package.json` is a
carried-over convention from the original `@intx/inference` vendoring, not a
claim about what's actually checked out — the vendored source can be (and
generally is) well ahead of that version number. The commit hash in the
table above is the only thing that reflects actual content; the `version`
field exists only because some tooling expects `package.json` to declare
one.

### The 2026-10-14 re-sync to `4cc697241fa037244a9164a50aec507c112bc9fb` (CL-10656, HEAD-drift triage)

Second sync of the day:

`5453d0b0` → `4cc697241fa037244a9164a50aec507c112bc9fb` (upstream, retrieved 2026-10-14). The range holds
~196 upstream commits and 154,000+ inserted lines; ~13,900 of those sit
in the vendored-package surface this repo adopted (the bulk belongs to
trees this repo does not vendor — `workflow-deploy`, `workflow-host`
supervisor, `workflow`, `db`, `hub-*`). The sync is a **partial-tree
triage**, not a
blind adopt: only the vendored paths moved, all eleven trees moved to the
same pin (single-commit coherence), and correctness fixes went first.

Triage per area (commit-hash evidence from `git log 5453d0b0..4cc697241fa037244a9164a50aec507c112bc9fb --
packages/<area>`):

| Area                               | Commits | Vendored surface touched     | Decision           | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------- | ------- | ---------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mime`                             | 12      | whole `src/`                 | **Adopt**          | CRLF/shape validation (`9313a743`, `02abb4e0`), relay-safe encoding (`a6804df4`), header folding; prerequisite for the mailbox adoption. Fully verbatim re-carried.                                                                                                                                                                                                                                                                                                                 |
| `mailbox`                          | 10      | whole `src/`                 | **Adopt**          | Signed outbound composition (`fcdbc8a5`), fetch-failure preservation (`faad83aa`), no-date sorting (`8c243d6f`). Depends on adopted `mime` + `types` subpaths.                                                                                                                                                                                                                                                                                                                      |
| `harness`                          | 7       | whole `src/`                 | **Adopt**          | Supervisor-mailbox threading (`c7a7bf89`, `58e5689b`), step credential assembly (`7b8cfbbc`). Depends on adopted `types`/`agent`.                                                                                                                                                                                                                                                                                                                                                   |
| `types`                            | 50      | whole `src/` (runtime split) | **Adopt**          | Required by mailbox/harness/inference/workflow-host (new `runtime-core`, `credential-delivery`, `workflow-definition`, `attachments`, `format-safety-rating` subpaths). Carries `adapter-manifest` (`2d973a4`), `PerCallInferenceOptions` (`d1835b`), identity/authz tightening (`0f72f95`, `1ff8805`). Four patched trees make this the biggest re-carry; no clean way to pin lower without breaking the adopted consumers, and the trio coherence rule forbids a types-only move. |
| `inference`                        | 9       | whole `src/`                 | **Adopt**          | Reasoning-effort mapping (`c8be7e9`) and auth-claim fixes (`0f72f957`, `1ff88053`). 9 patched files three-way merged, 2 conflict regions resolved by hand (see `PATCHES.md`).                                                                                                                                                                                                                                                                                                       |
| `storage-isogit`                   | 5       | whole `src/`                 | **Adopt**          | `e75eee2` `sync.request`/state-push removal, verified safe (below). Coupled-trio rule forces the pin to move with `types`/`inference` anyway.                                                                                                                                                                                                                                                                                                                                       |
| `agent`                            | 3       | whole `src/`                 | **Adopt**          | Per-send inference options (`d1835be`), runtime-contract imports (`660ef81`), and the `./authoring` subpath (`d1e05e9`) consumed by the adopted workflow-host loader.                                                                                                                                                                                                                                                                                                               |
| `workflow-host` (partial: 3 files) | 68      | 3 vendored files only        | **Adopt** (narrow) | The other ~100 drift files live in supervisor/workflow trees we do not vendor and are excluded by design. `workflow-definition-loader.ts` dropped the `@intx/hub-sessions/substrate` import for `@intx/types/workflow-definition`, in the direction CL-9021 already wants.                                                                                                                                                                                                          |
| `authz`, `log`, `tools-posix`      | 0       | nothing                      | **No change**      | `git diff 5453d0b0..4cc697241fa037244a9164a50aec507c112bc9fb -- packages/<p>` is empty for all three; pin bumped with the set for single-commit coherence only.                                                                                                                                                                                                                                                                                                                     |
| `crypto`                           | 2       | not vendored                 | **No action**      | Published npm dep stays at `0.3.0`; its adopted consumers (`generateKeyPair`, `createEd25519Crypto`, `importPublicKeyBytes`) all already export from the installed `0.3.0` dist (verified against `node_modules/@intx/crypto/dist/index.d.ts`).                                                                                                                                                                                                                                     |

Nothing was adopted from `packages/workflow-deploy`, `packages/workflow`,
`packages/db`, `packages/hub-*`, or any other non-vendored tree.

`e75eee2` ("Remove sync.request and the undeploy's agent-state push")
safety evidence: in this repo, `grep` for `sync.request`, `statePushed`,
`createStatePack`, and `undeploy` across `src/` and `e2e/` returns zero
matches (only `vendor/intx-types/src/sidecar.ts` carried the union —
dropped by the adopted `4cc697241fa037244a9164a50aec507c112bc9fb` tree); upstream-side, the commit's
`packages/storage-isogit` portion is comment-only (`pack-send.ts`,
`repo-lock.ts` doc blocks) plus the `hub-agent` caller removal, and the
`undeploy.ack` `statePushed` validators live only in non-vendored
hub-side schemas at this pin. Adoption is verified safe.

`c8be7e9` ("Map reasoning effort onto each provider's request") verdict:
**adopted**, riding the `4cc697241fa037244a9164a50aec507c112bc9fb` `@intx/inference` pin (`effort.ts`, the
three provider adapters, `classifyRequestBuildError`). Adoption follows
the whole-package decision above; first-party rollers that never set
`effort` see no wire change (the mapping only rewrites requests that
carry an effort name, and `thinking` semantics are unchanged).

Ledger adjudication (ticket CL-10656): **all ledger entries KEEP** —
`isStreamTerminal`, `ephemeralTurns`, `isPollOnlyPendingBatch`, `loadErrors`,
`turnsRevision`/`deepFreeze`, `isCommitting`, `MAX_LINE_LENGTH`, and the
extended `classifyAbortError(reason)` plumbing are all still absent from the
upstream `4cc697241fa037244a9164a50aec507c112bc9fb` vendored-area trees (grep per package, evidence in each
`PATCHES.md`). No entry was dropped; no disposition changed. The
divergence-surface proof after the merge: `bin/vendor-patch-diff` against
the recorded SHA prints exactly the pre-sync +/− line multiset plus three
new `runtime-ts-auth-recovery-context` marker comment lines in
`@intx/types` (`+/−` totals: inference 1324+/230−, agent 382+/2−,
storage-isogit 73+/1−, types 33→36+, tools-posix 13+/1−). Resume audit
(same day): a `bun run build` failure exposed two half-wired adoptions —
the vendored `@intx/types` export map was missing fifteen upstream
subpath exports (fixed; export-map completions are outside the src
SHA-diff so the totals above are unaffected) — and the runtime-split
dropped `formatSafetyRatingText` from the `./runtime` subpath, breaking
the installed `@corbits/openai-responses@0.2.1` dist. The compat
re-export (ledgered `vendor-types-ts-runtime-format-safety-rating-compat`
in `vendor/intx-types/PATCHES.md`, +7 line change) moves the `@intx/types`
divergence surface to its final measured 43+/6−.

First-party adaptation required by adopted APIs (only imported-symbol
moves, no behavior change): `src/provider/inference-dependencies.ts`
imports `AdapterManifest` from `@intx/types` (upstream dropped the
inference barrel re-export); optional `messageId` on inbound headers
(`1ff8805`, "no identity invented for a message that names none") surfaced
at `src/tui/runner/submit.ts` (use the narrowed local), two
`src/session/runtime-assembly.test.ts` assertions, and one
`src/tui/queued-input-chrome.test.ts` guard. No vendored-tree API the
first-party copy consumed was removed otherwise.

Procedure: this ticket lands as two commits. The first adopts upstream
`4cc697241fa037244a9164a50aec507c112bc9fb` content into the vendored trees and is not a pristine
unmodified snapshot of that commit — local lines remain, including
`ephemeralTurns`, `loadErrors`, and the tools-posix read_file paging
description. The second re-carries the patch ledgers and adapts first-party
`src`. Verbatim trees (`mime`, `mailbox`, `harness`, and the narrow
`workflow-host` subset) were copied from upstream `4cc697241fa037244a9164a50aec507c112bc9fb`.
Patched trees were merged per-file via `git merge-file` (ours = vendored,
base = `5453d0b0`, theirs = upstream `4cc697241fa037244a9164a50aec507c112bc9fb`) with two
hand-resolved conflict regions in `intx-inference`. `package.json` changes
were applied by hand onto the vendored rewritten files (new subpath exports
for `types` / `agent` / `inference`, mailbox's `@intx/log` dependency).

## How a vendored package resolves

Root `package.json`:

- `workspaces` lists each whole-package `vendor/intx-*` directory as a workspace member; the partial `vendor/intx-workflow-host/adapters/` tree is deliberately not a member.
- `overrides` pins the package name to `workspace:*`, so every transitive
  consumer (including other published `@intx/*` packages that declare a
  dependency on it) resolves to the vendored copy instead of installing
  their own nested copy from npm.
- The package's own entry in root `dependencies` reads `"workspace:*"`
  rather than a version string.

A clean `bun install` under those overrides links every consumer —
including nested Bun package layouts such as
`node_modules/.bun/@intx+agent@…/node_modules/@intx/types` — at the
vendored tree. That is the runtime and install-time story.

TypeScript needs a second pin. Published packages such as `@intx/tools-lsp`
ship `dist/*.d.ts` that import `@intx/types/runtime`. When a stale or
partial install leaves a nested published `@intx/types@0.3.0` (with its
older `dist/` shapes, missing fields such as `PendingOperation.kind`),
`tsc` treats that nested copy as a second type identity: first-party
code and vendored inference resolve the vendor source, while agent
declaration files resolve the nested publish, and assignability fails
even though both packages share the name `@intx/types`. Root
`tsconfig.json` therefore forces a single TypeScript-visible identity:

```json
"paths": {
  "@intx/types": ["./vendor/intx-types/src/index.ts"],
  "@intx/types/*": ["./vendor/intx-types/src/*"]
}
```

Overrides keep the filesystem install on vendor; paths keep `tsc` on
vendor even if a nested published copy reappears. Do not remove either
layer without re-checking `bun run typecheck` against a layout that
still has nested `@intx/types` under a published `@intx/*` package.

This is also what collapses a duplicate-dependency problem: before
`@intx/types` was vendored, every published `@intx/*` package we consumed
carried its own nested `arktype` install (pinned to whatever `arktype` minor
version was current when that package was last published on npm), distinct
from the root's own `arktype` — so an `instanceof` check against a type
constructed by one `arktype` instance silently failed against the other.
Vendoring `@intx/types` (and anything that itself vendors `@intx/types` as
`workspace:*`) removes the nested install; every import of `arktype` under
those packages now resolves to the single root instance. As of this sync,
`bun.lock` shows exactly one `arktype` resolution across the whole tree.

## Patched vs. verbatim

Of the twelve vendored paths, five carry local patches:
`@intx/inference`, `@intx/types`, `@intx/storage-isogit`, `@intx/agent`,
and (since the 2026-10-14 re-sync) `@intx/tools-posix` — every
divergence is a real fix not yet upstream, listed
one-per-patch in that package's `PATCHES.md`. The other seven paths
(five whole packages plus the two partial `vendor/intx-workflow-host/`
paths) are verbatim copies of upstream — no modifications. A diff against a
pristine upstream checkout at the same commit and paths will show 100%
upstream-authored lines for those seven.

## Bearer correlation IDs and approval provenance

On the approval rail, a correlation ID is a bearer capability. Interchange
removed the `expectedFrom` sender check upstream, so `tryCorrelate`
(`vendor/intx-inference/src/reactor.ts`) resolves any inbound message whose
`interchangeCorrelationId` matches a registered pending operation: a learned
ID plus a forged `approval.granted` would grant the parked call's one-shot
bypass, and a forged `approval.denied` would inject a denial into history.
Upstream's seam for sender authentication is the `CorrelationValidator`
interface (`vendor/intx-inference/src/correlation.ts`), injected through
reactor config — but the vendored `@intx/agent` layer forwards no such
validator into `createReactorAssembly` and its env contract has no field to
carry one, so production wiring happens on the app side.

Corbits Code therefore authenticates approval provenance at its inbound
delivery boundary (`src/session/approval-provenance.ts`, wired in
`src/agent/live-tool-dispatch.ts` around every agent the app constructs):
typed approvals (`approval.granted` / `approval.denied`) are accepted only
from the local approval-delivery path — sender `approval@local` on mailbox
`approval`, the exact provenance `src/session/approval-resume.ts`
`decisionMessage` stamps — and any other ingress (mailbox or system) is
discarded with a warn receipt before the reactor can correlate it. The same
policy is exposed as a `CorrelationValidator` implementation so the vendored
injection point can consume it verbatim (see
`e2e/reactor-approval-acceptance.test.ts`) when a vendor seam to forward it
exists. Decision binding to the gate is untouched and remains in the vendored
reactor: `tryCorrelate`'s `isLiveApproval` requires the pending operation's
gate to still hold the correlation ID and be unexpired, and the local
`reactor-ts-atomic-approval-acceptance` patch keeps a discarded typed
approval from collapsing the pending operation. The two provenance markers
and the policy live in one module so the authentic sender cannot drift from
the allowlist; `decisionMessage` draws its sender/mailbox from that module.

## Notable upstream shape changes carried by the 2026-08-22 sync

Upstream commit `5f798bea` ("Inject the runtime into iso-git storage")
split `@intx/storage-isogit`'s entry point: the package root (`.`) no
longer exports a bindable `createIsogitStore` free function, and callers
now pick a runtime-bound entry point instead — `./node` (backed by
`createNodeIsogitRuntime`) or `./browser`. `vendor/intx-storage-isogit/`'s
`package.json` `exports` map picks up both new subpaths verbatim from
upstream. The one first-party consumer,
`src/session/optimized-context-store.ts`, now imports `createIsogitStore`
from `@intx/storage-isogit/node` instead of the package root — the
`./node` re-export has the identical `(dir, signer?, gcPolicy?)` signature
the old root export had, so this is an import-path change, not a
behavioral one. The package also picked up two new dependencies
(`@isomorphic-git/lightning-fs`, `buffer`, both used only by the new
`./browser` runtime, which nothing here imports) and a new
`@intx/crypto` dev dependency for its own test suite, pinned to `0.3.0` —
the same "stay on published npm for a package we don't vendor" pattern as
the `@intx/log` dependency on the other vendored packages, kept aligned
with the root's published `0.3.0` pin so the lockfile never nests duplicate
copies; `@intx/mime` joined the vendored set in the 2026-09-07 step-1 pass,
and its consumers now resolve it through the root `workspace:*` override.

One new upstream test, `browser-bundle.test.ts`, is excluded via
`bunfig.toml`'s `pathIgnorePatterns`. It bundles `browser.ts` with
`Bun.build` under the `intx-src` export condition, which resolves
`@intx/log` and `@intx/mime` to `./src/*.ts`. Both are vendored source as
of the 2026-09-07 syncs (`@intx/mime` in the step-1 pass, which vendored
it for `buildMessageHeaders`), so the condition has a `src/` target again;
the exclusion remains because a local re-run of the bundle fails for a
different reason — the vendored mime sources import `@intx/crypto`, which
stays on published npm, and `Bun.build` cannot resolve that bare specifier
from inside the vendor workspace.

Patched packages carry local fixes not yet present upstream, not
workarounds for something upstream has since fixed. Every patched
location carries a one-line comment naming its site-specific entry in
that package's `PATCHES.md` (e.g. `#reactor-ts-correlating-ids-leak`),
so `grep -rn "Locally patched" vendor/*/src` finds every divergence.
**Markers are navigation; the SHA-diff is proof.** Run
`bin/vendor-patch-diff` against a pristine upstream checkout at the
recorded SHA to print exactly the lines that are ours. A correspondence
test (`scripts/vendor-patch-ledger.test.ts`) fails if a marker anchor
does not resolve to a ledger heading, or if a ledger heading has no marker.

## Approval rail hygiene audit (CL-10679)

App-side redaction built on CL-10678's provenance gate, audited against the
CL-10678 base (`950a3e37`). Nothing in `vendor/` was modified for this audit;
the vendored findings below are recorded as suppression/disposition notes.

**Vendored validator-throw log (`reactor.ts:687`,
`logger.warn`Correlation validator threw for ${correlationId}...``) —
unreachable in production wiring.** `tryCorrelate` only calls a validator when
one is injected (`correlationValidator !== undefined`), and both the vendored
`@intx/agent` env contract and every production call site forward none (see
the "Bearer correlation IDs and approval provenance" section above and the
comment at `src/agent/live-tool-dispatch.ts`). Foreign ingress is dropped the
line before it could ever be correlated (`createApprovalProvenanceGate` wraps
the app's `createAgent` deliver seam, fail-closed on unknown mailboxes), so
this vendored warn can log a bearer correlation ID only if a future wiring
injects a validator — and then only when that validator throws. When a seam
forwards the app validator, keep `createApprovalCorrelationValidator`'s
`validate` non-throwing: it returns `Promise.resolve(...)`, never throws, so
the death of this branch stays guaranteed even hot-swapped. **Second vendored
full-ID site, promotion candidate:** the `processDelivery` fatal path
(`reactor.ts` ~1906-1923 — `logger.error`Correlation dispatch failed: ${cause}``
plus the `closeMessageRun` failure text) can carry a full correlation ID a
correlation-path invariant failure embeds in its message (the registry's
double-registration throw names the ID). The deliver-gate pre-drop makes that
fatal branch effectively unreachable today (a throw can arise inside
`tryCorrelate`'s patched acceptance/correlation region, but no untrusted
delivery reaches it without first injecting a validator); recorded here so a
future wiring that can reach it gets an ID-free receipt at the next sync.

**Vendored retry-policy throw log (`harness.ts:1749`) — app-side
disposition, no vendor edit.** The vendored `runInference` catch sanitizes the
terminal error it shows the caller and passes policies pre-sanitized inputs,
but the warn about a policy's own exception interpolates raw
(`error=${cause.message}`). The app keeps its vendor tree untouched here and
answers the exposure contractually instead: `RetryPolicy` implementations are
trusted first-party code and must never embed credential-bearing text in an
exception — documented on `createCorbitsRetryPolicy`
(`src/agent/retry-policy.ts`). The vendored line is a promotion candidate if
upstream adopts a sanitized clone for policy-exception logging; the raw
terminal `inference.error` event keeps its existing sanitization.

**App-side correlation-ID receipt redaction.** All app-side log sites that
interpolated a correlation ID now emit the truncated, hash-suffixed form
(`src/session/redacted-correlation.ts`): the parked-approval,
late-decision and duplicate-resume warns in `src/session/approval-resume.ts`,
the forged-approval discard receipt in `src/session/approval-provenance.ts`,
and the acceptance-timeout warn in `src/tui/approval-delivery.ts`. The file
log sink (`src/logging/sink.ts`) records debug level too, so nothing app-side
carries the full ID at any log level; the full ID lives only on the in-memory
transport that consumes it (message headers, gate table, operator surface).

**Event-sink audit.** Correlation IDs do not reach model-visible history or
tool-output-readable surfaces: `run.json` excludes correlation IDs (status/task/turn
counts and usage only), the audit collector records `tool.start`/`tool.done`
keyed by callId — not correlation ID — and `message.correlated` /
`reactor.gate.blocked` events fan out to in-memory consumers (TUI occupancy
wait, runtime bridge, watchdog recovery) without being persisted. The
`metadata.json` checkpoint persists pending operations with their correlation
IDs by design (the restart-resume path re-registers parked calls) — that is
the credential cell's own storage, not a log or event sink.

**Approval snapshot args at rest (CL-10679 R5).** The app's context-store
write boundary (`src/session/pending-snapshot-scrub.ts`, wired into
`src/session/optimized-context-store.ts`) now runs the result-side secret-shape
scrubber (`scrubSecretShapedValue`) over every persisted
`approvalSnapshot.arguments`. The re-dispatch artifact (`suspendedCall`)
stays raw because the approved call must re-run with the arguments the
operator saw; residual at-rest exposure in `suspendedCall.arguments` inside
`metadata.json` is documented as a known gap for the vendored re-dispatch
owner, not silently widened here.

## Re-syncing a vendored package to a newer upstream commit

1. In the read-only upstream clone, confirm the commit to sync to and note
   its hash for this document's table.
2. For a **verbatim** package, copy `src/`, `README.md` over the vendored
   directory's `src/`, `README.md` (leave `package.json` and `LICENSE` as
   they are unless the package's own `package.json` exports or dependencies
   changed upstream — diff the two `package.json` files by hand; the
   partial `vendor/intx-workflow-host/adapters/` tree has no `package.json`
   of its own, so just re-copy its two vendored files,
   `adapters/substrate-mailbox-store.ts` and
   `adapters/substrate-mailbox-store.test.ts`). Run
   `bun install`, `bun run typecheck`, `bun run build`, `bun run test`.
3. For a **patched** package (`@intx/inference`, `@intx/types`,
   `@intx/storage-isogit`, `@intx/agent`, and `@intx/tools-posix`):
   before overwriting anything, run `bin/vendor-patch-diff` (optionally
   `--upstream /path/to/interchange`) to re-derive the exact local
   divergences against the recorded SHA — do not trust `PATCHES.md`'s
   prose alone. `@intx/tools-posix` is patched
   (`vendor/intx-tools-posix/PATCHES.md`); `registry.ts` carries
   `registry-ts-read-file-paging-description`. Copying that package as
   verbatim drops the paging description on the next resync. Then
   overwrite `src/` with the new upstream commit's source, and re-apply
   each patch from the ledger by hand against the new file shapes. For
   each patch, confirm from the new upstream source
   whether it: (a) still applies as-is, (b) needs adapting to a changed
   surrounding shape, or (c) has been subsumed by an equivalent upstream
   fix and can be dropped — verify (c) by reading the new upstream code,
   never by assumption. Update `PATCHES.md` and the site-specific
   `Locally patched` markers to reflect what actually landed, including
   any patches dropped as superseded and why. Run the full gate
   (`typecheck`/`build`/`test`, including
   `scripts/vendor-patch-ledger.test.ts`) and do not consider the sync
   complete until it passes clean.
4. Because `@intx/inference`, `@intx/types`, and `@intx/storage-isogit` are
   coupled (see above), a re-sync that moves any one of their commit hashes
   should move all three together, even if only one had code changes worth
   vendoring — otherwise the trio drifts out of the single-commit coherence
   this document assumes.
5. Update this document's table with the new commit hash and retrieval date.
6. Land the sync as **two commits, in this order**, only when the first
   commit really is unmodified upstream: a pristine copy with no local
   lines, then the re-applied patches. An auditor can then diff that
   first commit against the upstream clone. The 2026-10-14 re-sync did
   not meet that bar. Commit `865f63c6` is not a pristine byte-identical
   snapshot of `5453d0b0` (local lines remain, including `ephemeralTurns`
   and `Locally patched` in `vendor/intx-inference/src/reactor.ts`), and
   there was no exhaustive `cmp` that proved otherwise. The auditable
   artifact is the branch tip: upstream `5453d0b0` plus the carried
   local patches. Replaying the second commit onto a later pristine pin
   is not patch-only — that commit is not a clean patch set against an
   unmodified `5453d0b0` tree. The 2026-08-08 sync landed as two
   commits split by package rather than by pristine-then-patched, so neither
   isolates an unmodified upstream tree; `PATCHES.md` is what makes that state
   reconstructible, which is why that ledger is load-bearing rather than
   merely descriptive.
