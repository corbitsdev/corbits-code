## Tool-only pause, resume, and feedback

Healthy tool work was getting paused as thrash, and there was no clean way to
pick up the last session in a folder or send product feedback without looking
like a model turn. This release fixes those three surfaces.

### Tool-only pause that tracks real thrash

Hard pause now requires a **repeating tool-call cycle** — identical fingerprints,
A/B alternation, or longer fixed rotations — not a bare tool-only turn count.
Re-running a flaky test or checking a build a few times no longer false-positives.

Every model family shares a soft wrap-up nudge at 25 tool-only turns (a check-in,
never a stop). Grok drops its miscalibrated 6/10 pair and keeps only its shorter
sub-agent stall timeout and finish-bias residual.

A raw-count backstop covers cycles longer than the period ceiling or phase-broken
patterns: first a progress-summary nudge, then hard pause only if another full
interval passes with no genuine operator message. Synthetic system sends no longer
reset that counter.

### Resume and continue

`corbits resume` / `corbits continue` reopen the latest session for the current
project folder, a specific session id, or the interactive picker. Invalid ids
error instead of silently falling through; id and `--pick` cannot be combined.

### Feedback

`/feedback` sends free-text product feedback when you choose to. Bare
`/feedback` waits for the next line; text on the same line sends immediately;
empty Enter cancels. The reply is a short system notice (**Thanks — feedback
sent.**), not a model turn.

### Usage analytics

Settings describe optional ambient analytics clearly, and say when an environment
setting has disabled them so the toggle cannot re-enable. Generation properties
use PostHog cost names. Broader auth and slash product events.

### TUI and CI

Markdown settle waits for body paint so heading-only frames no longer flake CI.
`--help` exits 0 cleanly.

## Install

### macOS (Homebrew)

```
brew install corbitsdev/tap/corbits-code
```

### Debian / Ubuntu

```
sudo dpkg -i corbits_0.2.95_amd64.deb   # or _arm64.deb
```

### Any macOS or Linux (tarball)

Download the matching `corbits-0.2.95-<platform>.tar.gz` below, extract, and put
the `corbits` binary on your PATH. It is self-contained; no runtime is required.
