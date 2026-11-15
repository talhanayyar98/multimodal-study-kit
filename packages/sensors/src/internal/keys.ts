/**
 * Coarse key categories: the only thing the keyboard sensor records about a key by default.
 *
 * The set is deliberately small. Categories carry no character identity: "letter" covers every
 * letter of every script, "digit" every decimal digit. Punctuation is kept separate because
 * pauses at sentence boundaries matter in writing research.
 */
export const KEY_CATEGORIES = [
  'letter',
  'digit',
  'punctuation',
  'space',
  'enter',
  'tab',
  'backspace',
  'delete',
  'navigation',
  'modifier',
  'composition',
  'other',
] as const;

export type KeyCategory = (typeof KEY_CATEGORIES)[number];

const MODIFIERS = new Set([
  'Shift',
  'Control',
  'Alt',
  'AltGraph',
  'Meta',
  'OS',
  'Super',
  'Hyper',
  'CapsLock',
  'NumLock',
  'ScrollLock',
  'Fn',
  'FnLock',
  'Symbol',
  'SymbolLock',
]);

const NAVIGATION = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);

const LETTER = /^\p{L}\p{M}*$/u;
const DIGIT = /^\p{Nd}$/u;
const PUNCTUATION = /^[\p{P}\p{S}]$/u;

/** Category of a `KeyboardEvent`, from `key` (and `isComposing` for IMEs). */
export function keyCategory(key: string, isComposing = false): KeyCategory {
  // IME composition (CJK input etc.) reports key "Process"; dead keys build accented letters.
  if (isComposing || key === 'Process' || key === 'Dead') return 'composition';
  if (key === ' ' || key === 'Spacebar') return 'space';
  if (key === 'Enter') return 'enter';
  if (key === 'Tab') return 'tab';
  if (key === 'Backspace') return 'backspace';
  if (key === 'Delete') return 'delete';
  if (NAVIGATION.has(key)) return 'navigation';
  if (MODIFIERS.has(key)) return 'modifier';
  if (LETTER.test(key)) return 'letter';
  if (DIGIT.test(key)) return 'digit';
  if (PUNCTUATION.test(key)) return 'punctuation';
  return 'other';
}

const SENSITIVE_AUTOCOMPLETE = new Set([
  'current-password',
  'new-password',
  'one-time-code',
  'cc-number',
  'cc-csc',
  'cc-exp',
  'cc-exp-month',
  'cc-exp-year',
]);

/**
 * True for fields whose keystrokes are never recorded, not even their timing: password inputs,
 * inputs whose `autocomplete` marks them as passwords, one-time codes or card details, and
 * anything inside `[data-mmsk-ignore]`.
 */
export function isSensitiveTarget(target: EventTarget | null): boolean {
  if (!target || typeof Element === 'undefined' || !(target instanceof Element)) return false;
  if (target.closest('[data-mmsk-ignore]')) return true;
  if (target instanceof HTMLInputElement) {
    if (target.type === 'password') return true;
    const tokens = (target.getAttribute('autocomplete') ?? '').toLowerCase().split(/\s+/);
    if (tokens.some((t) => SENSITIVE_AUTOCOMPLETE.has(t))) return true;
  }
  return false;
}

/** The real target of an event, looking through open shadow roots. */
export function eventTarget(event: Event): EventTarget | null {
  return event.composedPath()[0] ?? event.target;
}
