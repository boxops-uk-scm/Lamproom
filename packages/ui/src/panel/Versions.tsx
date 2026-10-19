// An artefact's versions as a split button: the main half opens the chosen
// version in a modal, the chevron half picks which one. A ref can be a whole
// document (an answer, a question), so the panel never prints it inline.

import { Button } from '@astryxdesign/core/Button';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { DropdownMenu } from '@astryxdesign/core/DropdownMenu';
import { IconButton } from '@astryxdesign/core/IconButton';
import { LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import type { ArtefactState, Version } from '@lamproom/core';
import { useEffect, useState } from 'react';
import { Icon } from '../graph/nodes';
import { RichTextView } from '../rich/RichTextView';

const who = (v: Version) => (v.by.name ?? v.by.id) + (v.via ? ` via ${v.via.name ?? v.via.id}` : '');
const when = (ts: string) => new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function Versions({ artefact: a }: { artefact: ArtefactState }) {
  // The pick, by seq; none means the latest, so a new version is followed.
  const [seq, setSeq] = useState<number>();
  const [open, setOpen] = useState(false);
  useEffect(() => setSeq(undefined), [a.id]);

  const latest = a.versions[a.versions.length - 1];
  const chosen = a.versions.find((v) => v.seq === seq) ?? latest;
  if (!chosen) {
    return (
      <Text as="p" type="supporting">
        Not produced yet.
      </Text>
    );
  }
  const verdict = (v: Version) => (v.ref === a.acceptedRef ? 'accepted' : v.ref === a.rejectedRef ? 'rejected' : undefined);
  const meta = (v: Version) => [who(v), when(v.ts), verdict(v)].filter(Boolean).join(' · ');
  const number = (v: Version) => a.versions.indexOf(v) + 1;
  const items = [...a.versions].reverse().map((v) => ({
    id: String(v.seq),
    label: `Version ${number(v)}`,
    description: meta(v),
    onClick: () => setSeq(v.seq),
  }));

  return (
    <>
      <div className="lr-versions">
        <div className="lr-split">
          <Button label={`Version ${number(chosen)}`} variant="secondary" size="sm" onClick={() => setOpen(true)} />
          <DropdownMenu
            items={items}
            alignment="end"
            menuWidth={260}
            renderTrigger={(p) => <IconButton {...p} label="Choose a version" variant="secondary" size="sm" icon={<Icon name="down" size={14} />} />}
          />
        </div>
        <Text type="supporting">{meta(chosen)}</Text>
      </div>
      <Dialog isOpen={open} onOpenChange={(o) => !o && setOpen(false)} width={600}>
        <DialogHeader title={`Version ${number(chosen)}`} subtitle={meta(chosen)} />
        <div className="lr-goal-form">
          <LayoutContent>
            <VStack gap={4}>
              <RichTextView value={chosen.ref} />
              {chosen.note && (
                <div>
                  <Text type="label">Note</Text>
                  <RichTextView value={chosen.note} className="lr-rich-muted" />
                </div>
              )}
            </VStack>
          </LayoutContent>
          <LayoutFooter>
            <div className="lr-goal-actions">
              <Button label="Close" variant="secondary" onClick={() => setOpen(false)} />
            </div>
          </LayoutFooter>
        </div>
      </Dialog>
    </>
  );
}
