import { ReactFlowProvider } from '@xyflow/react';
import { KNOWN_KINDS, emptyState, eventEntityId, extend, isBlank, project, richTextItems, summarise, unionState, seams, type Event, type State, type Seam } from '@lamproom/core';
import { Button } from '@astryxdesign/core/Button';
import { ButtonGroup } from '@astryxdesign/core/ButtonGroup';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { DropdownMenu } from '@astryxdesign/core/DropdownMenu';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Heading } from '@astryxdesign/core/Heading';
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
import { Spinner } from '@astryxdesign/core/Spinner';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Token } from '@astryxdesign/core/Token';
import { Theme } from '@astryxdesign/core/theme';
import { useToast } from '@astryxdesign/core/Toast';
import { VStack } from '@astryxdesign/core/VStack';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { command, createProject, fetchMe, fetchProjects, fetchStates, fetchStreamEvents, logout, signInUrl, subscribe, uploadFile, type Me, type Project } from './api';
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
type View = 'graph' | 'ports' | 'board';

/** The user's preference and the scheme in effect. Astryx's Theme applies it to the document. */
interface ThemeControl {
  pref: ThemePref;
  /** The scheme in effect. */
  theme: 'light' | 'dark';
  /** Switch to the other scheme; switching to the system's own goes back to following it. */
  toggle: () => void;
}

function useTheme(): ThemeControl {
  const [pref, setPref] = useState<ThemePref>(() => {
    try {
      return (localStorage.getItem('lr-theme') as ThemePref) || 'auto';
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
      localStorage.setItem('lr-theme', pref);
    } catch {
      // ignore
    }
  }, [pref]);
  const theme = pref === 'auto' ? system : pref;
  const toggle = useCallback(() => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setPref(next === system ? 'auto' : next);
  }, [theme, system]);
  return { pref, theme, toggle };
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
  const ui = useTheme();
  return (
    <Theme theme={boxopsTheme} mode={ui.pref === 'auto' ? 'system' : ui.pref}>
      <ReactFlowProvider>
        <Shell ui={ui} />
      </ReactFlowProvider>
    </Theme>
  );
}

type Streams = Record<string, State>;

/** Sign-in, then a project, then the workspace. The URL names the project: /p/owner/name. */
function Shell({ ui }: { ui: ThemeControl }) {
  const [me, setMe] = useState<Me | null>();
  const [projects, setProjects] = useState<Project[]>();
  const [route, setRoute] = useState(() => window.location.pathname);
  const [addOpen, setAddOpen] = useState(false);
  const showToast = useToast();
  const navigate = useCallback((path: string) => {
    window.history.pushState(null, '', path);
    setRoute(path);
  }, []);
  useEffect(() => {
    const h = () => setRoute(window.location.pathname);
    window.addEventListener('popstate', h);
    return () => window.removeEventListener('popstate', h);
  }, []);
  useEffect(() => {
    fetchMe()
      .then(setMe)
      .catch(() => setMe(null));
  }, []);
  useEffect(() => {
    if (!me) return;
    fetchProjects()
      .then(setProjects)
      .catch((e: Error) => showToast({ body: e.message, type: 'error' }));
  }, [me, showToast]);
  const project = useMemo(() => projects?.find((p) => `/p/${p.owner}/${p.name}`.toLowerCase() === route.toLowerCase()), [projects, route]);
  // One project and no address: go straight to it.
  useEffect(() => {
    if (projects?.length === 1 && !route.startsWith('/p/')) navigate(`/p/${projects[0]!.owner}/${projects[0]!.name}`);
  }, [projects, route, navigate]);
  const pick = useCallback((p: Project) => navigate(`/p/${p.owner}/${p.name}`), [navigate]);
  const added = useCallback(
    (p: Project) => {
      setProjects((ps) => (ps?.some((x) => x.id === p.id) ? ps : [...(ps ?? []), p]));
      setAddOpen(false);
      pick(p);
    },
    [pick],
  );

  if (me === undefined) return <Loading />;
  if (me === null) return <SignIn />;
  if (!projects) return <Loading />;
  const addDialog = <AddProjectDialog isOpen={addOpen} onClose={() => setAddOpen(false)} onAdded={added} />;
  if (!project) {
    return (
      <>
        <Projects projects={projects} me={me} ui={ui} onPick={pick} onAdd={() => setAddOpen(true)} />
        {addDialog}
      </>
    );
  }
  return (
    <>
      <Workspace key={project.id} project={project} projects={projects} me={me} onSwitch={pick} onAdd={() => setAddOpen(true)} ui={ui} />
      {addDialog}
    </>
  );
}

function Loading() {
  return (
    <div className="lr-gate">
      <Spinner label="Loading" />
    </div>
  );
}

function SignIn() {
  return (
    <div className="lr-gate">
      <div className="lr-gate-card">
        <span className="lr-logo lr-logo-lg" aria-hidden="true" />
        <Heading level={1}>Lamproom</Heading>
        <Text as="p" color="secondary">
          Every seam your agents work, as a live hypergraph. Sign in with the GitHub account that can see your repositories.
        </Text>
        <Button label="Sign in with GitHub" variant="primary" icon={<Icon name="github" size={16} />} onClick={() => window.location.assign(signInUrl)} />
      </div>
    </div>
  );
}

/** The user's projects, each a GitHub repository registered on this server. */
function Projects({ projects, me, ui, onPick, onAdd }: { projects: Project[]; me: Me; ui: ThemeControl; onPick: (p: Project) => void; onAdd: () => void }) {
  const add = <Button label="Add project" variant="primary" size="sm" icon={<Icon name="plus" size={14} />} onClick={onAdd} />;
  return (
    <div className="lr-app">
      <header className="lr-top">
        <div className="lr-brand">
          <span className="lr-brand-name">Lamproom</span>
        </div>
        <div className="lr-stats" />
        <div className="lr-tools">
          <UserMenu me={me} ui={ui} />
        </div>
      </header>
      <main className="lr-gate lr-gate-main">
        {projects.length ? (
          <div className="lr-projects">
            <Text type="label">Projects</Text>
            <List hasDividers>
              {projects.map((p) => (
                <ListItem key={p.id} label={`${p.owner}/${p.name}`} description="GitHub repository" startContent={<Icon name="folder" size={16} />} onClick={() => onPick(p)} />
              ))}
            </List>
            <HStack>{add}</HStack>
          </div>
        ) : (
          <EmptyState
            title="No projects yet"
            description="Register a GitHub repository you can see. Agents and the CLI find it by the repository's remote."
            icon={<Icon name="folder" size={28} />}
            actions={add}
          />
        )}
      </main>
    </div>
  );
}

function AddProjectDialog({ isOpen, onClose, onAdded }: { isOpen: boolean; onClose: () => void; onAdded: (p: Project) => void }) {
  const [repo, setRepo] = useState('');
  const [busy, setBusy] = useState(false);
  const showToast = useToast();
  useEffect(() => {
    if (isOpen) setRepo('');
  }, [isOpen]);
  const m = /^\s*(?:https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\s*$/.exec(repo);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!m) return;
    setBusy(true);
    try {
      onAdded(await createProject(m[1]!, m[2]!));
    } catch (err) {
      showToast({ body: err instanceof Error ? err.message : String(err), type: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog isOpen={isOpen} onOpenChange={(o) => !o && onClose()} purpose="form" width={440}>
      <DialogHeader title="Add project" subtitle="A GitHub repository you can see. Its seams live here; agents in a checkout of it report to this project." />
      <form onSubmit={submit} className="lr-goal-form">
        <LayoutContent>
          <TextInput label="Repository" description="owner/name, or its GitHub address" value={repo} onChange={setRepo} hasAutoFocus isRequired width="100%" />
        </LayoutContent>
        <LayoutFooter>
          <div className="lr-goal-actions">
            <ButtonGroup label="Project">
              <Button label="Cancel" variant="secondary" onClick={onClose} isDisabled={busy} />
              <Button label="Add project" variant="primary" type="submit" isDisabled={!m} isLoading={busy} />
            </ButtonGroup>
          </div>
        </LayoutFooter>
      </form>
    </Dialog>
  );
}

function UserMenu({ me, ui }: { me: Me; ui: ThemeControl }) {
  const items = [
    { id: 'who', label: me.user.name ?? me.user.login, description: me.mode === 'dev' ? 'development sign-in' : `GitHub · ${me.user.login}`, isDisabled: true },
    // Names the scheme in effect; choosing it switches to the other.
    {
      id: 'theme',
      label: ui.theme === 'dark' ? 'Dark theme' : 'Light theme',
      description: ui.pref === 'auto' ? 'Following your system' : `Switch to ${ui.theme === 'dark' ? 'light' : 'dark'}`,
      icon: <Icon name={ui.theme === 'dark' ? 'moon' : 'sun'} size={14} />,
      onClick: ui.toggle,
      hasCloseOnSelect: false,
    },
    ...(me.mode === 'dev'
      ? []
      : [
          { id: 'out', label: 'Sign out', icon: <Icon name="signout" size={14} />, onClick: () => void logout().then(() => window.location.assign('/')) },
        ]),
  ];
  return (
    <span className="lr-user">
      {me.mode === 'dev' && <Token label="dev" size="sm" color="orange" />}
      <DropdownMenu
        items={items}
        alignment="end"
        menuWidth={240}
        renderTrigger={(p) => <Button {...p} label={me.user.login} variant="ghost" size="sm" icon={<Icon name="person" size={14} />} />}
      />
    </span>
  );
}

function Workspace({
  project: proj,
  projects,
  me,
  onSwitch,
  onAdd,
  ui,
}: {
  project: Project;
  projects: Project[];
  me: Me;
  onSwitch: (p: Project) => void;
  onAdd: () => void;
  ui: ThemeControl;
}) {
  const { theme } = ui;
  // One projected state per seam stream, kept current by the live feed.
  const [streams, setStreams] = useState<Streams>({});
  const [head, setHead] = useState<number | null>(null);
  // Events per stream, fetched when a seam is focused, for scrubbing.
  const cache = useRef<Record<string, Event[]>>({});
  const pending = useRef<Record<string, Event[]>>({});
  const [cacheVersion, bumpCache] = useReducer((x: number) => x + 1, 0);
  const [cursor, setCursor] = useState<number | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  const framesKey = `lr:frames:${proj.id}`;
  const [frames, setFrames] = useState<Frames>(() => loadFrames(framesKey));
  const [focus, setFocusState] = useState<string[]>([]);
  const [selected, setSelected] = useState<string>();
  const [goalOpen, setGoalOpen] = useState(false);
  const [fitKey, setFitKey] = useState(0);
  const [view, setView] = useState<View>(() => {
    try {
      const v = localStorage.getItem('lr-view');
      return v === 'board' || v === 'ports' ? v : 'graph';
    } catch {
      return 'graph';
    }
  });
  const showToast = useToast();
  // The details pane resizes from its left edge and collapses away on a
  // double-click there; Astryx keeps the width and collapse in localStorage.
  const mainRef = useRef<HTMLElement>(null);
  const pane = useResizable({
    defaultSize: 380,
    minSize: 300,
    maxSize: percent(60, { max: pixel(900) }),
    collapsible: true,
    containerRef: mainRef,
    autoSaveId: 'lr-panel',
  });
  // Picking anything to look at brings a collapsed pane back.
  const { isCollapsed: paneCollapsed, expand: expandPane } = pane;
  const select = useCallback(
    (id: string | undefined) => {
      setSelected(id);
      if (id && paneCollapsed) expandPane();
    },
    [paneCollapsed, expandPane],
  );
  useEffect(() => {
    try {
      localStorage.setItem('lr-view', view);
    } catch {
      // ignore
    }
  }, [view]);
  useEffect(() => {
    try {
      localStorage.setItem(framesKey, JSON.stringify(frames));
    } catch {
      // ignore
    }
  }, [frames, framesKey]);

  // Load every stream's state, then follow the feed from that head.
  useEffect(() => {
    let stop: (() => void) | undefined;
    let cancelled = false;
    fetchStates(proj.id)
      .then((r) => {
        if (cancelled) return;
        const s: Streams = {};
        for (const st of r.streams) s[st.id] = st.state;
        setStreams(s);
        setHead(r.head);
        stop = subscribe(proj.id, r.head, {
          append: (events) => {
            const by = new Map<string, Event[]>();
            for (const e of events) {
              const sid = e.stream ?? eventEntityId(e);
              const list = by.get(sid);
              if (list) list.push(e);
              else by.set(sid, [e]);
            }
            setStreams((prev) => {
              const next = { ...prev };
              for (const [sid, evs] of by) next[sid] = extend(structuredClone(next[sid] ?? emptyState()), evs);
              return next;
            });
            for (const [sid, evs] of by) {
              const have = cache.current[sid];
              if (have) {
                const last = have[have.length - 1]?.seq ?? -1;
                have.push(...evs.filter((e) => e.seq! > last));
              } else (pending.current[sid] ??= []).push(...evs);
            }
            bumpCache();
            const tail = events[events.length - 1];
            if (tail) setHead(tail.seq!);
          },
        });
      })
      .catch((e: Error) => showToast({ body: e.message, type: 'error' }));
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [proj.id, showToast]);

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

  // The live projection is the union of the streams; seams anchor focus and the scoped timeline.
  const liveState = useMemo(() => unionState(Object.values(streams)), [streams]);
  const allSeams = useMemo(() => seams(liveState), [liveState]);
  const entityStream = useMemo(() => {
    const m = new Map<string, string>();
    for (const [sid, st] of Object.entries(streams)) for (const id of st.order) m.set(id, sid);
    return m;
  }, [streams]);
  const focusSeams = useMemo(
    () => focus.map((id) => allSeams.list.find((w) => w.id === id)).filter((w): w is Seam => !!w),
    [focus, allSeams],
  );
  const focusSet = useMemo(() => new Set(focus), [focus]);
  // A focused seam that leaves the log leaves the focus.
  useEffect(() => {
    if (focusSeams.length !== focus.length) setFocusState(focusSeams.map((w) => w.id));
  }, [focus, focusSeams]);
  const focusLabel = focusSeams.length === 1 ? focusSeams[0]!.title : `${focusSeams.length} seams`;
  const focusStreams = useMemo(
    () => [...new Set(focusSeams.map((w) => entityStream.get(w.id)).filter((s): s is string => !!s))],
    [focusSeams, entityStream],
  );

  // Scrubbing needs the focused streams' events; fetch them once per stream and keep them current.
  useEffect(() => {
    for (const sid of focusStreams) {
      if (cache.current[sid]) continue;
      fetchStreamEvents(proj.id, sid)
        .then((evs) => {
          const seen = new Set(evs.map((e) => e.seq));
          const late = (pending.current[sid] ?? []).filter((e) => !seen.has(e.seq));
          delete pending.current[sid];
          cache.current[sid] = [...evs, ...late].sort((a, b) => a.seq! - b.seq!);
          bumpCache();
        })
        .catch((e: Error) => showToast({ body: e.message, type: 'error' }));
    }
  }, [focusStreams, proj.id, showToast]);

  /** Every event of the focused streams, in commit order, once all are loaded. */
  const focusAll = useMemo(() => {
    void cacheVersion;
    if (!focusStreams.length || !focusStreams.every((sid) => cache.current[sid])) return null;
    return focusStreams
      .flatMap((sid) => cache.current[sid]!)
      .sort((a, b) => a.seq! - b.seq!);
  }, [focusStreams, cacheVersion]);
  /** Indices into focusAll of the events that belong to the focused seams. */
  const focusIdx = useMemo(() => {
    if (!focusAll) return null;
    const out: number[] = [];
    focusAll.forEach((e, i) => {
      const w = allSeams.of.get(eventEntityId(e));
      if (w && focusSet.has(w)) out.push(i);
    });
    return out;
  }, [focusAll, allSeams, focusSet]);

  const live = cursor === null;
  const max = focusIdx ? focusIdx.length : 0;
  const state = useMemo(() => {
    if (cursor === null || !focusAll || !focusIdx) return liveState;
    const cut = new Set(focusIdx.slice(cursor));
    const viewEvents = focusAll.filter((_, i) => !cut.has(i));
    const others = Object.entries(streams)
      .filter(([sid]) => !focusStreams.includes(sid))
      .map(([, st]) => st);
    return unionState([project(viewEvents), ...others]);
  }, [cursor, focusAll, focusIdx, liveState, streams, focusStreams]);

  const focusIds = useMemo(
    () => (focusSeams.length ? new Set(focusSeams.flatMap((w) => [...w.actions, ...w.artefacts])) : undefined),
    [focusSeams],
  );
  const sum = useMemo(() => summarise(state, focusIds), [state, focusIds]);

  // Groups and seams fold up the moment they finish: the coal face has been eaten.
  // A finished seam that a follow-up reopens unfolds again.
  const seenDone = useRef(new Set<string>());
  useEffect(() => {
    if (!live) return;
    const freshGroups = Object.values(state.actions).filter(
      (t) => t.children.length && t.status === 'done' && !seenDone.current.has(t.id),
    );
    const freshSeams = allSeams.list.filter((w) => w.status === 'done' && !seenDone.current.has(`seam:${w.id}`));
    const reopened = allSeams.list.filter((w) => w.status !== 'done' && seenDone.current.has(`seam:${w.id}`));
    if (!freshGroups.length && !freshSeams.length && !reopened.length) return;
    for (const t of freshGroups) seenDone.current.add(t.id);
    for (const w of freshSeams) seenDone.current.add(`seam:${w.id}`);
    for (const w of reopened) seenDone.current.delete(`seam:${w.id}`);
    if (freshGroups.length) {
      setCollapsedGroups((prevSet) => {
        const next = new Set(prevSet);
        for (const t of freshGroups) next.add(t.id);
        return next;
      });
    }
    if (freshSeams.length || reopened.length) {
      setFrames((prevFrames) => {
        const next = { ...prevFrames };
        for (const w of freshSeams) next[w.id] = { ...next[w.id], collapsed: true };
        for (const w of reopened) next[w.id] = { ...next[w.id], collapsed: false };
        return next;
      });
    }
  }, [state, allSeams, live]);

  // Each command that can be undone names the one that undoes it; the toast
  // after it carries an Undo. Nothing is rewritten: the undo is one more event.
  const stateRef = useRef(state);
  stateRef.current = state;
  const run = useCallback(
    async (name: string, args: Record<string, unknown>) => {
      try {
        const r = await command(proj.id, name, args);
        if (r.warnings?.length) showToast({ body: r.warnings.join(' · ') });
        const undo = UNDO[name];
        if (undo && typeof args.actionId === 'string') {
          const id = args.actionId;
          const title = stateRef.current.actions[id]?.title ?? id;
          showToast({
            body: `${undo.did} "${title}"`,
            uniqueID: 'lr-undo',
            endContent: <Button label="Undo" size="sm" variant="ghost" onClick={() => void run(undo.command, { actionId: id })} />,
          });
        }
      } catch (e) {
        showToast({ body: e instanceof Error ? e.message : String(e), type: 'error' });
      }
    },
    [proj.id, showToast],
  );

  const upload = useCallback((file: File) => uploadFile(proj.id, file), [proj.id]);

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

  const total = focusIds ? focusSeams.reduce((n, w) => n + w.actions.length, 0) : Object.keys(state.actions).length;
  const wfOptions = useMemo(() => allSeams.list.map((w) => ({ value: w.id, label: w.title })), [allSeams]);
  const projectOptions = useMemo(
    () => [...projects.map((p) => ({ value: p.id, label: `${p.owner}/${p.name}` })), { value: '__add', label: 'Add project…' }],
    [projects],
  );
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
    <div className="lr-app">
      <header className="lr-top">
        <div className="lr-brand">
          <span className="lr-brand-name">Lamproom</span>
          {/* Straight after the name, so nothing beside it can move it. */}
          <SegmentedControl label="View" value={view} onChange={(v) => setView(v as View)} size="sm">
            <SegmentedControlItem value="graph" label="Graph" icon={<Icon name="graph" size={14} />} />
            <SegmentedControlItem value="ports" label="Ports" icon={<Icon name="ports" size={14} />} />
            <SegmentedControlItem value="board" label="Board" icon={<Icon name="board" size={14} />} />
          </SegmentedControl>
          <span className="lr-top-project">
            <Selector
              label="Project"
              isLabelHidden
              size="sm"
              variant="ghost"
              options={projectOptions}
              value={proj.id}
              onChange={(v: string) => {
                if (v === '__add') onAdd();
                else {
                  const p = projects.find((x) => x.id === v);
                  if (p) onSwitch(p);
                }
              }}
              startIcon={<Icon name="folder" size={14} />}
            />
          </span>
          <span className={cx('lr-picker', focus.length > 0 && 'is-focused')}>
            <MultiSelector
              label="Focus seams"
              isLabelHidden
              size="sm"
              variant={focus.length ? 'secondary' : 'ghost'}
              placeholder="All seams"
              options={wfOptions}
              value={focus}
              onChange={(v: string[]) => setFocus(v)}
              hasClear
              hasSearch={wfOptions.length > 8}
              triggerDisplay="labels"
              formatValue={(items) => (items.length === 1 ? items[0]!.label : `${items.length} seams`)}
              width={focus.length ? 260 : 150}
            />
          </span>
        </div>
        <div className="lr-tools">
          {newGoal}
          <UserMenu me={me} ui={ui} />
        </div>
      </header>

      <main ref={mainRef} className={cx('lr-main', pane.isCollapsed && 'is-pane-collapsed')} style={{ '--panel-w': `${pane.isCollapsed ? 0 : pane.size}px` } as CSSProperties}>
        <div className="lr-canvas">
          {view !== 'board' ? (
            <Graph
              ports={view === 'ports'}
              state={state}
              collapsedGroups={collapsedGroups}
              frames={frames}
              focus={focus}
              selected={selected}
              theme={theme}
              fitKey={fitKey}
              replaying={!live}
              onSelect={select}
              onToggleGroup={toggleGroup}
              onToggleFrame={toggleFrame}
              onPinFrame={pinFrame}
              onMoveFrame={moveFrame}
              onFocus={toggleFocus}
              onTidy={tidyFrames}
            />
          ) : (
            <Board state={state} focus={focus} selected={selected} onSelect={select} onFocus={toggleFocus} />
          )}
          {head !== null && state.order.length === 0 && (
            <div className="lr-empty">
              <EmptyState
                title="No seam yet"
                description={`Create a goal here, or tell your agent in a checkout of ${proj.owner}/${proj.name}: /lamproom:mine <goal>`}
                icon={<Icon name="flag" size={28} />}
                actions={newGoal}
              />
            </div>
          )}
          {/* The board's column headings carry its counts; the canvas shows them over the top. */}
          {(view !== 'board' || !live) && (
            <div className="lr-canvas-top">
              {view !== 'board' && (
                <div className="lr-stats">
                  <Stat label="ready for agents" value={sum.agentFace} tone="ready" />
                  <Stat label="waiting on you" value={sum.humanQueue} tone="human" />
                  <Stat label="active" value={sum.actions.active} tone="active" />
                  <Stat label="done" value={`${sum.actions.done}/${total}`} tone="done" />
                  <Stat label="undecomposed large" value={sum.undecomposedLarge} tone="muted" title="Large or unsized leaf actions: the honest measure of remaining uncertainty" />
                </div>
              )}
              {!live && (
                <div className="lr-history-banner">
                  Viewing history · event {cursor} of {max} in “{focusLabel}”
                </div>
              )}
            </div>
          )}
          {view !== 'board' && <Legend />}
        </div>
        <ResizeHandle
          className="lr-splitter"
          direction="horizontal"
          isReversed
          hasDivider
          label="Resize the details pane; double-click to hide or show it"
          resizable={pane.props}
        />
        <Panel state={state} selected={selected} human={me.actor} live={live} onSelect={select} run={run} upload={upload} />
      </main>

      <footer className="lr-timeline">
        <span className={cx('lr-live', live && 'is-live')}>
          <Button
            label="Live"
            size="sm"
            variant={live ? 'secondary' : 'ghost'}
            icon={<span className="lr-live-dot" />}
            onClick={() => setCursor(null)}
          />
        </span>
        <Hint content={focusSeams.length ? undefined : 'Focus a seam to replay its history'} placement="above">
          <div className="lr-tl-slider">
            <Slider
              label={focusSeams.length ? `Replay ${focusLabel}` : 'Focus a seam to replay its history'}
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
        </Hint>
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
    <Hint content={title ?? label} placement="below">
      <div className={cx('lr-stat', `tone-${tone}`)}>
        <span className="lr-dot" />
        <span className="lr-stat-value">{value}</span>
        <span className="lr-stat-label">{label}</span>
      </div>
    </Hint>
  );
}

function Legend() {
  return (
    <div className="lr-legend">
      {(['ready', 'active', 'submitted', 'blocked', 'rework', 'done'] as const).map((s) => (
        <span key={s} className={`st-${s}`}>
          <span className="lr-dot" />
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
        <form onSubmit={submit} className="lr-goal-form">
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
              <div className="lr-dl">
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
            <div className="lr-goal-actions">
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
      <form onSubmit={submit} className="lr-goal-form">
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
          <div className="lr-goal-actions">
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
