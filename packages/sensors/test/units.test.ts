import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { keyCategory, SENSORS_VERSION } from '../src/index.js';

describe('keyCategory', () => {
  it.each([
    ['a', 'letter'],
    ['Z', 'letter'],
    ['é', 'letter'],
    ['ж', 'letter'],
    ['あ', 'letter'],
    ['5', 'digit'],
    ['٣', 'digit'],
    ['.', 'punctuation'],
    ['?', 'punctuation'],
    ['€', 'punctuation'],
    [' ', 'space'],
    ['Enter', 'enter'],
    ['Tab', 'tab'],
    ['Backspace', 'backspace'],
    ['Delete', 'delete'],
    ['ArrowLeft', 'navigation'],
    ['PageDown', 'navigation'],
    ['Shift', 'modifier'],
    ['Meta', 'modifier'],
    ['CapsLock', 'modifier'],
    ['Dead', 'composition'],
    ['Process', 'composition'],
    ['Escape', 'other'],
    ['F5', 'other'],
    ['Unidentified', 'other'],
  ])('%j → %s', (key, category) => {
    expect(keyCategory(key)).toBe(category);
  });

  it('treats anything during IME composition as composition', () => {
    expect(keyCategory('a', true)).toBe('composition');
  });
});

describe('version', () => {
  it('SENSORS_VERSION matches package.json', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '../package.json'), 'utf8')) as {
      version: string;
    };
    expect(SENSORS_VERSION).toBe(pkg.version);
  });
});
