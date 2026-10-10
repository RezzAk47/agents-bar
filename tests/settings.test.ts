import { describe, expect, it } from 'vitest';
import { MemoryIO } from '../src/backend/memory';
import { DEFAULT_AGENT_METRIC, defaultSettings, maxRunningFor, mergeSettings, parseSettings, settingsToObject, validated } from '../src/core/settings';
import { SettingsStore } from '../src/core/settingsStore';

describe('settings decode', () => {
  it('defaults: percentage look, 12 agents, 8 repos, cards, ring, glass 100, medium blur, notifications on, PR limit 3', () => {
    expect(defaultSettings()).toEqual({ maxAgents: 12, maxRepos: 8, appearance: 'system', theme: 'classic', layout: 'cards', progress: 'ring', glass: 100, blur: 'medium', notifyFinish: true, prAlert: 3, agentMetric: 'percent' });
    expect(DEFAULT_AGENT_METRIC).toBe('percent');
  });
  it('a bad value falls back to its own default and the rest is kept', () => {
    const p = parseSettings(JSON.stringify({ max_agents: 99, max_repos: 'x', appearance: 'dark', theme: 'nope', layout: 5, progress: 'bar', agent_metric: 'both', glass: 47, blur: 'strong', notify_finish: 'yes', pr_alert: 0 }));
    expect(p.settings).toEqual({ maxAgents: 20, maxRepos: 8, appearance: 'dark', theme: 'classic', layout: 'cards', progress: 'bar', agentMetric: 'both', glass: 45, blur: 'strong', notifyFinish: true, prAlert: 1 });
    expect(p.notes.length).toBeGreaterThan(0);
  });
  it('hostile numbers', () => {
    for (const bad of [true, null, NaN, Infinity, '5', [], {}]) expect(validated({ maxAgents: bad, prAlert: bad, glass: bad })).toMatchObject({ maxAgents: 12, prAlert: 3, glass: 100 });
    expect(validated({ maxAgents: 2.9 }).maxAgents).toBe(3);
    expect(validated({ maxAgents: 7.9 }).maxAgents).toBe(7);
    expect(validated({ glass: -50 }).glass).toBe(0);
    expect(validated({ prAlert: 500 }).prAlert).toBe(20);
  });
  it('unknown keys are kept; a file that is not an object or not JSON is an error; BOM and empty are fine', () => {
    const p = parseSettings('﻿{"usage_rows": 7, "weird": {"a": [1]}, "theme": "ocean"}');
    expect(p.settings.theme).toBe('ocean');
    expect(settingsToObject(p.settings, p.extra)).toMatchObject({ usage_rows: 7, weird: { a: [1] }, theme: 'ocean', agent_metric: 'percent' });
    for (const bad of ['[]', '5', 'nope', '"x"', 'null']) expect(() => parseSettings(bad)).toThrow();
    expect(parseSettings('').settings).toEqual(defaultSettings());
    expect(parseSettings('{"__proto__": {"x": 1}}').settings).toEqual(defaultSettings());
  });
  it('the agent/running split of the limit', () => {
    expect(maxRunningFor(12)).toEqual([8, 4]);
    expect(maxRunningFor(3)).toEqual([2, 1]);
    expect(maxRunningFor(20)).toEqual([13, 7]);
    expect(maxRunningFor(NaN)).toEqual([8, 4]);
  });
  it('merge keeps a hand edit and applies only what the app changed', () => {
    const base = defaultSettings();
    const disk = { ...base, theme: 'grape' as const, maxAgents: 5 };
    const mine = { ...base, maxAgents: 9 };
    expect(mergeSettings(disk, mine, base)).toMatchObject({ theme: 'grape', maxAgents: 9 });
  });
});

describe('SettingsStore', () => {
  it('round trip, unknown keys survive, a file that cannot be read is never overwritten', async () => {
    const io = new MemoryIO();
    await io.write('settings.json', JSON.stringify({ keep_me: 1, theme: 'forest' }));
    const s = new SettingsStore(io);
    await s.init();
    expect(s.settings.theme).toBe('forest');
    await s.update({ agentMetric: 'both' });
    const saved = JSON.parse((await io.read('settings.json'))!);
    expect(saved).toMatchObject({ keep_me: 1, theme: 'forest', agent_metric: 'both' });
    await io.write('settings.json', '{broken');
    const t = new SettingsStore(io);
    await t.init();
    expect(t.loadError).toMatch(/could not be read/);
    await t.update({ theme: 'mono' });
    expect(await io.read('settings.json')).toBe('{broken');
    await t.resetToDefaults();
    expect(t.loadError).toBeNull();
    expect([...io.files.keys()].some((k) => k.startsWith('settings.broken-'))).toBe(true);
  });
  it('missing file means defaults and the first change creates it', async () => {
    const io = new MemoryIO(); const s = new SettingsStore(io);
    await s.init();
    expect(s.settings).toEqual(defaultSettings());
    await s.update({ notifyFinish: false });
    expect(JSON.parse((await io.read('settings.json'))!).notify_finish).toBe(false);
  });
});

describe('settings write races', () => {
  it('a file written by someone else between our read and our write is not overwritten: the save is redone on top of it', async () => {
    const io = new MemoryIO();
    const s = new SettingsStore(io);
    await s.init();
    await s.update({ theme: 'ocean' }); // the file exists now
    const orig = io.read.bind(io);
    let fired = false;
    io.read = async (n: string) => {
      const t = await orig(n);
      if (!fired && n === 'settings.json') { fired = true; await io.write(n, '{"zzz": 1, "max_agents": 5, "theme": "ocean"}\n'); } // another instance, right now
      return t;
    };
    await s.update({ layout: 'compact' });
    const disk = JSON.parse(io.files.get('settings.json')!.text) as Record<string, unknown>;
    expect(disk.zzz).toBe(1); // their key survived
    expect(disk.max_agents).toBe(5); // their value survived
    expect(disk.layout).toBe('compact'); // ours was applied
    expect(s.saveError).toBeNull();
  });
});
