import { afterEach, describe, expect, it } from 'vitest';

import { createSession, openIndexedDbStore } from '../src/index.js';
import type { ChunkStore, SessionRecord, Sink, StoredChunk } from '../src/index.js';
import { nextFrame, recordingSink, schemaErrors, sleep } from './browser.js';

const dbNames: string[] = [];
async function freshStore(): Promise<ChunkStore> {
  const name = `mmsk-test-${crypto.randomUUID()}`;
  dbNames.push(name);
  const store = await openIndexedDbStore(name);
  if (!store) throw new Error('IndexedDB unavailable');
  return store;
}

afterEach(async () => {
  sessionStorage.clear();
  await Promise.all(
    dbNames.splice(0).map(
      (name) =>
        new Promise<void>((resolve) => {
          const req = indexedDB.deleteDatabase(name);
          req.onsuccess =
            req.onerror =
            req.onblocked =
              () => {
                resolve();
              };
        }),
    ),
  );
});

async function seqsOf(store: ChunkStore, sessionId: string): Promise<number[]> {
  const seqs: number[] = [];
  for await (const chunk of store.chunks(sessionId, 'x.y')) seqs.push(chunk.seq);
  return seqs;
}

function fakeRecord(id: string): SessionRecord {
  return { v: 1, id, streams: [] } as unknown as SessionRecord;
}

describe('IndexedDB store', () => {
  it('writes atomically, pages through chunks in order and deletes one session only', async () => {
    const store = await freshStore();
    const chunks = (sessionId: string, n: number): StoredChunk[] =>
      Array.from({ length: n }, (_, seq) => ({
        sessionId,
        stream: 'x.y',
        seq,
        rows: [[seq, `r${seq}`]],
      }));
    // 40 chunks, written out of order, so paging (16 per read) is exercised.
    const a = chunks('a', 40);
    await store.write(fakeRecord('a'), a.slice(20));
    await store.write(fakeRecord('a'), a.slice(0, 20));
    await store.write(fakeRecord('b'), chunks('b', 3));

    expect(await seqsOf(store, 'a')).toEqual([...Array(40).keys()]);
    expect((await store.load('a'))?.id).toBe('a');

    await store.delete('a');
    expect(await store.load('a')).toBeUndefined();
    expect(await seqsOf(store, 'a')).toEqual([]);
    expect(await seqsOf(store, 'b')).toEqual([0, 1, 2]);
    store.close();
  });
});

describe('session in a real browser', () => {
  it('persists to IndexedDB, resumes after a simulated reload and exports a valid bundle', async () => {
    const store = await freshStore();
    const base = { studyId: 'browser-resume', participantId: 'P1', storage: store };
    const s1 = await createSession(base);
    await s1.consent({ textVersion: 'v1', granted: [] });
    await s1.start();
    expect(s1.persistence).toBe('indexeddb');
    s1.mark('before_reload');
    await s1.flush();

    // "Reload": abandon s1 and create the session again from the same tab state.
    await sleep(30);
    const { sink, result } = recordingSink();
    const s2 = await createSession({ ...base, sinks: [sink] });
    expect(s2.resumed).toBe(true);
    expect(s2.id).toBe(s1.id);
    await s2.start();
    const tFrame = await s2.markOnNextFrame('after_reload');
    const end = await s2.end();
    expect(end.localDataDeleted).toBe(true);

    const { manifest, streams } = await result;
    expect(schemaErrors(manifest)).toBe('');
    expect(manifest.environment.persistence).toBe('indexeddb');
    expect(manifest.clock.segments.map((s) => s.reason)).toEqual(['start', 'reload-resume']);
    expect(manifest.clock.discontinuities[0]?.kind).toBe('reload-gap');
    const markers = streams['task.markers'] ?? [];
    expect(markers.map((m) => [m.name, m.source])).toEqual([
      ['before_reload', 'api'],
      ['after_reload', 'frame'],
    ]);
    expect(markers[1]?.t).toBeCloseTo(tFrame, 3);
    expect(markers[1]?.t as number).toBeGreaterThan(markers[0]?.t as number);
    expect(await store.load(s1.id)).toBeUndefined();
  });

  it('recovers rows that never reached IndexedDB because the page unloaded', async () => {
    const inner = await freshStore();
    let hang = false;
    // While `hang` is set, writes never complete: what an unload does to a pending transaction.
    const store: ChunkStore = {
      kind: 'indexeddb',
      write: (r, c, o) => (hang ? new Promise<void>(() => undefined) : inner.write(r, c, o)),
      load: (id) => inner.load(id),
      chunks: (id, s) => inner.chunks(id, s),
      delete: (id) => inner.delete(id),
      close: () => undefined,
    };
    const base = { studyId: 'browser-spill', participantId: 'P3', storage: store };
    const s1 = await createSession(base);
    await s1.consent({ textVersion: 'v1', granted: [] });
    await s1.start();
    s1.mark('saved');
    await s1.flush();
    hang = true;
    s1.mark('unsaved_1');
    s1.mark('unsaved_2');
    dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
    expect(sessionStorage.getItem(`mmstudykit:spill:${s1.id}`)).not.toBeNull();

    hang = false;
    const { sink, result } = recordingSink();
    const s2 = await createSession({ ...base, sinks: [sink] });
    expect(s2.resumed).toBe(true);
    expect(sessionStorage.getItem(`mmstudykit:spill:${s1.id}`)).toBeNull();
    await s2.start();
    s2.mark('after_reload');
    await s2.end();
    const { manifest, streams } = await result;
    expect(schemaErrors(manifest)).toBe('');
    expect(streams['task.markers']?.map((m) => m.name)).toEqual([
      'saved',
      'unsaved_1',
      'unsaved_2',
      'after_reload',
    ]);
  });

  it('markOnNextFrame resolves with the rAF timestamp of the next frame', async () => {
    const { sink, result } = recordingSink();
    const session = await createSession({
      studyId: 'raf',
      participantId: 'P1',
      storage: 'memory',
      sinks: [sink],
    });
    await session.consent({ textVersion: 'v1', granted: [] });
    await session.start();
    await nextFrame();
    const before = session.now();
    const t = await session.markOnNextFrame('onset');
    // The frame's timestamp is at or after the request (some engines round it to the frame start).
    expect(t).toBeGreaterThanOrEqual(before - 17);
    expect(t).toBeLessThanOrEqual(session.now());
    await session.end();
    expect((await result).streams['task.markers']?.[0]).toMatchObject({
      name: 'onset',
      source: 'frame',
    });
  });

  it('records coarse, real environment info and timer resolution', async () => {
    const { sink, result } = recordingSink();
    const session = await createSession({
      studyId: 'env',
      participantId: 'P1',
      storage: 'memory',
      sinks: [sink],
    });
    await session.consent({ textVersion: 'v1', granted: [] });
    await session.start();
    await session.end();
    const { manifest } = await result;
    const ua = navigator.userAgent;
    const expected = ua.includes('Firefox/')
      ? 'Firefox'
      : ua.includes('HeadlessChrome')
        ? 'HeadlessChrome'
        : ua.includes('Chrome/')
          ? 'Chrome'
          : 'Safari';
    expect(manifest.environment.browser.name).toBe(expected);
    expect(manifest.environment.browser.majorVersion).toBeGreaterThan(10);
    expect(manifest.environment.viewport.width).toBe(innerWidth);
    expect(manifest.clock.measuredResolutionMs).not.toBeNull();
    expect(manifest.clock.measuredResolutionMs).toBeLessThanOrEqual(2);
    expect(JSON.stringify(manifest.environment)).not.toContain(ua);
  });

  it('withdrawal deletes IndexedDB data and survives a reload as withdrawn', async () => {
    const store = await freshStore();
    const deleted: string[] = [];
    const sink: Sink = {
      name: 'remote',
      onWithdraw: (n) => {
        deleted.push(n.sessionId);
        return Promise.resolve();
      },
    };
    const base = {
      studyId: 'browser-withdraw',
      participantId: 'P2',
      storage: store,
      sinks: [sink],
    };
    const s1 = await createSession(base);
    await s1.consent({ textVersion: 'v1', granted: [] });
    await s1.start();
    s1.mark('x');
    await s1.flush();
    const { manifest } = await s1.withdraw();
    expect(schemaErrors(manifest)).toBe('');
    expect(deleted).toEqual([s1.id]);
    const store2 = await openIndexedDbStore(dbNames.at(-1));
    expect(await store2?.load(s1.id)).toBeUndefined();
    const s2 = await createSession({ ...base, storage: store2 ?? 'memory' });
    expect(s2.state).toBe('withdrawn');
    store2?.close();
  });
});
