// The words on an agent row, per "agent numbers" setting. Pure and bounded, so the draw code only paints them.
import { elapsed, overrun, remaining, type Agent } from '../core/agents';
import type { AgentMetric } from '../core/settings';
import { clean, clock, fmtDuration, fmtStats } from '../core/text';

export interface Ring { text: string; fraction: number | null; label: string }

/** What the ring shows: ~63% (our estimate), 63% (the agent's own), ... (no estimate yet), 100% (done), - (stalled). */
export function ringOf(a: Agent): Ring {
  if (a.state === 'done') return { text: '100%', fraction: 1, label: '100 percent, done' };
  if (a.state === 'stalled') return { text: '–', fraction: 0, label: 'stalled' };
  if (a.pct === null) return { text: '…', fraction: null, label: 'no estimate yet' };
  return { text: a.reported ? `${a.pct}%` : `~${a.pct}%`, fraction: a.pct / 100, label: `${a.reported ? '' : 'about '}${a.pct} percent` };
}

const STATE_WORD = { running: 'Running', done: 'Done', stalled: 'Stalled' } as const;
export const stateWord = (a: Agent): string => STATE_WORD[a.state];

const quiet = (a: Agent): string => `No activity for ${fmtDuration(Math.max(0, a.asOf - a.lastActivity))}`;
const onTool = (a: Agent): string => (a.lastTool ? `on ${clean(a.lastTool, 24)}` : '');

/** The second line of a row. `metric` decides what leads: percentage look (time left first), tokens look, or both. */
export function subtitle(a: Agent, metric: AgentMetric): string {
  const stats = fmtStats(a);
  const took = fmtDuration(elapsed(a));
  if (a.state === 'done') return metric === 'percent' ? `Finished ${clock(a.lastActivity)} · ${fmtStats({ ...a, tokensNew: null })} · ${took}` : `Finished ${clock(a.lastActivity)} · ${stats} · ${took}`;
  if (a.state === 'stalled') return `${quiet(a)} · ${metric === 'percent' ? fmtStats({ ...a, tokensNew: null }) : stats}`;
  const est = a.pct === null ? '' : a.reported ? `${a.pct}%` : `est. ${a.pct}%`;
  if (metric === 'percent') {
    const rem = remaining(a);
    if (overrun(a)) return `Taking longer than usual · ${fmtStats({ ...a, tokensNew: null })}`;
    const parts: string[] = [];
    if (rem !== null) parts.push(`~${fmtDuration(rem)} left`);
    if (a.note) parts.push(a.note);
    else if (a.eta !== null) parts.push(`done ~${clock(a.eta)}`);
    if (rem === null || !a.note) parts.push(rem === null ? `${fmtStats({ ...a, tokensNew: null })} · ${took}` : fmtStats({ ...a, tokensNew: null }));
    if (rem === null && !a.note) parts.push(onTool(a));
    return parts.filter(Boolean).join(' · ');
  }
  return [stats, took, est, a.note || onTool(a)].filter(Boolean).join(' · ');
}

/** The text a screen reader gets for a whole row. */
export function spokenAgent(a: Agent, metric: AgentMetric): string {
  return clean(`${a.description}, ${a.source}, ${stateWord(a)}, ${subtitle(a, metric)}`, 300);
}

/** Splits the agent limit into the rows shown: running first (about two thirds), recent ones (stalled, then done) take
 * what is left, and running agents may use slots the recent list does not need. */
export function selectRows(agents: Agent[], maxRunning: number, max: number): { running: Agent[]; recent: Agent[]; hidden: number } {
  const running = agents.filter((a) => a.state === 'running');
  const rest = agents.filter((a) => a.state !== 'running');
  const ordered = [...rest.filter((a) => a.state === 'stalled'), ...rest.filter((a) => a.state === 'done')];
  const recentReserved = Math.min(ordered.length, Math.max(0, max - maxRunning));
  const runShown = running.slice(0, max - recentReserved);
  const recent = ordered.slice(0, Math.max(0, max - runShown.length));
  return { running: runShown, recent, hidden: agents.length - runShown.length - recent.length };
}
