# Real-terminal sign-off — v0.2.90

Every acceptance result on the OpenTUI cutover so far comes from the headless
test renderer. That renderer cannot see paint, real modifier reporting, the
system clipboard, or terminal-owned selection, so a whole class of defect is
invisible to it by construction.

This is not a theoretical gap. During the cutover, every genuine defect was
found by running the app or capturing the pty byte stream, and none were found
by the suite — including a standalone binary that could not start, a clipboard
that had never written to the system clipboard, and a quit key that fired
mid-edit. Two separate false "blocking" verdicts came from trusting documents
instead.

So this checklist is signed by a human at a real terminal, or it is not signed.

**Signed by:** ______________________  **Date:** ______________

**Build under test:** `bun run build:bin` → `dist/corbits`, run from a
directory with no adjacent `node_modules`.

**Terminal:** ______________________  **Version:** ______________

Run the whole list at **80x24**, then again at **120x40**. A row passes only if
it passes at both sizes.

## Launch and layout

| # | Check | 80x24 | 120x40 |
|---|---|---|---|
| 1 | Binary starts from an empty directory | ☐ | ☐ |
| 2 | Landing screen paints; the mark and hint row are intact | ☐ | ☐ |
| 3 | Resize the window mid-session: no overlap, no stuck rows, no horizontal scroll | ☐ | ☐ |
| 4 | Resize while an overlay is open | ☐ | ☐ |

## Input

| # | Check | 80x24 | 120x40 |
|---|---|---|---|
| 5 | Ctrl+Enter inserts a newline; the prompt grows and then scrolls at 40vh | ☐ | ☐ |
| 6 | Enter sends; the message is not split at a newline | ☐ | ☐ |
| 7 | Ctrl+D deletes the character under the cursor and never exits | ☐ | ☐ |
| 8 | Ctrl+C interrupts a run; twice quits, and the terminal is restored | ☐ | ☐ |
| 9 | Paste a short API key into onboarding | ☐ | ☐ |
| 10 | Paste a key longer than 1000 characters — it must not truncate | ☐ | ☐ |
| 11 | Paste multi-line text into the prompt: arrives whole, does not send early | ☐ | ☐ |
| 12 | Ctrl+V with an image on the clipboard attaches it | ☐ | ☐ |
| 13 | Typing works immediately on every surface without clicking first | ☐ | ☐ |

## Selection and copy

| # | Check | 80x24 | 120x40 |
|---|---|---|---|
| 15 | Drag-select transcript text with the mouse, no modifier | ☐ | ☐ |
| 16 | CMD+C copies the selection; paste it elsewhere to confirm | ☐ | ☐ |
| 17 | Alt+M takes the mouse; click-to-expand works | ☐ | ☐ |
| 18 | Alt+M again returns selection to the terminal | ☐ | ☐ |
| 19 | Alt+C copy mode writes to the system clipboard | ☐ | ☐ |

## Streaming and transcript

| # | Check | 80x24 | 120x40 |
|---|---|---|---|
| 20 | Stream a reply containing `####` headings — no literal markers, no shaking | ☐ | ☐ |
| 21 | Stream a reply with a code fence and a table | ☐ | ☐ |
| 22 | Run the same tool 4+ times in one turn: one folded row, no orphan results | ☐ | ☐ |
| 23 | Non-ASCII output (CJK, em dashes, arrows) does not overflow or mis-wrap | ☐ | ☐ |
| 24 | A session past 500 rows still streams smoothly | ☐ | ☐ |

## Permissions and failure

| # | Check | 80x24 | 120x40 |
|---|---|---|---|
| 25 | Approval overlay is sized to its content, not the terminal | ☐ | ☐ |
| 26 | The gate content is not printed twice | ☐ | ☐ |
| 27 | The decision is recorded in the transcript after choosing | ☐ | ☐ |
| 28 | Force a crash: the terminal is restored and the process exits | ☐ | ☐ |
| 29 | Resume a session created before the cutover | ☐ | ☐ |

## Known open at sign-off

State whether each is still true, so the release notes match reality.

- **Shift+Enter** does not insert a newline on terminals that do not report the
  modifier. Ctrl+Enter and Ctrl+J do. Verified as terminal reporting, not a
  decode defect — the kitty path works end to end.
- **Markdown flicker while streaming.** The deterministic cause (a bare `####`
  painting as literal text) is fixed and guarded. A milder flicker remains from
  the async highlighter repainting raw source before the concealed form lands.
- **CL-5551**, transcript rows are retained for the life of the process. The
  600-block cap died with the deleted Ink stream state and was not ported.

## Sign-off

Do not tag the release until every row above is checked at both sizes, or until
an unchecked row is deliberately accepted and named in the release notes.

Anything found here is worth more than anything found by the suite. If a row
fails, say what you saw rather than what you expected — the failures that cost
the most this cycle were the ones described from intent instead of observation.
