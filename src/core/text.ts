// Text helpers shared by every part of the app. Port of agents_core.py (_clean, fmt_*, clock) with bounded outputs.

const CONTROL = /[\u0000-\u001f\u007f]/g;
// Characters that reorder or hide text: bidi embeddings/isolates/marks and zero-width spaces.
// U+200C ZWNJ and U+200D ZWJ stay: Persian spelling and emoji need them and they hide nothing.
const INVISIBLE = /[‪-‮⁦-⁩​‎‏؜⁠-⁤﻿᠎­]/g;

export const MAX_AGE_CLAMP = 366 * 86400;
export const MAX_TOKEN_FIELD = 1e12;

/** Cuts to `limit` code points (never in the middle of a surrogate pair). */
export function cutChars(s: string, limit: number): string {
  if (s.length <= limit) return s; // fewer UTF-16 units than the limit: certainly fewer code points
  const chars = Array.from(s);
  return chars.length <= limit ? s : chars.slice(0, limit).join('');
}

/** A one-line printable string from anything: control characters, bidi and zero-width characters removed. */
export function clean(value: unknown, limit?: number): string {
  const raw = typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
  const s = raw ? raw.replace(CONTROL, ' ').replace(INVISIBLE, '').split(/[\s\u0085]+/).filter(Boolean).join(' ') : '';
  return limit ? cutChars(s, limit) : s;
}

/** A token count: a plain non-negative integer up to 1e12, else null (booleans, floats, strings, NaN ...). */
export function count(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_TOKEN_FIELD) return null;
  return value;
}

export function fmtDuration(seconds: unknown): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return '?';
  if (seconds > MAX_AGE_CLAMP) return '>1y';
  const t = Math.max(0, Math.trunc(seconds));
  if (t < 60) return `${t}s`;
  const m = Math.floor(t / 60), s = t % 60;
  if (m < 60) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** 950, 1.2k, 212k, 1.4M: a short token count, rounded half up. '' for a missing or invalid count. */
export function fmtTokens(value: unknown): string {
  const n = count(value);
  if (n === null) return '';
  if (n < 1000) return String(n);
  const units: [string, number][] = [['k', 1e3], ['M', 1e6], ['B', 1e9], ['T', 1e12]];
  for (const [unit, size] of units) {
    const whole = Math.floor((n + size / 2) / size); // exact: sizes are multiples of 2 and n is an integer below 2^53
    if (whole < 1000 || unit === 'T') {
      const tenths = Math.floor((n * 10 + size / 2) / size);
      if (tenths < 100) return `${Math.floor(tenths / 10)}${tenths % 10 ? `.${tenths % 10}` : ''}${unit}`;
      return `${whole}${unit}`;
    }
  }
  return String(n);
}

/** '212k tokens', '1 token'; '' when the count is missing, invalid or zero. */
export function tokenPhrase(value: unknown): string {
  const text = fmtTokens(value);
  if (!text || count(value) === 0) return '';
  return value === 1 ? '1 token' : `${text} tokens`;
}

export interface StatsLike { toolCalls?: unknown; tokensNew?: unknown; tokensCache?: unknown }

/** '38 steps · 212k tokens' (Codex without counts: '38 steps'). withCache adds 'plus 3.1M cached'. */
export function fmtStats(a: StatsLike, withCache = false): string {
  const steps = typeof a.toolCalls === 'number' && Number.isInteger(a.toolCalls) && a.toolCalls >= 0 ? a.toolCalls : 0;
  const parts = [`${steps} step${steps === 1 ? '' : 's'}`];
  const fresh = tokenPhrase(a.tokensNew);
  const cacheN = count(a.tokensCache) ? fmtTokens(a.tokensCache) : '';
  if (fresh) parts.push(fresh);
  else if (withCache && cacheN) parts.push(`cached only (${cacheN})`);
  let text = parts.join(' · ');
  if (withCache && cacheN && fresh) text += ` plus ${cacheN} cached`;
  return text;
}

/** HH:MM local time for an epoch time (seconds), or '--:--' when it is missing or absurd. */
export function clock(ts: unknown): string {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return '--:--';
  const d = new Date(ts * 1000);
  if (Number.isNaN(d.getTime())) return '--:--';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 'just now', '5m ago', '3h ago', '2d ago', '4w ago', '8mo ago', '2y ago'. */
export function ago(epoch: unknown, now: number): string {
  if (typeof epoch !== 'number' || !Number.isFinite(epoch) || !(epoch > 0)) return '';
  const s = Math.max(0, Math.trunc(now - epoch));
  for (const [unit, size] of [['y', 31536000], ['mo', 2592000], ['w', 604800], ['d', 86400], ['h', 3600], ['m', 60]] as const) {
    if (s >= size) return `${Math.floor(s / size)}${unit} ago`;
  }
  return 'just now';
}

/** A transcript time kept inside [now - a year, now]. */
export function saneTime(ts: unknown, now: number): number {
  const t = typeof ts === 'number' ? ts : Number.NaN;
  if (!Number.isFinite(t)) return now;
  return Math.max(now - MAX_AGE_CLAMP, Math.min(t, now));
}

export const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
