import { describe, expect, it } from 'vitest';
import { ago, clean, clock, fmtDuration, fmtStats, fmtTokens, saneTime, tokenPhrase } from '../src/core/text';

const HOSTILE: unknown[] = [true, false, -5, 2.5, NaN, Infinity, '12', null, [1], { a: 1 }, 10 ** 40, 10 ** 12 + 1, undefined];

describe('fmtTokens / tokenPhrase / fmtStats (vectors from the Mac tests)', () => {
  it('short numbers', () => {
    const cases: [number, string][] = [[0, '0'], [950, '950'], [999, '999'], [1000, '1k'], [1200, '1.2k'], [9949, '9.9k'], [10000, '10k'], [212345, '212k'], [999499, '999k'], [999500, '1M'], [1_400_000, '1.4M'], [3_100_000, '3.1M'], [2e9, '2B'], [98_500, '99k']];
    for (const [n, t] of cases) expect(fmtTokens(n), String(n)).toBe(t);
    for (const bad of HOSTILE) expect(fmtTokens(bad), String(bad)).toBe('');
  });
  it('token phrase never says 0', () => {
    expect(tokenPhrase(1)).toBe('1 token');
    expect(tokenPhrase(2)).toBe('2 tokens');
    expect(tokenPhrase(0)).toBe('');
    for (const bad of HOSTILE) expect(tokenPhrase(bad)).toBe('');
  });
  it('stats text', () => {
    const a = { toolCalls: 38, tokensNew: 212_345, tokensCache: 3_100_000 };
    expect(fmtStats(a)).toBe('38 steps · 212k tokens');
    expect(fmtStats(a, true)).toBe('38 steps · 212k tokens plus 3.1M cached');
    expect(fmtStats({ toolCalls: 1, tokensNew: null, tokensCache: null }, true)).toBe('1 step');
    expect(fmtStats({ toolCalls: 0 }, true)).toBe('0 steps');
    expect(fmtStats({ toolCalls: 3, tokensNew: 1, tokensCache: 0 })).toBe('3 steps · 1 token');
    expect(fmtStats({ toolCalls: 3, tokensNew: 0, tokensCache: 500 })).toBe('3 steps');
    expect(fmtStats({ toolCalls: 3, tokensNew: 0, tokensCache: 500 }, true)).toBe('3 steps · cached only (500)');
    expect(fmtStats({ toolCalls: 3, tokensNew: 5, tokensCache: 500 }, true)).toBe('3 steps · 5 tokens plus 500 cached');
    expect(fmtStats({ toolCalls: 'x' as unknown as number })).toBe('0 steps');
  });
});

describe('fmtDuration / clock / ago / saneTime', () => {
  it('formats and is bounded', () => {
    expect(fmtDuration(42)).toBe('42s');
    expect(fmtDuration(125)).toBe('2m 05s');
    expect(fmtDuration(3720)).toBe('1h 02m');
    expect(fmtDuration(3725)).toBe('1h 02m');
    expect(fmtDuration(-5)).toBe('0s');
    expect(fmtDuration(NaN)).toBe('?');
    expect(fmtDuration(Infinity)).toBe('?');
    expect(fmtDuration('x')).toBe('?');
    for (const v of [0, 1e3, 1e8, 1e12, 1e300, -1e300, 59.99]) expect(fmtDuration(v).length).toBeLessThanOrEqual(9);
  });
  it('clock is HH:MM or a placeholder', () => {
    expect(clock(1_700_000_000)).toMatch(/^\d\d:\d\d$/);
    for (const bad of [NaN, Infinity, 'x', null, 1e300, undefined]) expect(clock(bad)).toBe('--:--');
  });
  it('ago', () => {
    expect(ago(1000, 1030)).toBe('just now');
    expect(ago(1000, 1000 + 5 * 60)).toBe('5m ago');
    expect(ago(1000, 1000 + 3 * 3600)).toBe('3h ago');
    expect(ago(1000, 1000 + 2 * 86400)).toBe('2d ago');
    expect(ago(0, 99)).toBe('');
    expect(ago(NaN, 99)).toBe('');
  });
  it('clamps absurd times', () => {
    expect(saneTime(1e15, 1000)).toBe(1000);
    expect(saneTime(NaN, 1000)).toBe(1000);
    expect(saneTime(0, 1_800_000_000)).toBe(1_800_000_000 - 366 * 86400);
    expect(saneTime(900, 1000)).toBe(900);
  });
});

describe('clean', () => {
  it('removes control, bidi and zero-width characters but keeps ZWNJ and ZWJ', () => {
    expect(clean('a\nb\tc\u0000d')).toBe('a b c d');
    expect(clean('x\u202Ey\u2066z\u200B\u200E\u061C\uFEFF')).toBe('xyz');
    expect(clean('می\u200Cخواهم')).toBe('می\u200Cخواهم');
    expect(clean('👩\u200D💻')).toBe('👩\u200D💻');
    expect(clean('  many   spaces ')).toBe('many spaces');
    expect(clean(null)).toBe('');
    expect(clean(42)).toBe('42');
  });
  it('cuts by code points', () => {
    expect(clean('😀😀😀😀', 2)).toBe('😀😀');
    expect(clean('x'.repeat(500), 80).length).toBe(80);
  });
});
