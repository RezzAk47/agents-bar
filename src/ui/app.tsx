import { useEffect, useReducer, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type { Engine } from './engine';
import { cssVars, isDark, tokens } from './palette';
import { ringOf, selectRows, spokenAgent, stateWord, subtitle } from './format';
import { Alert, Back, Chevron, Gear, Lock, Pause, Play, Power, Refresh, Tick } from './icons';
import { AGENT_METRICS, APPEARANCES, BLURS, GLASS_STEP, LABELS, LAYOUTS, LIMIT_MAX, LIMIT_MIN, PROGRESS_STYLES, PR_ALERT_MAX, PR_ALERT_MIN, THEMES, maxRunningFor, type AppSettings } from '../core/settings';
import { nextDone, type Agent } from '../core/agents';
import { capRows, todayRow } from '../core/history';
import { allReposText, segments, spoken, spokenAttention, type Repo, type Role } from '../core/github';
import { ago, clean, fmtDuration } from '../core/text';

/** Applies the theme as CSS variables on <html>. Called again when settings or the system appearance change. */
export function applyTheme(s: AppSettings, systemDark: boolean): void {
  const dark = isDark(s.appearance, systemDark);
  const root = document.documentElement;
  const t = tokens(s.theme, s.layout, dark);
  for (const [k, v] of Object.entries(cssVars(t))) root.style.setProperty(k, v);
  root.dataset.dark = dark ? '1' : '0';
  root.dataset.layout = s.layout;
  root.dataset.progress = s.progress;
  root.style.setProperty('--glass', String(s.glass / 100));
  root.style.setProperty('--blur', `${{ off: 0, light: 6, medium: 14, strong: 26 }[s.blur]}px`);
  root.style.colorScheme = dark ? 'dark' : 'light';
}

function useEngine(engine: Engine): void {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => engine.subscribe(() => bump(0)), [engine]);
}

function RingView({ a }: { a: Agent }) {
  const r = ringOf(a);
  const C = 2 * Math.PI * 21;
  return (
    <div class={`ring ${a.state}`} role="img" aria-label={r.label}>
      <svg viewBox="0 0 50 50" aria-hidden="true">
        <circle class="track" cx="25" cy="25" r="21" />
        {r.fraction !== null && r.fraction > 0 && <circle class="arc" cx="25" cy="25" r="21" stroke-dasharray={`${C * r.fraction} ${C}`} transform="rotate(-90 25 25)" />}
      </svg>
      <span class="ring-text">{r.text}</span>
    </div>
  );
}

function Bar({ a }: { a: Agent }) {
  const r = ringOf(a);
  return (
    <div class={`bar ${a.state}`} role="img" aria-label={r.label}>
      <div class="bar-fill" style={{ inlineSize: `${Math.round((r.fraction ?? 0) * 100)}%` }} />
    </div>
  );
}

const StateIcon = ({ s }: { s: Agent['state'] }) => (s === 'running' ? <Play /> : s === 'done' ? <Tick /> : <Pause />);

function AgentCard({ a, s, onOpen }: { a: Agent; s: AppSettings; onOpen: (a: Agent) => void }) {
  const showRing = s.agentMetric !== 'tokens';
  const bar = s.progress === 'bar';
  return (
    <li>
      <button class={`card agent ${a.state}${showRing ? ' with-ring' : ''}`} onClick={() => onOpen(a)} aria-label={`${spokenAgent(a, s.agentMetric)}. Show transcript in the file manager.`}>
        {showRing && !bar && <RingView a={a} />}
        <div class="body">
          <div class="pills">
            <span class={`pill src ${a.source === 'Codex' ? 'codex' : 'claude'}`}>{a.source}</span>
            {clean(a.kind, 24).toLowerCase() !== a.source.toLowerCase() && <span class="kind" dir="auto">{clean(a.kind, 24)}</span>}
            <span class={`pill status ${a.state}`}><StateIcon s={a.state} />{stateWord(a)}</span>
          </div>
          <div class="title" dir="auto">{a.description}</div>
          {showRing && bar && <Bar a={a} />}
          <div class="sub" dir="auto">{subtitle(a, s.agentMetric)}</div>
        </div>
        <Chevron class="chev" />
      </button>
    </li>
  );
}

function Section({ title, children, id }: { title: string; children: ComponentChildren; id: string }) {
  return (
    <section aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {children}
    </section>
  );
}

const ROLE_CLASS: Record<Role, string> = { plain: '', bad: 'bad', good: 'good', quiet: 'quiet' };

function RepoRow({ r, now, onOpen }: { r: Repo; now: number; onOpen: (r: Repo) => void }) {
  const seg = segments(r);
  return (
    <li>
      <button class="repo" onClick={() => onOpen(r)} aria-label={`${r.name}${r.private ? ', private' : ''}. ${spoken(r)}. Open on GitHub.`}>
        <div class="repo-top">
          <span class="repo-name" dir="auto">{r.private && <Lock class="lock" />}{r.name}</span>
          <span class="repo-meta">{[r.language, r.stars ? `★ ${r.stars}` : '', ago(r.pushed, now / 1000)].filter(Boolean).join(' · ')}</span>
        </div>
        {r.description && <div class="repo-desc" dir="auto">{r.description}</div>}
        {seg.length > 0 && (
          <div class="repo-status">
            {seg.map(([text, role], i) => <span key={i}>{i > 0 && ' · '}<span class={ROLE_CLASS[role]}>{text}</span></span>)}
          </div>
        )}
      </button>
    </li>
  );
}

function MainView({ engine }: { engine: Engine }) {
  const snap = engine.snap, s = engine.settings.settings;
  const [maxRunning] = maxRunningFor(s.maxAgents);
  const { running, recent, hidden } = selectRows(snap.agents, maxRunning, s.maxAgents);
  const runningAll = snap.agents.filter((a) => a.state === 'running');
  const next = nextDone(snap.agents);
  const open = (a: Agent) => { void engine.backend.revealTranscript(a.path).catch(() => undefined); };
  const [rows, more] = capRows(snap.finishedToday);
  const summaryText = runningAll.length
    ? `${runningAll.length} running · ${next !== null && s.agentMetric !== 'tokens' ? `next done in ~${fmtDuration(next)}` : `${snap.agents.filter((a) => a.state === 'done').length} finished in 24h`}`
    : snap.agents.length ? `Nothing running · ${snap.agents.filter((a) => a.state === 'done').length} finished in 24h` : '';
  const repos = snap.repos.slice(0, s.maxRepos);
  const allRepos = allReposText(snap.login, snap.repos.length, repos.length);
  const date = new Date(snap.now ? snap.now * 1000 : engine.backend.now()).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  return (
    <>
      <header class="head">
        <div>
          <h1>Agents</h1>
          <div class="date">{date}</div>
        </div>
        <div class="summary" role="status" aria-live="polite">{summaryText}</div>
      </header>
      <main>
        {snap.scanError && <div class="notice bad" role="alert">Could not read the transcript folders: {clean(snap.scanError, 160)}</div>}
        {!snap.ready && <p class="empty">Looking for agents…</p>}
        {snap.ready && !snap.scanning && snap.agents.length === 0 && !snap.scanError && (
          <div class="empty-state">
            <p class="empty-title">No agents yet</p>
            <p class="empty">Start a Claude Code subagent or a Codex session and it shows up here within a few seconds. Nothing is sent anywhere: the transcripts on this computer are only read.</p>
          </div>
        )}
        {running.length > 0 && <Section title="Running" id="h-running"><ul class="cards">{running.map((a) => <AgentCard key={a.path} a={a} s={s} onOpen={open} />)}</ul></Section>}
        {recent.length > 0 && <Section title="Recent" id="h-recent"><ul class="cards">{recent.map((a) => <AgentCard key={a.path} a={a} s={s} onOpen={open} />)}</ul></Section>}
        {hidden > 0 && <p class="more">+{hidden} more not shown (Settings: Agents shown)</p>}
        {rows.length > 0 && (
          <Section title="Today" id="h-today">
            <ul class="today">
              {rows.map((a) => { const [title, line] = todayRow(a); return <li key={a.path}><span class="t-title" dir="auto">{title}</span><span class="t-line">{line}</span></li>; })}
              {more > 0 && <li class="t-more">+{more} more</li>}
            </ul>
          </Section>
        )}
        <Section title={`GitHub${snap.login ? ` · ${clean(snap.login, 40)}` : ''}`} id="h-github">
          {snap.attention && (
            <button class="attention" onClick={() => void engine.openRepo(snap.attention!.repo)} aria-label={`${spokenAttention(snap.hits)}. Opens ${snap.attention.repo.name} on GitHub.`}>
              <Alert /><span dir="auto">{snap.attention.text}</span>
            </button>
          )}
          {snap.ghError && <div class="notice bad" role="alert">{snap.ghError}{repos.length > 0 ? ' Showing the last list.' : ''}</div>}
          {snap.ghLoading && repos.length === 0 && !snap.ghError && <p class="empty">Loading repositories…</p>}
          {repos.length > 0 && <ul class="repos">{repos.map((r) => <RepoRow key={r.url || r.name} r={r} now={snap.now * 1000 || engine.backend.now()} onOpen={(x) => void engine.openRepo(x)} />)}</ul>}
          {allRepos && <button class="all-repos" onClick={() => void engine.openProfile().catch(() => undefined)} aria-label={`${allRepos}. Open on GitHub.`}>{allRepos}</button>}
        </Section>
      </main>
    </>
  );
}

// ---- settings -----------------------------------------------------------------------------------------------------

function Segmented<T extends string>({ label, value, options, labels, onPick, disabled }: { label: string; value: T; options: readonly T[]; labels: Record<T, string>; onPick: (v: T) => void; disabled?: boolean }) {
  return (
    <div class="row">
      <div class="row-label" id={`l-${label}`}>{label}</div>
      <div class="seg" role="group" aria-labelledby={`l-${label}`}>
        {options.map((o) => <button key={o} class="seg-btn" aria-pressed={value === o} disabled={disabled} onClick={() => onPick(o)}>{labels[o]}</button>)}
      </div>
    </div>
  );
}

function Stepper({ label, value, min, max, onChange, unit }: { label: string; value: number; min: number; max: number; onChange: (n: number) => void; unit?: string }) {
  return (
    <div class="row">
      <div class="row-label" id={`l-${label}`}>{label}</div>
      <div class="stepper" role="group" aria-labelledby={`l-${label}`}>
        <button class="btn sq" aria-label={`Fewer: ${label}`} disabled={value <= min} onClick={() => onChange(value - 1)}>{'−'}</button>
        <span class="step-val" aria-live="polite">{value}{unit ?? ''}</span>
        <button class="btn sq" aria-label={`More: ${label}`} disabled={value >= max} onClick={() => onChange(value + 1)}>+</button>
      </div>
    </div>
  );
}

function Toggle({ label, checked, onChange, note }: { label: string; checked: boolean; onChange: (v: boolean) => void; note?: string }) {
  return (
    <label class="row toggle">
      <span><span class="row-label">{label}</span>{note && <span class="note">{note}</span>}</span>
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange((e.currentTarget as HTMLInputElement).checked)} />
    </label>
  );
}

function SettingsView({ engine, onBack }: { engine: Engine; onBack: () => void }) {
  const st = engine.settings, s = st.settings, b = engine.backend;
  const set = (p: Partial<AppSettings>) => void st.update(p);
  const [auto, setAuto] = useState<boolean | null>(null);
  useEffect(() => { void b.autostart?.isEnabled().then(setAuto).catch(() => setAuto(null)); }, [b]);
  const [maxRunning, maxRecent] = maxRunningFor(s.maxAgents);
  return (
    <>
      <header class="head">
        <button class="btn back" onClick={onBack}><Back />Back</button>
        <h1>Settings</h1>
      </header>
      <main class="settings">
        {st.loadError && <div class="notice bad" role="alert">{st.loadError}</div>}
        {st.saveError && <div class="notice bad" role="alert">Could not save: {clean(st.saveError, 160)}</div>}
        {st.ignoredNotes.length > 0 && <div class="notice">{st.ignoredNotes.slice(0, 3).join('. ')}.</div>}
        <h2>Look</h2>
        <Segmented label="Appearance" value={s.appearance} options={APPEARANCES} labels={LABELS.appearance} onPick={(v) => set({ appearance: v })} />
        <Segmented label="Colour theme" value={s.theme} options={THEMES} labels={LABELS.theme} onPick={(v) => set({ theme: v })} />
        <Segmented label="Layout" value={s.layout} options={LAYOUTS} labels={LABELS.layout} onPick={(v) => set({ layout: v })} />
        <Segmented label="Progress style" value={s.progress} options={PROGRESS_STYLES} labels={LABELS.progress} onPick={(v) => set({ progress: v })} />
        <Segmented label="Agent numbers" value={s.agentMetric} options={AGENT_METRICS} labels={LABELS.agentMetric} onPick={(v) => set({ agentMetric: v })} />
        <div class="row">
          <label class="row-label" for="glass">Glass amount: {s.glass}%</label>
          <input id="glass" type="range" min="0" max="100" step={GLASS_STEP} value={s.glass} disabled={s.layout === 'solid'} onChange={(e) => set({ glass: Number((e.currentTarget as HTMLInputElement).value) })} />
        </div>
        <Segmented label="Blur strength" value={s.blur} options={BLURS} labels={LABELS.blur} onPick={(v) => set({ blur: v })} disabled={s.layout === 'solid'} />
        <p class="note">Glass and blur only restyle the panel: this window cannot show the desktop through itself, so it is a tint, not a live blur.</p>
        <h2>Lists</h2>
        <Stepper label="Agents shown" value={s.maxAgents} min={LIMIT_MIN} max={LIMIT_MAX} onChange={(n) => set({ maxAgents: n })} />
        <p class="note">{maxRunning} running + {maxRecent} recent at most.</p>
        <Stepper label="GitHub repos shown" value={s.maxRepos} min={LIMIT_MIN} max={LIMIT_MAX} onChange={(n) => set({ maxRepos: n })} />
        <Stepper label="Open PRs before 'Needs attention'" value={s.prAlert} min={PR_ALERT_MIN} max={PR_ALERT_MAX} onChange={(n) => set({ prAlert: n })} />
        <h2>Notifications and start-up</h2>
        <Toggle label="Notify when an agent finishes" checked={s.notifyFinish} onChange={(v) => set({ notifyFinish: v })} note={b.notifyOff ? 'Notifications are switched off for this run.' : undefined} />
        {b.autostart && <Toggle label="Start when I log in" checked={auto === true} onChange={(v) => { setAuto(v); void b.autostart!.set(v).catch(() => setAuto(!v)); }} />}
        <div class="row end">
          <button class="btn" onClick={() => void st.resetToDefaults()}>Reset to defaults</button>
        </div>
        <p class="note">Settings are saved in {b.dataDir}. Transcripts are only read, never changed.</p>
        {b.trayNote && <p class="note">{b.trayNote}</p>}
      </main>
    </>
  );
}

export function App({ engine }: { engine: Engine }) {
  useEngine(engine);
  const [view, setView] = useState<'main' | 'settings'>('main');
  const s = engine.settings.settings;
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => applyTheme(engine.settings.settings, mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [s.appearance, s.theme, s.layout, s.progress, s.glass, s.blur, engine]);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => engine.backend.onShown(() => { setView('main'); rootRef.current?.querySelector<HTMLElement>('button')?.focus(); }), [engine]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (view === 'settings') setView('main'); else void engine.backend.hide();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [view, engine]);
  return (
    <div class="shell" ref={rootRef}>
      {view === 'main' ? <MainView engine={engine} /> : <SettingsView engine={engine} onBack={() => setView('main')} />}
      <footer class="foot">
        <button class="btn plain" onClick={() => { void engine.tick(); void engine.refreshGithub(true); }}><Refresh />Refresh</button>
        <span class="grow" />
        <button class="btn plain" onClick={() => setView(view === 'main' ? 'settings' : 'main')} aria-label={view === 'main' ? 'Settings' : 'Back to the list'}><Gear />{view === 'main' ? 'Settings' : 'Done'}</button>
        <button class="btn plain" onClick={() => void engine.backend.quit()}><Power />Quit</button>
      </footer>
    </div>
  );
}
