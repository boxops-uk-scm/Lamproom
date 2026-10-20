// Stop hook: decide whether the turn that just ended belongs in Lamproom, and
// record it if so. The session waits for it, so turns never overlap. First
// the free rules in `screen` (a turn that already reported through the
// Lamproom tools, or that changed nothing worth recording, stops there), then
// the Haiku classifier, then the Haiku tracker. What was recorded is shown to
// the user now and given to the main session on its next prompt.
//
// In dry run, switched on from the session with /lamproom:dry-run, the same
// three stages run against the real graph and the tracker's writes are traced
// instead of sent: the turn is rehearsed in the state the chat has actually
// reached, which is the only state in which its context is real. Each stage's
// verdict is reported even when it stops early, because under a rehearsal
// silence cannot be told from "nothing to do".

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  archiveTurn, clip, describeMode, disabled, feedbackFile, log, parseTurnFile, readMode, readStdin, screen,
  sessionDir, turnFile, writeMode, type Mode, type TurnRecord,
} from './autotrack.js';
import { formatRehearsal, takeRehearsal } from './report.js';
import { classify, record } from './track.js';

if (disabled()) process.exit(0);

const input = await readStdin();
const sessionId = String(input.session_id ?? '');
const promptId = String(input.prompt_id ?? '');
const cwd = String(input.cwd ?? process.cwd());
if (!sessionId || !promptId) process.exit(0);

const mode = readMode(cwd);

/** Tell the user, and leave a note the next prompt hands to the session. */
function say(lines: string[], forModel?: string): never {
  if (forModel) fs.appendFileSync(feedbackFile(sessionId), `- ${forModel}\n`);
  process.stdout.write(JSON.stringify({ systemMessage: lines.join('\n') }));
  process.exit(0);
}

/** Spend one turn of a rehearsal budget, reverting to live when it runs out. */
function spend(m: Mode): string[] {
  const rehearsed = (m.rehearsed ?? 0) + 1;
  if (m.turnsLeft === undefined) return writeMode(cwd, { ...m, rehearsed }), [];
  const turnsLeft = m.turnsLeft - 1;
  writeMode(cwd, { ...m, rehearsed, turnsLeft, dryRun: turnsLeft > 0 });
  return turnsLeft > 0
    ? [`${turnsLeft} rehearsal turn(s) left.`]
    : ['That was the last rehearsal turn; Lamproom is recording normally again.'];
}

// Interrupted turns never reach Stop; clear their records after a day.
for (const f of fs.readdirSync(sessionDir(sessionId))) {
  const p = path.join(sessionDir(sessionId), f);
  if (f.startsWith('turn-') && Date.now() - fs.statSync(p).mtimeMs > 86_400_000) fs.rmSync(p, { force: true });
}

const file = turnFile(sessionId, promptId);
if (!fs.existsSync(file)) process.exit(0);
const turnRecord: TurnRecord = { promptId, cwd, reply: clip(input.last_assistant_message, 3000), entries: parseTurnFile(file) };
fs.rmSync(file);
archiveTurn(sessionId, turnRecord);

const screened = screen(turnRecord.entries, turnRecord);
if (screened.verdict === 'skip') {
  log(sessionId, `${promptId} skip: ${screened.reason}`);
  if (!mode.dryRun) process.exit(0);
  say(['Lamproom DRY RUN', `  the free rules stopped this turn: ${screened.reason}`, ...spend(mode)]);
}

let decision;
try {
  decision = classify(sessionId, screened.turn);
} catch (e) {
  log(sessionId, `${promptId} failed: ${(e as Error).message}`);
  if (!mode.dryRun) process.exit(0);
  say(['Lamproom DRY RUN', `  the classifier failed: ${(e as Error).message}`, ...spend(mode)]);
}

if (!decision.track) {
  if (!mode.dryRun) process.exit(0);
  say([
    'Lamproom DRY RUN',
    `  the classifier said skip (confidence ${decision.confidence}), so the tracker would not run`,
    `  ${decision.reason}`,
    ...spend(mode),
  ]);
}

if (mode.dryRun) {
  const trace = path.join(os.tmpdir(), `lamproom-rehearsal-${process.pid}.jsonl`);
  let rec;
  try {
    rec = record(sessionId, screened.turn, { dryRunTrace: trace });
  } catch (e) {
    log(sessionId, `${promptId} failed: ${(e as Error).message}`);
    say(['Lamproom DRY RUN', `  the tracker failed: ${(e as Error).message}`, ...spend(mode)]);
  }
  const rehearsal = takeRehearsal(trace);
  const lines = [
    'Lamproom DRY RUN — nothing was recorded',
    `  classifier  track (confidence ${decision.confidence})`,
    ...formatRehearsal(rehearsal, { indent: '  ' }),
    `  reported    ${rec.summary ?? 'Nothing recorded.'}`,
    ...(rehearsal.newSeams ? [`  ! ${rehearsal.newSeams} new seam(s) would have been created`] : []),
    ...spend(mode),
  ];
  // The session is told too, so you can ask about the rehearsal in the next turn.
  say(lines, `DRY RUN, nothing recorded: ${rec.summary ?? 'the tracker would have recorded nothing'}`);
}

let summary: string | undefined;
try {
  summary = record(sessionId, screened.turn).summary;
} catch (e) {
  log(sessionId, `${promptId} failed: ${(e as Error).message}`);
}
if (summary) say([`Lamproom: ${summary}`], summary);
