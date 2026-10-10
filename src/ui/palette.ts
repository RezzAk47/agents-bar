// Colours: tokens per theme, light and dark, with every text colour pushed to at least 4.5:1 on the background it sits on
// (WCAG 2.x relative luminance). Pure, so tests check the whole matrix.
import type { Appearance, AppSettings, ThemeName } from '../core/settings';

export type RGB = [number, number, number];
export const hexToRgb = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
export const rgbToHex = (c: RGB): string => '#' + c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('').toUpperCase();
const lin = (v: number) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
export const luminance = (c: RGB): number => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
export function ratio(a: string | RGB, b: string | RGB): number {
  const la = luminance(typeof a === 'string' ? hexToRgb(a) : a), lb = luminance(typeof b === 'string' ? hexToRgb(b) : b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
/** `top` over `bottom` at opacity `a`. */
export const mix = (top: RGB, bottom: RGB, a: number): RGB => [0, 1, 2].map((i) => top[i]! * a + bottom[i]! * (1 - a)) as RGB;

/** The colour nearest to `fg` (towards black on a light background, towards white on a dark one) that reaches `min`:1 on `bg`. */
export function readable(fg: string, bg: string, min = 4.5): string {
  if (ratio(fg, bg) >= min) return fg;
  const target: RGB = luminance(hexToRgb(bg)) > 0.4 ? [0, 0, 0] : [255, 255, 255];
  const f = hexToRgb(fg);
  for (let a = 0.02; a <= 1.0001; a += 0.02) {
    const c = rgbToHex(mix(target, f, a));
    if (ratio(c, bg) >= min) return c;
  }
  return rgbToHex(target);
}

interface Roles { accent: RGB; success: RGB; danger: RGB; warning: RGB; surface: RGB }
// Same roles and values as the Mac bars (settings.py THEMES): light then dark.
const T = (a: RGB, s: RGB, d: RGB, w: RGB, f: RGB, b: RGB, sd: RGB, dd: RGB, wd: RGB, fd: RGB): [Roles, Roles] => [
  { accent: a, success: s, danger: d, warning: w, surface: f }, { accent: b, success: sd, danger: dd, warning: wd, surface: fd }];
export const THEME_ROLES: Record<ThemeName, [Roles, Roles]> = {
  classic: T([255, 149, 0], [52, 199, 89], [255, 59, 48], [255, 149, 0], [247, 247, 247], [255, 159, 10], [48, 209, 88], [255, 69, 58], [255, 159, 10], [38, 38, 38]),
  ocean: T([0, 112, 201], [0, 140, 130], [205, 62, 58], [176, 100, 0], [240, 247, 252], [64, 170, 255], [77, 208, 195], [255, 120, 110], [255, 190, 80], [22, 34, 46]),
  forest: T([70, 125, 30], [0, 121, 107], [191, 54, 12], [180, 100, 0], [241, 248, 241], [139, 195, 74], [38, 198, 168], [255, 138, 101], [255, 183, 77], [24, 38, 28]),
  grape: T([123, 31, 162], [0, 137, 123], [194, 24, 91], [176, 100, 0], [248, 242, 251], [206, 147, 216], [77, 182, 172], [244, 110, 160], [255, 190, 90], [40, 28, 48]),
  mono: T([40, 40, 46], [90, 90, 96], [20, 20, 20], [70, 70, 76], [246, 246, 246], [235, 235, 245], [190, 190, 198], [255, 255, 255], [215, 215, 225], [30, 30, 30]),
};
// Source pill colours (the Mac "Cards" themes: Claude takes the first palette colour, Codex the second).
const SOURCES: Record<ThemeName, [string, string]> = {
  classic: ['#2F7BF5', '#F5871F'], ocean: ['#0A84A8', '#2C6BD6'], forest: ['#2E8B57', '#8A9A2B'], grape: ['#8E44C8', '#C2449B'], mono: ['#5A6270', '#7B8494'],
};
const lighten = (hex: string, a: number) => rgbToHex(mix([255, 255, 255], hexToRgb(hex), a));

export interface Tokens {
  panel: string; card: string; text: string; text2: string; line: string; field: string; fieldBorder: string; button: string; buttonText: string;
  accent: string; accentText: string; ringRunning: string; ringDone: string; ringStalled: string; ringTrack: string;
  claudeFg: string; claudeBg: string; codexFg: string; codexBg: string;
  runningFg: string; runningBg: string; doneFg: string; doneBg: string; stalledFg: string; stalledBg: string;
  badFg: string; goodFg: string; attentionFg: string; attentionBg: string; focus: string;
  /** The far end of the glass layout's background gradient (the near end is `panel`). */
  glassEnd: string;
}

/** The glass card keeps at least this much of its colour (glass 100 %): the card is `1 - glass * 0.55` opaque. */
export const GLASS_MIN_CARD_ALPHA = 0.45;
export const GLASS_FOOTER_ALPHA = 0.7;
export const GLASS_END_MIX = 0.22;

/** Every colour text can end up on in the glass layout, at every glass amount: the panel, the gradient (5 points), the card
 * laid over each of them at alphas from 1 down to the minimum, and the footer. */
export function glassBackgrounds(panel: string, end: string, card: string): string[] {
  const out: string[] = [];
  const [p, e, c] = [hexToRgb(panel), hexToRgb(end), hexToRgb(card)];
  for (let i = 0; i <= 4; i++) {
    const bg = mix(e, p, i / 4); // t = 0 is the panel, 1 the end
    out.push(rgbToHex(bg), rgbToHex(mix(p, bg, GLASS_FOOTER_ALPHA)));
    for (let a = 1; a >= GLASS_MIN_CARD_ALPHA - 1e-9; a -= 0.05) out.push(rgbToHex(mix(c, bg, a)));
  }
  return out;
}

function readableOnAll(fg: string, bgs: string[], min: number): string {
  let c = fg;
  for (let pass = 0; pass < 3; pass++) for (const bg of bgs) c = readable(c, bg, min);
  return c;
}

export const isDark = (appearance: Appearance, systemDark: boolean): boolean => (appearance === 'system' ? systemDark : appearance === 'dark');

export function tokens(theme: ThemeName, layout: AppSettings['layout'], dark: boolean): Tokens {
  const roles = THEME_ROLES[theme][dark ? 1 : 0];
  const h = rgbToHex;
  const tinted = layout === 'solid' || layout === 'glass';
  const panel = tinted ? h(roles.surface) : dark ? '#1E1E1E' : '#F2F2F2';
  const baseText = dark ? '#F2F2F2' : '#1A1A1A';
  const card = h(mix(hexToRgb(baseText), hexToRgb(panel), dark ? 0.1 : 0.06));
  const glassEnd = h(mix(roles.accent, hexToRgb(panel), GLASS_END_MIX));
  // In the glass layout the card is see-through, so text must hold on everything it can end up over.
  const behind = layout === 'glass' ? glassBackgrounds(panel, glassEnd, card) : [card, panel];
  const text = readableOnAll(baseText, behind, 4.5);
  const text2 = readableOnAll(dark ? '#B8B8B8' : '#585858', behind, 4.5);
  const pill = (color: string) => { const bg = h(mix(hexToRgb(color), hexToRgb(card), 0.16)); return { bg, fg: readable(color, bg, 4.5) }; };
  const acc = pill(h(roles.accent)), ok = pill(h(roles.success)), warn = pill(h(roles.warning));
  const [claudeBase, codexBase] = SOURCES[theme];
  const claude = pill(dark ? lighten(claudeBase, 0.28) : claudeBase), codex = pill(dark ? lighten(codexBase, 0.28) : codexBase);
  const bad = readableOnAll(h(roles.danger), behind, 4.5);
  const attBg = h(mix(hexToRgb(h(roles.danger)), hexToRgb(card), 0.14));
  const button = h(mix(hexToRgb(text), hexToRgb(card), dark ? 0.16 : 0.1));
  return {
    panel, card, text, text2, line: readable(dark ? '#5A5A5A' : '#B8B8B8', panel, 1.6), field: dark ? '#141414' : '#FFFFFF', fieldBorder: dark ? '#8A8A8A' : '#7A7A7A',
    button, buttonText: readable(text, button, 4.5),
    accent: acc.fg, accentText: acc.fg, ringRunning: readable(h(roles.accent), card, 3), ringDone: readable(h(roles.success), card, 3), ringStalled: readable(h(roles.warning), card, 3),
    ringTrack: h(mix(hexToRgb(text), hexToRgb(card), 0.16)),
    claudeFg: claude.fg, claudeBg: claude.bg, codexFg: codex.fg, codexBg: codex.bg,
    runningFg: acc.fg, runningBg: acc.bg, doneFg: ok.fg, doneBg: ok.bg, stalledFg: warn.fg, stalledBg: warn.bg,
    badFg: bad, goodFg: readableOnAll(h(roles.success), behind, 4.5), glassEnd, attentionFg: readable(h(roles.danger), attBg, 4.5), attentionBg: attBg,
    focus: readable(h(roles.accent), panel, 3),
  };
}

const kebab = (k: string) => k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
export function cssVars(t: Tokens): Record<string, string> {
  return Object.fromEntries(Object.entries(t).map(([k, v]) => [`--${kebab(k)}`, v]));
}
