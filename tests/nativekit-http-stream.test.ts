import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const custom = vi.hoisted(() => ({
  addListener: vi.fn(async () => ({ remove: async () => undefined })),
  startSSE: vi.fn(async () => undefined),
  stopSSE: vi.fn(async () => undefined),
}));

vi.mock('@nativekit/custom-native', () => ({ NativeKitCustom: custom }));

let nativekit: typeof import('../bridge/nativekit');
const originalFetch = globalThis.fetch;

beforeAll(async () => {
  const config = JSON.parse(readFileSync(new URL('../app.config.json', import.meta.url), 'utf8'));
  const browserGlobals: Record<string, unknown> = {
    __NATIVEKIT_CONFIG__: config,
    window: globalThis,
    location: new URL('https://shell.test/index.html'),
    navigator: {},
    document: { readyState: 'complete', addEventListener: () => undefined },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  };
  // Node 22 exposes navigator through a getter; define configurable test shims explicitly.
  for (const [key, value] of Object.entries(browserGlobals)) {
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  }
  if (!globalThis.CustomEvent) {
    class TestCustomEvent<T = unknown> extends Event {
      detail: T;
      constructor(type: string, init?: CustomEventInit<T>) { super(type); this.detail = init?.detail as T; }
    }
    Object.assign(globalThis, { CustomEvent: TestCustomEvent });
  }
  if (!(globalThis as any).dispatchEvent) Object.assign(globalThis, { dispatchEvent: () => true });
  nativekit = await import('../bridge/nativekit');
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  custom.addListener.mockClear();
  custom.startSSE.mockReset().mockResolvedValue(undefined);
  custom.stopSSE.mockReset().mockResolvedValue(undefined);
});

describe('NativeKit HTTP compatibility helpers', () => {
  it('adds scalar/array query values, preserves existing query/hash, and honors raw values', () => {
    expect(nativekit.withHttpParams(
      new URL('https://api.test/items?fixed=1#part'),
      { q: 'a b', page: 2, tag: ['x/y', 'z'], omitted: null },
    ).toString()).toBe('https://api.test/items?fixed=1&q=a%20b&page=2&tag=x%2Fy&tag=z#part');
    expect(nativekit.withHttpParams(new URL('https://api.test/'), { q: 'a/b' }, false).toString())
      .toBe('https://api.test/?q=a/b');
    expect(() => nativekit.withHttpParams(new URL('https://api.test/'), ['bad']))
      .toThrow(/must be an object/);
  });

  it('selects the browser adapter and native transport exactly from platform/config', () => {
    expect(nativekit.usesCapacitorHttpAdapter(false, false)).toBe(true);
    expect(nativekit.usesCapacitorHttpAdapter(false, true)).toBe(true);
    expect(nativekit.usesCapacitorHttpAdapter(true, true)).toBe(true);
    expect(nativekit.usesCapacitorHttpAdapter(true, false)).toBe(false);
  });

  it('serializes JSON and form bodies through Capacitor buildRequestInit', async () => {
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    globalThis.fetch = vi.fn(async (input, init) => {
      calls.push([input, init]);
      return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain', 'x-test': 'yes' } });
    });

    await nativekit.fetchHttpRequest(new URL('https://api.test/json'), {
      method: 'POST', headers: { 'content-type': 'application/json' }, data: { ok: true }, params: { page: 1 },
    });
    await nativekit.fetchHttpRequest(new URL('https://api.test/form'), {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, data: { a: 'x y', n: 2 },
    });

    expect(String(calls[0][0])).toBe('https://api.test/json?page=1');
    expect(calls[0][1]?.body).toBe('{"ok":true}');
    expect(calls[1][1]?.body).toBe('a=x+y&n=2');
  });

  it('returns JSON, text, and base64 binary with status/headers', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response('{"answer":42}', { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response('plain', { status: 202, headers: { 'content-type': 'text/plain', 'x-mode': 'text' } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([0, 1, 254, 255]), { status: 200, headers: { 'content-type': 'application/octet-stream' } }));

    const json = await nativekit.fetchHttpRequest(new URL('https://api.test/json'), { responseType: 'text' });
    const text = await nativekit.fetchHttpRequest(new URL('https://api.test/text'), { responseType: 'text' });
    const binary = await nativekit.fetchHttpRequest(new URL('https://api.test/binary'), { responseType: 'arraybuffer' });

    expect(json.data).toEqual({ answer: 42 });
    expect(text).toMatchObject({ status: 202, data: 'plain', headers: { 'content-type': 'text/plain', 'x-mode': 'text' } });
    expect(binary.data).toBe('AAH+/w==');
  });
});

describe('NativeKit stream cancellation', () => {
  it('web close aborts fetch, resolves done, and does not report cancellation as an error', async () => {
    let signal: AbortSignal | undefined;
    const onError = vi.fn();
    globalThis.fetch = vi.fn((_input, init) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    });

    const stream = await nativekit.webStream({ url: 'https://api.test/stream' }, { onError });
    await stream.close();
    await expect(stream.done).resolves.toEqual({});
    expect(signal?.aborted).toBe(true);
    expect(onError).not.toHaveBeenCalled();
  });

  it('native close settles done and clears local state even when stop acknowledgement rejects', async () => {
    custom.stopSSE.mockRejectedValueOnce(new Error('native stop failed'));
    const stream = await nativekit.nativeStream({ url: 'https://api.test/stream' }, {});

    await expect(stream.close()).rejects.toThrow('native stop failed');
    await expect(stream.done).resolves.toEqual({});
    expect(custom.startSSE).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://api.test/stream' }));
    expect(custom.stopSSE).toHaveBeenCalledWith({ streamId: stream.id });
  });
});
