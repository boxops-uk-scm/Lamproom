// Stop hook: decide whether the turn that just ended belongs in Lamproom, and
// record it if so. The session waits for it, so turns never overlap. First
// the free rules: a turn goes no further when it already reported through
// the Lamproom tools (the mine skill did it) or when it changed nothing worth
// recording: no file edits and no commits, pushes or pull-request changes.
// Then the Haiku classifier, then the Haiku tracker. What was recorded is
// shown to the user now and given to the main session on its next prompt.

import fs from 'node:fs';
import path from 'node:path';
import {
  clip, disabled, EDIT_TOOLS, feedbackFile, isRecordableCommand, log, readStdin, sessionDir, turnFile,
  type Turn, type TurnEntry,
} from './autotrack.js';
import { classify, record } from './track.js';

if (disabled()) process.exit(0);

const input = await readStdin();
const sessionId = String(input.session_id ?? '');
const promptId = String(input.prompt_id ?? '');
const cwd = String(input.cwd ?? process.cwd());
if (!sessionId || !promptId) process.exit(0);

// Interrupted turns never reach Stop; clear their records after a day.
for (const f of fs.readdirSync(sessionDir(sessionId))) {
  const p = path.join(sessionDir(sessionId), f);
  if (f.startsWith('turn-') && Date.now() - fs.statSync(p).mtimeMs > 86_400_000) fs.rmSync(p, { force: true });
}

const file = turnFile(sessionId, promptId);
if (!fs.existsSync(file)) process.exit(0);
const entries = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as TurnEntry);
fs.rmSync(file);

const tools = entries.filter((e) => e.kind === 'tool');
const prompt = entries.find((e) => e.kind === 'prompt')?.text ?? '';
if (tools.some((t) => t.lamproom)) {
  log(sessionId, `${promptId} skip: the turn reported through Lamproom itself`);
  process.exit(0);
}
const recordable = tools.filter((t) => EDIT_TOOLS.has(t.tool) || (t.tool === 'Bash' && isRecordableCommand(t.input)));
if (!recordable.length) {
  log(sessionId, `${promptId} skip: no edits, commits or pull-request changes`);
  process.exit(0);
}

const relative = (p: string) => (p.startsWith(cwd + path.sep) ? path.relative(cwd, p) : p);
const edited = [...new Set(recordable.filter((t) => EDIT_TOOLS.has(t.tool)).map((t) => relative(t.input)))];
const activity = [
  ...(edited.length ? [`edited ${edited.join(', ')}`] : []),
  ...recordable.filter((t) => t.tool === 'Bash').map((t) => `ran \`${t.input}\`${t.output ? ` -> ${t.output}` : ''}`),
];
const turn: Turn = { promptId, cwd, prompt, activity, reply: clip(input.last_assistant_message, 3000) };

let summary: string | undefined;
try {
  if (classify(sessionId, turn)) summary = record(sessionId, turn);
} catch (e) {
  log(sessionId, `${promptId} failed: ${(e as Error).message}`);
}
if (summary) {
  fs.appendFileSync(feedbackFile(sessionId), `- ${summary}\n`);
  process.stdout.write(JSON.stringify({ systemMessage: `Lamproom: ${summary}` }));
}
