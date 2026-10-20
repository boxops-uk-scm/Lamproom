// UserPromptSubmit and PostToolUse hook: append what this turn did to its
// record, keyed by prompt id, for the Stop hook to judge. On a new prompt,
// also hand the main session whatever the tracker recorded since the last
// one. Runs synchronously on every edit and shell call, so it stays small.

import fs from 'node:fs';
import { clip, disabled, EDIT_TOOLS, feedbackFile, isLamproomTool, readStdin, turnFile, type TurnEntry } from './autotrack.js';

if (disabled()) process.exit(0);

const input = await readStdin();
const sessionId = String(input.session_id ?? '');
const promptId = String(input.prompt_id ?? '');
if (!sessionId || !promptId) process.exit(0);

const append = (e: TurnEntry) => fs.appendFileSync(turnFile(sessionId, promptId), `${JSON.stringify(e)}\n`);

if (input.hook_event_name === 'UserPromptSubmit') {
  append({ kind: 'prompt', text: clip(input.prompt, 4000) });
  const fb = feedbackFile(sessionId);
  if (fs.existsSync(fb)) {
    const notes = fs.readFileSync(fb, 'utf8').trim();
    fs.rmSync(fb);
    if (notes) {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'UserPromptSubmit',
            // Rehearsals land in the same file, so the framing has to cover
            // both: calling a rehearsal "recorded" would be a lie the
            // session then repeats to the user.
            additionalContext:
              `Lamproom checked your recent chat work automatically:\n${notes}\n` +
              'Entries marked DRY RUN were rehearsed and recorded nowhere; everything else is already ' +
              'in the log and need not be reported again.',
          },
        }),
      );
    }
  }
} else if (input.hook_event_name === 'PostToolUse') {
  const tool = String(input.tool_name ?? '');
  const server = (input.mcp_server as { name?: string } | undefined)?.name;
  const ti = (input.tool_input ?? {}) as Record<string, unknown>;
  const desc = EDIT_TOOLS.has(tool) ? String(ti.file_path ?? ti.notebook_path ?? '') : tool === 'Bash' ? String(ti.command ?? '') : ti;
  const tr = input.tool_response as Record<string, unknown> | string | undefined;
  const out = tool === 'Bash' && tr && typeof tr === 'object' ? tr.stdout : EDIT_TOOLS.has(tool) ? '' : tr;
  append({ kind: 'tool', tool, input: clip(desc, 600), output: clip(out, 800), lamproom: isLamproomTool(tool, server) });
}
