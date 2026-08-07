## A rebuilt model surface, and two bugs that could end a session

This is the second sweep over the OpenTUI cutover. Several of these were
behaviour that had been fixed once already and lost when the renderer was
replaced — the fix lived in a file the cutover deleted, so the bug came back
without anyone changing it.

### Picking a model

The picker now lists providers, and you descend into one to choose a model.
Escape steps back out to the provider level rather than closing. Recents and
favourites stay flat at the top so a model you already use is one keystroke
away, and each account gets its own row instead of being flattened into a
single combined list.

**Model tiers are gone.** `/fast`, `/standard`, and `/clever` are retired
rather than remapped, because a tier was a fallback chain of providers rather
than a single model — neither a favourite nor a pinned model says the same
thing. Per-agent selection still works through the agent's own inference
setting. A settings file that still contains tiers loads fine; the key is
dropped the next time settings are saved.

**The context meter was reading nearly four times low** for anyone on a
custom-named provider. A 500k window showed as the 128k default, so the meter
looked comfortable while the real context filled. It now recognises
account-qualified model names, and only marks a figure as estimated when it is
genuinely guessing.

The model marked as current is the one the session is actually running. It used
to be inferred from the most recent pick, which meant any session that never
opened the picker showed the wrong one.

### Two ways a session could die

**Switching models used to poison the conversation permanently.** Reasoning
state issued by one provider was replayed to another that could not read it,
and every turn after that failed. Reasoning state now travels with the provider
that produced it. Switching between accounts on the same provider still keeps
reasoning continuity.

**A model that fell into a loop ran until you stopped it.** Repetition is now
detected inside a single streaming stretch, and by comparing successive
stretches across tool calls — so a model that loops while calling a tool each
pass is still caught. Ordinary narration repeated before successive tool calls
is left alone.

### The screen

- Plugin diagnostics were writing straight to the terminal and corrupting the
  display. They go to the log now, and the warnings that used to disappear
  along with them are surfaced where you can see them.
- The provider setup screen garbled its own text on a short terminal, with rows
  compressed into one another instead of clipping.
- The command palette matches the prompt box width, loses its marker column,
  kind column and title rule, and marks the selected row by colour instead of a
  grey band.
- An overlay reserves room for its own frame before anything else is allowed to
  squeeze it.
- **`/resume` was offering sessions that did not exist.** Demo placeholder data
  was shipping in the product and appeared whenever something failed to load.
  A missing dependency now shows an honest empty state.
- Dialogs describe their choices in plain English.

### Context and files

- Compaction stopped hollowing out the turns it had just decided to keep, so a
  file you edited two turns ago is still there when you ask about it.
- A crash finalizes the session record instead of leaving it marked running.
- Mentioning a file outside your workspace inlines it once rather than refusing.
  Sensitive files stay blocked, and that list now covers shell history, system
  credentials, keychains, browser cookie and password stores, and cloud
  credentials.

### Your machine

**An agent could rewrite your global git configuration in order to push**,
which changes every repository on the machine and outlives the session. That
now asks you first, and there is a scoped push path that applies credentials
for a single command without writing to any config file.

Tools that only apply sometimes — `present`, goal and task management, and LSP —
are only offered when they apply. A dispatched sub-agent shows live progress on
its own row. The most recently queued message can be cancelled.

### Underneath

The test suite only passed in one order. Under a randomized order it produced
over a hundred failures, because a mocking idiom used throughout was silently
leaving mocks installed for every file that ran afterwards. It now passes in any
order, and CI checks a fixed order on every change plus a random one nightly.

There is also now a written specification for how the terminal UI is meant to
look and behave, covering overlays, selectors, the palette, the prompt box,
scrolling and key macros. Nine documents describing the finished migration have
been retired.
