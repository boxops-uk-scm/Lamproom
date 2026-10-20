// Reading back a rehearsal. The dry-run MCP server traces every call it was
// asked to make; this turns that trace into the report, so the fixture dry run
// and a live dry-run turn describe themselves the same way.

import fs from 'node:fs';
import { clip, readJsonl } from './autotrack.js';

/** One call the agent made under a dry run, as mcp.ts traced it. */
export interface TraceLine {
  at?: string;
  kind: 'read' | 'write' | 'refused';
  tool: string;
  args?: Record<string, unknown>;
  note?: string;
}

/** Which structural move a propose makes, per the propose tool's own contract. */
export function proposeKind(args: Record<string, unknown>): 'a new seam' | 'a decomposition' | 'a follow-up' {
  if (args.parent) return 'a decomposition';
  const actions = (args.actions as { inputs?: string[] }[]) ?? [];
  return actions.some((a) => a.inputs?.length) ? 'a follow-up' : 'a new seam';
}

export interface Write {
  tool: string;
  args: Record<string, unknown>;
  /** Set for propose, where the shape of the call decides what it would create. */
  kind?: string;
}

export interface Rehearsal {
  reads: string[];
  writes: Write[];
  /** Writes that would have started a new seam: the one outcome worth a human's eye. */
  newSeams: number;
}

export function rehearsalOf(lines: TraceLine[]): Rehearsal {
  const reads = lines.filter((l) => l.kind === 'read').map((l) => (l.args ? `${l.tool} ${clip(JSON.stringify(l.args), 80)}` : l.tool));
  const writes: Write[] = lines
    .filter((l) => l.kind === 'write')
    .map((l) => ({ tool: l.tool, args: l.args ?? {}, kind: l.tool === 'propose' ? proposeKind(l.args ?? {}) : undefined }));
  return { reads, writes, newSeams: writes.filter((w) => w.kind === 'a new seam').length };
}

/** Read a trace file and delete it; an absent file means the agent called nothing. */
export function takeRehearsal(file: string): Rehearsal {
  const lines = fs.existsSync(file) ? readJsonl<TraceLine>(file) : [];
  fs.rmSync(file, { force: true });
  return rehearsalOf(lines);
}

/** The arguments of one call, on one line unless verbose. */
export const callArgs = (args: unknown, verbose = false, indent = '') =>
  verbose ? JSON.stringify(args ?? {}, null, 2).split('\n').join(`\n${indent}`) : clip(JSON.stringify(args ?? {}), 160);

/** The indented block the dry-run report prints under a turn. */
export function formatRehearsal(r: Rehearsal, opts: { verbose?: boolean; indent?: string } = {}): string[] {
  const pad = opts.indent ?? '     ';
  const out: string[] = [];
  if (r.reads.length) out.push(`${pad}reads       ${r.reads.join(`\n${pad}            `)}`);
  if (!r.writes.length) {
    out.push(`${pad}would write nothing`);
    return out;
  }
  out.push(`${pad}would write`);
  for (const w of r.writes) {
    out.push(`${pad}  ${w.tool}${w.kind ? ` (${w.kind})` : ''}  ${callArgs(w.args, opts.verbose, `${pad}  `)}`);
  }
  return out;
}

/** A compact account for a terminal notice, where there is no room for arguments. */
export function briefRehearsal(r: Rehearsal): string {
  if (!r.writes.length) return 'would record nothing';
  const calls = r.writes.map((w) => {
    const target = w.args.actionId ?? w.args.artefactId ?? w.args.id;
    if (w.tool === 'propose') {
      const titles = ((w.args.actions as { title?: string }[]) ?? []).map((a) => `"${a.title ?? '?'}"`).join(', ');
      return `propose ${w.kind} ${titles}`;
    }
    return target ? `${w.tool} ${String(target)}` : w.tool;
  });
  return `would ${calls.join('; ')}`;
}
