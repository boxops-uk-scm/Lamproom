# Coalface

A tracker for agentic development workflows. Artefacts are nodes, actions are
hyperedges, and agents mine the coal face: take one enabled action, size it,
and either implement it or decompose it into children. The parent stays as a
grouping node, the history is an append-only event log, and the graph you see
is a pure projection of that log.

This is an MVP. The work itself is mocked: agents only update workflow state.

## Layout

| Package | What it is |
| --- | --- |
| `packages/core` | The workflow algebra: types, event projection, policy atoms, commands, status rendering. Pure, tested. |
| `packages/plugin` | Claude Code plugin: MCP reporting tools, a SessionStart hook that injects the coal face, and the `mine` skill. |
| `packages/ui` | Live graph and board: Vite, React Flow, ELK layered layout, event-log scrubber. Components from Meta's Astryx, themed with the Boxops design tokens. |
| `packages/cli` | `coalface` command: serve the UI, init a project, answer and review as a human, replay a log. |

## Quick start

Requires Node 22 and pnpm.

```bash
pnpm install
pnpm build
```

Start the UI against a project (creates `.coalface/` in it on first write):

```bash
cd /path/to/project
node /path/to/coalface/packages/cli/dist/coalface.js serve
# http://localhost:4411
```

Load the plugin into a Claude Code session in that project:

```bash
claude --plugin-dir /path/to/coalface/packages/plugin
```

Then give the agent a goal:

```
/coalface:mine Add passwordless login
```

The agent proposes a top-level action with a pull-request deliverable, policy
adds the human review step, and the agent works the face: evaluate, implement
or decompose, report. Review, answer questions, and take over actions from the
UI, or from the shell:

```bash
coalface status
coalface answer <questionId> "15 minutes"
coalface review <artefactId> accept
coalface review <artefactId> reject "no tests"
```

To see the UI with data and no agent, seed the demo workflow:

```bash
pnpm --filter @coalface/cli seed --dir /path/to/project
```

## Reading the graph

Each goal is a workflow: a connected component of the hypergraph, drawn as a
frame with the goal's title, status, and progress in its header and its
deliverable flagged at the right edge. Frames lay out independently and stack
automatically. Drag a frame by its header and it stays where you drop it, with
the others flowing around it; pin it to lock it there so it cannot be dragged;
Tidy returns every unpinned frame to the automatic stack. Finished workflows
fold up on their own. Focus one or more workflows from the picker in the top
bar, a frame's focus button, or a double-click on a frame (shift to add it to
the focus), to dim the others, fit them to the view, scope the counts to them,
and scope the timeline slider to their events alone. A single click on the
canvas clears only the selection; a double-click on the canvas, or Escape,
clears the focus. Frame positions, pins, and collapse state are remembered per
project in the browser.
The details pane on the right resizes from its left edge: drag the handle, or
focus it and use the arrow keys. The width is remembered too.

The board view shows the same state as a kanban: every leaf action from every
workflow is a card, in columns by what the action is waiting for (blocked,
ready, needs you, in progress, awaiting review, done). Each card names its
workflow; decomposed actions are not cards, their children are, with the chain
of parents as a breadcrumb. Focus filters the board to the chosen workflows:
double-click a card to focus its workflow (shift to add), double-click the
background to clear. Selection and the timeline slider work the same in both
views.

## The model in one paragraph

An action is enabled when every input artefact has a valid version. The coal
face is the set of enabled actions nobody holds. Decomposing an action adds
children under it; it completes when they do and its outputs are closed. Policy
is a set of atoms: declaring a `pull-request` expands into pull-request, a
human review action, and a `reviewed-pull-request` terminal; declaring a
`question` expands into question, a human answer action, and an `answer`. A
rejection marks the current version rejected and sends the producer to rework;
a new version clears it. Loops are version advances on the same node, never new
nodes. Every event carries its actor and a provenance rung (owned, verified,
reported, inferred). Nothing is ever rewritten: an abandonment is undone by a
`restore` event and a completion by a `reopen` event, and the UI offers Undo on
the toast after each human command that has a reverse. Sizes are strict t-shirt sizes and never time. Every
piece of prose, descriptions, criteria, questions and answers, notes and
reasons, is rich text: Markdown in the log, which agents and the CLI write
directly; a rich text editor in the UI; plain text wherever a terminal shows
it. Titles are one line of plain text.

## The UI's components and tokens

The UI is built from [Astryx](https://github.com/facebook/astryx) components
(`@astryxdesign/core`), prebuilt and loaded as plain CSS, so no StyleX compile
step is needed; `pnpm --filter @coalface/ui theme:build` (run by `build` and
`dev`) compiles the theme to CSS with the Astryx CLI. The look comes from the Boxops design tokens: `pnpm --filter
@coalface/ui sync-boxops` fetches the token sources from the Boxops monorepo
(`www/@boxops/ui/src/*.stylex.ts`, via `gh api`) and writes
`packages/ui/src/theme/boxops.generated.ts`; `boxopsTheme.tsx` maps those onto
Astryx's token roles with `defineTheme`, and `icons.tsx` supplies the Astryx
semantic icons from Phosphor, as Boxops does. Coalface's own styles in
`styles.css` only alias Astryx tokens, so a re-sync restyles everything. The
graph nodes stay custom React Flow components on the same tokens. Run `pnpm
--filter @coalface/ui astryx component <Name>` for any component's docs.

Rich text is edited with the Boxops Lexical editor, ported to Astryx in
`packages/ui/src/rich`: a toolbar at the top of every editor shows the
formatting at the caret and applies bold, italic, strikethrough, code, links
(Ctrl or Cmd+K asks for an address), bulleted, numbered and check lists,
quotes and code blocks; Markdown shortcuts work as you type; Cmd or
Ctrl+Enter submits where a form takes one answer. The editor reads and
writes Markdown, so the log never sees editor state. Rendering goes through
Astryx's `Markdown` component. The goal dialog, review notes, answers,
descriptions, criteria, rationale and log notes all use it. The goal dialog
takes a title, a description and a list of deliverables; each deliverable is
composed in its own dialog, with a kind, a title and acceptance criteria.

## Development

```bash
pnpm test                       # core algebra tests
pnpm typecheck
pnpm --filter @coalface/ui dev  # Vite dev server, proxies /api to :4411
```

The event log lives at `.coalface/events.jsonl`; policy at `.coalface/policy.json`.
Any prefix of the log projects to a consistent state, which is what the
timeline scrubber in the UI does.
