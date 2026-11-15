/**
 * Random RFC 4122 version-4 UUID.
 *
 * `crypto.randomUUID()` is only exposed in secure contexts. `crypto.getRandomValues()` is
 * available everywhere, so it's the fallback for studies served over plain http.
 */
export function randomId(): string {
  const c = globalThis.crypto as Partial<Crypto> & Pick<Crypto, 'getRandomValues'>;
  if (typeof c.randomUUID === 'function') return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
