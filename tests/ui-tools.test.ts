import { describe, expect, it } from 'vitest';

import { UI_TOOL_PREFIX, createUiToolRegistry, toMcpResult, type UiToolAgent } from '../bridge/ui-tools';

function fakeAgent(opts: { withRemove?: boolean } = {}) {
  const published: any[][] = [];
  const removed: string[][] = [];
  const responses: Array<{ id: string; result: any; isError: boolean }> = [];
  let handler: ((event: any) => void) | undefined;
  const agent: UiToolAgent & { emit(event: any): void } = {
    async startMcp(toolsJson: string) {
      published.push(JSON.parse(toolsJson));
    },
    async respondToMcpTool(id: string, resultJson: string, isError: boolean) {
      responses.push({ id, result: JSON.parse(resultJson), isError });
    },
    addListener(_event: string, h: (event: any) => void) {
      handler = h;
      return { remove: () => { handler = undefined; } };
    },
    emit(event: any) {
      handler?.(event);
    },
  };
  if (opts.withRemove) {
    agent.removeMcpTools = async (namesJson: string) => {
      removed.push(JSON.parse(namesJson));
    };
  }
  return { agent, published, removed, responses };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const call = (toolName: string, args: unknown, toolCallId = 'c1') => ({
  eventType: 'mcp_tool_call',
  payloadJson: JSON.stringify({ toolCallId, toolName, args }),
});

describe('UI tools (frontend tools answered by the page)', () => {
  it('publishes a ui__ tool that only a live page can answer', async () => {
    const { agent, published } = fakeAgent();
    const registry = createUiToolRegistry(agent);
    const handle = await registry.register({ name: 'pick_date', description: 'Ask the user for a date', execute: () => '2026-11-13' });

    expect(handle.name).toBe(`${UI_TOOL_PREFIX}pick_date`);
    expect(published[0][0]).toMatchObject({
      name: 'ui__pick_date',
      description: 'Ask the user for a date',
      webviewOnly: true,
      approvalPolicy: 'always_allow',
      inputSchema: { type: 'object', properties: {} },
    });
    expect(registry.list()).toEqual(['ui__pick_date']);
  });

  it('rejects bad names, missing descriptions and missing execute', async () => {
    const registry = createUiToolRegistry(fakeAgent().agent);
    await expect(registry.register({ name: '1bad', description: 'x', execute: () => 1 })).rejects.toThrow(/name/);
    await expect(registry.register({ name: 'ok', description: ' ', execute: () => 1 })).rejects.toThrow(/description/);
    await expect(registry.register({ name: 'ok', description: 'x' } as any)).rejects.toThrow(/execute/);
  });

  it('runs the page handler and answers the engine with its result', async () => {
    const { agent, responses } = fakeAgent();
    const registry = createUiToolRegistry(agent);
    await registry.register({
      name: 'confirm',
      description: 'Ask yes or no',
      execute: (args) => ({ answer: args.question === 'go?' ? 'yes' : 'no' }),
    });
    agent.emit(call('ui__confirm', { question: 'go?' }));
    await flush();

    expect(responses).toHaveLength(1);
    expect(responses[0].id).toBe('c1');
    expect(responses[0].isError).toBe(false);
    expect(responses[0].result.structuredContent).toEqual({ answer: 'yes' });
    expect(JSON.parse(responses[0].result.content[0].text)).toEqual({ answer: 'yes' });
  });

  it('turns a throw into an error result instead of leaving the turn hanging', async () => {
    const { agent, responses } = fakeAgent();
    const registry = createUiToolRegistry(agent);
    await registry.register({ name: 'boom', description: 'fails', execute: () => { throw new Error('user closed the form'); } });
    agent.emit(call('ui__boom', {}));
    await flush();
    expect(responses[0]).toMatchObject({ id: 'c1', isError: true });
    expect(responses[0].result.content[0].text).toBe('user closed the form');
  });

  it('answers an unknown ui__ tool with an error and ignores other servers', async () => {
    const { agent, responses } = fakeAgent();
    const registry = createUiToolRegistry(agent);
    await registry.register({ name: 'known', description: 'k', execute: () => 'ok' });
    agent.emit(call('ui__missing', {}, 'a'));
    agent.emit(call('weather__forecast', {}, 'b'));
    await flush();
    expect(responses.map((r) => r.id)).toEqual(['a']);
    expect(responses[0].isError).toBe(true);
  });

  it('rejects non-object arguments', async () => {
    const { agent, responses } = fakeAgent();
    const registry = createUiToolRegistry(agent);
    await registry.register({ name: 't', description: 'd', execute: () => 'never' });
    agent.emit(call('ui__t', [1, 2]));
    await flush();
    expect(responses[0].isError).toBe(true);
  });

  it('answers open calls with an error when the tool is unregistered, and drops it from the engine', async () => {
    const { agent, responses, removed } = fakeAgent({ withRemove: true });
    const registry = createUiToolRegistry(agent);
    let aborted = false;
    await registry.register({
      name: 'slow',
      description: 'waits for the user',
      execute: (_args, ctx) => new Promise((resolve) => ctx.signal.addEventListener('abort', () => { aborted = true; resolve('late'); })),
    });
    agent.emit(call('ui__slow', {}));
    await flush();
    expect(registry.pending()).toEqual([{ toolCallId: 'c1', tool: 'slow' }]);

    await registry.unregister('slow');
    await flush();
    expect(aborted).toBe(true);
    expect(responses).toHaveLength(1); // the late resolve is not sent twice
    expect(responses[0].isError).toBe(true);
    expect(removed).toEqual([['ui__slow']]);
    expect(registry.list()).toEqual([]);
  });

  it('republishes every tool after a catalogue replace', async () => {
    const { agent, published } = fakeAgent();
    const registry = createUiToolRegistry(agent);
    await registry.register({ name: 'a', description: 'A', execute: () => 1 });
    await registry.register({ name: 'b', description: 'B', execute: () => 2, approvalPolicy: 'always_ask' });
    await registry.republish();
    const last = published[published.length - 1];
    expect(last.map((t: any) => t.name)).toEqual(['ui__a', 'ui__b']);
    expect(last[1].approvalPolicy).toBe('always_ask');
  });

  it('normalises handler return values into MCP results', () => {
    expect(toMcpResult(undefined)).toEqual({ content: [{ type: 'text', text: 'Done.' }] });
    expect(toMcpResult('hi')).toEqual({ content: [{ type: 'text', text: 'hi' }] });
    expect(toMcpResult([1, 2])).toEqual({ content: [{ type: 'text', text: '[1,2]' }] });
    const full = { content: [{ type: 'text', text: 'x' }], isError: true };
    expect(toMcpResult(full)).toBe(full);
  });
});
