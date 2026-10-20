---
description: Rehearse Lamproom tracking from here on: report what would be recorded, record nothing. Takes on, off, status, or a number of turns.
argumentHint: "[on | off | status | <turns>]"
allowedTools: ["mcp__lamproom__mode", "mcp__lamproom__status"]
---

# Dry run

Switch Lamproom between recording this chat and rehearsing it, using the
`mode` tool. The point is to try the tracking out *from the state this
conversation has already reached*, because what the tracker does with a turn
depends on that state: the seam, who holds which action, and what the earlier
turns already recorded.

Argument given: `$ARGUMENTS`

Read it as follows, and do exactly one thing:

- empty, or `on` — call `mode` with `dryRun: true`.
- a bare number, or `on <n>` — call `mode` with `dryRun: true` and `turns: <n>`,
  so it reverts on its own after that many turns.
- `off` — call `mode` with `dryRun: false`.
- `status` — call `mode` with no arguments and report what comes back.

Then tell the user, in two or three lines:

- which mode is now in force, and that dry run **stays on across turns and
  across restarts** until it is switched off or its turn budget runs out;
- that in dry run nothing they do is recorded anywhere, so any work worth
  tracking should be re-run, or re-reported, after switching back;
- what to expect next: at the end of each turn the tracker rehearses it and
  prints what it would have recorded, including the tool calls and their
  arguments, with a warning when a turn would have started a new seam.

Do not call any other Lamproom tool, and do not start or finish work of your
own. If the user asked for `status`, say what the mode is and stop there.
