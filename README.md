# Lamproom

A tracker for agentic development. Work is a hypergraph: artefacts are nodes, actions are
hyperedges, and agents mine the coal face: take one enabled action, size it,
and either implement it or decompose it into children. The parent stays as a
grouping node, the history is an append-only event log, and the graph you see
is a pure projection of that log.

This is the second prototype: a real server with GitHub sign-in and a
database, one event stream per seam, and the UI, CLI and Claude Code
plugin as its clients. Agents do the work for real: each implementation
runs in a subagent in its own git worktree, on its own branch, and ends in
its own pull request.

## Layout

| Package | What it is |
| --- | --- |
| `packages/core` | The algebra: types, event projection, policy atoms, fragments, commands, status rendering. Pure, tested. |
| `packages/server` | The server: per-seam event streams in SQLite (Postgres-shaped), GitHub sign-in, sessions and API tokens, the command API, a resumable live feed, JSON-lines import and export. Tested against a fake GitHub. |
| `packages/client` | Node client shared by the CLI and the plugin: sign-in config, project resolution from a git remote, API calls. |
| `packages/cli` | `lamproom` command: run the server, sign in, register a project, act as a human, import and export logs. |
| `packages/plugin` | Claude Code plugin: MCP reporting tools, a SessionStart hook that injects the coal face, and the `mine` skill. Talks to the server. |
| `packages/ui` | Live graph and board: Vite, React Flow, ELK layered layout, per-seam history scrubber. Components from Meta's Astryx, themed with the Boxops design tokens. |

## Quick start

Requires Node 22 and pnpm.

```bash
pnpm install
pnpm build
```

Run the server. For development without a GitHub App, name a user and every
request is signed in as them:

```bash
LAMPROOM_DEV_USER=tom node packages/cli/dist/lamproom.js serve
# http://localhost:4411
```

Register a repository as a project, either from the UI (Add project) or from
a checkout of it:

```bash
cd /path/to/checkout      # its origin remote names the GitHub repository
lamproom init             # or: lamproom init owner/name
```

Load the plugin into a Claude Code session in that checkout and give the
agent a goal:

```bash
claude --plugin-dir /path/to/lamproom/packages/plugin
/lamproom:mine Add passwordless login
```

The agent proposes a top-level action with a pull-request deliverable, policy
adds the human review step, and the agent works the face: evaluate, implement
or decompose, report. Review, answer questions, and take over actions from the
UI, or from the shell:

```bash
lamproom status
lamproom answer <questionId> "15 minutes"
lamproom review <artefactId> accept
lamproom review <artefactId> reject "no tests"
```

To see the UI with data and no agent, seed the demo seam (a goal and its tree of actions) into a project:

```bash
pnpm seed --project owner/name
```

## Signing in with GitHub

Sign-in is GitHub's user authorization, with PKCE, completed by the server
(GitHub still requires the client secret at the token exchange). Browsers use
the web flow; terminals use the device flow and keep an API token in
`~/.config/lamproom/config.json`.

1. Create a GitHub App (Settings, Developer settings). Set the callback URL
   to `http://localhost:4411/auth/github/callback`, tick "Enable Device Flow",
   and give it the Metadata repository permission (read). Install it on the
   repositories you will track; a user can only register a repository the
   app is installed on and they can see. An OAuth App works too, with
   `LAMPROOM_GITHUB_SCOPE="read:user repo"`.
2. Run the server with the app's credentials:

   ```bash
   LAMPROOM_GITHUB_CLIENT_ID=... LAMPROOM_GITHUB_CLIENT_SECRET=... node packages/cli/dist/lamproom.js serve
   ```

3. Open the UI and sign in. From a terminal, `lamproom login` shows a code to
   enter on GitHub.

On a remote box, forward the port (`ssh -L 4411:localhost:4411 box`) and the
callback still lands on `localhost:4411`. If the browser reaches the server
under another address, set `LAMPROOM_PUBLIC_URL` to it and register that
callback.

Server environment, all optional except one way to sign in:

| Variable | Meaning |
| --- | --- |
| `LAMPROOM_DATA` | Data directory, default `~/.lamproom` (holds `lamproom.db` and the signing secret). |
| `LAMPROOM_DATABASE_URL` | `postgres://...` to use Postgres instead of SQLite (the `pg` package must be installed; untested here). |
| `LAMPROOM_SECRET` | Cookie signing and token encryption key; generated into the data directory if unset. |
| `LAMPROOM_PUBLIC_URL` | How the browser reaches the server, default `http://localhost:<port>`. |
| `LAMPROOM_GITHUB_CLIENT_ID`, `LAMPROOM_GITHUB_CLIENT_SECRET` | The GitHub App or OAuth App. |
| `LAMPROOM_GITHUB_URL`, `LAMPROOM_GITHUB_API_URL` | Defaults `https://github.com` and `https://api.github.com`; tests point them at a fake. |
| `LAMPROOM_DEV_USER` | Sign every request in as this login with no GitHub. Development only; the UI shows a `dev` badge. |

Client environment: `LAMPROOM_SERVER` (default `http://localhost:4411`),
`LAMPROOM_TOKEN` (instead of the config file), `LAMPROOM_PROJECT`
(`owner/name`, instead of the git remote), `LAMPROOM_AGENT` (the agent's label).

## Storage

One event stream per seam. Every event carries a global `seq` (commit
order across the project) and a dense per-stream `rev`; commands can pass an
expected `rev` and an idempotency key. Each stream keeps a snapshot of its
projected state and the summary the overview needs, written in the same
transaction as the append, so opening a project reads snapshots and never
replays. The UI applies live events to those states with the same `extend`
the server uses, and the history scrubber works only on focused seams,
reading their streams alone. Snapshots carry the projection version and are
rebuilt from their stream when it changes; events carry a schema version and
are upcast on read.

The log is a grow-only set: the projection sorts by `seq` before folding, so
any arrival order gives the same state, and streams share no entities, so the
union of stream projections is the projection of the union. That is the
invariant behind partitioning, and the reason commands refuse edges between
seams.

SQLite is the development store, through Node's built-in `node:sqlite`, with
one file in the data directory. The schema and statements are
Postgres-shaped (a second adapter rewrites placeholders and the sequence, and
takes a per-project advisory lock so `seq` order is commit order); it has not
been run against Postgres yet. The file log remains the interchange format:
`lamproom import events.jsonl` replays a file into streams (each event joins
the stream of what it references), `lamproom export` writes one out, and
`lamproom replay` projects a file offline.

## Reading the graph

Each goal is a seam, a connected component of the hypergraph, drawn as a
frame with the goal's title, status, and progress in its header and its
deliverables flagged at the right edge. Frames lay out independently and stack
automatically. Drag a frame by its header and it stays where you drop it, with
the others flowing around it; pin it to lock it there so it cannot be dragged;
Tidy returns every unpinned frame to the automatic stack. Finished seams
fold up on their own, and unfold if a follow-up reopens them. Focus one or
more seams from the picker in the top bar, a frame's focus button, or a
double-click on a frame (shift to add it to the focus), to dim the others, fit
them to the view, scope the counts to them, and enable the history slider for
their events alone. A single click on the canvas clears only the selection; a
double-click on the canvas, or Escape, clears the focus. Frame positions, pins,
and collapse state are remembered per project in the browser.
The details pane on the right resizes from its left edge: drag the handle, or
focus it and use the arrow keys. The width is remembered too.

The board view shows the same state as a kanban: every leaf action from every
seam is a card, in columns by what the action is waiting for (blocked,
ready, needs you, in progress, awaiting review, done). Each card names its
seam; decomposed actions are not cards, their children are, with the chain
of parents as a breadcrumb. Focus filters the board to the chosen seams:
double-click a card to focus its seam (shift to add), double-click the
background to clear. Selection and the slider work the same in both views.

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
the toast after each human command that has a reverse. Sizes are strict t-shirt
sizes and never time. Every piece of prose, descriptions, criteria, questions
and answers, notes and reasons, is rich text: Markdown in the log, which agents
and the CLI write directly; a rich text editor in the UI; plain text wherever a
terminal shows it. Titles are one line of plain text.

Two units of structure. The **seam** is the logical and storage unit, the thing agents work along: a
goal, everything connected to it, one stream. Seams never share edges; an
action's inputs must all come from one seam. A finished seam is
extended, not copied: a **follow-up** is a top-level action whose inputs are
the seam's delivered artefacts, and it reopens the seam until it too
is done. The **fragment** is the composable unit: an open hypergraph (a
cospan) with an input boundary and an output boundary typed by artefact kind.
Policy atoms are fragments, fragments compose by gluing an output boundary to
an input boundary, and the `decompose` command instantiates a fragment under
an action with the action's own boundary, declaring what is inside and
proposing the children. A seam is a closed composition, which is why it,
and not the fragment, carries the stream.

## The UI's components and tokens

The UI is built from [Astryx](https://github.com/facebook/astryx) components
(`@astryxdesign/core`), prebuilt and loaded as plain CSS, so no StyleX compile
step is needed; `pnpm --filter @lamproom/ui theme:build` (run by `build` and
`dev`) compiles the theme to CSS with the Astryx CLI. The look comes from the Boxops design tokens: `pnpm --filter
@lamproom/ui sync-boxops` fetches the token sources from the Boxops monorepo
(`www/@boxops/ui/src/*.stylex.ts`, via `gh api`) and writes
`packages/ui/src/theme/boxops.generated.ts`; `boxopsTheme.tsx` maps those onto
Astryx's token roles with `defineTheme`, and `icons.tsx` supplies the Astryx
semantic icons from Phosphor, as Boxops does. Lamproom's own styles in
`styles.css` only alias Astryx tokens, so a re-sync restyles everything. The
graph nodes stay custom React Flow components on the same tokens. Run `pnpm
--filter @lamproom/ui astryx component <Name>` for any component's docs.

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
pnpm test                       # core algebra and server (against a fake GitHub)
pnpm typecheck
pnpm --filter @lamproom/ui dev  # Vite dev server, proxies /api and /auth to :4411
```

The CLI bundles the server; after a change run `pnpm build` and restart
`lamproom serve`. The plugin bundles the client the same way.
