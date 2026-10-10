import { describe, expect, it } from 'vitest';
import { LAYOUTS, THEMES } from '../src/core/settings';
import { hexToRgb, ratio, readable, tokens, cssVars, mix, rgbToHex } from '../src/ui/palette';

describe('palette: every text colour reaches 4.5:1 on what it sits on (all themes, layouts, light and dark)', () => {
  for (const theme of THEMES) for (const layout of LAYOUTS) for (const dark of [false, true]) {
    it(`${theme} / ${layout} / ${dark ? 'dark' : 'light'}`, () => {
      const t = tokens(theme, layout, dark);
      const on = (fg: string, bg: string, min: number, what: string) => expect(ratio(fg, bg), `${what}: ${fg} on ${bg}`).toBeGreaterThanOrEqual(min);
      on(t.text, t.panel, 4.5, 'text/panel'); on(t.text, t.card, 4.5, 'text/card'); on(t.text2, t.card, 4.5, 'text2/card'); on(t.text2, t.panel, 4.5, 'text2/panel');
      on(t.buttonText, t.button, 4.5, 'button'); on(t.text, t.field, 4.5, 'field');
      on(t.claudeFg, t.claudeBg, 4.5, 'claude pill'); on(t.codexFg, t.codexBg, 4.5, 'codex pill');
      on(t.runningFg, t.runningBg, 4.5, 'running pill'); on(t.doneFg, t.doneBg, 4.5, 'done pill'); on(t.stalledFg, t.stalledBg, 4.5, 'stalled pill');
      on(t.badFg, t.card, 4.5, 'CI failing text'); on(t.goodFg, t.card, 4.5, 'CI passing text'); on(t.attentionFg, t.attentionBg, 4.5, 'needs attention');
      on(t.accent, t.card, 4.5, 'accent text');
      for (const ring of [t.ringRunning, t.ringDone, t.ringStalled]) on(ring, t.card, 3, 'ring (non-text 3:1)');
      on(t.fieldBorder, t.field, 3, 'input border'); on(t.focus, t.panel, 3, 'focus ring');
    });
  }
  it('readable() leaves a good colour alone and fixes a bad one', () => {
    expect(readable('#000000', '#FFFFFF')).toBe('#000000');
    expect(ratio(readable('#FFFF00', '#FFFFFF'), '#FFFFFF')).toBeGreaterThanOrEqual(4.5);
    expect(ratio(readable('#101010', '#000000'), '#000000')).toBeGreaterThanOrEqual(4.5);
    expect(hexToRgb('#0A0B0C')).toEqual([10, 11, 12]);
  });
  it('css variables are kebab-cased', () => { expect(cssVars(tokens('classic', 'cards', false))['--ring-running']).toMatch(/^#/); });
});

describe('glass layout: text holds 4.5:1 over the translucent card at every glass amount and over the gradient', () => {
  // The CSS (styles.css): body = linear-gradient(160deg, panel, glassEnd); card = card colour at alpha (1 - glass * 0.55);
  // footer = panel at 70 %. Checked here with the formula written out again, not with palette.ts's own helper.
  const over = (top: string, bottom: string, a: number) => rgbToHex(mix(hexToRgb(top), hexToRgb(bottom), a));
  for (const theme of THEMES) for (const dark of [false, true]) {
    it(`${theme} ${dark ? 'dark' : 'light'}`, () => {
      const t = tokens(theme, 'glass', dark);
      const worst: string[] = [];
      for (let glass = 0; glass <= 100; glass += 5) {
        for (const pos of [0, 0.25, 0.5, 0.75, 1]) {
          const backdrop = over(t.glassEnd, t.panel, pos);
          const cardEff = over(t.card, backdrop, 1 - (glass / 100) * 0.55);
          const footer = over(t.panel, backdrop, 0.7);
          for (const [name, fg] of [['text', t.text], ['text2', t.text2], ['bad', t.badFg], ['good', t.goodFg]] as const) {
            for (const [where, bg] of [['card', cardEff], ['body', backdrop], ['footer', footer]] as const) {
              const r = ratio(fg, bg);
              if (r < 4.5) worst.push(`${name} on ${where} glass ${glass} pos ${pos}: ${r.toFixed(2)}`);
            }
          }
        }
      }
      expect(worst, worst.slice(0, 5).join('; ')).toEqual([]);
    });
  }
});
