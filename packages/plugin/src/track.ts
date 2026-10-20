// The two Haiku tiers, run by the Stop hook as headless claude processes: a
// classifier that makes a typed track-or-skip call on a turn, and a tracker
// that records the turn through the Lamproom tools and nothing else.
//
// Both take an override for the system prompt under test, and the tracker
// takes a dry run, so `lamproom dry-run` can rehearse a candidate prompt
// without appending a single event.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHILD_ENV, log, type Turn } from './autotrack.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const promptsDir = path.join(here, '..', 'prompts');
const MODEL = process.env.LAMPROOM_TRACKER_MODEL ?? 'claude-haiku-5-5';
const CLAUDE = process.env.LAMPROOM_CLAUDE_BIN ?? 'claude';
/** A skip below this confidence is tracked anyway; the tracker can still record nothing. */
const SKIP_CONFIDENCE = 0.6;

/** The reporting verbs the tracker may use. Judgement calls stay with the mine skill and with humans. */
const TRACKER_TOOLS = ['status', 'inspect', 'propose', 'claim', 'release', 'progress', 'attach', 'comment', 'complete', 'declare'];

/** Per-call overrides. The prompt paths are what makes a candidate prompt testable. */
export interface TierOptions {
  classifyPrompt?: string;
  trackPrompt?: string;
  /** The tracker's writes are traced to this file instead of being sent. */
  dryRunTrace?: string;
  model?: string;
}

const CLASSIFY_SCHEMA = {
  type: 'object',
  properties: {
    decision: { type: 'string', enum: ['skip', 'track'] },
    confidence: { type: 'number' },
    reason: { type: 'string' },
  },
  required: ['decision', 'confidence', 'reason'],
  additionalProperties: false,
};

interface ClaudeResult {
  result?: string;
  structured_output?: unknown;
  total_cost_usd?: number;
  is_error?: boolean;
}

function claude(args: string[], input: string, cwd: string, model: string, env: Record<string, string> = {}): ClaudeResult {
  const r = spawnSync(
    CLAUDE,
    [
      '-p', '--model', model, '--output-format', 'json', '--no-session-persistence',
      '--settings', JSON.stringify({ disableAllHooks: true }), '--tools', '', '--strict-mcp-config',
      ...args,
    ],
    { input, cwd, encoding: 'utf8', timeout: 2 * 60_000, maxBuffer: 16 << 20, env: { ...process.env, ...env, [CHILD_ENV]: '1' } },
  );
  if (r.error) throw r.error;
  try {
    return JSON.parse(r.stdout) as ClaudeResult;
  } catch {
    throw new Error(`claude exited ${r.status}: ${(r.stderr || r.stdout).slice(0, 400)}`);
  }
}

export const describe = (t: Turn) =>
  [
    `User prompt:\n${t.prompt || '(none)'}`,
    `What the turn did:\n${t.activity.map((a) => `- ${a}`).join('\n')}`,
    `The assistant's final reply:\n${t.reply || '(none)'}`,
  ].join('\n\n');

/** What the classifier decided, and whether that means the tracker runs. */
export interface Decision {
  decision: 'skip' | 'track';
  confidence: number;
  reason: string;
  /** A skip below SKIP_CONFIDENCE is tracked anyway. */
  track: boolean;
  cost?: number;
}

export function classify(sessionId: string, t: Turn, opts: TierOptions = {}): Decision {
  const prompt = opts.classifyPrompt ?? path.join(promptsDir, 'classify.md');
  const r = claude(
    ['--system-prompt', fs.readFileSync(prompt, 'utf8'), '--json-schema', JSON.stringify(CLASSIFY_SCHEMA), '--max-budget-usd', '0.02'],
    describe(t),
    t.cwd,
    opts.model ?? MODEL,
  );
  const d = r.structured_output as { decision: 'skip' | 'track'; confidence: number; reason: string } | undefined;
  if (!d) {
    log(sessionId, `${t.promptId} classifier gave no decision; tracking it`);
    return { decision: 'track', confidence: 0, reason: 'the classifier gave no decision', track: true, cost: r.total_cost_usd };
  }
  log(sessionId, `${t.promptId} classifier ${d.decision} (${d.confidence}) $${r.total_cost_usd?.toFixed(4)}: ${d.reason}`);
  return { ...d, track: d.decision === 'track' || d.confidence < SKIP_CONFIDENCE, cost: r.total_cost_usd };
}

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
}

/** What the tracker reported, if anything. */
export interface Recorded {
  summary?: string;
  cost?: number;
  error?: boolean;
}

/** Record the turn through the Lamproom tools; returns what it reported. */
export function record(sessionId: string, t: Turn, opts: TierOptions = {}): Recorded {
  const env: Record<string, string> = {
    // One tracker identity per chat session, so a later turn can finish what an earlier one claimed.
    LAMPROOM_AGENT: `chat-${sessionId.slice(0, 5)}`,
  };
  if (opts.dryRunTrace) {
    env.LAMPROOM_DRY_RUN = '1';
    env.LAMPROOM_DRY_RUN_LOG = opts.dryRunTrace;
  }
  const mcp = { mcpServers: { lamproom: { command: process.execPath, args: [path.join(here, 'mcp.js')], env } } };
  const prompt = opts.trackPrompt ?? path.join(promptsDir, 'track.md');
  const body = [
    `Repository: ${git(t.cwd, 'remote', 'get-url', 'origin') || 'unknown'}`,
    `Branch: ${git(t.cwd, 'rev-parse', '--abbrev-ref', 'HEAD') || 'unknown'}, head commit ${git(t.cwd, 'rev-parse', 'HEAD') || 'unknown'}`,
    describe(t),
  ].join('\n\n');
  const r = claude(
    [
      '--mcp-config', JSON.stringify(mcp),
      '--allowedTools', ...TRACKER_TOOLS.map((n) => `mcp__lamproom__${n}`),
      '--system-prompt', fs.readFileSync(prompt, 'utf8'),
      '--max-budget-usd', '0.10',
    ],
    body,
    t.cwd,
    opts.model ?? MODEL,
    env,
  );
  const summary = (r.result ?? '').trim();
  log(sessionId, `${t.promptId} tracked $${r.total_cost_usd?.toFixed(4)}${r.is_error ? ' (error)' : ''}: ${summary.replace(/\s+/g, ' ')}`);
  return {
    summary: summary && !/^nothing recorded/i.test(summary) ? summary : undefined,
    cost: r.total_cost_usd,
    error: r.is_error,
  };
}
