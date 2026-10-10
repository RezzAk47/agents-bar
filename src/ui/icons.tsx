// Small inline SVG icons (no icon font, no remote files). All are decorative: the text next to them says the same.
const base = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' } as const;
type P = { class?: string; width?: number; height?: number };

export const Play = (p: P) => <svg {...base} {...p}><circle cx="8" cy="8" r="6" fill="currentColor" stroke="none" /><path d="M6.6 5.4l3.6 2.6-3.6 2.6z" fill="var(--pill-bg, #fff)" stroke="none" /></svg>;
export const Tick = (p: P) => <svg {...base} {...p}><circle cx="8" cy="8" r="6" fill="currentColor" stroke="none" /><path d="M5.2 8.3l2 2 3.6-4" stroke="var(--pill-bg, #fff)" /></svg>;
export const Pause = (p: P) => <svg {...base} {...p}><circle cx="8" cy="8" r="6" fill="currentColor" stroke="none" /><path d="M6.6 5.6v4.8M9.4 5.6v4.8" stroke="var(--pill-bg, #fff)" /></svg>;
export const Gear = (p: P) => <svg {...base} {...p}><circle cx="8" cy="8" r="5.4" stroke-width="2.6" stroke-dasharray="2.1 2.1" /><circle cx="8" cy="8" r="4" /><circle cx="8" cy="8" r="1.7" /></svg>;
export const Refresh = (p: P) => <svg {...base} {...p}><path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5v2.8h-2.8" /></svg>;
export const Chevron = (p: P) => <svg {...base} {...p}><path d="M6 3.5L10.5 8 6 12.5" /></svg>;
export const Back = (p: P) => <svg {...base} {...p}><path d="M10 3.5L5.5 8 10 12.5" /></svg>;
export const Lock = (p: P) => <svg {...base} {...p}><rect x="3.5" y="7" width="9" height="6.5" rx="1.5" /><path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" /></svg>;
export const Alert = (p: P) => <svg {...base} {...p}><path d="M8 2.2L14.2 13H1.8z" fill="currentColor" stroke="none" /><path d="M8 6.5v3M8 11.2v.2" stroke="var(--pill-bg, #fff)" /></svg>;
export const Power = (p: P) => <svg {...base} {...p}><path d="M8 2v6M4.6 4.4a5.2 5.2 0 1 0 6.8 0" /></svg>;
