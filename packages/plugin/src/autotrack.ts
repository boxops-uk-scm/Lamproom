// Shared by the auto-tracking hooks. After every turn of an ordinary chat
// session, the turn's activity is checked by cheap rules, then by a Haiku
// classifier, and only then handed to a Haiku tracker that reports it
// through the Lamproom tools. Turn records, feedback and the log live under
// the plugin data directory, one folder per session.

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Set on the tracker's own claude process so its hooks never recurse. */
export const CHILD_ENV = 'LAMPROOM_TRACKER';

/** True when auto-tracking must not run in this process. */
export function disabled(): boolean {
  return process.env[CHILD_ENV] === '1' || process.env.LAMPROOM_AUTOTRACK === '0';
}

export function dataDir(): string {
  return process.env.CLAUDE_PLUGIN_DATA ?? path.join(os.homedir(), '.lamproom', 'plugin-data');
}

const safe = (id: string) => id.replace(/[^\w-]/g, '_');

export function sessionDir(sessionId: string): string {
  const dir = path.join(dataDir(), 'sessions', safe(sessionId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export const turnFile = (sessionId: string, promptId: string) => path.join(sessionDir(sessionId), `turn-${safe(promptId)}.jsonl`);
export const feedbackFile = (sessionId: string) => path.join(sessionDir(sessionId), 'feedback.md');
export const logFile = (sessionId: string) => path.join(sessionDir(sessionId), 'tracker.log');

export function log(sessionId: string, line: string): void {
  fs.appendFileSync(logFile(sessionId), `${new Date().toISOString()} ${line}\n`);
}

export function clip(s: unknown, n: number): string {
  const t = typeof s === 'string' ? s : JSON.stringify(s ?? '');
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** One line of a turn record: the prompt, or one tool call. */
export type TurnEntry =
  | { kind: 'prompt'; text: string }
  | { kind: 'tool'; tool: string; input: string; output: string; lamproom: boolean };

/** A turn that passed the rules, as the classifier and tracker see it. */
export interface Turn {
  promptId: string;
  cwd: string;
  prompt: string;
  activity: string[];
  reply: string;
}

export async function readStdin(): Promise<Record<string, unknown>> {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  try {
    return JSON.parse(input) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const GIT_WRITE = /\bgit\b[^|;&\n]*\b(commit|push|merge|cherry-pick|rebase|tag|revert)\b/;
const GH_WRITE = /\bgh\s+pr\s+(create|merge|close|ready|edit|reopen)\b/;

/** Whether a shell command changes history or pull requests, not just the tree. */
export const isRecordableCommand = (cmd: string) => GIT_WRITE.test(cmd) || GH_WRITE.test(cmd);

/** Lamproom tools however the server is named: mcp__lamproom__x or mcp__plugin_lamproom_tracker__x. */
export const isLamproomTool = (name: string, server?: string) =>
  /^mcp__.*lamproom.*__/.test(name) || /lamproom/.test(server ?? '');

/** The free rules' verdict on a turn: dropped here, or worth a classifier call. */
export type Screened = { verdict: 'skip'; reason: string } | { verdict: 'consider'; turn: Turn };

/**
 * The free rules, and the turn as the two Haiku tiers will see it. The Stop
 * hook and the dry run share this so a rehearsal cannot drift from the real
 * thing.
 */
export function screen(entries: TurnEntry[], about: { promptId: string; cwd: string; reply: string }): Screened {
  const tools = entries.filter((e): e is Extract<TurnEntry, { kind: 'tool' }> => e.kind === 'tool');
  const prompt = entries.find((e) => e.kind === 'prompt')?.text ?? '';
  if (tools.some((t) => t.lamproom)) return { verdict: 'skip', reason: 'the turn reported through Lamproom itself' };

  const recordable = tools.filter((t) => EDIT_TOOLS.has(t.tool) || (t.tool === 'Bash' && isRecordableCommand(t.input)));
  if (!recordable.length) return { verdict: 'skip', reason: 'no edits, commits or pull-request changes' };

  const relative = (p: string) => (p.startsWith(about.cwd + path.sep) ? path.relative(about.cwd, p) : p);
  const edited = [...new Set(recordable.filter((t) => EDIT_TOOLS.has(t.tool)).map((t) => relative(t.input)))];
  const activity = [
    ...(edited.length ? [`edited ${edited.join(', ')}`] : []),
    ...recordable.filter((t) => t.tool === 'Bash').map((t) => `ran \`${t.input}\`${t.output ? ` -> ${t.output}` : ''}`),
  ];
  return { verdict: 'consider', turn: { promptId: about.promptId, cwd: about.cwd, prompt, activity, reply: about.reply } };
}

export const readJsonl = <T>(file: string): T[] =>
  fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as T);

export const parseTurnFile = (file: string): TurnEntry[] => readJsonl<TurnEntry>(file);

/** A turn as the Stop hook received it: everything a dry run needs to replay it. */
export interface TurnRecord {
  promptId: string;
  cwd: string;
  reply: string;
  entries: TurnEntry[];
}

export const archiveDir = (sessionId: string) => path.join(sessionDir(sessionId), 'turns');

// --- Tracking mode ----------------------------------------------------------
// Dry run is switched on from a live session and has to be seen by the Stop
// hook, a separate process. It is keyed by repository, not by session: the
// hook knows the turn's cwd and the MCP tools know their own, so the two
// agree without either needing a session id. Two sessions in one checkout
// therefore share the setting.

/** How this repository's chat work is being tracked. */
export interface Mode {
  dryRun: boolean;
  /** When it was switched on, ISO. */
  since?: string;
  /** Who switched it on, for the record. */
  by?: string;
  /** Turns left to rehearse before it reverts on its own; absent means until switched off. */
  turnsLeft?: number;
  /** Turns rehearsed so far. */
  rehearsed?: number;
}

const LIVE: Mode = { dryRun: false };

/**
 * The checkout a path belongs to. Claude Code gives an MCP server no session
 * id and no project directory, so the repository root is what the tools and
 * the hooks can both name: it is the same from any subdirectory of it.
 */
export function repoRoot(cwd: string): string {
  const r = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : path.resolve(cwd);
}

const modeFile = (cwd: string) => {
  const root = repoRoot(cwd);
  const key = crypto.createHash('sha1').update(root).digest('hex').slice(0, 12);
  return path.join(dataDir(), 'modes', `${path.basename(root)}-${key}.json`);
};

/** Where this repository's rehearsed calls are traced, for the curious. */
export const modeTrace = (cwd: string) => modeFile(cwd).replace(/\.json$/, '.trace.jsonl');

export function readMode(cwd: string): Mode {
  try {
    return { ...LIVE, ...(JSON.parse(fs.readFileSync(modeFile(cwd), 'utf8')) as Mode) };
  } catch {
    return { ...LIVE };
  }
}

export function writeMode(cwd: string, m: Mode): Mode {
  const f = modeFile(cwd);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  if (!m.dryRun) {
    fs.rmSync(f, { force: true });
    return { ...LIVE };
  }
  fs.writeFileSync(f, `${JSON.stringify(m, null, 2)}\n`);
  return m;
}

/** One sentence on the mode, for a hook notice or a tool's answer. */
export function describeMode(m: Mode): string {
  if (!m.dryRun) return 'Lamproom is recording this chat normally.';
  const budget = m.turnsLeft === undefined ? 'until you switch it off' : `for ${m.turnsLeft} more turn(s)`;
  return `Lamproom is in DRY RUN ${budget}: turns are rehearsed and nothing is recorded.`;
}

/**
 * Keep a turn for later rehearsal. Off by default: the hook consumes each
 * record, and these hold prompts and shell output, so they are only written
 * when LAMPROOM_KEEP_TURNS=1.
 */
export function archiveTurn(sessionId: string, r: TurnRecord): string | undefined {
  if (process.env.LAMPROOM_KEEP_TURNS !== '1') return undefined;
  const dir = archiveDir(sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${safe(r.promptId)}.json`);
  fs.writeFileSync(out, `${JSON.stringify(r, null, 2)}\n`);
  return out;
}
