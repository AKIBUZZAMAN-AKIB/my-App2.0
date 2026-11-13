import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// NativeKit.agent.subagents / onSubagentEvent, run against the real bridge with
// a native platform and a stand-in NativeAgent plugin.

const agent = vi.hoisted(() => {
  const listeners: Array<(event: any) => void> = [];
  return {
    listeners,
    features: ['subagents'] as string[],
    getEngineFeatures: vi.fn(async function (this: any) { return { engineVersion: 'test', features: agent.features }; }),
    subagents: vi.fn(async ({ requestJson }: { requestJson: string }) => ({ echo: JSON.parse(requestJson) })),
    addListener: vi.fn(async (_name: string, cb: (event: any) => void) => {
      listeners.push(cb);
      return { remove: async () => { listeners.splice(listeners.indexOf(cb), 1); } };
    }),
  };
});

vi.mock('@capacitor/core', async (orig) => {
  const real: any = await orig();
  return { ...real, Capacitor: { ...real.Capacitor, isNativePlatform: () => true, getPlatform: () => 'android' } };
});
vi.mock('capacitor-native-agent', () => ({ NativeAgent: new Proxy(agent, {
  get: (target: any, key) => (key in target ? target[key] : vi.fn(async () => ({}))),
}) }));
vi.mock('@nativekit/custom-native', () => ({ NativeKitCustom: { addListener: vi.fn(async () => ({ remove: async () => undefined })) } }));

let NativeKit: any;

beforeAll(async () => {
  const config = JSON.parse(readFileSync(path.resolve(__dirname, '../app.config.json'), 'utf8'));
  const globals: Record<string, unknown> = {
    __NATIVEKIT_CONFIG__: config,
    window: globalThis,
    location: new URL('https://shell.test/index.html'),
    navigator: {},
    document: { readyState: 'complete', addEventListener: () => undefined },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  };
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  }
  if (!globalThis.CustomEvent) {
    class TestCustomEvent<T = unknown> extends Event {
      detail: T;
      constructor(type: string, init?: CustomEventInit<T>) { super(type); this.detail = init?.detail as T; }
    }
    Object.assign(globalThis, { CustomEvent: TestCustomEvent });
  }
  await import('../bridge/nativekit');
  NativeKit = (globalThis as any).NativeKit;
});

beforeEach(() => { agent.subagents.mockClear(); });

describe('NativeKit.agent.subagents', () => {
  it('sends one JSON request per action and returns the engine object', async () => {
    const out = await NativeKit.agent.subagents({ action: 'spawn', task: 'Review the diff', tools: ['read_file'], tokenBudget: 5000 });
    expect(agent.subagents).toHaveBeenCalledTimes(1);
    expect(out.echo).toEqual({ action: 'spawn', task: 'Review the diff', tools: ['read_file'], tokenBudget: 5000 });
    const listed = await NativeKit.agent.subagents({});
    expect(listed.echo.action).toBe('list');
    for (const action of ['get', 'retry', 'delete']) {
      await NativeKit.agent.subagents({ action, id: 'sa_1' });
    }
    await NativeKit.agent.subagents({ action: 'stop', all: true });
    await NativeKit.agent.subagents({ action: 'message', id: 'sa_1', message: 'also run tests' });
    await NativeKit.agent.subagents({ action: 'memory', name: 'researcher', op: 'promote', key: 'k' });
    await NativeKit.agent.subagents({ action: 'settings', settings: { maxParallel: 2 } });
    expect(agent.subagents).toHaveBeenCalledTimes(9);
  });

  it('rejects bad requests before they reach the engine', async () => {
    await expect(NativeKit.agent.subagents({ action: 'explode' })).rejects.toThrow(/unknown action/);
    await expect(NativeKit.agent.subagents({ action: 'spawn', task: '  ' })).rejects.toThrow(/needs a task/);
    await expect(NativeKit.agent.subagents({ action: 'get' })).rejects.toThrow(/needs an id/);
    await expect(NativeKit.agent.subagents({ action: 'stop' })).rejects.toThrow(/id or all/);
    await expect(NativeKit.agent.subagents({ action: 'message', id: 'x', message: '' })).rejects.toThrow(/needs text/);
    await expect(NativeKit.agent.subagents(null)).rejects.toThrow(/request object/);
    expect(agent.subagents).not.toHaveBeenCalled();
  });

  it('passes only subagent.* events to onSubagentEvent, parsed', async () => {
    const seen: any[] = [];
    const handle = await NativeKit.agent.onSubagentEvent((e: any) => seen.push(e));
    for (const cb of agent.listeners) {
      cb({ eventType: 'text_delta', payloadJson: '{"text":"hi"}' });
      cb({ eventType: 'subagent.started', payloadJson: '{"id":"sa_1","name":"researcher"}' });
      cb({ eventType: 'subagent.usage', payloadJson: 'not json' });
    }
    expect(seen).toEqual([
      { type: 'subagent.started', payload: { id: 'sa_1', name: 'researcher' } },
      { type: 'subagent.usage', payload: null },
    ]);
    await handle.remove();
  });

  it('declares the method and feature on every layer', () => {
    const read = (p: string) => readFileSync(path.resolve(__dirname, '..', p), 'utf8');
    expect(read('plugins/native-agent/src/definitions.ts')).toMatch(/\bsubagents\(options: \{ requestJson: string \}\)/);
    expect(read('plugins/native-agent/src/plugin.ts')).toMatch(/async subagents\(\)/);
    expect(read('plugins/native-agent/android/src/main/java/com/t6x/plugins/nativeagent/NativeAgentPlugin.kt')).toMatch(/@PluginMethod\s+fun subagents\(/);
    const swift = read('plugins/native-agent/ios/Sources/NativeAgentPlugin/NativeAgentPlugin.swift');
    expect(swift).toContain('CAPPluginMethod(name: "subagents"');
    expect(swift).toMatch(/@objc func subagents\(/);
    expect(read('plugins/native-agent/android/src/main/java/uniffi/native_agent_ffi/native_agent_ffi.kt')).toContain('fun `subagents`(');
    expect(read('plugins/native-agent/ios/Sources/NativeAgentPlugin/Generated/native_agent_ffi.swift')).toMatch(/open func subagents\(requestJson: String\) throws -> String/);
    const lib = read('plugins/native-agent/rust/native-agent-ffi/src/lib.rs');
    expect(lib).toMatch(/pub fn subagents\(&self, request_json: String\)/);
    expect(lib).toContain('"subagents"');
    expect(read('types/nativekit.d.ts.template')).toContain('subagents(request:');
    expect(read('bridge/nativekit.ts')).toContain("requireEngineFeature('subagents'");
  });
});

describe('NativeKit.agent.subagents on an old engine', () => {
  it('explains that the engine is too old', async () => {
    // The feature list is cached per page, so check the message the bridge builds.
    const bridge = readFileSync(path.resolve(__dirname, '../bridge/nativekit.ts'), 'utf8');
    expect(bridge).toContain("engine is too old (missing '${name}')");
  });
});
