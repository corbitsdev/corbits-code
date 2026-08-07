## The interactive TUI is now OpenTUI

The Ink renderer is gone — deleted, not feature-flagged. If a release goes wrong,
rollback is the prior tag rather than a setting.

### What moved under your hands

- **Newline is Ctrl+Enter** (or Ctrl+J). Shift+Enter works only on terminals
  that report the modifier, which many do not.
- **The mouse belongs to your terminal.** Drag-select and copy behave the way
  they do everywhere else. Alt+M hands the mouse to Corbits when you want
  click-to-expand or drag-to-scroll, and Alt+M again gives it back.
- **Quitting is unchanged.** Ctrl+C interrupts a run; twice exits.

### New

- A zone-based layout resolver with per-zone minimums and an explicit collapse
  order, replacing React reconciliation.
- A multi-line composer that wraps and grows to 40% of the screen before it
  scrolls.
- Copy mode (Alt+C) that writes to the system clipboard on macOS, Windows and
  Linux, with an OSC 52 fallback for content selection cannot reach — scrolled
  off output is not in your terminal's scrollback while we hold the screen.
- Free-text answers to questions the agent asks, instead of only picking from a
  list.
- Live status for lifecycle hooks, subagent progress, MCP connections and
  recorded permission grants.

### Fixed

The ones most likely to have affected you:

- **The standalone binary could not start.** It excluded its own native module,
  so a distributed binary had nothing to resolve it from.
- **Copying never worked.** Alt+C wrote to an in-memory array, and mouse
  reporting stopped the terminal from selecting text at all.
- **A crash left your terminal wedged** in the alternate screen with raw mode
  still on, and the process kept running.
- **Text in an approval prompt could lie.** Bidirectional override characters
  reached the overlay, so a command could read as one thing and run as another.
- **Search could return far more than its cap** into the model's context — and
  on machines without ripgrep it had no cap at all.
- **Pasting an API key during setup silently truncated at 1000 characters.**
- **Repeated tool calls dropped every result after the first.**
- **A retried turn painted itself twice.**
- **Resuming an older session silently dropped some content.**

### Known issues

- Shift+Enter does not insert a newline on terminals that do not report the
  modifier. Use Ctrl+Enter or Ctrl+J.
- Markdown flickers mildly while streaming.
- Transcript history past 500 rows cannot be scrolled back to, and rows are
  retained for the life of the process.
- A crash in a background task, or a signal, can leave a session marked as
  still running.

### Upgrading

Sessions started under the previous release resume normally. Nothing on disk
changed format.
