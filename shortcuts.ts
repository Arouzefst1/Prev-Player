// ==========================================================================
// Keyboard shortcuts — what each player key does, and the user's own choices.
//
// A binding is a combo string: optional "Ctrl+", "Alt+", "Shift+" and the key
// ("K", "ArrowRight", ">"). Shift is only spelled out for letters and named
// keys — for punctuation it is already in the character ("Shift+." is ">").
// Space (tap to play, hold for 2×), 0–9 (jump to 0–90%) and Esc stay fixed:
// they behave differently from a plain press and everyone expects them.
// ==========================================================================

import { useSettings, settingsStore } from './settings';

export type ShortcutAction =
  | 'playPause' | 'forward5' | 'back5' | 'back10' | 'volumeUp' | 'volumeDown' | 'mute'
  | 'loop' | 'fullscreen' | 'pip' | 'queue' | 'next' | 'prev' | 'subtitles'
  | 'faster' | 'slower' | 'stats';

export const SHORTCUTS: { id: ShortcutAction; label: string; key: string }[] = [
  { id: 'playPause', label: 'Play / pause', key: 'K' },
  { id: 'forward5', label: 'Forward 5 seconds', key: 'ArrowRight' },
  { id: 'back5', label: 'Back 5 seconds', key: 'ArrowLeft' },
  { id: 'back10', label: 'Back 10 seconds', key: 'J' },
  { id: 'volumeUp', label: 'Volume up', key: 'ArrowUp' },
  { id: 'volumeDown', label: 'Volume down', key: 'ArrowDown' },
  { id: 'mute', label: 'Mute', key: 'M' },
  { id: 'faster', label: 'Faster', key: '>' },
  { id: 'slower', label: 'Slower', key: '<' },
  { id: 'loop', label: 'Loop', key: 'L' },
  { id: 'subtitles', label: 'Subtitles on / off', key: 'C' },
  { id: 'fullscreen', label: 'Fullscreen', key: 'F' },
  { id: 'pip', label: 'Mini player', key: 'P' },
  { id: 'queue', label: 'Queue', key: 'Q' },
  { id: 'next', label: 'Next video', key: 'N' },
  { id: 'prev', label: 'Previous video', key: 'B' },
  { id: 'stats', label: 'Stats for nerds', key: 'I' },
];

/** Shown in Settings, but not rebindable. */
export const FIXED_SHORTCUTS: { label: string; keys: string }[] = [
  { label: 'Play / pause — hold for 2× speed', keys: 'Space' },
  { label: 'Jump to 0% … 90%', keys: '0 – 9' },
  { label: 'Leave fullscreen / mini player', keys: 'Esc' },
];

const DEFAULTS = Object.fromEntries(SHORTCUTS.map(s => [s.id, s.key])) as Record<ShortcutAction, string>;

/**
 * Keys a combo can't be: fixed above, modifiers on their own, or F5 / Ctrl+R,
 * which App turns into a clean "go home" instead of a WebView reload.
 */
const RESERVED = new Set([' ', 'Escape', 'Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Tab', 'Dead', 'Unidentified',
  'F5', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9']);

const NAMED = /^[A-Z][a-zA-Z0-9]+$/; // ArrowRight, PageUp, F5, Home…

/** The combo a key press spells, or null for a key that can't be bound. */
export function comboOf(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>): string | null {
  if (RESERVED.has(e.key)) return null;
  if ((e.ctrlKey || e.metaKey) && /^r$/i.test(e.key)) return null;
  const letter = /^[a-z]$/i.test(e.key);
  const named = e.key.length > 1 && NAMED.test(e.key);
  if (e.key.length > 1 && !named) return null;
  // "+" would collide with the separator.
  const key = letter ? e.key.toUpperCase() : e.key === '+' ? 'Plus' : e.key;
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey && (letter || named)) parts.push('Shift');
  parts.push(key);
  return parts.join('+');
}

export function bindingsOf(custom: Partial<Record<ShortcutAction, string>> | undefined): Record<ShortcutAction, string> {
  return { ...DEFAULTS, ...custom };
}

/**
 * Which action a key press triggers. A letter pressed with Shift (or Caps Lock)
 * still counts as the plain letter unless Shift+letter is bound to something —
 * "K" and "k" both played and paused before shortcuts became editable.
 */
export function actionFor(e: KeyboardEvent, bindings = bindingsOf(settingsStore.get().shortcuts)): ShortcutAction | null {
  const combo = comboOf(e);
  if (!combo) return null;
  const byCombo = new Map<string, ShortcutAction>();
  (Object.keys(bindings) as ShortcutAction[]).forEach(id => { if (bindings[id]) byCombo.set(bindings[id], id); });
  return byCombo.get(combo) ?? (combo.startsWith('Shift+') ? byCombo.get(combo.slice(6)) ?? null : null);
}

const PRETTY: Record<string, string> = {
  ArrowRight: '→', ArrowLeft: '←', ArrowUp: '↑', ArrowDown: '↓',
  PageUp: 'Page Up', PageDown: 'Page Down', Backspace: '⌫', Delete: 'Del', Enter: '↵', Plus: '+',
};

/** "Shift+ArrowRight" → "Shift + →". */
export function prettyCombo(combo: string | undefined): string {
  if (!combo) return '—';
  return combo.split('+').map(p => PRETTY[p] ?? p).join(' + ');
}

/** The current key for one action, for menus and tooltips ("" when it has none). */
export function useShortcutKey(action: ShortcutAction): string {
  return useShortcutKeys()[action];
}

/** Every action's current key, pretty-printed ("" when it has none). */
export function useShortcutKeys(): Record<ShortcutAction, string> {
  const [settings] = useSettings();
  const bindings = bindingsOf(settings.shortcuts);
  return Object.fromEntries(SHORTCUTS.map(s => [s.id, bindings[s.id] ? prettyCombo(bindings[s.id]) : ''])) as Record<ShortcutAction, string>;
}

/** "Fullscreen (F)" — or just "Fullscreen" when the action has no key. */
export const withKey = (label: string, key: string | undefined) => (key ? `${label} (${key})` : label);
