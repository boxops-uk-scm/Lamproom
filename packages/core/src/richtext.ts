// Rich text is Markdown. These helpers flatten it where a terminal, a title
// attribute or a one-line summary needs plain text, and split it into items
// where a list of criteria or reasons is edited as one document.

import type { RichText } from './types.js';

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

/** Markdown flattened to plain text: markers gone, structure kept as line breaks. */
export function plainText(md: RichText | undefined | null): string {
  if (!md) return '';
  let s = md.replace(/\r\n?/g, '\n');
  // Fenced code keeps its content and loses the fences.
  s = s.replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n[ \t]*\1[ \t]*$/gm, '$2');
  // Images and links keep their text; autolinks keep the address.
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  s = s.replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1');
  s = s.replace(/<((?:https?|mailto):[^>]+)>/g, '$1');
  s = s.replace(/<\/?[a-zA-Z][^>]*>/g, '');
  const lines: string[] = [];
  for (const line of s.split('\n')) {
    let l = line;
    // Rules and table separator rows carry no text at all.
    if (/^[ \t]*([-*_])([ \t]*\1){2,}[ \t]*$/.test(l)) continue;
    if (/^\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/.test(l)) continue;
    l = l.replace(/^[ \t]{0,3}#{1,6}[ \t]+/, '').replace(/[ \t]+#+[ \t]*$/, '');
    l = l.replace(/^([ \t]*>[ \t]?)+/, '');
    l = l.replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/, '');
    if (l.includes('|')) l = l.replace(/^[ \t]*\||\|[ \t]*$/g, '').replace(/[ \t]*\|[ \t]*/g, ' · ');
    lines.push(l);
  }
  s = lines.join('\n');
  s = s.replace(/`([^`\n]+)`/g, '$1');
  s = s.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2');
  s = s.replace(/(^|[^*\w])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, '$1$2');
  s = s.replace(/(^|[^_\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, '$1$2');
  s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1');
  s = s.replace(/==(?=\S)([\s\S]*?\S)==/g, '$1');
  s = s.replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, '$1');
  return s
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Plain text on one line, lines separated by a middle dot. For listings and tooltips. */
export function inlineText(md: RichText | undefined | null, max?: number): string {
  const one = plainText(md).replace(/\s*\n+\s*/g, ' · ');
  return max ? clip(one, max) : one;
}

/** The first line of the plain text, for a one-line summary; empty when blank. */
export function summary(md: RichText | undefined | null, max = 120): string {
  const first = plainText(md).split('\n').find(Boolean) ?? '';
  return clip(first, max);
}

export function isBlank(md: RichText | undefined | null): boolean {
  return plainText(md) === '';
}

/**
 * One document read as a list: each top-level list item or paragraph is an
 * item, kept as Markdown. A list of criteria or reasons entered in one editor
 * comes apart here and goes back together with `joinRichText`.
 */
export function richTextItems(md: RichText | undefined | null): RichText[] {
  if (!md) return [];
  const items: string[] = [];
  let cur: string[] = [];
  let inFence = false;
  const flush = () => {
    const t = cur.join('\n').trim();
    if (t) items.push(t);
    cur = [];
  };
  for (const line of md.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^[ \t]*(`{3,}|~{3,})/.test(line)) {
      inFence = !inFence;
      cur.push(line);
      continue;
    }
    if (inFence) {
      cur.push(line);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    // An indented line continues the item above it; nested lists come along.
    if (/^[ \t]{2,}/.test(line) && cur.length) {
      cur.push(line.trim());
      continue;
    }
    const item = /^[ \t]?(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?(.*)$/.exec(line);
    if (item) {
      flush();
      cur.push(item[1]!);
      continue;
    }
    cur.push(line);
  }
  flush();
  return items;
}

/** Items back into one document: a single item as it is, several as a bullet list. */
export function joinRichText(items: readonly RichText[] | undefined | null): RichText | undefined {
  const list = (items ?? []).map((i) => i.trim()).filter(Boolean);
  if (!list.length) return undefined;
  if (list.length === 1) return list[0];
  return list
    .map((i) =>
      i
        .split('\n')
        .map((l, n) => (n === 0 ? `- ${l}` : `  ${l}`))
        .join('\n'),
    )
    .join('\n');
}
