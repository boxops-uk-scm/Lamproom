// A fragment is the composable unit of seam: an open hypergraph, that is
// a cospan  inputs -> inner graph <- outputs. Its boundary is a set of named
// ports typed by artefact kind; its inside is artefacts and actions wired to
// those ports. Fragments compose by gluing an output boundary to an input
// boundary, and a fragment is instantiated into a seam by binding its
// input ports (and optionally its output ports) to existing artefacts.
//
// Policy atoms are fragments (atomFragment); a decomposition is a fragment
// instantiated under an action with the action's own boundary (decomposeWith
// in commands.ts); a seam is a closed composition, which is why it, and
// not the fragment, carries the stream.

import type { Requirement, RichText, Size } from './types.js';

export interface FragmentArtefact {
  kind: string;
  title: string;
  criteria?: RichText[];
}

export interface FragmentAction {
  title: string;
  description?: RichText;
  size?: Size;
  requires?: Requirement;
  /** Port names or inner artefact names. */
  inputs: string[];
  outputs: string[];
}

export interface Fragment {
  /** Input boundary: port names bound to existing artefacts when instantiated. */
  inputs: string[];
  /** Output boundary: names of inner artefacts (or input ports passed through). */
  outputs: string[];
  /** Inner artefacts by local name. */
  artefacts: Record<string, FragmentArtefact>;
  actions: FragmentAction[];
}

export function validateFragment(f: Fragment): string[] {
  const errors: string[] = [];
  const inner = new Set(Object.keys(f.artefacts));
  const ports = new Set(f.inputs);
  for (const p of f.inputs) if (inner.has(p)) errors.push(`input port "${p}" is also an inner artefact`);
  for (const o of f.outputs) {
    if (!inner.has(o) && !ports.has(o)) errors.push(`output port "${o}" names nothing inside the fragment`);
  }
  f.actions.forEach((a, i) => {
    if (!a.title?.trim()) errors.push(`action ${i} has no title`);
    for (const x of a.inputs) if (!inner.has(x) && !ports.has(x)) errors.push(`action "${a.title}" reads unknown "${x}"`);
    for (const x of a.outputs) {
      if (ports.has(x)) errors.push(`action "${a.title}" writes input port "${x}"`);
      else if (!inner.has(x)) errors.push(`action "${a.title}" writes unknown "${x}"`);
    }
  });
  return errors;
}

/**
 * Sequential composition: glue g's input ports onto f's output ports. By
 * default ports glue by name; `glue` maps g input port -> f output port
 * explicitly. Unglued ports of either side stay on the boundary. Inner names
 * of g that clash with f's are prefixed.
 */
export function compose(f: Fragment, g: Fragment, glue?: Record<string, string>): Fragment {
  const map: Record<string, string> = glue ?? Object.fromEntries(g.inputs.filter((p) => f.outputs.includes(p)).map((p) => [p, p]));
  for (const [gi, fo] of Object.entries(map)) {
    if (!g.inputs.includes(gi)) throw new Error(`glue: "${gi}" is not an input port of the second fragment`);
    if (!f.outputs.includes(fo)) throw new Error(`glue: "${fo}" is not an output port of the first fragment`);
  }
  const rename = new Map<string, string>();
  const artefacts: Record<string, FragmentArtefact> = { ...f.artefacts };
  for (const [name, a] of Object.entries(g.artefacts)) {
    let n = name;
    while (n in artefacts || f.inputs.includes(n)) n = `${n}'`;
    rename.set(name, n);
    artefacts[n] = a;
  }
  const r = (x: string) => map[x] ?? rename.get(x) ?? x;
  const glued = new Set(Object.values(map));
  const inputs = [...f.inputs, ...g.inputs.filter((p) => !(p in map))];
  const outputs = [...f.outputs.filter((o) => !glued.has(o)), ...g.outputs.map(r)];
  const actions = [...f.actions, ...g.actions.map((a) => ({ ...a, inputs: a.inputs.map(r), outputs: a.outputs.map(r) }))];
  return { inputs, outputs, artefacts, actions };
}

/**
 * The fragment a policy atom stands for: one input port (the naked artefact),
 * one inner terminal artefact, and the typed action between them.
 */
export function atomFragment(
  atom: { terminal: string; terminalTitle?: string; action: { title: string; description?: RichText; requires: Requirement; size?: Size } },
  fill: (template: string) => string,
): Fragment {
  return {
    inputs: ['naked'],
    outputs: ['terminal'],
    artefacts: { terminal: { kind: atom.terminal, title: fill(atom.terminalTitle ?? '{title}') } },
    actions: [
      {
        title: fill(atom.action.title),
        description: atom.action.description,
        requires: atom.action.requires,
        size: atom.action.size,
        inputs: ['naked'],
        outputs: ['terminal'],
      },
    ],
  };
}
