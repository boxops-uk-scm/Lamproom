// The RichText primitive on screen: Markdown rendered by Astryx. Block for
// descriptions, questions and rationale; inline for list items and log notes.

import { Markdown } from '@astryxdesign/core/Markdown';
import type { RichText } from '@coalface/core';
import { cx } from '../graph/nodes';

/** Links leave the app in a new tab rather than navigating the tracker away. */
function openLink(href: string, event: { preventDefault(): void }): false {
  event.preventDefault();
  window.open(href, '_blank', 'noopener');
  return false;
}

export function RichTextView({ value, inline = false, className }: { value: RichText | undefined | null; inline?: boolean; className?: string }) {
  if (!value?.trim()) return null;
  if (inline) {
    return (
      <Markdown display="inline" autolink="gfm" onLinkClick={openLink}>
        {value}
      </Markdown>
    );
  }
  return (
    <div className={cx('cf-rich', className)}>
      <Markdown density="compact" headingLevelStart={4} contentWidth="100%" autolink="gfm" onLinkClick={openLink}>
        {value}
      </Markdown>
    </div>
  );
}
