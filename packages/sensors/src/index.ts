/**
 * @mmstudykit/sensors: pointer, keyboard and page sensors.
 *
 * Each sensor is also available as a subpath (`@mmstudykit/sensors/pointer`, …). They have no
 * dependencies and share nothing at runtime, so importing one doesn't pull in the others.
 */
export { keyboard, KEY_CATEGORIES, keyCategory } from './keyboard.js';
export type { KeyboardOptions, KeyCategory } from './keyboard.js';
export { page } from './page.js';
export type { PageOptions } from './page.js';
export { pointer } from './pointer.js';
export type { PointerOptions } from './pointer.js';
export { SENSORS_VERSION } from './version.js';
