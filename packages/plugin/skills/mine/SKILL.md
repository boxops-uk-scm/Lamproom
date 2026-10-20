---
name: mine
description: Mine the coal face of this project's seams in Lamproom. Takes the next enabled action, sizes it, implements it or decomposes it, and reports every state change to the tracker. Pass a goal as the argument to open a new seam.
---

# Mining the coal face

You are working a seam that Lamproom tracks. A seam is one goal and everything connected to it; the tracker is a hypergraph: artefacts are the things delivered, actions are the work that turns input artefacts into output artefacts. You report through the Lamproom tools (status, inspect, propose, evaluate, claim, release, progress, attach, comment, complete, ask, amend, abandon, restore, reopen, declare). The tracker observes; it does not do work for you.

Arguments given with this skill: $ARGUMENTS

Titles are one line of plain text. Everything else you write to the tracker, descriptions, criteria, rationale, question context, notes and reasons, is Markdown: use lists, emphasis, inline code and links where they help a human reading it in the UI.

## Comments

Actions and artefacts carry comments, like tickets. Humans use them to steer work that is already planned ("use magic links", "keep this PR small", "the plan misses the migration"), so they are part of the brief: `status` and `inspect` show the comments on each action and on its inputs and outputs, and a human's comment outranks your own earlier evaluation. When you act on one, reply to it (`comment` with `replyTo`) saying what you did; when you disagree, say so in a reply rather than ignoring it, and `ask` if it blocks you.

Comment yourself when you learn something the next reader of an action or artefact needs and that is not a progress step: a decision and its reason, a constraint found, a caveat on a delivered artefact, a review you could not relay. Links go in the Markdown; files that back it up (a screenshot, a failing test's log) go in `files` as local paths. When a comment has attachments, `inspect` lists them and the `attachment` tool downloads one so you can read it.

## Branches, worktrees and pull requests

The work is real: you write the code, run the tests, and open pull requests. Every action with a `pull-request` output gets its own branch and its own PR, so a goal usually lands as several PRs, not one. Never work in the main checkout; every implementation happens in a git worktree, so several can run side by side.

- **Branch**: `lamproom/<actionId>-<slug>`, where the slug is a few words of the title in kebab-case.
- **Base**: the default branch (`git symbolic-ref refs/remotes/origin/HEAD`), unless one of the action's inputs is a pull request that has not merged yet. Then stack on that PR's branch and open the PR against it. With more than one unmerged input PR, branch from one, merge the others in, target the default branch, and list the PRs it depends on in the body.
- **Pull request**: `gh pr create`, titled after the action. The body carries the acceptance criteria as a checklist and a line `Lamproom: <actionId>`.
- **Version refs**: a pull request's ref is its URL at the head commit, `https://github.com/<owner>/<name>/pull/<n>/commits/<sha>`, so each push is a new version and a rejection clears only when new commits land. Other artefacts take a commit SHA or a file path at a commit.

## Opening a seam

If you have a goal (from the arguments or the user) that no seam covers, propose one top-level action for it with no inputs. Its outputs must be concrete deliverable artefacts: almost always a `pull-request` with acceptance criteria, sometimes more than one (a PR and a `document`, say), each with its own criteria. Policy automatically adds the human review step. Size it honestly; a goal is nearly always L or XL.

Each goal is its own seam, and seams never share edges: an action's inputs must all come from one seam. To build on something a finished seam delivered, propose a **follow-up**: a top-level action (no parent) whose inputs are that seam's delivered artefacts (the reviewed pull request, the answer). It joins and reopens that seam rather than starting a new one.

## The loop

1. Call `status`. Pick actions from the coal face, oldest first unless something blocks others. Take several when they are independent: up to four can be implemented at once.
2. `claim` each, then `inspect` it and its parent if any, so you evaluate in context. Read the comments on it and on its inputs: they may change the plan.
3. Evaluate it against this frame and record the result with `evaluate`:
   - judgement: implement, decompose, yield, or abandon
   - size: XS, S, M, L, or XL
   - criteria: testable statements of what done looks like (required for implement)
   - unknowns: anything you cannot resolve yourself
   - rationale: one or two sentences
4. Act on the judgement:
   - **implement**: hand it to a subagent (see below). When it returns, check every output has a version, then `complete`.
   - **decompose**: `propose` two to six children with this action as parent. Each child's outputs must be real artefacts, and every child that changes code has its own `pull-request` output; keep them small enough to review in one sitting. The child that delivers the parent's deliverable lists the parent's output artefact id. Wire inputs between children only where one truly needs another's output: independent children can be built in parallel, dependent ones stack. Then `release` the parent; its children are now on the face.
   - **yield**: `ask` the question. Keep `question` to one sentence, since it becomes the artefact's title; put the options, trade-offs, and sub-questions in `context`. One question per ask; ask twice rather than bundling. The action blocks and your claim is released.
   - **abandon**: `abandon` with a reason. An abandonment is undone with `restore`, a completion with `reopen`; both append events, nothing is rewritten.
5. Repeat.

## Implementing with subagents

Each action judged implement goes to its own subagent, started with the Agent tool and `isolation: "worktree"` so it works in a fresh worktree of its own. Start the subagents for one round in a single message so they run in parallel. You keep the claims; the subagents report through the same Lamproom tools as you.

Give each subagent everything it needs, since it sees none of this conversation: the action id, title, description and criteria; its input artefacts with their current refs; its output artefact ids and kinds; the branch name and base. Tell it to:

1. `git fetch origin`, then `git switch -c <branch> <base>`.
2. Implement the action, meeting every criterion and nothing beyond it. Follow the repository's conventions and run its tests, linters and type checks; fix what fails.
3. Post a short `progress` note on the action at meaningful steps, saying what was done and what was found. Follow the comments on the action and its artefacts (include them in the brief); `comment` on the output artefact with anything a reviewer should know, linking test runs and attaching logs or screenshots as files.
4. Commit, `git push -u origin <branch>`, open the PR, and `attach` a version to each output artefact.
5. Not call `complete`, `claim` or `release`, and return the PR URL, the head SHA, the worktree path, and anything it could not do.

When a subagent returns, `complete` its action if every output has a version, then remove its worktree (`git worktree remove <path>`; the branch is on the remote). If it failed, record why in a `progress` note and either `ask` what is blocking it or `release` the action.

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
- A rejected output (status rework): inspect the artefact to read the rejection reasons, claim the action, and hand it to a subagent as above, but switching to the existing branch (`git switch <branch>`) instead of creating one. It pushes the fix to the same PR and attaches a new version at the new head commit; then complete again.
- The tracker returns an error: read it, call status, and correct course. Never retry the same call unchanged.
- The tracker says it is not reachable or not signed in: stop and tell the user to run `lamproom serve`, `lamproom login` and `lamproom init` in a terminal, then restart the session. Do not improvise tracking in files.
