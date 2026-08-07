## Twenty-five fixes on the OpenTUI cutover

Most of these had no visible symptom. Sessions that hung with no way out,
memory that grew until the process slowed, and session state that quietly
corrupted itself — the kind of thing you feel as "it got weird" long before
you can name it.

### The mouse changes again

0.2.90 gave the mouse to your terminal so drag-select and copy worked
normally. That turned out to break scrolling: with mouse reporting off, a
terminal translates a wheel tick into arrow-key bytes that are
indistinguishable from a real keypress, and arrows drive prompt history. So
scrolling moved through your old messages instead of the chat.

The main session shell now takes the mouse.

- **The wheel scrolls the transcript.** Arrows still cycle prompt history.
- **Click-to-expand on tool rows and drag-to-scroll work immediately**, with
  no need to press Alt+M first.
- **Native drag-select in the transcript is gone.** Alt+M hands the mouse back
  when you want to select text, and Alt+C copies a message, tool output or
  diff without the mouse at all.
- **The onboarding and session pickers keep native selection** either way.

### Sessions could hang with no way out

- Pressing Esc on a permission prompt abandoned the request the agent was
  waiting on. The session hung permanently, and Ctrl+C did not recover it —
  the interrupt never reached that promise. Dismissing now denies the request.
- An unattended goal run could park on a permission prompt forever. The
  auto-deny timeout and the tool-watchdog abort were both being sent and
  silently discarded before they reached the prompt.
- A permission prompt raised before anything else had rendered showed its
  title and footer but clipped its options — the layout reserved room for
  exactly one choice however many there were.
- Messages typed while the agent was working were queued and never sent. The
  queue drained on a signal that fires once at shutdown rather than at the end
  of each turn.
- A crash left the process alive with the terminal held. It now writes a crash
  report next to the session's own files and exits.

### Memory and state drifted

- Transcript rows were kept for the life of the process. They are bounded
  again, and history past 500 rows can be scrolled to instead of collapsing
  into an unreachable marker.
- Appending a row in a long session no longer rebuilds the whole visible
  transcript.
- A late progress write can no longer resurrect a finished session as still
  running.
- Resuming a session no longer resets its turn count to zero or forgets which
  MCP servers were connected.
- Quitting during an @-mention lookup or a clipboard read could write into
  freed memory.

### The context meter told you the wrong thing

The meter read only what the provider reported, with no fallback — so a
provider that omitted usage left it frozen while the real number climbed. It
now falls back to a local estimate and marks the figure approximate when it is.

The meter and the compaction governor were also measuring different things and
could disagree by the entire size of the prompt cache. They now share one
definition, the system prompt and tool schemas are counted, and compaction can
actually act at the point it decides to.

### Input and rendering

- Pasting several lines into a terminal that does not negotiate bracketed
  paste sent each line as a separate message.
- Markdown headings no longer flicker while text below them streams.
- Three sub-agents dispatched at once could resolve each other's results into
  the wrong rows. Results are matched by call id.

### Sub-agents run unbounded

The concurrency cap is removed, along with the `maxConcurrentSubAgents`
setting. An existing settings file containing it still loads. Setting it to
`0` used to disable sub-agents entirely; that switch is gone with it.
