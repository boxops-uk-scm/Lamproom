// `dry-run`: rehearse the auto-tracking prompts against a turn and report what
// would have happened, appending nothing. It drives the same three stages the
// Stop hook does, in the same order, from the same code: the free rules in
// `screen`, the Haiku classifier, then the Haiku tracker with its writes
// traced instead of sent.
//
//   node dist/dryrun.js fixtures/*.json
//   node dist/dryrun.js --session <id>                 archived turns of a session
//   node dist/dryrun.js --prompt "..." --edited src/a.ts --committed
//   node dist/dryrun.js fixtures/new-goal.json --track-prompt /tmp/candidate.md
//
// Reads still reach the server, so the prompt under test sees the real graph;
// a project must therefore be registered and reachable, exactly as in a
// session. Each turn costs what a tracked turn costs, about a third of a cent.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { archiveDir, parseTurnFile, screen, type Turn, type TurnEntry, type TurnRecord } from './autotrack.js';
import { formatRehearsal, takeRehearsal, type Write } from './report.js';
import { classify, describe, promptsDir, record, type TierOptions } from './track.js';

const argv = process.argv.slice(2);
/** Flags that take no value, so the word after them is a file, not an argument. */
const BOOLEAN = new Set(['verbose', 'json', 'committed', 'help']);

const has = (f: string) => argv.includes(`--${f}`);
const opt = (f: string): string | undefined => {
  const i = argv.indexOf(`--${f}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const all = (f: string): string[] => argv.flatMap((a, i) => (a === `--${f}` && argv[i + 1] ? [argv[i + 1]!] : []));
const takesValue = (i: number) => i > 0 && argv[i - 1]!.startsWith('--') && !BOOLEAN.has(argv[i - 1]!.slice(2));
const files = argv.filter((a, i) => !a.startsWith('--') && !takesValue(i));

if (has('help') || (!files.length && !opt('session') && !opt('prompt'))) {
  process.stdout.write(`Rehearse the auto-tracking prompts against a turn; nothing is recorded.

  dry-run <fixture.json|turn.jsonl>...   replay turn records
  dry-run --session <id>                 replay a session's archived turns
                                         (archiving needs LAMPROOM_KEEP_TURNS=1)
  dry-run --prompt "<text>" [--edited <path>]... [--committed]
                                         build one turn from the command line

Options
  --stage screen|classify|track   stop after this stage (default track)
  --classify-prompt <file>        system prompt under test for the classifier
  --track-prompt <file>           system prompt under test for the tracker
  --model <name>                  default ${process.env.LAMPROOM_TRACKER_MODEL ?? 'claude-haiku-5-5'}
  --cwd <dir>                     repository the turn happened in (default .)
  --verbose                       full arguments of every traced call
  --json                          machine-readable report on stdout

Prompts in use: ${promptsDir}
`);
  process.exit(0);
}

const stage = opt('stage') ?? 'track';
if (!['screen', 'classify', 'track'].includes(stage)) {
  process.stderr.write(`unknown stage "${stage}"; expected screen, classify or track\n`);
  process.exit(2);
}
const cwd = path.resolve(opt('cwd') ?? process.cwd());
const tiers: TierOptions = {
  classifyPrompt: opt('classify-prompt'),
  trackPrompt: opt('track-prompt'),
  model: opt('model'),
};
for (const p of [tiers.classifyPrompt, tiers.trackPrompt]) {
  if (p && !fs.existsSync(p)) {
    process.stderr.write(`no such prompt file: ${p}\n`);
    process.exit(2);
  }
}

/** A turn to rehearse: either raw entries to screen, or one already screened. */
type Case = { name: string; record: TurnRecord } | { name: string; turn: Turn };

function load(file: string): Case {
  const name = path.relative(process.cwd(), file);
  if (file.endsWith('.jsonl')) {
    const promptId = path.basename(file).replace(/^turn-/, '').replace(/\.jsonl$/, '');
    return { name, record: { promptId, cwd, reply: '', entries: parseTurnFile(file) } };
  }
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  const promptId = String(raw.promptId ?? path.basename(file).replace(/\.json$/, ''));
  if (Array.isArray(raw.entries)) {
    return { name, record: { promptId, cwd: String(raw.cwd ?? cwd), reply: String(raw.reply ?? ''), entries: raw.entries as TurnEntry[] } };
  }
  // An authored fixture states the activity directly and skips the free rules.
  if (Array.isArray(raw.activity)) {
    return {
      name,
      turn: {
        promptId,
        cwd: String(raw.cwd ?? cwd),
        prompt: String(raw.prompt ?? ''),
        activity: (raw.activity as unknown[]).map(String),
        reply: String(raw.reply ?? ''),
      },
    };
  }
  throw new Error(`${name}: expected "entries" (a captured turn) or "activity" (an authored turn)`);
}

const cases: Case[] = [];
for (const f of files) cases.push(load(f));
if (opt('session')) {
  const dir = archiveDir(opt('session')!);
  if (!fs.existsSync(dir)) {
    process.stderr.write(`no archived turns for session ${opt('session')} (${dir})\nRun the session with LAMPROOM_KEEP_TURNS=1 to archive them.\n`);
    process.exit(2);
  }
  for (const f of fs.readdirSync(dir).sort()) if (f.endsWith('.json')) cases.push(load(path.join(dir, f)));
}
if (opt('prompt')) {
  const activity = [
    ...(all('edited').length ? [`edited ${all('edited').join(', ')}`] : []),
    ...(has('committed') ? ['ran `git commit -m "work"` -> [main 0000000] work'] : []),
  ];
  cases.push({ name: '--prompt', turn: { promptId: 'cli', cwd, prompt: opt('prompt')!, activity, reply: opt('reply') ?? '' } });
}

interface Report {
  name: string;
  promptId: string;
  screened: 'pass' | 'skip';
  screenReason?: string;
  decision?: { decision: string; confidence: number; reason: string; track: boolean };
  reads?: string[];
  writes?: Write[];
  reported?: string;
  newSeams?: number;
  cost: number;
}

const reports: Report[] = [];
const out = (s = '') => process.stdout.write(`${s}\n`);
const sessionId = `dryrun-${process.pid}`;

for (const [i, c] of cases.entries()) {
  const r: Report = { name: c.name, promptId: '', screened: 'pass', cost: 0 };
  let turn: Turn;

  if ('record' in c) {
    r.promptId = c.record.promptId;
    const s = screen(c.record.entries, c.record);
    if (s.verdict === 'skip') {
      r.screened = 'skip';
      r.screenReason = s.reason;
      reports.push(r);
      if (!has('json')) {
        out(`${i + 1}/${cases.length}  ${c.name}  [${r.promptId}]`);
        out(`  1 free rules   SKIP: ${s.reason}`);
        out();
      }
      continue;
    }
    turn = s.turn;
  } else {
    turn = c.turn;
    r.promptId = turn.promptId;
  }

  if (!has('json')) {
    out(`${i + 1}/${cases.length}  ${c.name}  [${r.promptId}]`);
    out(`  the turn`);
    for (const line of describe(turn).split('\n')) out(`    ${line}`);
    out(`  1 free rules   pass${'record' in c ? '' : ' (activity stated directly, so the rules are not exercised)'}`);
  }
  if (stage === 'screen') {
    reports.push(r);
    if (!has('json')) out();
    continue;
  }

  const d = classify(sessionId, turn, tiers);
  r.decision = d;
  r.cost += d.cost ?? 0;
  if (!has('json')) {
    out(`  2 classifier   ${d.decision}  confidence ${d.confidence}  $${(d.cost ?? 0).toFixed(4)}`);
    out(`                 ${d.reason}`);
    if (d.decision === 'skip' && d.track) out(`                 below the confidence floor, so the tracker runs anyway`);
    if (!d.track) out(`                 the tracker would not run`);
  }
  if (stage === 'classify' || !d.track) {
    reports.push(r);
    if (!has('json')) out();
    continue;
  }

  const tracePath = path.join(os.tmpdir(), `lamproom-dryrun-${process.pid}-${i}.jsonl`);
  const rec = record(sessionId, turn, { ...tiers, dryRunTrace: tracePath });
  r.cost += rec.cost ?? 0;
  r.reported = rec.summary;
  const rehearsal = takeRehearsal(tracePath);
  r.reads = rehearsal.reads;
  r.writes = rehearsal.writes;
  r.newSeams = rehearsal.newSeams;

  if (!has('json')) {
    out(`  3 tracker      $${(rec.cost ?? 0).toFixed(4)}${rec.error ? '  (the tracker errored)' : ''}`);
    for (const line of formatRehearsal(rehearsal, { verbose: has('verbose') })) out(line);
    out(`     reported    ${rec.summary ?? 'Nothing recorded.'}`);
    if (r.newSeams) out(`     ! ${r.newSeams} new seam(s) would be created from this turn`);
    out();
  }
  reports.push(r);
}

const total = reports.reduce((s, r) => s + r.cost, 0);
const seams = reports.reduce((s, r) => s + (r.newSeams ?? 0), 0);
if (has('json')) {
  out(JSON.stringify({ turns: reports, totalCostUsd: total, newSeams: seams }, null, 2));
} else {
  const wrote = reports.filter((r) => r.writes?.length).length;
  out(
    `${reports.length} turn(s): ${wrote} would write, ` +
      `${reports.filter((r) => r.screened === 'skip').length} stopped at the rules, ` +
      `${reports.filter((r) => r.decision && !r.decision.track).length} stopped at the classifier. ` +
      `${seams} new seam(s). $${total.toFixed(4)} spent rehearsing.`,
  );
}
