import { describe, expect, it } from 'vitest';
import { inlineText, isBlank, joinRichText, plainText, richTextItems, summary } from '../src/richtext.js';

const doc = `# Login flow

Users sign in with a **magic link** sent by email; see [the RFC](https://example.com/rfc) and \`auth.ts\`.

- existing *password* login still works
- links expire after ~~an hour~~ 15 minutes
  - configurable per tenant

> No new dependencies.

\`\`\`ts
const ttl = 15;
\`\`\`

| col | val |
| --- | --- |
| a | 1 |
`;

describe('rich text', () => {
  it('flattens markdown to plain text', () => {
    expect(plainText(doc)).toBe(
      [
        'Login flow',
        '',
        'Users sign in with a magic link sent by email; see the RFC and auth.ts.',
        '',
        'existing password login still works',
        'links expire after an hour 15 minutes',
        'configurable per tenant',
        '',
        'No new dependencies.',
        '',
        'const ttl = 15;',
        '',
        'col · val',
        'a · 1',
      ].join('\n'),
    );
  });

  it('summarises and inlines', () => {
    expect(summary(doc)).toBe('Login flow');
    expect(summary('**bold** start of a long line that keeps going and going', 20)).toBe('bold start of a lon…');
    expect(inlineText('one\n\ntwo')).toBe('one · two');
    expect(isBlank('  \n\n')).toBe(true);
    expect(isBlank('- ')).toBe(true);
    expect(isBlank('x')).toBe(false);
  });

  it('splits a document into items and joins them back', () => {
    expect(richTextItems('- a\n- **b**\n  - nested\n\nparagraph one\nstill one\n\n1. c\n- [ ] d')).toEqual([
      'a',
      '**b**\n- nested',
      'paragraph one\nstill one',
      'c',
      'd',
    ]);
    expect(richTextItems('```\n- not an item\n```')).toEqual(['```\n- not an item\n```']);
    expect(joinRichText(['only'])).toBe('only');
    expect(joinRichText(['a', 'b\nmore'])).toBe('- a\n- b\n  more');
    expect(joinRichText([])).toBeUndefined();
    expect(richTextItems(joinRichText(['a', 'b\nmore']))).toEqual(['a', 'b\nmore']);
  });
});
