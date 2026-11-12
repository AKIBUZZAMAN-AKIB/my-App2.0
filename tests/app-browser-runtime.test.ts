import { IDBKeyRange as FakeIDBKeyRange, indexedDB as fakeIndexedDB } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import {
  boundedJson,
  createAppBrowser,
  createAppBrowserMethodTable,
  discardSandboxDownload,
  enforceSandboxDatabaseQuota,
  getAppBrowserPermissionDecision,
  isAppBrowserMethodAllowed,
  sandboxDestinationState,
  sandboxFilesystemUsage,
  releaseScheduledSandboxState,
  runWithDurablePrecondition,
  serializeError,
  saveInstalledAppAndPolicy,
  writeOwnedStorage,
} from '../bridge/app-browser';

Object.defineProperties(globalThis, {
  indexedDB: { configurable: true, value: fakeIndexedDB },
  IDBKeyRange: { configurable: true, value: FakeIDBKeyRange },
});

const appBrowserConfig = (overrides: Record<string, any> = {}) => ({
  enabled: true,
  maxApps: 100,
  maxPackageBytes: 1_048_576,
  maxFiles: 100,
  auditLogLimit: 100,
  maxRequestsPerMinute: 100,
  defaultCapabilities: [],
  allowDirectWebNetwork: false,
  urlMode: { enabled: false, allowedHosts: [] },
  renderer: 'iframe',
  permissionPrompts: {
    enabled: true,
    requestTimeoutMs: 90_000,
    requestedCapabilityDefault: 'ask',
    unrequestedCapabilityDefault: 'block',
  },
  isolated: {
    enabled: false,
    fallbackToIframe: true,
    stageChunkBytes: 262_144,
    androidMinApi: 28,
    hangTerminationDelayMs: 5_000,
  },
  ...overrides,
}) as any;

function installHostWindow(): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { addEventListener: vi.fn(), dispatchEvent: vi.fn(), open: vi.fn() },
  });
}

function minimalNativeKit(overrides: Record<string, any> = {}): any {
  return {
    isNative: false,
    config: {
      features: { filesystem: false, localNotifications: false, advancedAlarms: false },
      backgroundRunner: { defaultSyncUrl: '' },
    },
    preferences: { keys: vi.fn(async () => ({ keys: [] })), remove: vi.fn(async () => undefined) },
    secureStorage: { remove: vi.fn(async () => undefined) },
    sqlite: { delete: vi.fn(async () => undefined) },
    backgroundLocation: { status: vi.fn(async () => ({ running: false })), stop: vi.fn(async () => undefined) },
    notifications: {
      pending: vi.fn(async () => ({ notifications: [] })),
      delivered: vi.fn(async () => ({ notifications: [] })),
      cancel: vi.fn(async () => undefined),
      removeDelivered: vi.fn(async () => undefined),
    },
    alarms: { list: vi.fn(async () => ({ alarms: [] })), cancel: vi.fn(async () => undefined) },
    ...overrides,
  };
}

async function installRuntimeTestApp(host: any, appId: string): Promise<void> {
  await host.install({
    files: [{ path: 'index.html', data: '<!doctype html><title>test</title>' }],
    manifest: { id: appId, name: 'Runtime test', version: '1.0.0', entry: 'index.html', requestedCapabilities: [], allowedHosts: [] },
  });
}

describe('App Browser runtime bounds', () => {
  it('aborts the package and policy transaction when either write cannot be queued', async () => {
    const id = `test.atomic-${crypto.randomUUID()}`;
    const app = { id, manifest: {}, files: [], integrity: 'test', installedAt: '', updatedAt: '', totalBytes: 0 };
    await expect(saveInstalledAppAndPolicy(app as any, { enabled: false } as any)).rejects.toBeTruthy();

    const stored = await new Promise<unknown>((resolve, reject) => {
      const request = fakeIndexedDB.open('nativekit-app-browser-v1', 4);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction('apps', 'readonly');
        const get = transaction.objectStore('apps').get(id);
        get.onsuccess = () => resolve(get.result);
        get.onerror = () => reject(get.error);
        transaction.oncomplete = () => db.close();
      };
    });
    expect(stored).toBeUndefined();
  });

  it('returns a detached JSON clone and rejects cycles or oversized data', () => {
    const original = { nested: { ok: true }, omitted: undefined };
    const clone = boundedJson(original, 1_024) as { nested: { ok: boolean } };
    original.nested.ok = false;
    expect(clone).toEqual({ nested: { ok: true } });

    const cyclic: any = {}; cyclic.self = cyclic;
    expect(() => boundedJson(cyclic, 1_024, 'RPC test')).toThrow(/JSON-serializable/);
    expect(() => boundedJson('é'.repeat(10), 10, 'RPC test')).toThrow(/exceeds 10/);
  });

  it('durably commits ownership before the native write and rolls back a new record on failure', async () => {
    const appId = `test.storage-${crypto.randomUUID()}`;
    let ownershipWasVisible = false;
    await writeOwnedStorage(appId, 'preference', 'durable', async () => {
      ownershipWasVisible = await new Promise<boolean>((resolve, reject) => {
        const request = fakeIndexedDB.open('nativekit-app-browser-v1', 4);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const transaction = db.transaction('resources', 'readonly');
          const get = transaction.objectStore('resources').get(`preference:${appId}:durable`);
          get.onsuccess = () => resolve(!!get.result);
          get.onerror = () => reject(get.error);
          transaction.oncomplete = () => db.close();
        };
      });
    });
    expect(ownershipWasVisible).toBe(true);

    const failingAppId = `test.storage-${crypto.randomUUID()}`;
    await expect(writeOwnedStorage(failingAppId, 'preference', 'failed', async () => { throw new Error('native write failed'); })).rejects.toThrow('native write failed');

    for (let index = 0; index < 64; index += 1) {
      const result = await writeOwnedStorage(failingAppId, 'preference', `key-${index}`, async (nativeKey) => nativeKey);
      expect(result).toContain(`nativekit.appBrowser.${failingAppId}.key-${index}`);
    }
    await expect(writeOwnedStorage(failingAppId, 'preference', 'overflow', async () => undefined)).rejects.toThrow(/At most 64 preference keys/);
  });
});

describe('App Browser filesystem accounting failures', () => {
  it('treats only positively identified missing roots and destinations as absent', async () => {
    const nativeKit = {
      filesystem: {
        readdir: vi.fn(async () => { throw Object.assign(new Error('File does not exist'), { code: 'OS-PLUG-FILE-0008' }); }),
        stat: vi.fn(async () => { throw Object.assign(new Error('Not found'), { code: 'OS-PLUG-FILE-0008' }); }),
      },
    };
    await expect(sandboxFilesystemUsage(nativeKit, 'thirdparty.test')).resolves.toEqual({ bytes: 0, files: 0 });
    await expect(sandboxDestinationState(nativeKit, 'Data', 'missing.txt')).resolves.toEqual({ exists: false, size: 0 });
  });

  it('fails closed when a quota scan or destination probe has an unexpected native error', async () => {
    const scanFailure = new Error('native permission failure');
    const statFailure = new Error('native stat failure');
    await expect(sandboxFilesystemUsage({ filesystem: { readdir: vi.fn(async () => { throw scanFailure; }) } }, 'thirdparty.test')).rejects.toBe(scanFailure);
    await expect(sandboxDestinationState({ filesystem: { stat: vi.fn(async () => { throw statFailure; }) } }, 'Data', 'unknown.txt')).rejects.toBe(statFailure);
    await expect(sandboxDestinationState({ filesystem: { stat: vi.fn(async () => ({ type: 'file', size: Number.NaN })) } }, 'Data', 'invalid.txt')).rejects.toThrow(/Invalid filesystem size/);
  });
});

describe('App Browser policy precedence', () => {
  it('allows a method decision under ask/allow capability state, while app disable remains absolute', () => {
    const policy = { enabled: true, capabilityDecisions: { camera: 'ask' }, methodDecisions: { 'camera.pickImages': 'allow', 'camera.getPhoto': 'ask' } } as any;
    expect(isAppBrowserMethodAllowed(policy, 'camera.pickImages', 'camera')).toBe(true);
    expect(isAppBrowserMethodAllowed(policy, 'camera.getPhoto', 'camera')).toBe(false);
    expect(isAppBrowserMethodAllowed(policy, 'camera.getLimitedLibraryPhotos', 'camera')).toBe(false);
    policy.enabled = false;
    expect(isAppBrowserMethodAllowed(policy, 'camera.pickImages', 'camera')).toBe(false);
  });

  it('treats capability block as master revocation over a stale method allow', () => {
    const policy = { enabled: true, capabilityDecisions: { camera: 'block' }, methodDecisions: { 'camera.pickImages': 'allow' } } as any;
    expect(getAppBrowserPermissionDecision(policy, 'camera.pickImages', 'camera')).toBe('block');
    expect(isAppBrowserMethodAllowed(policy, 'camera.pickImages', 'camera')).toBe(false);
  });
});

describe('App Browser audit precondition', () => {
  it('does not execute a native operation when durable pre-operation audit persistence fails', async () => {
    const auditFailure = new Error('audit store unavailable');
    const operation = vi.fn(async () => 'native result');
    await expect(runWithDurablePrecondition(async () => { throw auditFailure; }, operation)).rejects.toBe(auditFailure);
    expect(operation).not.toHaveBeenCalled();
  });

  it('starts the operation only after the durable audit promise completes', async () => {
    const order: string[] = [];
    await expect(runWithDurablePrecondition(
      async () => { await Promise.resolve(); order.push('audit committed'); },
      async () => { order.push('native operation'); return 'ok'; },
    )).resolves.toBe('ok');
    expect(order).toEqual(['audit committed', 'native operation']);
  });
});

describe('App Browser native-state cleanup', () => {
  it('does not call disabled notification or alarm facades during cleanup', async () => {
    const nativeKit = {
      config: { features: { localNotifications: false, advancedAlarms: false } },
      notifications: { pending: vi.fn(), cancel: vi.fn(), delivered: vi.fn(), removeDelivered: vi.fn() },
      alarms: { list: vi.fn(), cancel: vi.fn() },
    };
    await releaseScheduledSandboxState(nativeKit, 'thirdparty.test');
    expect(nativeKit.notifications.pending).not.toHaveBeenCalled();
    expect(nativeKit.notifications.delivered).not.toHaveBeenCalled();
    expect(nativeKit.alarms.list).not.toHaveBeenCalled();
  });

  it('attempts every owned alarm cancellation and aggregates individual failures', async () => {
    const first = new Error('first cancel failed');
    const second = new Error('second cancel failed');
    const cancel = vi.fn(async (id: string) => { if (id === 'thirdparty.test:one') throw first; if (id === 'thirdparty.test:two') throw second; });
    const nativeKit = {
      config: { features: { localNotifications: false, advancedAlarms: true } },
      alarms: {
        list: vi.fn(async () => ({ alarms: [
          { id: 'thirdparty.test:one', extra: { nativeKitAppBrowserId: 'thirdparty.test' } },
          { id: 'thirdparty.test:two', extra: { nativeKitAppBrowserId: 'thirdparty.test' } },
          { id: 'host', extra: {} },
        ] })),
        cancel,
      },
    };
    const error = await releaseScheduledSandboxState(nativeKit, 'thirdparty.test', 'alarms').catch((value) => value);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toHaveLength(2);
    expect(cancel.mock.calls.map(([id]) => id)).toEqual(['thirdparty.test:one', 'thirdparty.test:two']);
  });
});

describe('App Browser scheduling result boundary and quotas', () => {
  it('returns only logical notification IDs and rejects empty, oversized, and exhausted batches', async () => {
    const appId = `test.notifications-${crypto.randomUUID()}`;
    const nativeKit = minimalNativeKit();
    nativeKit.notifications.schedule = vi.fn(async () => ({ nativeIds: [1_999_999_999], internalOwner: 'host' }));
    const methods = createAppBrowserMethodTable(nativeKit);
    const context = { app: { id: appId }, policy: {} } as any;

    await expect(methods['notifications.schedule'].run(context, [[{
      id: 'welcome', title: 'Welcome', body: 'Hello', schedule: { at: '2030-01-01T00:00:00.000Z' },
    }]])).resolves.toEqual({ scheduled: true, ids: ['welcome'] });
    expect(nativeKit.notifications.schedule).toHaveBeenCalledTimes(1);
    const nativeItem = nativeKit.notifications.schedule.mock.calls[0][0][0];
    expect(nativeItem.id).toEqual(expect.any(Number));
    expect(nativeItem.id).not.toBe('welcome');
    expect(nativeItem.extra).toEqual({ nativeKitAppBrowserId: appId, logicalId: 'welcome' });

    await expect(methods['notifications.schedule'].run(context, [[]])).rejects.toThrow(/At least one/);
    await expect(methods['notifications.schedule'].run(context, [Array.from({ length: 17 }, (_, index) => ({ id: `n${index}`, title: 'x', body: 'x' }))])).rejects.toThrow(/At most 16/);

    nativeKit.notifications.pending.mockResolvedValueOnce({
      notifications: Array.from({ length: 16 }, (_, index) => ({ id: index + 1, extra: { nativeKitAppBrowserId: appId, logicalId: `existing${index}` } })),
    });
    await expect(methods['notifications.schedule'].run(context, [[{ id: 'overflow', title: 'x', body: 'x' }]])).rejects.toThrow(/notification quota exceeded/);
    expect(nativeKit.notifications.schedule).toHaveBeenCalledTimes(1);
  });

  it('returns only the logical alarm ID and rejects an exhausted app quota', async () => {
    const appId = `test.alarms-${crypto.randomUUID()}`;
    const nativeKit = minimalNativeKit();
    nativeKit.alarms.schedule = vi.fn(async () => ({ nativeId: `${appId}:wake`, backend: 'exact-alarm' }));
    const methods = createAppBrowserMethodTable(nativeKit);
    const context = { app: { id: appId }, policy: {} } as any;

    await expect(methods['alarms.schedule'].run(context, [{
      id: 'wake', title: 'Wake', body: 'Now', at: Date.now() + 60_000,
    }])).resolves.toEqual({ id: 'wake', scheduled: true });
    expect(nativeKit.alarms.schedule).toHaveBeenCalledWith(expect.objectContaining({
      id: `${appId}:wake`,
      extra: { nativeKitAppBrowserId: appId, logicalId: 'wake' },
    }));

    nativeKit.alarms.list.mockResolvedValueOnce({
      alarms: Array.from({ length: 16 }, (_, index) => ({ id: `${appId}:existing${index}`, extra: { nativeKitAppBrowserId: appId, logicalId: `existing${index}` } })),
    });
    await expect(methods['alarms.schedule'].run(context, [{ id: 'overflow', title: 'x', body: 'x', at: Date.now() + 60_000 }])).rejects.toThrow(/alarm quota exceeded/);
    expect(nativeKit.alarms.schedule).toHaveBeenCalledTimes(1);
  });
});

describe('App Browser installed result boundary', () => {
  it('converts gallery paths inside the broker, strips native fields, and uses a bounded webPath fallback', async () => {
    const appId = `test.camera-${crypto.randomUUID()}`;
    const readFile = vi.fn(async () => ({ data: 'AQID', uri: 'file:///private/leak.jpg' }));
    const nativeKit = minimalNativeKit({
      camera: {
        pickImages: vi.fn(async () => ({
          photos: [{ path: 'file:///private/one.jpg', webPath: 'capacitor://localhost/_capacitor_file_/private/one.jpg', format: 'jpeg', exif: { secret: true } }],
          nativeIdentifier: 'asset-id',
        })),
      },
      filesystem: { readFile },
    });
    const methods = createAppBrowserMethodTable(nativeKit);
    const context = { app: { id: appId }, policy: {} } as any;

    await expect(methods['camera.pickImages'].run(context, [{}])).resolves.toEqual({
      photos: [{ data: 'AQID', encoding: 'base64', format: 'jpeg' }],
    });
    expect(readFile).toHaveBeenCalledWith({ path: 'file:///private/one.jpg' });

    const fallbackFetch = vi.fn(async () => ({ ok: true, blob: async () => new Blob([new Uint8Array([4, 5, 6])]) }));
    vi.stubGlobal('fetch', fallbackFetch);
    nativeKit.filesystem.readFile.mockRejectedValueOnce(new Error('native path read failed'));
    nativeKit.camera.pickImages.mockResolvedValueOnce({ photos: [{ path: 'file:///private/two.jpg', webPath: 'blob:https://mini.invalid/id', format: 'png' }] });
    await expect(methods['camera.pickImages'].run(context, [{}])).resolves.toEqual({
      photos: [{ data: 'BAUG', encoding: 'base64', format: 'png' }],
    });
    expect(fallbackFetch).toHaveBeenCalledWith('blob:https://mini.invalid/id');
    vi.unstubAllGlobals();
  });

  it('rejects an oversized gallery blob before base64 conversion', async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(393_217));
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      blob: async () => ({ size: 393_217, arrayBuffer }),
    })));
    const nativeKit = minimalNativeKit({
      camera: { pickImages: vi.fn(async () => ({ photos: [{ webPath: 'blob:https://mini.invalid/large', format: 'jpeg' }] })) },
      filesystem: { readFile: vi.fn() },
    });
    const methods = createAppBrowserMethodTable(nativeKit);
    await expect(methods['camera.pickImages'].run({ app: { id: `test.camera-${crypto.randomUUID()}` } } as any, [{}]))
      .rejects.toThrow(/per-image broker limit/);
    expect(arrayBuffer).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('suppresses plugin write output and returns exact app, network, filesystem, background, and SQLite fields', async () => {
    const appId = `test.exact-${crypto.randomUUID()}`;
    const sqliteExecute = vi.fn(async (_name: string, sql: string) => sql.startsWith('PRAGMA max_page_count')
      ? { nativePath: '/data/db' }
      : { changes: { changes: 2, lastId: 7, secret: 'native' }, nativePath: '/data/db' });
    const nativeKit = minimalNativeKit({
      preferences: {
        keys: vi.fn(async () => ({ keys: [] })),
        set: vi.fn(async () => ({ written: true, nativePath: '/data/prefs' })),
        get: vi.fn(async () => 'dark'),
        remove: vi.fn(async () => undefined),
      },
      network: { status: vi.fn(async () => ({ connected: true, connectionType: 'wifi', ssid: 'private' })) },
      background: { dispatch: vi.fn(async () => ({ taskId: 'native-task' })) },
      filesystem: {
        readdir: vi.fn(async () => ({ files: [{ name: 'safe.txt', type: 'file', size: 3, ctime: 1, mtime: 2, uri: 'file:///private/safe.txt', path: '/private/safe.txt' }], uri: 'file:///private' })),
      },
      sqlite: {
        open: vi.fn(async () => ({ path: '/data/db' })),
        query: vi.fn(async (_name: string, sql: string) => {
          if (sql === 'PRAGMA page_size') return { values: [{ page_size: 4_096 }] };
          if (sql === 'PRAGMA page_count') return { values: [{ page_count: 1 }] };
          return { values: [{ max_page_count: 16_384 }] };
        }),
        execute: sqliteExecute,
        close: vi.fn(async () => ({ closed: true })),
      },
    });
    const methods = createAppBrowserMethodTable(nativeKit);
    const context = {
      app: { id: appId, manifest: { id: appId, name: 'Exact app', version: '2.3.4', allowedHosts: [] } },
      policy: {},
    } as any;

    await expect(methods['preferences.set'].run(context, ['theme', 'dark'])).resolves.toBeUndefined();
    await expect(methods['preferences.get'].run(context, ['theme'])).resolves.toBe('dark');
    await expect(methods['app.info'].run(context, [])).resolves.toEqual({ id: appId, name: 'Exact app', version: '2.3.4' });
    await expect(methods['network.status'].run(context, [])).resolves.toEqual({ connected: true, connectionType: 'wifi' });
    await expect(methods['background.dispatch'].run(context, [{ event: 'sync' }])).resolves.toEqual({ dispatched: true });
    await expect(methods['filesystem.readdir'].run(context, [{ directory: 'Data', path: '' }])).resolves.toEqual({
      files: [{ name: 'safe.txt', type: 'file', size: 3, ctime: 1, mtime: 2 }],
    });
    await expect(methods['sqlite.execute'].run(context, ['main', 'UPDATE items SET done = 1', true])).resolves.toEqual({ changes: { changes: 2, lastId: 7 } });
    expect(methods['filesystem.getUri']).toBeUndefined();
  });

  it('filters alarm ownership and redacts resource identifiers from public errors', async () => {
    const appId = `test.owner-${crypto.randomUUID()}`;
    const nativeKit = minimalNativeKit({
      alarms: {
        list: vi.fn(async () => ({ alarms: [
          { id: `${appId}:wake`, title: 'Wake', body: 'Now', at: 1_800_000_000_000, repeatIntervalMinutes: 15, extra: { nativeKitAppBrowserId: appId, logicalId: 'wake' }, nativePath: '/data/alarm' },
          { id: 'host', title: 'Host', body: 'Private', at: 1_800_000_000_000, extra: {} },
          { id: 'other:wake', title: 'Other', body: 'Private', at: 1_800_000_000_000, extra: { nativeKitAppBrowserId: 'other', logicalId: 'wake' } },
        ] })),
        cancel: vi.fn(async () => undefined),
      },
    });
    const methods = createAppBrowserMethodTable(nativeKit);
    await expect(methods['alarms.list'].run({ app: { id: appId } } as any, [])).resolves.toEqual({
      alarms: [{ id: 'wake', title: 'Wake', body: 'Now', scheduledAt: 1_800_000_000_000, repeatIntervalMinutes: 15 }],
    });

    const error = serializeError(Object.assign(new Error(
      'failed file:///private/secret.jpg content://provider/7 /data/user/0/app/databases/nk_hidden_123 nativekit-app-browser/secret/root',
    ), { code: 'OS-PLUG-FILE-0008' }));
    expect(error.code).toBe('OS-PLUG-FILE-0008');
    expect(error.message).not.toMatch(/file:\/\/|content:\/\/|\/private\/|\/data\/|nk_hidden_123|nativekit-app-browser\/secret/);
    expect(error.message).toContain('[redacted');
  });
});

describe('App Browser usage and package-preserving cleanup', () => {
  it('reports ownership, cleans it, and preserves the installed package and policy', async () => {
    installHostWindow();
    const appId = `test.cleanup-success-${crypto.randomUUID()}`;
    const nativeKey = `nativekit.appBrowser.${appId}.theme`;
    const nativeKit = minimalNativeKit({
      preferences: {
        keys: vi.fn(async () => ({ keys: [nativeKey] })),
        remove: vi.fn(async () => undefined),
      },
    });
    const host = createAppBrowser(nativeKit, appBrowserConfig());
    await installRuntimeTestApp(host, appId);
    await writeOwnedStorage(appId, 'preference', 'theme', async () => undefined);

    await expect(host.usage(appId)).resolves.toMatchObject({
      appId,
      storage: { preferenceKeys: 1, secureStorageKeys: 0, databases: 0, filesystem: null },
      scheduled: { notifications: null, alarms: null },
      active: { sessions: 0, subscriptions: 0, backgroundLocation: false },
    });
    await expect(host.cleanup(appId)).resolves.toBeUndefined();
    expect(nativeKit.preferences.remove).toHaveBeenCalledWith(nativeKey);
    await expect(host.get(appId)).resolves.toMatchObject({ id: appId, policy: { enabled: true } });
    await expect(host.usage(appId)).resolves.toMatchObject({ storage: { preferenceKeys: 0 } });
  });

  it('rejects failed cleanup and retains ownership metadata and the package for retry', async () => {
    installHostWindow();
    const appId = `test.cleanup-failure-${crypto.randomUUID()}`;
    const nativeKey = `nativekit.appBrowser.${appId}.token`;
    const removalFailure = new Error('secure erase denied');
    const nativeKit = minimalNativeKit({
      preferences: {
        keys: vi.fn(async () => ({ keys: [nativeKey] })),
        remove: vi.fn(async () => { throw removalFailure; }),
      },
    });
    const host = createAppBrowser(nativeKit, appBrowserConfig());
    await installRuntimeTestApp(host, appId);
    await writeOwnedStorage(appId, 'preference', 'token', async () => undefined);

    const error = await host.cleanup(appId).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AggregateError);
    expect(String(error.message)).toMatch(/could not be cleaned/);
    await expect(host.usage(appId)).resolves.toMatchObject({ storage: { preferenceKeys: 1 } });
    await expect(host.get(appId)).resolves.toMatchObject({ id: appId, policy: { enabled: true } });
  });

  it('fails usage instead of returning partial counts when native enumeration fails', async () => {
    installHostWindow();
    const appId = `test.usage-failure-${crypto.randomUUID()}`;
    const enumerationFailure = new Error('filesystem permission lost');
    const nativeKit = minimalNativeKit({
      config: {
        features: { filesystem: true, localNotifications: false, advancedAlarms: false },
        backgroundRunner: { defaultSyncUrl: '' },
      },
      filesystem: { readdir: vi.fn(async () => { throw enumerationFailure; }) },
    });
    const host = createAppBrowser(nativeKit, appBrowserConfig());
    await installRuntimeTestApp(host, appId);

    await expect(host.usage(appId)).rejects.toBe(enumerationFailure);
    await expect(host.get(appId)).resolves.toMatchObject({ id: appId });
  });
});

describe('App Browser quick-add: single web component', () => {
  it('auto-detects the tag, synthesizes the manifest + wrapper entry, and installs', async () => {
    installHostWindow();
    const host = createAppBrowser(minimalNativeKit(), appBrowserConfig());
    const source = `class W extends HTMLElement { connectedCallback(){ this.textContent = 'hi'; } }\ncustomElements.define('my-temp-card', W);`;
    const installed = await host.installWebComponent({ fileName: 'my-temp-card.js', data: source });
    expect(installed.manifest.webComponent).toMatchObject({ tag: 'my-temp-card', module: 'my-temp-card.js' });
    expect(installed.manifest.entry).toBe('__nativekit_component__.html');
    expect(installed.manifest.requestedCapabilities).toEqual([]);
    expect(installed.fileCount).toBe(2); // the js + the generated wrapper entry
    await expect(host.get(installed.id)).resolves.toMatchObject({ id: installed.id, policy: { enabled: true } });
  });

  it('uses an uploaded HTML page as the entry when there is no component module', async () => {
    installHostWindow();
    const host = createAppBrowser(minimalNativeKit(), appBrowserConfig());
    const installed = await host.installWebComponent({ fileName: 'hello.html', data: '<!doctype html><title>hi</title>' });
    expect(installed.manifest.entry).toBe('hello.html');
    expect(installed.manifest.webComponent).toBeUndefined();
    expect(installed.id).toBe('nativekit.quick.hello');
  });

  it('rejects a JS module whose tag cannot be detected unless a tag is supplied', async () => {
    installHostWindow();
    const host = createAppBrowser(minimalNativeKit(), appBrowserConfig());
    await expect(host.installWebComponent({ fileName: 'widget.js', data: 'const x = 1;' })).rejects.toThrow(/No custom-element tag detected/);
  });

  it('accepts an explicit tag override when detection is impossible', async () => {
    installHostWindow();
    const host = createAppBrowser(minimalNativeKit(), appBrowserConfig());
    const installed = await host.installWebComponent({ fileName: 'widget.js', data: 'globalThis.X = 1;', tag: 'my-widget' });
    expect(installed.manifest.webComponent.tag).toBe('my-widget');
    expect(installed.id).toBe('nativekit.quick.my-widget');
  });
});

describe('App Browser download failure cleanup', () => {
  it('preserves both the transfer/quota failure and a non-missing cleanup failure', async () => {
    const cause = new Error('download failed');
    const cleanup = new Error('delete denied');
    const promise = discardSandboxDownload({ filesystem: { deleteFile: vi.fn(async () => { throw cleanup; }) } }, 'Data', 'partial.bin', cause);
    const error = await promise.catch((value) => value);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([cause, cleanup]);
  });

  it('keeps the original failure when the partial destination is already absent', async () => {
    const cause = new Error('download failed');
    const missing = Object.assign(new Error('not found'), { code: 'OS-PLUG-FILE-0008' });
    await expect(discardSandboxDownload({ filesystem: { deleteFile: vi.fn(async () => { throw missing; }) } }, 'Data', 'gone.bin', cause)).rejects.toBe(cause);
  });
});

describe('App Browser SQLite quota setup', () => {
  it('sets and verifies max_page_count before accepting a database', async () => {
    const sqlite = {
      open: vi.fn(async () => undefined),
      query: vi.fn(async (_name: string, sql: string) => {
        if (sql === 'PRAGMA page_size') return { values: [{ page_size: 4_096 }] };
        if (sql === 'PRAGMA page_count') return { values: [{ page_count: 10 }] };
        return { values: [{ max_page_count: 16_384 }] };
      }),
      execute: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };

    await enforceSandboxDatabaseQuota(sqlite, 'sandbox');
    expect(sqlite.open).toHaveBeenCalledWith('sandbox', { encrypted: false, mode: 'no-encryption' });
    expect(sqlite.execute).toHaveBeenCalledWith('sandbox', 'PRAGMA max_page_count = 16384', false);
    expect(sqlite.query).toHaveBeenLastCalledWith('sandbox', 'PRAGMA max_page_count');
    expect(sqlite.close).not.toHaveBeenCalled();
  });

  it('rejects an already oversized database and closes its connection', async () => {
    const sqlite = {
      open: vi.fn(async () => undefined),
      query: vi.fn(async (_name: string, sql: string) => sql === 'PRAGMA page_size'
        ? { values: [{ page_size: 4_096 }] }
        : { values: [{ page_count: 16_385 }] }),
      execute: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };

    await expect(enforceSandboxDatabaseQuota(sqlite, 'oversized')).rejects.toThrow(/already exceeds/);
    expect(sqlite.execute).not.toHaveBeenCalled();
    expect(sqlite.close).toHaveBeenCalledWith('oversized');
  });

  it('rejects an unverifiable max_page_count and reports close failures too', async () => {
    const sqlite = {
      open: vi.fn(async () => undefined),
      query: vi.fn(async (_name: string, sql: string) => {
        if (sql === 'PRAGMA page_size') return { values: [{ page_size: 4_096 }] };
        if (sql === 'PRAGMA page_count') return { values: [{ page_count: 1 }] };
        return { values: [{ max_page_count: 99_999 }] };
      }),
      execute: vi.fn(async () => undefined),
      close: vi.fn(async () => { throw new Error('close failed'); }),
    };

    const error = await enforceSandboxDatabaseQuota(sqlite, 'unverified').catch((reason) => reason);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.message).toMatch(/quota setup failed/);
  });
});
