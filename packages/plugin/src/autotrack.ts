// Shared by the auto-tracking hooks. After every turn of an ordinary chat
// session, the turn's activity is checked by cheap rules, then by a Haiku
// classifier, and only then handed to a Haiku tracker that reports it
// through the Lamproom tools. Turn records, feedback and the log live under
// the plugin data directory, one folder per session.

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
