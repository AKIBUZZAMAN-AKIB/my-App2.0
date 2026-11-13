import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { MCP_APP_MIME_TYPE, connectMcpServers, mcpAppUiMeta, type McpTransport } from '../bridge/mcp-client';

const root = path.resolve(__dirname, '..');
const read = (p: string) => readFileSync(path.join(root, p), 'utf8');

const NEW_METHODS = [
  'getEngineFeatures',
  'followUpWithAttachments',
  'respondToApprovalWithArgs',
  'rewindSession',
  'forkSession',
  'removeMcpTools',
];

describe('native agent — new APIs are wired on every layer', () => {
  it('declares each new method in the TS definitions, web stub, Android and iOS', () => {
    const defs = read('plugins/native-agent/src/definitions.ts');
    const web = read('plugins/native-agent/src/plugin.ts');
    const kt = read('plugins/native-agent/android/src/main/java/com/t6x/plugins/nativeagent/NativeAgentPlugin.kt');
    const swift = read('plugins/native-agent/ios/Sources/NativeAgentPlugin/NativeAgentPlugin.swift');
    for (const m of NEW_METHODS) {
      expect(defs, `definitions.ts: ${m}`).toMatch(new RegExp(`\\b${m}\\(`));
      expect(web, `web stub: ${m}`).toMatch(new RegExp(`async ${m}\\(`));
      expect(kt, `Kotlin: ${m}`).toMatch(new RegExp(`fun ${m}\\(`));
      expect(swift, `Swift: ${m}`).toMatch(new RegExp(`func ${m}\\(`));
    }
  });

  it('exports the new FFI methods from the Rust handle and the regenerated bindings', () => {
    const lib = read('plugins/native-agent/rust/native-agent-ffi/src/lib.rs');
    const kt = read('plugins/native-agent/android/src/main/java/uniffi/native_agent_ffi/native_agent_ffi.kt');
    const swift = read('plugins/native-agent/ios/Sources/NativeAgentPlugin/Generated/native_agent_ffi.swift');
    for (const [rust, camel] of [
      ['get_engine_features', 'getEngineFeatures'],
      ['follow_up_with_attachments', 'followUpWithAttachments'],
      ['respond_to_approval_with_args', 'respondToApprovalWithArgs'],
      ['rewind_session', 'rewindSession'],
      ['fork_session', 'forkSession'],
      ['remove_mcp_tools', 'removeMcpTools'],
    ]) {
      expect(lib, `lib.rs: ${rust}`).toMatch(new RegExp(`pub fn ${rust}\\(`));
      expect(kt, `Kotlin bindings: ${camel}`).toContain(`fun \`${camel}\`(`);
      expect(swift, `Swift bindings: ${camel}`).toMatch(new RegExp(`func ${camel}\\(`));
    }
  });

  it('exposes the new methods on NativeKit.agent behind feature detection', () => {
    const bridge = read('bridge/nativekit.ts');
    for (const m of ['rewindSession', 'forkSession', 'respondToApprovalWithArgs', 'getEngineFeatures', 'registerUiTool', 'unregisterUiTool', 'listUiTools', 'removeMcpTools']) {
      expect(bridge, `NativeKit.agent.${m}`).toMatch(new RegExp(`\\b${m}:`));
    }
    // Old callers keep working: followUp(prompt) still calls the old native method.
    expect(bridge).toContain('return NativeAgent.followUp({ prompt });');
    expect(bridge).toContain("requireEngineFeature('attachments'");
    expect(bridge).toContain("requireEngineFeature('rewindSession'");
    expect(bridge).toContain("requireEngineFeature('approvalWithArgs'");
  });

  it('keeps the web fallback non-throwing for feature detection', async () => {
    const web = read('plugins/native-agent/src/plugin.ts');
    expect(web).toMatch(/async getEngineFeatures\(\)[^{]*\{[^}]*features: \[\]/);
  });
});

function appServer(): McpTransport {
  const tools = [
    { name: 'show_chart', description: 'Show a chart', inputSchema: { type: 'object' }, _meta: { ui: { resourceUri: 'ui://charts/main', visibility: ['model', 'app'] } } },
    { name: 'model_only', description: 'Hidden from apps', inputSchema: { type: 'object' }, _meta: { ui: { resourceUri: 'ui://charts/main', visibility: ['model'] } } },
    { name: 'plain', description: 'No UI', inputSchema: { type: 'object' } },
  ];
  const handlers: Record<string, (p: any) => unknown> = {
    initialize: () => ({ protocolVersion: '2025-06-18', serverInfo: { name: 'charts', version: '1' }, capabilities: { tools: {}, resources: {} } }),
    'tools/list': () => ({ tools }),
    'resources/read': (p) => ({
      contents: [{ uri: p.uri, mimeType: MCP_APP_MIME_TYPE, text: '<!doctype html><p>chart</p>', _meta: { ui: { csp: { connectDomains: ['https://api.example.com'] }, prefersBorder: true } } }],
    }),
    'tools/call': (p) => ({ content: [{ type: 'text', text: `called ${p.name}` }] }),
  };
  return {
    async send(message: any) {
      if (message.id === undefined) return null;
      const h = handlers[message.method];
      if (!h) return { jsonrpc: '2.0' as const, id: message.id, error: { code: -32601, message: 'nope' } };
      return { jsonrpc: '2.0' as const, id: message.id, result: h(message.params) };
    },
  };
}

function agentStub() {
  return {
    published: [] as any[],
    async startMcp(json: string) { this.published = JSON.parse(json); },
    async respondToMcpTool() {},
    addListener() { return { remove() {} }; },
  };
}

describe('MCP Apps (ui:// resources)', () => {
  it('reads the UI link in the nested and the flat form', () => {
    expect(mcpAppUiMeta({ name: 'a', _meta: { ui: { resourceUri: 'ui://x' } } } as any)).toEqual({ resourceUri: 'ui://x', visibility: ['model', 'app'] });
    expect(mcpAppUiMeta({ name: 'a', _meta: { 'ui/resourceUri': 'ui://y' } } as any)?.resourceUri).toBe('ui://y');
    expect(mcpAppUiMeta({ name: 'a', _meta: { ui: { resourceUri: 'https://evil' } } } as any)).toBeNull();
  });

  it('lists app tools, reads their HTML and lets the app call tools it may call', async () => {
    const agent = agentStub();
    const conn = await connectMcpServers(agent as any, [{ name: 'charts', url: 'x' }], { makeTransport: appServer });
    expect(Object.keys(conn.appTools).sort()).toEqual(['charts__model_only', 'charts__show_chart']);
    expect(conn.appTools['charts__show_chart']).toMatchObject({ server: 'charts', tool: 'show_chart', resourceUri: 'ui://charts/main' });

    const res = await conn.readAppResource('charts', 'ui://charts/main');
    expect(res.html).toContain('chart');
    expect(res.csp?.connectDomains).toEqual(['https://api.example.com']);
    expect(res.prefersBorder).toBe(true);

    await expect(conn.readAppResource('charts', 'ui://not/declared')).rejects.toThrow(/not a UI resource/);
    await expect(conn.readAppResource('charts', 'https://x')).rejects.toThrow(/ui:\/\//);

    const called = await conn.callAppTool('charts', 'show_chart', { q: 1 });
    expect(called.content[0]).toEqual({ type: 'text', text: 'called show_chart' });
    await expect(conn.callAppTool('charts', 'model_only', {})).rejects.toThrow(/may not be called from an app/);
    await expect(conn.callAppTool('charts', 'missing', {})).rejects.toThrow(/no tool named/);
    await conn.dispose();
  });

  it('refuses an MCP server that claims the reserved ui namespace', async () => {
    const conn = await connectMcpServers(agentStub() as any, [{ name: 'ui', url: 'x' }], { makeTransport: appServer });
    expect(conn.failures.map((f) => f.server)).toContain('ui');
    await conn.dispose();
  });
});

describe('www/agent.html', () => {
  it('has no stray <script> text inside its inline scripts', () => {
    // A literal "<script" inside script text can make the HTML parser swallow
    // the rest of the page, so the app script would never run.
    const html = read('www/agent.html');
    const tags = html.match(/<script\b[^>]*>/g) || [];
    const closes = html.match(/<\/script>/g) || [];
    expect(tags.length).toBe(closes.length);
  });

  it('uses the engine v2 APIs only behind getEngineFeatures', () => {
    const html = read('www/agent.html');
    expect(html).toContain('getEngineFeatures');
    for (const f of ['imageInput', 'rewindSession', 'forkSession', 'approvalWithArgs', 'uiTools']) {
      expect(html, `feature check for ${f}`).toContain(`engine.has('${f}')`);
    }
    // The old calls stay in place for older app builds.
    expect(html).toContain('bridge.respondToApproval(approvalId, ok, ok ? undefined : reason)');
  });
});
