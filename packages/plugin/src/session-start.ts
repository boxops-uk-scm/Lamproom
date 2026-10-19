// SessionStart hook: inject the current coal face into context so the agent
// never has to ask for it. Output is the hook JSON contract.

import { Client, ClientError, resolveProject, resolveServer, tokenFor } from '@lamproom/client';

let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;

let cwd = process.cwd();
try {
  const parsed = JSON.parse(input) as { cwd?: string };
  if (parsed.cwd) cwd = parsed.cwd;
} catch {
  // No JSON on stdin; fall back to cwd.
}

const serverUrl = resolveServer();
const client = new Client(serverUrl, tokenFor(serverUrl));
let context: string;
try {
  const p = await resolveProject(client, cwd);
  const status = await client.status(p.id);
  context =
    `Lamproom is tracking ${p.owner}/${p.name} (${serverUrl}).\n\n${status}\n\n` +
    'To continue working the coal face, invoke the /lamproom:mine skill, and report every state change on a seam through the Lamproom tools. ' +
    'Outside that skill, work you do in this chat is recorded in Lamproom automatically after each turn, so you need not report it yourself.';
} catch (e) {
  const why = e instanceof ClientError ? e.message : e instanceof Error ? e.message : String(e);
  context =
    `Lamproom is installed but not reachable for this project: ${why}. ` +
    'If the user wants to track work, tell them to run "lamproom serve", "lamproom login" and "lamproom init" in a terminal, ' +
    'then restart the session. When the user gives a goal and the tracker is reachable, invoke the /lamproom:mine skill with that goal as its argument.';
}

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context },
  }),
);
