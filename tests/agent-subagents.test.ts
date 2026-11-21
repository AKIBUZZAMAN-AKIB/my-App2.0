import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// NativeKit.agent.subagents / onSubagentEvent, run against the real bridge with
// a native platform and a stand-in NativeAgent plugin.

const agent = vi.hoisted(() => {
  const listeners: Array<(event: any) => void> = [];
  return {
    listeners,
    features: ['subagents', 'subagentQueue', 'crossSession', 'contextTree'] as string[],
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

  it('sends the queue / regenerate / edit / fork actions (subagentQueue)', async () => {
    await NativeKit.agent.subagents({ action: 'regenerate', id: 'sa_1' });
    await NativeKit.agent.subagents({ action: 'regenerate', id: 'sa_1', turn: 0 });
    await NativeKit.agent.subagents({ action: 'edit', id: 'sa_1', turn: 1, message: 'try with tests' });
    await NativeKit.agent.subagents({ action: 'fork', id: 'sa_1', task: 'same, for docs/', keepHistory: true });
    await NativeKit.agent.subagents({ action: 'rerun', id: 'sa_1' });
    await NativeKit.agent.subagents({ action: 'priority', id: 'sa_1', priority: 5 });
    const q = await NativeKit.agent.subagents({ action: 'queue' });
    expect(q.echo).toEqual({ action: 'queue' });
    expect(agent.subagents).toHaveBeenCalledTimes(7);
    expect(JSON.parse(agent.subagents.mock.calls[2][0].requestJson)).toEqual({ action: 'edit', id: 'sa_1', turn: 1, message: 'try with tests' });
    await expect(NativeKit.agent.subagents({ action: 'edit', id: 'sa_1', message: ' ' })).rejects.toThrow(/new message text/);
    await expect(NativeKit.agent.subagents({ action: 'fork' })).rejects.toThrow(/needs an id/);
    await expect(NativeKit.agent.subagents({ action: 'regenerate' })).rejects.toThrow(/needs an id/);
    expect(agent.subagents).toHaveBeenCalledTimes(7);
    const bridge = readFileSync(path.resolve(__dirname, '../bridge/nativekit.ts'), 'utf8');
    expect(bridge).toContain("requireEngineFeature('subagentQueue'");
  });

  it('sends the cross-session actions and validates ask (crossSession)', async () => {
    await NativeKit.agent.subagents({ action: 'chats' });
    await NativeKit.agent.subagents({ action: 'titles', titles: { 'chat-1': 'Trip' } });
    await NativeKit.agent.subagents({ action: 'ask', targetSessionKey: 'chat-1', callerSessionKey: 'chat-2', message: 'What did we decide?' });
    await NativeKit.agent.subagents({ action: 'asks', sessionKey: 'chat-1' });
    await NativeKit.agent.subagents({ action: 'cancelAsk', targetSessionKey: 'chat-1' });
    expect(agent.subagents).toHaveBeenCalledTimes(5);
    expect(JSON.parse(agent.subagents.mock.calls[2][0].requestJson)).toEqual({ action: 'ask', targetSessionKey: 'chat-1', callerSessionKey: 'chat-2', message: 'What did we decide?' });
    await expect(NativeKit.agent.subagents({ action: 'ask', targetSessionKey: 'chat-1', message: '  ' })).rejects.toThrow(/targetSessionKey and message/);
    await expect(NativeKit.agent.subagents({ action: 'ask', message: 'hi' })).rejects.toThrow(/targetSessionKey and message/);
    expect(agent.subagents).toHaveBeenCalledTimes(5);
  });

  it('sends the chat memory, compaction log and swarm actions the page calls', async () => {
    // The three errors users saw: 'subagents: unknown action "memory.get" / "log" / "swarmState"'.
    await NativeKit.agent.subagents({ action: 'memory.get', sessionKey: 'chat-1' });
    await NativeKit.agent.subagents({ action: 'log', id: 'a1', limit: 50 });
    await NativeKit.agent.subagents({ action: 'swarmState', sessionKey: 'chat-1' });
    await NativeKit.agent.subagents({ action: 'interrupt', id: 'a1' });
    await NativeKit.agent.subagents({ action: 'message', id: 'a1', message: '', attachmentsJson: '[{"type":"image","mediaType":"image/png","data":"AA=="}]' });
    const sent = agent.subagents.mock.calls.map((c: any) => JSON.parse(c[0].requestJson));
    expect(sent.map((r: any) => r.action)).toEqual(['memory.get', 'log', 'swarmState', 'interrupt', 'message']);
    expect(sent[0].sessionKey).toBe('chat-1');
    await expect(NativeKit.agent.subagents({ action: 'log' })).rejects.toThrow(/needs an id/);
    await expect(NativeKit.agent.subagents({ action: 'interrupt' })).rejects.toThrow(/needs an id/);
    await expect(NativeKit.agent.subagents({ action: 'message', id: 'a1', message: '', attachmentsJson: '[]' })).rejects.toThrow(/needs text/);
  });

  it('routes the context tree actions (ctx.*) to the engine so the panel can turn the tree on', async () => {
    {
      const sent: any[] = [];
      const engineAnswer = async ({ requestJson }: { requestJson: string }): Promise<any> => {
        const req = JSON.parse(requestJson); sent.push(req);
        return req.action === 'ctx.settings' ? { settings: { enabled: req.settings?.enabled === true }, saved: !!req.settings } : { ok: true };
      };
      agent.subagents.mockImplementationOnce(engineAnswer).mockImplementationOnce(engineAnswer).mockImplementationOnce(engineAnswer);
      const on: any = await NativeKit.agent.subagents({ action: 'ctx.settings', sessionKey: 'chat-1', settings: { enabled: true } });
      expect(on).toEqual({ settings: { enabled: true }, saved: true });
      await NativeKit.agent.subagents({ action: 'ctx.tree', sessionKey: 'chat-1' });
      await NativeKit.agent.subagents({ action: 'ctx.reset', sessionKey: 'chat-1' });
      expect(sent.map((r) => r.action)).toEqual(['ctx.settings', 'ctx.tree', 'ctx.reset']);
      expect(sent[0].settings).toEqual({ enabled: true });
      await expect(NativeKit.agent.subagents({ action: 'ctx.tree' })).rejects.toThrow(/needs a sessionKey/);
      await expect(NativeKit.agent.subagents({ action: 'ctx.reset', sessionKey: ' ' })).rejects.toThrow(/needs a sessionKey/);
    }
  });

  it('lets through every action the engine dispatches, and every action the page sends', async () => {
    const root = path.resolve(__dirname, '..');
    const ffi = path.join(root, 'plugins/native-agent/rust/native-agent-ffi/src');
    // Match arms of the app-request dispatchers, e.g. `"pause" | "resume" =>`.
    const arms = (file: string, from: RegExp, prefixes: string[] = ['']) => {
      const src = readFileSync(path.join(ffi, file), 'utf8');
      const start = src.search(from);
      expect(start, `${file}: dispatcher not found`).toBeGreaterThanOrEqual(0);
      const out = new Set<string>();
      for (const m of src.slice(start).matchAll(/^\s+((?:"[A-Za-z.]+"\s*\|\s*)*"[A-Za-z.]+")\s*(?:if [^=\n]*)?=>/gm)) {
        for (const name of m[1].match(/"[A-Za-z.]+"/g) || []) {
          const action = name.slice(1, -1);
          if (prefixes.some((p) => action.startsWith(p))) out.add(action);
        }
      }
      return out;
    };
    const engine = new Set<string>([
      ...arms('subagents.rs', /pub fn handle_app_request/),
      ...arms('subagents/team.rs', /fn team_app_request/),
      ...arms('subagents/channels.rs', /fn channels_app_request/),
      ...arms('subagents/comms.rs', /fn comms_app_request/),
      ...arms('subagents/advanced.rs', /fn advanced_app_request/),
      // memory_action answers every prefix NativeAgentHandle::subagents routes to it.
      ...arms('lib.rs', /pub\(crate\) fn memory_action/, ['memory.', 'ctx.', 'agents.', 'social.']),
      'ask', 'memory.get',
    ]);
    // Sub-operations matched inside those handlers (queue ops, bulk filters) are not actions.
    for (const inner of ['active', 'clear', 'promote', 'queued', 'running', 'finished', 'context.usage']) engine.delete(inner);
    const { SUBAGENT_ACTIONS } = await import('../bridge/nativekit');
    const bridge = new Set<string>(SUBAGENT_ACTIONS);
    expect([...engine].filter((a) => !bridge.has(a)).sort(), 'engine actions the bridge rejects').toEqual([]);
    expect([...bridge].filter((a) => !engine.has(a)).sort(), 'bridge actions the engine does not know').toEqual([]);

    // Every action literal the Agent page sends through agent.subagents must be allowed.
    const pageDir = path.join(root, 'tools/agent-html-src');
    const page = readdirSync(pageDir).filter((f: string) => f.endsWith('.js'))
      .map((f: string) => readFileSync(path.join(pageDir, f), 'utf8')).join('\n');
    const sentByPage = new Set<string>();
    for (const m of page.matchAll(/\b(?:call|csCall|run|act|subCall)\(\s*(?:ctx,\s*)?'([A-Za-z]+(?:\.[A-Za-z]+)?)'/g)) sentByPage.add(m[1]);
    for (const m of page.matchAll(/subagents\(\{\s*action:\s*'([A-Za-z.]+)'/g)) sentByPage.add(m[1]);
    // Panels that pass the action in a variable (the Context panel's send('ctx.tree')) name it as a dotted literal.
    for (const m of page.matchAll(/'((?:memory|ctx|agents|social)\.[A-Za-z]+)'/g)) sentByPage.add(m[1]);
    expect(sentByPage.has('ctx.settings'), 'the Context panel sends ctx.settings').toBe(true);
    const unknown = [...sentByPage].filter((a) => engine.has(a) && !bridge.has(a));
    expect(unknown, 'page actions the bridge rejects').toEqual([]);
  });

  it('passes only subagent.* events to onSubagentEvent, parsed', async () => {
    const seen: any[] = [];
    const handle = await NativeKit.agent.onSubagentEvent((e: any) => seen.push(e));
    for (const cb of agent.listeners) {
      cb({ eventType: 'text_delta', payloadJson: '{"text":"hi"}' });
      cb({ eventType: 'subagent.started', payloadJson: '{"id":"sa_1","name":"researcher"}' });
      cb({ eventType: 'subagent.usage', payloadJson: 'not json' });
    }
    for (const cb of agent.listeners) cb({ eventType: 'tool_queued', payloadJson: '{"toolName":"edit_file"}' });
    for (const cb of agent.listeners) cb({ eventType: 'subagent.queued', payloadJson: '{"id":"sa_2","queuePosition":1}' });
    const queued = seen.pop();
    expect(queued).toEqual({ type: 'subagent.queued', payload: { id: 'sa_2', queuePosition: 1 } });
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
    expect(lib).toContain('"subagentQueue"');
    expect(lib).toContain('"toolScheduler"');
    expect(lib).toContain('"crossSession"');
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
