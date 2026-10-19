import { ReactFlowProvider } from '@xyflow/react';
import { KNOWN_KINDS, eventEntityId, isBlank, project, richTextItems, summarise, workflows, type Event, type Workflow } from '@coalface/core';
import { Button } from '@astryxdesign/core/Button';
import { ButtonGroup } from '@astryxdesign/core/ButtonGroup';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { HStack } from '@astryxdesign/core/HStack';
import { IconButton } from '@astryxdesign/core/IconButton';
import { LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout';
import { List, ListItem } from '@astryxdesign/core/List';
import { MultiSelector } from '@astryxdesign/core/MultiSelector';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { ResizeHandle, percent, useResizable } from '@astryxdesign/core/Resizable';
import { pixel } from '@astryxdesign/core/Resizable/utils';
import { Selector } from '@astryxdesign/core/Selector';
import { Slider } from '@astryxdesign/core/Slider';
import { StackItem } from '@astryxdesign/core/Stack';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Theme } from '@astryxdesign/core/theme';
import { useToast } from '@astryxdesign/core/Toast';
import { VStack } from '@astryxdesign/core/VStack';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { command, fetchMeta, subscribe, type Meta } from './api';
import { describeEvent } from './events';
import { Board } from './board/Board';
import { Graph } from './graph/Graph';
import type { FrameState } from './graph/build';
import { Icon, cx, iconFor, kindIcon } from './graph/nodes';
import { Hint } from './hint';
import { Panel } from './panel/Panel';
import { RichTextEditor } from './rich/RichTextEditor';
// The prebuilt theme (pnpm theme:build writes it from boxopsTheme.tsx).
import { boxopsTheme } from './theme/boxops';

type ThemePref = 'auto' | 'light' | 'dark';
type Frames = Record<string, FrameState>;
type View = 'graph' | 'board';

/** The user's preference and the scheme in effect. Astryx's Theme applies it to the document. */
function useTheme(): [ThemePref, 'light' | 'dark', (t: ThemePref) => void] {
  const [pref, setPref] = useState<ThemePref>(() => {
    try {
      return (localStorage.getItem('cf-theme') as ThemePref) || 'auto';
    } catch {
      return 'auto';
    }
  });
  const [system, setSystem] = useState<'light' | 'dark'>(() =>
    window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
  );
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const h = () => setSystem(mq.matches ? 'dark' : 'light');
    mq.addEventListener('change', h);
    return () => mq.removeEventListener('change', h);
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem('cf-theme', pref);
    } catch {
      // ignore
    }
  }, [pref]);
  return [pref, pref === 'auto' ? system : pref, setPref];
}

function loadFrames(key: string): Frames {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Frames) : {};
  } catch {
    return {};
  }
}

export function App() {
  const [pref, theme, setPref] = useTheme();
  return (
    <Theme theme={boxopsTheme} mode={pref === 'auto' ? 'system' : pref}>
      <ReactFlowProvider>
        <Shell pref={pref} theme={theme} setPref={setPref} />
      </ReactFlowProvider>
    </Theme>
  );
}

function Shell({ pref, theme, setPref }: { pref: ThemePref; theme: 'light' | 'dark'; setPref: (t: ThemePref) => void }) {
  const [events, setEvents] = useState<Event[]>([]);
  const [connected, setConnected] = useState(false);
  const [meta, setMeta] = useState<Meta>();
  const [cursor, setCursor] = useState<number | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  const [frames, setFrames] = useState<Frames>({});
  const framesKey = useRef<string | undefined>(undefined);
  const [focus, setFocusState] = useState<string[]>([]);
  const [selected, setSelected] = useState<string>();
  const [goalOpen, setGoalOpen] = useState(false);
  const [fitKey, setFitKey] = useState(0);
  const [view, setView] = useState<View>(() => {
    try {
      return localStorage.getItem('cf-view') === 'board' ? 'board' : 'graph';
    } catch {
      return 'graph';
    }
  });
  const showToast = useToast();
  // The details pane resizes from its left edge; Astryx keeps the width in localStorage.
  const mainRef = useRef<HTMLElement>(null);
  const pane = useResizable({
    defaultSize: 380,
    minSize: 300,
    maxSize: percent(60, { max: pixel(900) }),
    containerRef: mainRef,
    autoSaveId: 'cf-panel',
  });
  useEffect(() => {
    try {
      localStorage.setItem('cf-view', view);
    } catch {
      // ignore
    }
  }, [view]);

  useEffect(
    () =>
      subscribe({
        snapshot: setEvents,
        append: (more) => setEvents((prev) => [...prev, ...more]),
        status: setConnected,
      }),
    [],
  );
  useEffect(() => {
    fetchMeta()
      .then((m) => {
        setMeta(m);
        framesKey.current = `cf:frames:${m.dir}`;
        setFrames(loadFrames(framesKey.current));
      })
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    if (!framesKey.current) return;
    try {
      localStorage.setItem(framesKey.current, JSON.stringify(frames));
    } catch {
      // ignore
    }
  }, [frames]);

  const setFocus = useCallback((ids: string[]) => {
    setFocusState(ids);
    setCursor(null);
  }, []);
  /** A frame's focus control: focus it alone, unfocus it, or with a modifier add it to the set. */
  const toggleFocus = useCallback((id: string | undefined, additive = false) => {
    setFocusState((cur) => {
      if (!id) return [];
      if (cur.includes(id)) return cur.filter((x) => x !== id);
      return additive ? [...cur, id] : [id];
    });
    setCursor(null);
  }, []);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      // Escape inside a popup, dialog or field belongs to it.
      const t = e.target instanceof Element ? e.target : null;
      if (t?.closest('dialog, [role="dialog"], [role="listbox"], [role="menu"], [role="combobox"], input, textarea, select')) return;
      if (selected) setSelected(undefined);
      else if (focus.length) setFocus([]);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [selected, focus, setFocus]);

  // The live projection and its workflows anchor focus and the scoped timeline.
  const liveState = useMemo(() => project(events), [events]);
  const wfs = useMemo(() => workflows(liveState), [liveState]);
  const focusWfs = useMemo(
    () => focus.map((id) => wfs.list.find((w) => w.id === id)).filter((w): w is Workflow => !!w),
    [focus, wfs],
  );
  const focusSet = useMemo(() => new Set(focus), [focus]);
  // A focused workflow that leaves the log leaves the focus.
  useEffect(() => {
    if (focusWfs.length !== focus.length) setFocusState(focusWfs.map((w) => w.id));
  }, [focus, focusWfs]);
  const focusLabel = focusWfs.length === 1 ? focusWfs[0]!.title : `${focusWfs.length} workflows`;

  /** Indices of the events that belong to the focused workflows. */
  const focusIdx = useMemo(() => {
    if (!focus.length) return null;
    const out: number[] = [];
    events.forEach((e, i) => {
      const w = wfs.of.get(eventEntityId(e));
      if (w && focusSet.has(w)) out.push(i);
    });
    return out;
  }, [events, wfs, focus, focusSet]);

  const live = cursor === null;
  const max = focusIdx ? focusIdx.length : events.length;
  const viewEvents = useMemo(() => {
    if (cursor === null) return events;
    if (!focusIdx) return events.slice(0, cursor);
    const cut = new Set(focusIdx.slice(cursor));
    return events.filter((_, i) => !cut.has(i));
  }, [events, cursor, focusIdx]);
  const state = useMemo(() => (cursor === null ? liveState : project(viewEvents)), [cursor, liveState, viewEvents]);

  const focusIds = useMemo(
    () => (focusWfs.length ? new Set(focusWfs.flatMap((w) => [...w.actions, ...w.artefacts])) : undefined),
    [focusWfs],
  );
  const sum = useMemo(() => summarise(state, focusIds), [state, focusIds]);

  // Groups and workflows fold up the moment they finish: the coal face has been eaten.
  const seenDone = useRef(new Set<string>());
  useEffect(() => {
    if (!live) return;
    const freshGroups = Object.values(state.actions).filter(
      (t) => t.children.length && t.status === 'done' && !seenDone.current.has(t.id),
    );
    const freshWfs = wfs.list.filter((w) => w.status === 'done' && !seenDone.current.has(`wf:${w.id}`));
    if (!freshGroups.length && !freshWfs.length) return;
    for (const t of freshGroups) seenDone.current.add(t.id);
    for (const w of freshWfs) seenDone.current.add(`wf:${w.id}`);
    if (freshGroups.length) {
      setCollapsedGroups((prevSet) => {
        const next = new Set(prevSet);
        for (const t of freshGroups) next.add(t.id);
        return next;
      });
    }
    if (freshWfs.length) {
      setFrames((prevFrames) => {
        const next = { ...prevFrames };
        for (const w of freshWfs) next[w.id] = { ...next[w.id], collapsed: true };
        return next;
      });
    }
  }, [state, wfs, live]);

  // Each command that can be undone names the one that undoes it; the toast
  // after it carries an Undo. Nothing is rewritten: the undo is one more event.
  const stateRef = useRef(state);
  stateRef.current = state;
  const run = useCallback(
    async (name: string, args: Record<string, unknown>) => {
      try {
        const r = await command<{ warnings?: string[] }>(name, args);
        if (r.warnings?.length) showToast({ body: r.warnings.join(' · ') });
        const undo = UNDO[name];
        if (undo && typeof args.actionId === 'string') {
          const id = args.actionId;
          const title = stateRef.current.actions[id]?.title ?? id;
          showToast({
            body: `${undo.did} "${title}"`,
            uniqueID: 'cf-undo',
            endContent: <Button label="Undo" size="sm" variant="ghost" onClick={() => void run(undo.command, { actionId: id })} />,
          });
        }
      } catch (e) {
        showToast({ body: e instanceof Error ? e.message : String(e), type: 'error' });
      }
    },
    [showToast],
  );

  const toggleGroup = useCallback((id: string) => {
    setCollapsedGroups((prevSet) => {
      const next = new Set(prevSet);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const toggleFrame = useCallback((id: string) => {
    setFrames((prevFrames) => ({ ...prevFrames, [id]: { ...prevFrames[id], collapsed: !prevFrames[id]?.collapsed } }));
  }, []);
  // Pinning locks a frame where it currently is; unpinning only makes it
  // draggable again. A dragged frame keeps its position until tidied.
  const pinFrame = useCallback((id: string, position?: { x: number; y: number }) => {
    setFrames((prevFrames) => {
      const cur = prevFrames[id] ?? {};
      if (cur.pinned) return { ...prevFrames, [id]: { ...cur, pinned: false } };
      return { ...prevFrames, [id]: { ...cur, pinned: true, x: position?.x ?? cur.x ?? 0, y: position?.y ?? cur.y ?? 0 } };
    });
  }, []);
  const moveFrame = useCallback((id: string, position: { x: number; y: number }) => {
    setFrames((prevFrames) => ({ ...prevFrames, [id]: { ...prevFrames[id], x: position.x, y: position.y } }));
  }, []);
  const tidyFrames = useCallback(() => {
    setFrames((prevFrames) =>
      Object.fromEntries(
        Object.entries(prevFrames).map(([id, f]) => [id, f.pinned ? f : { ...f, x: undefined, y: undefined }]),
      ),
    );
    setFitKey((k) => k + 1);
  }, []);

  const total = focusIds ? focusWfs.reduce((n, w) => n + w.actions.length, 0) : Object.keys(state.actions).length;
  const lastEvent = focusIdx
    ? cursor === null
      ? events[focusIdx[focusIdx.length - 1] ?? -1]
      : events[focusIdx[cursor - 1] ?? -1]
    : viewEvents[viewEvents.length - 1];
  const shown = focusIdx ? (cursor === null ? focusIdx.length : cursor) : viewEvents.length;
  const lastText = lastEvent ? describeEvent(state, lastEvent) : 'empty log';
  const wfOptions = useMemo(() => wfs.list.map((w) => ({ value: w.id, label: w.title })), [wfs]);
  const newGoal = (
    <Button
      label="New goal"
      variant="primary"
      size="sm"
      icon={<Icon name="plus" size={14} />}
      onClick={() => setGoalOpen(true)}
      isDisabled={!live}
    />
  );

  return (
    <div className="cf-app">
      <header className="cf-top">
        <div className="cf-brand">
          <span className="cf-logo" aria-hidden="true" />
          <span className="cf-brand-name">Coalface</span>
          {meta && (
            <Hint content={meta.dir} placement="below">
              <span className="cf-top-dir">
                <Text type="code" size="sm" color="secondary">
                  {shortDir(meta.dir)}
                </Text>
              </span>
            </Hint>
          )}
          <span className={cx('cf-picker', focus.length > 0 && 'is-focused')}>
            <MultiSelector
              label="Focus workflows"
              isLabelHidden
              size="sm"
              variant={focus.length ? 'secondary' : 'ghost'}
              placeholder="All workflows"
              options={wfOptions}
              value={focus}
              onChange={(v: string[]) => setFocus(v)}
              hasClear
              hasSearch={wfOptions.length > 8}
              triggerDisplay="labels"
              formatValue={(items) => (items.length === 1 ? items[0]!.label : `${items.length} workflows`)}
              width={focus.length ? 260 : 150}
            />
          </span>
        </div>
        <div className="cf-stats">
          <Stat label="ready for agents" value={sum.agentFace} tone="ready" />
          <Stat label="waiting on you" value={sum.humanQueue} tone="human" />
          <Stat label="active" value={sum.actions.active} tone="active" />
          <Stat label="done" value={`${sum.actions.done}/${total}`} tone="done" />
          <Stat label="undecomposed large" value={sum.undecomposedLarge} tone="muted" title="Large or unsized leaf actions: the honest measure of remaining uncertainty" />
        </div>
        <div className="cf-tools">
          <Hint content={connected ? 'Connected to the log' : 'Disconnected'} placement="below">
            <span className={cx('cf-conn', connected ? 'is-on' : 'is-off')}>
              <StatusDot
                variant={connected ? 'success' : 'neutral'}
                label={connected ? 'Connected to the log' : 'Disconnected'}
                isPulsing={connected}
              />
              <span className="cf-conn-text">{connected ? 'live' : 'offline'}</span>
            </span>
          </Hint>
          {newGoal}
          <SegmentedControl label="View" value={view} onChange={(v) => setView(v as View)} size="sm">
            <SegmentedControlItem value="graph" label="Graph" icon={<Icon name="graph" size={14} />} />
            <SegmentedControlItem value="board" label="Board" icon={<Icon name="board" size={14} />} />
          </SegmentedControl>
          {view === 'graph' && (
            <>
              <IconButton
                label="Fit view"
                tooltip="Fit view"
                variant="ghost"
                size="sm"
                icon={<Icon name="fit" size={16} />}
                onClick={() => setFitKey((k) => k + 1)}
              />
              <IconButton
                label="Tidy"
                tooltip="Tidy: return unpinned workflows to the automatic stack"
                variant="ghost"
                size="sm"
                icon={<Icon name="tidy" size={16} />}
                onClick={tidyFrames}
              />
            </>
          )}
          <IconButton
            label={`Theme: ${pref}`}
            tooltip={`Theme: ${pref}. Click to change`}
            variant="ghost"
            size="sm"
            icon={<Icon name={pref === 'auto' ? 'auto' : theme === 'dark' ? 'moon' : 'sun'} size={16} />}
            onClick={() => setPref(pref === 'auto' ? 'light' : pref === 'light' ? 'dark' : 'auto')}
          />
        </div>
      </header>

      <main ref={mainRef} className="cf-main" style={{ '--panel-w': `${pane.size}px` } as CSSProperties}>
        <div className="cf-canvas">
          {view === 'graph' ? (
            <Graph
              state={state}
              collapsedGroups={collapsedGroups}
              frames={frames}
              focus={focus}
              selected={selected}
              theme={theme}
              fitKey={fitKey}
              onSelect={setSelected}
              onToggleGroup={toggleGroup}
              onToggleFrame={toggleFrame}
              onPinFrame={pinFrame}
              onMoveFrame={moveFrame}
              onFocus={toggleFocus}
            />
          ) : (
            <Board state={state} focus={focus} selected={selected} onSelect={setSelected} onFocus={toggleFocus} />
          )}
          {state.order.length === 0 && (
            <div className="cf-empty">
              <EmptyState
                title="No workflow yet"
                description="Create a goal here, or tell your agent in Claude Code: /coalface:mine <goal>"
                icon={<Icon name="flag" size={28} />}
                actions={newGoal}
              />
            </div>
          )}
          {!live && (
            <div className="cf-history-banner">
              Viewing history · event {cursor} of {max}
              {focusWfs.length ? ` in “${focusLabel}”` : ''}
            </div>
          )}
          {view === 'graph' && <Legend />}
        </div>
        <ResizeHandle className="cf-splitter" direction="horizontal" isReversed hasDivider label="Resize the details pane" resizable={pane.props} />
        <Panel state={state} selected={selected} human={meta?.human} live={live} onSelect={setSelected} run={run} />
      </main>

      <footer className="cf-timeline">
        <span className={cx('cf-live', live && 'is-live')}>
          <Button
            label="Live"
            size="sm"
            variant={live ? 'secondary' : 'ghost'}
            icon={<span className="cf-live-dot" />}
            onClick={() => setCursor(null)}
          />
        </span>
        <div className="cf-tl-slider">
          <Slider
            label={focusWfs.length ? `Replay ${focusLabel}` : 'Replay the event log'}
            isLabelHidden
            min={0}
            max={Math.max(max, 1)}
            value={cursor ?? max}
            onChange={(v: number) => setCursor(v >= max ? null : v)}
            valueDisplay="none"
            isDisabled={max === 0}
            width="100%"
          />
        </div>
        <span className="cf-tl-label">
          <span className="cf-tl-n">
            #{shown}/{max}
          </span>
          <Hint content={lastText}>
            <span className="cf-tl-text">
              {lastText}
            </span>
          </Hint>
        </span>
      </footer>

      <GoalDialog
        isOpen={goalOpen}
        onClose={() => setGoalOpen(false)}
        onSubmit={async (args) => {
          await run('propose', args);
          setGoalOpen(false);
        }}
      />
    </div>
  );
}

/** Commands a human can take back from the toast, each paired with its reverse. */
const UNDO: Record<string, { did: string; command: string }> = {
  abandon: { did: 'Abandoned', command: 'restore' },
  restore: { did: 'Restored', command: 'abandon' },
  complete: { did: 'Completed', command: 'reopen' },
  reopen: { did: 'Reopened', command: 'complete' },
  claim: { did: 'Claimed', command: 'release' },
  release: { did: 'Released', command: 'claim' },
};

function Stat({ label, value, tone, title }: { label: string; value: number | string; tone: string; title?: string }) {
  return (
    <Hint content={title} placement="below">
      <div className={cx('cf-stat', `tone-${tone}`)}>
        <span className="cf-stat-value">{value}</span>
        <span className="cf-stat-label">{label}</span>
      </div>
    </Hint>
  );
}

function Legend() {
  return (
    <div className="cf-legend">
      {(['ready', 'active', 'submitted', 'blocked', 'rework', 'done'] as const).map((s) => (
        <span key={s} className={`st-${s}`}>
          <span className="cf-dot" />
          {s === 'submitted' ? 'awaiting review' : s}
        </span>
      ))}
      <span className="is-human">
        <Icon name="person" size={11} /> needs a human
      </span>
      <span>
        <Icon name="flag" size={11} /> deliverable
      </span>
    </div>
  );
}

interface Deliverable {
  key: number;
  kind: string;
  title: string;
  criteria: string;
}

let deliverableKey = 0;
const KINDS = KNOWN_KINDS.filter((k) => k !== 'answer' && k !== 'reviewed-pull-request').map((k) => ({ value: k, label: k, icon: iconFor(kindIcon(k)) }));

/** A fallback title for an untitled deliverable, numbered when the goal has several of its kind untitled. */
function deliverableTitle(goal: string, d: Deliverable, all: Deliverable[]): string {
  const base = `${goal || 'Goal'} ${d.kind === 'pull-request' ? 'PR' : d.kind}`;
  const untitled = all.filter((o) => o.kind === d.kind && !o.title.trim());
  return untitled.length > 1 ? `${base} ${untitled.indexOf(d) + 1}` : base;
}

function GoalDialog({
  isOpen,
  onClose,
  onSubmit,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (args: Record<string, unknown>) => Promise<void>;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [deliverables, setDeliverables] = useState<Deliverable[]>([]);
  // The deliverable open in its own composer: a fresh one, or one from the list.
  const [composing, setComposing] = useState<Deliverable | null>(null);
  const [busy, setBusy] = useState(false);

  // A fresh form each time it opens.
  useEffect(() => {
    if (!isOpen) return;
    setTitle('');
    setDescription('');
    setDeliverables([]);
    setComposing(null);
  }, [isOpen]);

  const save = (d: Deliverable) => {
    setDeliverables((ds) => (ds.some((o) => o.key === d.key) ? ds.map((o) => (o.key === d.key ? d : o)) : [...ds, d]));
    setComposing(null);
  };
  const remove = (key: number) => setDeliverables((ds) => ds.filter((d) => d.key !== key));
  const canCreate = !!title.trim() && deliverables.length > 0;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canCreate) return;
    setBusy(true);
    try {
      await onSubmit({
        actions: [
          {
            title: title.trim(),
            description: isBlank(description) ? undefined : description,
            size: 'L',
            outputs: deliverables.map((d) => ({
              kind: d.kind,
              title: d.title.trim() || deliverableTitle(title.trim(), d, deliverables),
              criteria: richTextItems(d.criteria),
            })),
          },
        ],
      });
    } finally {
      setBusy(false);
    }
  };

  const close = (open: boolean) => {
    if (!open) onClose();
  };

  return (
    <>
      <Dialog isOpen={isOpen} onOpenChange={close} purpose="form" width={520}>
        <DialogHeader title="New goal" subtitle="The agent sizes and decomposes it from the coal face." />
        <form onSubmit={submit} className="cf-goal-form">
          <LayoutContent>
            <VStack gap={4}>
              <TextInput
                label="Goal"
                value={title}
                onChange={setTitle}
                hasAutoFocus
                isRequired
                width="100%"
              />
              <RichTextEditor
                label="Description"
                description="Context for the agent: what, why, and any constraints"
                value={description}
                onChange={setDescription}
                rows={4}
                isOptional
                width="100%"
              />
              <div className="cf-dl">
                <Text type="label">Deliverables</Text>
                {deliverables.length ? (
                  <List hasDividers density="compact">
                    {deliverables.map((d) => {
                      const n = richTextItems(d.criteria).length;
                      return (
                        <ListItem
                          key={d.key}
                          label={d.title.trim() || deliverableTitle(title.trim(), d, deliverables)}
                          description={`${d.kind}${n ? ` · ${n} ${n === 1 ? 'criterion' : 'criteria'}` : ''}`}
                          startContent={<Icon name={kindIcon(d.kind)} size={16} />}
                          onClick={() => setComposing(d)}
                          endContent={
                            <IconButton
                              label="Remove deliverable"
                              variant="ghost"
                              size="sm"
                              icon={<Icon name="x" size={14} />}
                              onClick={(e) => {
                                e.stopPropagation();
                                remove(d.key);
                              }}
                            />
                          }
                        />
                      );
                    })}
                  </List>
                ) : null}
                <HStack>
                  <Button
                    label="Add deliverable"
                    variant="secondary"
                    size="sm"
                    icon={<Icon name="plus" size={14} />}
                    onClick={() => setComposing({ key: ++deliverableKey, kind: 'pull-request', title: '', criteria: '' })}
                  />
                </HStack>
              </div>
            </VStack>
          </LayoutContent>
          <LayoutFooter>
            {/* One joined control across the dialog: the two ways out of it. */}
            <div className="cf-goal-actions">
              <ButtonGroup label="Goal">
                <Button label="Cancel" variant="secondary" onClick={onClose} isDisabled={busy} />
                <Button
                  label="Create goal"
                  variant="primary"
                  type="submit"
                  isDisabled={!canCreate}
                  tooltip={deliverables.length ? undefined : 'A goal needs at least one deliverable'}
                  isLoading={busy}
                />
              </ButtonGroup>
            </div>
          </LayoutFooter>
        </form>
      </Dialog>
      <DeliverableDialog
        draft={composing}
        isNew={!!composing && !deliverables.some((d) => d.key === composing.key)}
        onClose={() => setComposing(null)}
        onSave={save}
      />
    </>
  );
}

/** One deliverable's composer, opened over the goal dialog. */
function DeliverableDialog({
  draft,
  isNew,
  onClose,
  onSave,
}: {
  draft: Deliverable | null;
  isNew: boolean;
  onClose: () => void;
  onSave: (d: Deliverable) => void;
}) {
  const [kind, setKind] = useState('pull-request');
  const [title, setTitle] = useState('');
  const [criteria, setCriteria] = useState('');

  useEffect(() => {
    if (!draft) return;
    setKind(draft.kind);
    setTitle(draft.title);
    setCriteria(draft.criteria);
  }, [draft]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (draft) onSave({ ...draft, kind, title, criteria });
  };
  const close = (open: boolean) => {
    if (!open) onClose();
  };

  return (
    <Dialog isOpen={!!draft} onOpenChange={close} purpose="form" width={480}>
      <DialogHeader
        title={isNew ? 'New deliverable' : 'Edit deliverable'}
        subtitle="Something concrete the goal must produce. A pull request or question also gets its human step from policy."
      />
      <form onSubmit={submit} className="cf-goal-form">
        <LayoutContent>
          <VStack gap={4}>
            <Selector label="Kind" options={KINDS} value={kind} onChange={setKind} startIcon={<Icon name={kindIcon(kind)} size={16} />} width="100%" />
            <TextInput label="Title" value={title} onChange={setTitle} hasAutoFocus isOptional width="100%" />
            <RichTextEditor
              label="Acceptance criteria"
              description="One per bullet or paragraph"
              value={criteria}
              onChange={setCriteria}
              rows={4}
              isOptional
              width="100%"
            />
          </VStack>
        </LayoutContent>
        <LayoutFooter>
          <div className="cf-goal-actions">
            <ButtonGroup label="Deliverable">
              <Button label="Cancel" variant="secondary" onClick={onClose} />
              <Button label={isNew ? 'Add deliverable' : 'Save'} variant="primary" type="submit" />
            </ButtonGroup>
          </div>
        </LayoutFooter>
      </form>
    </Dialog>
  );
}

function shortDir(dir: string): string {
  const parts = dir.replace(/[\\/]+\.coalface$/, '').split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join('/');
}
