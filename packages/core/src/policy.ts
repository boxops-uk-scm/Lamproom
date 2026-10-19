import type { Policy } from './types.js';

export const DEFAULT_POLICY: Policy = {
  atoms: {
    'pull-request': {
      terminal: 'reviewed-pull-request',
      terminalTitle: '{title} (reviewed)',
      relay: false,
      action: {
        title: 'Review: {title}',
        description: 'Human review of the pull request against its acceptance criteria.',
        requires: { actorKind: 'human', count: 1 },
        size: 'S',
      },
    },
    question: {
      terminal: 'answer',
      terminalTitle: 'Answer: {title}',
      relay: true,
      action: {
        title: 'Answer: {title}',
        description: 'A human answers the question so the blocked action can continue.',
        requires: { actorKind: 'human', count: 1 },
        size: 'XS',
      },
    },
  },
};

/** Kinds that get a richer rendering in the UI. Anything else is free text. */
export const KNOWN_KINDS = [
  'goal',
  'pull-request',
  'reviewed-pull-request',
  'question',
  'answer',
  'document',
  'decision',
  'plan',
] as const;

/** Fill gaps in a loaded policy from the defaults, so older files keep working. */
export function mergePolicy(p: Policy): Policy {
  const atoms: Policy['atoms'] = { ...p.atoms };
  for (const [kind, atom] of Object.entries(DEFAULT_POLICY.atoms)) {
    if (atoms[kind]) atoms[kind] = { ...atom, ...atoms[kind] };
  }
  return { ...p, atoms };
}

export function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? `{${k}}`);
}

/**
 * Verify the kind-expansion relation is well-founded: no atom's terminal
 * kind may (transitively) expand back into the kind that produced it.
 */
export function validatePolicy(policy: Policy): string[] {
  const errors: string[] = [];
  for (const kind of Object.keys(policy.atoms)) {
    const seen = new Set<string>([kind]);
    let cur: string | undefined = policy.atoms[kind]!.terminal;
    while (cur && policy.atoms[cur]) {
      if (seen.has(cur)) {
        errors.push(`atom cycle: ${[...seen, cur].join(' -> ')}`);
        break;
      }
      seen.add(cur);
      cur = policy.atoms[cur]!.terminal;
    }
  }
  return errors;
}
