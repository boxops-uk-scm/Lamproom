// SessionStart hook: inject the current coal face into context so the agent
// never has to ask for it. Output is the hook JSON contract.

import { renderStatus } from '@coalface/core';
import { Store } from '@coalface/core/node';

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

const store = Store.resolve(cwd);
let context: string;
if (!store.exists()) {
  context =
    'Coalface workflow tracker is installed but this project has no workflow yet. ' +
    'When the user gives a goal, invoke the /coalface:mine skill with that goal as its argument.';
} else {
  let status: string;
  try {
    status = renderStatus(store.state());
  } catch (e) {
    status = `(could not read workflow: ${e instanceof Error ? e.message : String(e)})`;
  }
  context =
    `Coalface workflow tracker is active for this project.\n\n${status}\n\n` +
    'To continue working the coal face, invoke the /coalface:mine skill. ' +
    'Report every workflow state change through the coalface tracker tools.';
}

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context },
  }),
);
