---
name: mine
description: Mine the coal face of this project's seams in Lamproom. Takes the next enabled action, sizes it, implements it or decomposes it, and reports every state change to the tracker. Pass a goal as the argument to open a new seam.
---

# Mining the coal face

You are working a seam that Lamproom tracks. A seam is one goal and everything connected to it; the tracker is a hypergraph: artefacts are the things delivered, actions are the work that turns input artefacts into output artefacts. You report through the Lamproom tools (status, inspect, propose, evaluate, claim, release, progress, attach, complete, ask, amend, abandon, restore, reopen, declare). The tracker observes; it does not do work for you.

Arguments given with this skill: $ARGUMENTS

Titles are one line of plain text. Everything else you write to the tracker, descriptions, criteria, rationale, question context, notes and reasons, is Markdown: use lists, emphasis, inline code and links where they help a human reading it in the UI.

## This run is mocked

Do not create, edit, or run anything in the repository. The point of this exercise is the tracking, not the code. When you "implement" an action, write one to three sentences in a progress note describing what you would have done, then attach a version to each output artefact with a ref like `mock:<short description>`. Spend your effort on decomposition quality, acceptance criteria, and honest sizing.

## Opening a seam

If you have a goal (from the arguments or the user) that no seam covers, propose one top-level action for it with no inputs. Its outputs must be concrete deliverable artefacts: almost always a `pull-request` with acceptance criteria, sometimes more than one (a PR and a `document`, say), each with its own criteria. Policy automatically adds the human review step. Size it honestly; a goal is nearly always L or XL.

Each goal is its own seam, and seams never share edges: an action's inputs must all come from one seam. To build on something a finished seam delivered, propose a **follow-up**: a top-level action (no parent) whose inputs are that seam's delivered artefacts (the reviewed pull request, the answer). It joins and reopens that seam rather than starting a new one.

## The loop

1. Call `status`. Pick one action from the coal face. Prefer the oldest unless something blocks others.
2. `claim` it, then `inspect` it and its parent if any, so you evaluate in context.
3. Evaluate it against this frame and record the result with `evaluate`:
   - judgement: implement, decompose, yield, or abandon
   - size: XS, S, M, L, or XL
   - criteria: testable statements of what done looks like (required for implement)
   - unknowns: anything you cannot resolve yourself
   - rationale: one or two sentences
4. Act on the judgement:
   - **implement**: note progress, attach versions to every output, `complete`.
   - **decompose**: `propose` two to six children with this action as parent. Each child's outputs must be real artefacts; the child that delivers the parent's deliverable lists the parent's output artefact id. Wire inputs between children where one depends on another's output. Then `release` the parent; its children are now on the face.
   - **yield**: `ask` the question. Keep `question` to one sentence, since it becomes the artefact's title; put the options, trade-offs, and sub-questions in `context`. One question per ask; ask twice rather than bundling. The action blocks and your claim is released.
   - **abandon**: `abandon` with a reason. An abandonment is undone with `restore`, a completion with `reopen`; both append events, nothing is rewritten.
5. Repeat.

## Sizing rules

Sizes are strict and never about time:

- **XS or S**: acceptance criteria are stated and testable, no open questions, one deliverable. Implement outright.
- **M**: as S but one unresolved question or one dependency not yet accepted. Resolve it by asking or waiting, or decompose.
- **L or XL**: you cannot state testable criteria yet. Must decompose.

Decompose lazily: only the action you have picked, never the whole tree. Every action is re-evaluated when picked, so earlier plans are hypotheses. If working an action reveals a missing dependency or an extra deliverable, use `amend` rather than silently absorbing it.

## When to stop

End your turn, with a short summary of what moved and what the humans need to do, when any of these holds:

- The agent coal face is empty (everything is done, blocked on a human, or waiting for review).
- You have completed or decomposed four actions in this invocation.
- You asked a question. Do not answer your own questions. A human answers in the Lamproom UI, with `lamproom answer`, or by replying in chat. If they reply in chat, record their reply with the `answer` tool, which logs it on their behalf, then carry on.

Pull-request reviews cannot be relayed from chat. If the human says "looks good" in chat, ask them to accept it in the UI or run `lamproom review <artefactId> accept`.

Before stopping, release any action you still hold unless you are mid-implementation and will continue next turn.

## Things that go wrong

- An action held by another agent: do not take it unless the user confirms that session is gone; then claim with force.
- A rejected output (status rework): inspect the artefact to read the rejection reasons, claim the action, fix, attach a new version, complete again.
- The tracker returns an error: read it, call status, and correct course. Never retry the same call unchanged.
- The tracker says it is not reachable or not signed in: stop and tell the user to run `lamproom serve`, `lamproom login` and `lamproom init` in a terminal, then restart the session. Do not improvise tracking in files.
