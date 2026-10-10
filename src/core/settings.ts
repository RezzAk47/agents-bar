// settings.json: strict decode with a default for every bad value, unknown keys kept (port of settings.py, agents keys only).
import { DecodeError, Extra, dict, isObject, stripBom, unknownKeys, withExtra } from './json';

export const LIMIT_MIN = 3, LIMIT_MAX = 20, DEFAULT_MAX_AGENTS = 12, DEFAULT_MAX_REPOS = 8;
export const PR_ALERT_MIN = 1, PR_ALERT_MAX = 20, DEFAULT_PR_ALERT = 3;
export const GLASS_MIN = 0, GLASS_MAX = 100, GLASS_STEP = 5, DEFAULT_GLASS = 100;
export const APPEARANCES = ['system', 'light', 'dark'] as const;
export const THEMES = ['classic', 'ocean', 'forest', 'grape', 'mono'] as const;
export const LAYOUTS = ['cards', 'glass', 'solid', 'compact'] as const;
export const PROGRESS_STYLES = ['ring', 'bar', 'rings'] as const;
export const AGENT_METRICS = ['tokens', 'percent', 'both'] as const;
export const BLURS = ['off', 'light', 'medium', 'strong'] as const;
export const DEFAULT_AGENT_METRIC = 'percent'; // the Mac default is 'tokens'; the owner prefers the percentage look
export type Appearance = (typeof APPEARANCES)[number];
export type ThemeName = (typeof THEMES)[number];
export type Layout = (typeof LAYOUTS)[number];
export type ProgressStyle = (typeof PROGRESS_STYLES)[number];
export type AgentMetric = (typeof AGENT_METRICS)[number];
export type Blur = (typeof BLURS)[number];

export const LABELS = {
  appearance: { system: 'System', light: 'Light', dark: 'Dark' },
  theme: { classic: 'Classic', ocean: 'Ocean', forest: 'Forest', grape: 'Grape', mono: 'Mono' },
  layout: { cards: 'Cards', glass: 'Glass', solid: 'Solid', compact: 'Compact' },
  progress: { ring: 'Ring', bar: 'Bar', rings: 'Ring everywhere' },
  agentMetric: { tokens: 'Steps + tokens', percent: 'Percentage', both: 'Both' },
  blur: { off: 'Off', light: 'Light', medium: 'Medium', strong: 'Strong' },
} as const;

export interface AppSettings {
  maxAgents: number; maxRepos: number; appearance: Appearance; theme: ThemeName; layout: Layout; progress: ProgressStyle;
  glass: number; blur: Blur; notifyFinish: boolean; prAlert: number; agentMetric: AgentMetric;
}

/** The JSON key of each field (the Mac bars' names, so the same file means the same thing). */
export const KEYS = {
  maxAgents: 'max_agents', maxRepos: 'max_repos', appearance: 'appearance', theme: 'theme', layout: 'layout', progress: 'progress',
  glass: 'glass', blur: 'blur', notifyFinish: 'notify_finish', prAlert: 'pr_alert', agentMetric: 'agent_metric',
} as const satisfies Record<keyof AppSettings, string>;
const KNOWN = Object.values(KEYS) as string[];

export const defaultSettings = (): AppSettings => ({
  maxAgents: DEFAULT_MAX_AGENTS, maxRepos: DEFAULT_MAX_REPOS, appearance: 'system', theme: 'classic', layout: 'cards', progress: 'ring',
  glass: DEFAULT_GLASS, blur: 'medium', notifyFinish: true, prAlert: DEFAULT_PR_ALERT, agentMetric: DEFAULT_AGENT_METRIC,
});

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const limit = (v: unknown, d: number) => (finite(v) ? Math.max(LIMIT_MIN, Math.min(LIMIT_MAX, Math.trunc(v))) : d);
const prAlert = (v: unknown) => (finite(v) ? Math.max(PR_ALERT_MIN, Math.min(PR_ALERT_MAX, Math.trunc(v))) : DEFAULT_PR_ALERT);
/** Python round() is half-to-even; the glass slider only ever sees multiples of 5, so the tie case is irrelevant. */
const glass = (v: unknown) => (finite(v) ? Math.max(GLASS_MIN, Math.min(GLASS_MAX, Math.round(v / GLASS_STEP) * GLASS_STEP)) : DEFAULT_GLASS);
const choice = <T extends string>(v: unknown, allowed: readonly T[], d: T): T => (typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : d);

/** A complete, valid settings object from whatever was read. */
export function validated(data: Partial<Record<keyof AppSettings, unknown>>): AppSettings {
  const d = defaultSettings();
  return {
    maxAgents: limit(data.maxAgents, d.maxAgents), maxRepos: limit(data.maxRepos, d.maxRepos),
    appearance: choice(data.appearance, APPEARANCES, d.appearance), theme: choice(data.theme, THEMES, d.theme),
    layout: choice(data.layout, LAYOUTS, d.layout), progress: choice(data.progress, PROGRESS_STYLES, d.progress),
    agentMetric: choice(data.agentMetric, AGENT_METRICS, d.agentMetric), glass: glass(data.glass), blur: choice(data.blur, BLURS, d.blur),
    notifyFinish: typeof data.notifyFinish === 'boolean' ? data.notifyFinish : true, prAlert: prAlert(data.prAlert),
  };
}

export interface Parsed { settings: AppSettings; extra: Extra; notes: string[] }

/** Strict decode: not JSON or not an object throws DecodeError (the file is then never overwritten); a bad value falls back to
 * its own default and is noted; keys this app does not know are kept in `extra`. */
export function parseSettings(text: string): Parsed {
  const body = stripBom(text);
  if (!body.trim()) return { settings: defaultSettings(), extra: dict(), notes: [] };
  let data: unknown;
  try { data = JSON.parse(body); } catch (e) { throw new DecodeError(`not valid JSON (${(e as Error).message})`); }
  if (!isObject(data)) throw new DecodeError('the top level is not an object');
  const raw: Partial<Record<keyof AppSettings, unknown>> = {};
  for (const [field, key] of Object.entries(KEYS)) raw[field as keyof AppSettings] = Object.hasOwn(data, key) ? data[key] : undefined;
  const settings = validated(raw);
  const notes: string[] = [];
  for (const [field, key] of Object.entries(KEYS)) {
    const v = raw[field as keyof AppSettings];
    if (v !== undefined && JSON.stringify(v) !== JSON.stringify(settings[field as keyof AppSettings])) notes.push(`${key} was not usable, so its default is used`);
  }
  return { settings, extra: unknownKeys(data, KNOWN) ?? dict(), notes };
}

export function settingsToObject(s: AppSettings, extra: Extra): Record<string, unknown> {
  const known: Record<string, unknown> = {};
  for (const [field, key] of Object.entries(KEYS)) known[key] = s[field as keyof AppSettings];
  return withExtra(known, Object.keys(extra).length ? extra : undefined);
}

/** A hand edit while the app runs: start from the file (`disk`) and apply only the fields this app changed since `baseline`. */
export function mergeSettings(disk: AppSettings, mine: AppSettings, baseline: AppSettings): AppSettings {
  const out = { ...disk } as Record<string, unknown>;
  for (const k of Object.keys(mine) as (keyof AppSettings)[]) if (mine[k] !== baseline[k]) out[k] = mine[k];
  return validated(out);
}

/** Running vs recent split of the agent limit: about two thirds running. 12 -> [8, 4]. */
export function maxRunningFor(maxAgents: number): [number, number] {
  const n = limit(maxAgents, DEFAULT_MAX_AGENTS);
  const running = Math.max(1, Math.floor((n * 2) / 3));
  return [running, n - running];
}

export const SETTINGS_FILE = 'settings.json';
export const NOTIFIED_FILE = 'notified.json';
