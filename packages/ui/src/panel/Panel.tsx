import { isBlank, richTextItems, type ActionState, type Actor, type ArtefactState, type LogEntry, type State } from '@coalface/core';
import { BreadcrumbItem, Breadcrumbs } from '@astryxdesign/core/Breadcrumbs';
import { Button } from '@astryxdesign/core/Button';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { HStack } from '@astryxdesign/core/HStack';
import { Heading } from '@astryxdesign/core/Heading';
import { StackItem } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Token } from '@astryxdesign/core/Token';
import { useState, type ReactNode } from 'react';
import { ARTEFACT_HUE, ARTEFACT_LABEL, Icon, STATUS_LABEL, StatusToken, actionHue, cx, kindIcon } from '../graph/nodes';
import { RichTextEditor } from '../rich/RichTextEditor';
import { RichTextView } from '../rich/RichTextView';
import { Versions } from './Versions';

export type Run = (command: string, args: Record<string, unknown>) => Promise<void>;

interface Props {
  state: State;
  selected?: string;
  human?: Actor;
  live: boolean;
  onSelect: (id: string | undefined) => void;
  run: Run;
}

export function Panel({ state, selected: rawSelected, human, live, onSelect, run }: Props) {
  const selected = rawSelected?.startsWith('wf:') ? rawSelected.slice(3) : rawSelected;
  if (!selected) {
    return (
      <aside className="cf-panel cf-panel-empty">
        <EmptyState isCompact title="Nothing selected" description="Select an action or artefact to see its detail." />
      </aside>
    );
  }
  const t = state.actions[selected];
  if (t) return <ActionPanel state={state} action={t} human={human} live={live} onSelect={onSelect} run={run} />;
  const a = state.artefacts[selected];
  if (a) return <ArtefactPanel state={state} artefact={a} human={human} live={live} onSelect={onSelect} run={run} />;
  return (
    <aside className="cf-panel cf-panel-empty">
      <EmptyState isCompact title="Not yet" description="Nothing here at this point in history." />
    </aside>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="cf-section">
      <div className="cf-section-title">
        <Heading level={5} color="secondary">
          {title}
        </Heading>
      </div>
      {children}
    </section>
  );
}

function Sub({ children }: { children: ReactNode }) {
  return (
    <div className="cf-sub">
      <Text type="label" color="secondary">
        {children}
      </Text>
    </div>
  );
}

function Ref({ id, state, onSelect }: { id: string; state: State; onSelect: (id: string) => void }) {
  const a = state.artefacts[id];
  const t = state.actions[id];
  if (a) {
    return (
      <span className={cx('cf-ref', `as-${a.status}`)}>
        <Token
          size="sm"
          color={ARTEFACT_HUE[a.status]}
          label={a.title}
          description={ARTEFACT_LABEL[a.status]}
          icon={<Icon name={kindIcon(a.kind)} size={12} />}
          endContent={<span className="cf-adot" />}
          onClick={() => onSelect(id)}
        />
      </span>
    );
  }
  if (t) {
    return (
      <span className={cx('cf-ref', `st-${t.status}`, t.requires?.actorKind === 'human' && 'is-human')}>
        <Token
          size="sm"
          color={actionHue(t)}
          label={t.title}
          description={STATUS_LABEL[t.status]}
          icon={<span className="cf-dot" />}
          onClick={() => onSelect(id)}
        />
      </span>
    );
  }
  return <Text type="code">{id}</Text>;
}

function Criteria({ items, tone }: { items: string[]; tone?: 'unknown' }) {
  return (
    <ul className={cx('cf-criteria', tone === 'unknown' && 'is-unknown')}>
      {items.map((c, i) => (
        <li key={i}>
          <Text>
            <RichTextView value={c} inline />
          </Text>
        </li>
      ))}
    </ul>
  );
}

function History({ log }: { log: LogEntry[] }) {
  if (!log.length) {
    return (
      <Text as="p" type="supporting">
        No activity yet.
      </Text>
    );
  }
  return (
    <ol className="cf-log">
      {[...log].reverse().map((l) => (
        <li key={l.seq}>
          <span className="cf-log-type">{l.type.replace('action.', '')}</span>
          <span className="cf-log-actor">
            {l.actor.name ?? l.actor.id}
            {l.via ? ` via ${l.via.name ?? l.via.id}` : ''}
          </span>
          {l.note && (
            <span className="cf-log-note">
              <RichTextView value={l.note} inline />
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}

function Breadcrumb({ state, action, onSelect }: { state: State; action: ActionState; onSelect: (id: string) => void }) {
  const chain: ActionState[] = [];
  let cur = action.parent ? state.actions[action.parent] : undefined;
  while (cur) {
    chain.unshift(cur);
    cur = cur.parent ? state.actions[cur.parent] : undefined;
  }
  if (!chain.length) return null;
  return (
    <div className="cf-crumbs">
      <Breadcrumbs variant="supporting" label="Parent actions">
        {chain.map((c) => (
          <BreadcrumbItem key={c.id} isCurrent={false} onClick={() => onSelect(c.id)}>
            {c.title}
          </BreadcrumbItem>
        ))}
      </Breadcrumbs>
    </div>
  );
}

function ActionPanel({ state, action: t, human, live, onSelect, run }: { state: State; action: ActionState } & Omit<Props, 'selected'>) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const isHumanAction = t.requires?.actorKind === 'human';
  const naked = t.inputs.map((i) => state.artefacts[i]).find((a) => a && a.closedTo && t.outputs.includes(a.closedTo));
  const isReview = isHumanAction && naked && naked.kind !== 'question';
  const isAnswer = isHumanAction && naked && naked.kind === 'question';
  const canAct = !!(live && human);
  const canAnswer = canAct && !busy && !isBlank(text) && t.status === 'ready';

  const act = async (command: string, args: Record<string, unknown>) => {
    setBusy(true);
    try {
      await run(command, args);
      setText('');
    } finally {
      setBusy(false);
    }
  };

  const outputsNeedingVersion = t.outputs.map((o) => state.artefacts[o]).filter((a): a is ArtefactState => !!a && !a.versions.length);

  return (
    <aside className="cf-panel">
      <header className={cx('cf-panel-head', `st-${t.status}`, isHumanAction && 'is-human')}>
        <Breadcrumb state={state} action={t} onSelect={onSelect} />
        <HStack gap={1.5} wrap="wrap" align="center">
          <StatusToken label={STATUS_LABEL[t.status]} hue={actionHue(t)} />
          {t.size && <Token size="sm" color="gray" label={t.size} description="Size" />}
          {isHumanAction && <Token size="sm" color="pink" label="human" icon={<Icon name="person" size={12} />} />}
          <span className="cf-spacer" />
          <Text type="code" size="sm" color="secondary">
            {t.id}
          </Text>
        </HStack>
        <Heading level={3}>{t.title}</Heading>
        <RichTextView value={t.description} className="cf-rich-muted" />
        {t.claimedBy && (
          <Text as="p" type="supporting">
            Held by {t.claimedBy.name ?? t.claimedBy.id}
            {t.claimedBy.principal ? ` for ${t.claimedBy.principal}` : ''}
          </Text>
        )}
      </header>

      {isReview && naked && (
        <Section title="Review">
          <Text as="p">
            Review <Ref id={naked.id} state={state} onSelect={onSelect} /> against its criteria.
          </Text>
          {naked.criteria?.length ? <Criteria items={naked.criteria} /> : null}
          <Versions artefact={naked} />
          <RichTextEditor
            label="Review notes"
            isLabelHidden
            value={text}
            onChange={setText}
            rows={3}
            isDisabled={!canAct || busy}
            width="100%"
          />
          <HStack gap={2} wrap="wrap">
            <Button
              label="Accept"
              variant="primary"
              size="sm"
              isDisabled={!canAct || busy || t.status !== 'ready'}
              clickAction={() => act('review', { artefactId: naked.id, verdict: 'accept', notes: items(text) })}
            />
            <Button
              label="Reject"
              variant="destructive"
              size="sm"
              isDisabled={!canAct || busy || t.status !== 'ready' || isBlank(text)}
              clickAction={() => act('review', { artefactId: naked.id, verdict: 'reject', notes: items(text) })}
            />
          </HStack>
        </Section>
      )}

      {isAnswer && naked && (
        <Section title="Question">
          <div className="cf-question">
            <RichTextView value={naked.versions.length ? naked.versions[naked.versions.length - 1]!.ref : naked.title} />
          </div>
          <RichTextEditor
            label="Your answer"
            isLabelHidden
            value={text}
            onChange={setText}
            rows={4}
            isDisabled={!canAct || busy}
            onSubmit={canAnswer ? () => act('answer', { questionId: naked.id, text }) : undefined}
            width="100%"
          />
          <HStack gap={2}>
            <Button
              label="Answer"
              variant="primary"
              size="sm"
              isDisabled={!canAnswer}
              clickAction={() => act('answer', { questionId: naked.id, text })}
            />
          </HStack>
        </Section>
      )}

      {t.evaluation && (
        <Section title="Evaluation">
          <Text as="p">
            <Text weight="semibold">{t.evaluation.judgement}</Text>
            {t.evaluation.size ? ` · ${t.evaluation.size}` : ''}
          </Text>
          <RichTextView value={t.evaluation.rationale} />
          {t.evaluation.criteria?.length ? (
            <>
              <Sub>Acceptance criteria</Sub>
              <Criteria items={t.evaluation.criteria} />
            </>
          ) : null}
          {t.evaluation.unknowns?.length ? (
            <>
              <Sub>Unknowns</Sub>
              <Criteria items={t.evaluation.unknowns} tone="unknown" />
            </>
          ) : null}
        </Section>
      )}

      {(t.inputs.length > 0 || t.outputs.length > 0) && (
        <Section title="Interface">
          {t.inputs.length > 0 && (
            <>
              <Sub>Inputs</Sub>
              <div className="cf-refs">
                {t.inputs.map((i) => (
                  <Ref key={i} id={i} state={state} onSelect={onSelect} />
                ))}
              </div>
            </>
          )}
          {t.outputs.length > 0 && (
            <>
              <Sub>Outputs</Sub>
              <div className="cf-refs">
                {t.outputs.map((o) => (
                  <Ref key={o} id={o} state={state} onSelect={onSelect} />
                ))}
              </div>
            </>
          )}
        </Section>
      )}

      {t.children.length > 0 && (
        <Section title={`Children (${t.children.filter((c) => state.actions[c]?.status === 'done').length}/${t.children.length} done)`}>
          <div className="cf-refs is-col">
            {t.children.map((c) => (
              <Ref key={c} id={c} state={state} onSelect={onSelect} />
            ))}
          </div>
        </Section>
      )}

      {!isHumanAction && canAct && t.status !== 'done' && t.status !== 'abandoned' && !t.children.length && (
        <Section title="Take over">
          <Text as="p" type="supporting">
            Humans take precedence. Claim this to work it yourself, or complete and abandon on an agent's behalf.
          </Text>
          {outputsNeedingVersion.length > 0 && t.claimedBy?.id === human?.id && (
            <HStack gap={2} align="end">
              <StackItem size="fill">
                <TextInput
                  label="Version ref for the outputs"
                  size="sm"
                  value={text}
                  onChange={setText}
                  isDisabled={busy}
                  width="100%"
                />
              </StackItem>
              <Button
                label="Attach"
                size="sm"
                isDisabled={busy || !text.trim()}
                clickAction={async () => {
                  for (const a of outputsNeedingVersion) await run('attach', { artefactId: a.id, ref: text });
                  setText('');
                }}
              />
            </HStack>
          )}
          <HStack gap={2} wrap="wrap">
            {t.claimedBy?.id !== human?.id ? (
              <Button label="Claim" size="sm" isDisabled={busy} clickAction={() => act('claim', { actionId: t.id })} />
            ) : (
              <Button label="Release" size="sm" isDisabled={busy} clickAction={() => act('release', { actionId: t.id })} />
            )}
            <Button
              label="Complete"
              size="sm"
              isDisabled={busy || t.status === 'submitted'}
              clickAction={() => act('complete', { actionId: t.id })}
            />
            <Button
              label="Abandon"
              variant="destructive"
              size="sm"
              isDisabled={busy}
              clickAction={() => act('abandon', { actionId: t.id, reason: text || undefined })}
            />
          </HStack>
        </Section>
      )}

      {canAct && t.status === 'abandoned' && (
        <Section title="Abandoned">
          {t.abandoned && t.abandoned !== 'abandoned' ? <RichTextView value={t.abandoned} className="cf-rich-muted" /> : null}
          <HStack gap={2}>
            <Button label="Restore" variant="secondary" size="sm" isDisabled={busy} clickAction={() => act('restore', { actionId: t.id })} />
          </HStack>
        </Section>
      )}

      {canAct && !isHumanAction && t.completed && !t.children.length && (
        <Section title="Finished">
          <Text as="p" type="supporting">
            Reopen it if more work turned out to be needed. Its outputs keep their versions.
          </Text>
          <HStack gap={2}>
            <Button label="Reopen" variant="secondary" size="sm" isDisabled={busy} clickAction={() => act('reopen', { actionId: t.id })} />
          </HStack>
        </Section>
      )}

      <Section title="History">
        <History log={t.log} />
      </Section>
    </aside>
  );
}

function ArtefactPanel({ state, artefact: a, human, live, onSelect, run }: { state: State; artefact: ArtefactState } & Omit<Props, 'selected'>) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const producers = Object.values(state.actions).filter((t) => t.outputs.includes(a.id));
  const consumers = Object.values(state.actions).filter((t) => t.inputs.includes(a.id));
  const terminal = a.closedTo ? state.artefacts[a.closedTo] : undefined;
  const canReview = !!(live && human && a.versions.length > 0 && !a.closedTo && a.status === 'produced');

  const act = async (command: string, args: Record<string, unknown>) => {
    setBusy(true);
    try {
      await run(command, args);
      setText('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="cf-panel">
      <header className={cx('cf-panel-head', `as-${a.status}`)}>
        <HStack gap={1.5} wrap="wrap" align="center">
          <Token
            size="sm"
            color={ARTEFACT_HUE[a.status]}
            label={ARTEFACT_LABEL[a.status]}
            icon={<span className="cf-adot" />}
          />
          <Token size="sm" color="gray" label={a.kind} icon={<Icon name={kindIcon(a.kind)} size={12} />} />
          <span className="cf-spacer" />
          <Text type="code" size="sm" color="secondary">
            {a.id}
          </Text>
        </HStack>
        <Heading level={3}>{a.title}</Heading>
        {terminal && (
          <Text as="p" type="supporting">
            Closed by <Ref id={terminal.id} state={state} onSelect={onSelect} />
          </Text>
        )}
      </header>

      {a.criteria?.length ? (
        <Section title="Acceptance criteria">
          <Criteria items={a.criteria} />
        </Section>
      ) : null}

      {a.rejections.length > 0 && a.status === 'rejected' && (
        <Section title="Rejected because">
          <Criteria items={a.rejections} tone="unknown" />
        </Section>
      )}

      <Section title={`Versions (${a.versions.length})`}>
        <Versions artefact={a} />
      </Section>

      {canReview && (
        <Section title="Accept or reject">
          <RichTextEditor
            label="Review notes"
            isLabelHidden
            value={text}
            onChange={setText}
            rows={3}
            isDisabled={busy}
            width="100%"
          />
          <HStack gap={2} wrap="wrap">
            <Button
              label="Accept"
              variant="primary"
              size="sm"
              isDisabled={busy}
              clickAction={() => act('review', { artefactId: a.id, verdict: 'accept', notes: items(text) })}
            />
            <Button
              label="Reject"
              variant="destructive"
              size="sm"
              isDisabled={busy || isBlank(text)}
              clickAction={() => act('review', { artefactId: a.id, verdict: 'reject', notes: items(text) })}
            />
          </HStack>
        </Section>
      )}

      {(producers.length > 0 || consumers.length > 0) && (
        <Section title="Flow">
          {producers.length > 0 && (
            <>
              <Sub>Produced by</Sub>
              <div className="cf-refs is-col">
                {producers.map((t) => (
                  <Ref key={t.id} id={t.id} state={state} onSelect={onSelect} />
                ))}
              </div>
            </>
          )}
          {consumers.length > 0 && (
            <>
              <Sub>Consumed by</Sub>
              <div className="cf-refs is-col">
                {consumers.map((t) => (
                  <Ref key={t.id} id={t.id} state={state} onSelect={onSelect} />
                ))}
              </div>
            </>
          )}
        </Section>
      )}
    </aside>
  );
}

/** Review notes are one document; each paragraph or bullet is a note. */
function items(text: string): string[] | undefined {
  const out = richTextItems(text);
  return out.length ? out : undefined;
}
