/**
 * Frontend (UI) tools for the native agent.
 *
 * A WebView can register tools the model may call, whose result comes from the
 * page itself — a confirmation dialog, a form the user fills in, a value read
 * from the current screen. This is the human-in-the-loop pattern assistant-ui
 * calls `makeAssistantTool`.
 *
 * Transport: the engine already proxies MCP tools to the WebView through the
 * `mcp_tool_call` event and blocks the turn until `respondToMcpTool` answers.
 * UI tools ride that same path under the reserved `ui__` namespace, so no new
 * event type is needed and older native builds still deliver the calls. Newer
 * engines give `ui__*` calls a 10-minute floor instead of the short MCP
 * timeout, because a person may need time to answer.
 *
 * The registry is the only listener that answers `ui__*` calls;
 * `connectMcpServers` skips them.
 */

import { UI_TOOL_SERVER, type McpCallToolResult } from './mcp-client';

export const UI_TOOL_PREFIX = `${UI_TOOL_SERVER}__`;

export interface UiToolContext {
  toolCallId: string;
  sessionKey?: string;
  /** Aborted when the tool is unregistered while the call is still open. */
  signal: AbortSignal;
}

export interface UiToolDefinition {
  /** Name without the prefix: letters, digits, `_` or `-`, at most 48. */
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  /**
   * Runs in the page. Return a string, any JSON value, or a full MCP
   * `{ content, structuredContent?, isError? }` result. A throw becomes an
   * error result the model can read.
   */
  execute: (args: Record<string, unknown>, context: UiToolContext) => unknown | Promise<unknown>;
  /** Default `always_allow`: the tool's own UI is already the user's decision. */
  approvalPolicy?: 'always_allow' | 'always_ask' | 'always_ask_biometric';
}

/** The slice of the native plugin this registry needs. */
export interface UiToolAgent {
  startMcp(toolsJson: string): Promise<unknown>;
  removeMcpTools?(namesJson: string): Promise<unknown>;
  respondToMcpTool(toolCallId: string, resultJson: string, isError: boolean): Promise<unknown>;
  addListener(event: string, handler: (event: any) => void): Promise<{ remove: () => void }> | { remove: () => void };
}

const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,47}$/;

/** Normalise whatever `execute` returned into an MCP tool result. */
export function toMcpResult(value: unknown): McpCallToolResult {
  if (value && typeof value === 'object' && Array.isArray((value as McpCallToolResult).content)) {
    return value as McpCallToolResult;
  }
  if (value === undefined || value === null) return { content: [{ type: 'text', text: 'Done.' }] };
  if (typeof value === 'string') return { content: [{ type: 'text', text: value }] };
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  return {
    content: [{ type: 'text', text }],
    ...(typeof value === 'object' && !Array.isArray(value) ? { structuredContent: value as Record<string, unknown> } : {}),
  };
}

function parsePayload(event: any): any {
  let payload: any = event?.payloadJson ?? event?.payload ?? event;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      payload = {};
    }
  }
  return payload ?? {};
}

export function createUiToolRegistry(agent: UiToolAgent) {
  const tools = new Map<string, UiToolDefinition>();
  const open = new Map<string, { tool: string; controller: AbortController }>();
  let listening: Promise<{ remove: () => void }> | null = null;

  const catalogueEntry = (tool: UiToolDefinition) => ({
    name: UI_TOOL_PREFIX + tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
    // Only a live page can answer, so background wakes never see these.
    webviewOnly: true,
    approvalPolicy: tool.approvalPolicy ?? 'always_allow',
  });

  const reply = async (toolCallId: string, result: McpCallToolResult) => {
    open.delete(toolCallId);
    await agent.respondToMcpTool(toolCallId, JSON.stringify(result), Boolean(result.isError));
  };

  async function handle(event: any): Promise<void> {
    const type = event?.eventType ?? event?.type;
    if (type !== 'mcp_tool_call') return;
    const payload = parsePayload(event);
    const fullName = String(payload.toolName ?? payload.tool_name ?? '');
    if (!fullName.startsWith(UI_TOOL_PREFIX)) return;
    const toolCallId = payload.toolCallId ?? payload.tool_call_id;
    if (!toolCallId || open.has(toolCallId)) return;
    const name = fullName.slice(UI_TOOL_PREFIX.length);
    const tool = tools.get(name);
    if (!tool) {
      await reply(toolCallId, { content: [{ type: 'text', text: `The UI tool '${name}' is not available on this screen.` }], isError: true });
      return;
    }
    let args: Record<string, unknown> = {};
    const raw = typeof payload.args === 'string' ? (() => { try { return JSON.parse(payload.args); } catch { return null; } })() : payload.args;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) args = raw;
    else if (raw !== undefined && raw !== null) {
      await reply(toolCallId, { content: [{ type: 'text', text: `The arguments for '${name}' must be a JSON object.` }], isError: true });
      return;
    }
    const controller = new AbortController();
    open.set(toolCallId, { tool: name, controller });
    let result: McpCallToolResult;
    try {
      result = toMcpResult(await tool.execute(args, { toolCallId, sessionKey: payload.sessionKey, signal: controller.signal }));
    } catch (error) {
      result = { content: [{ type: 'text', text: String((error as Error)?.message ?? error ?? 'The UI tool failed.') }], isError: true };
    }
    if (!open.has(toolCallId)) return; // already answered by unregister()
    try {
      await reply(toolCallId, result);
    } catch {
      /* the turn ended (abort/timeout); nothing is waiting any more */
    }
  }

  function ensureListening() {
    if (!listening) listening = Promise.resolve(agent.addListener('nativeAgentEvent', (event) => { void handle(event); }));
    return listening;
  }

  return {
    /** Register (or replace) a UI tool. Resolves once the engine knows it. */
    async register(tool: UiToolDefinition): Promise<{ name: string; unregister: () => Promise<void> }> {
      if (!tool || !NAME.test(tool.name ?? '')) throw new Error('registerUiTool: name must start with a letter and use letters, digits, _ or - (48 at most).');
      if (typeof tool.description !== 'string' || !tool.description.trim()) throw new Error('registerUiTool: description is required.');
      if (typeof tool.execute !== 'function') throw new Error('registerUiTool: execute must be a function.');
      await ensureListening();
      tools.set(tool.name, tool);
      await agent.startMcp(JSON.stringify([catalogueEntry(tool)]));
      return { name: UI_TOOL_PREFIX + tool.name, unregister: () => this.unregister(tool.name) };
    },
    /** Remove a UI tool. Open calls to it are answered with an error so no turn hangs. */
    async unregister(name: string): Promise<void> {
      if (!tools.delete(name)) return;
      for (const [toolCallId, call] of [...open]) {
        if (call.tool !== name) continue;
        call.controller.abort();
        await reply(toolCallId, { content: [{ type: 'text', text: `The UI tool '${name}' was closed before it answered.` }], isError: true }).catch(() => undefined);
      }
      // Older engines cannot drop one tool; a stale entry is then answered
      // with "not available" by handle() instead of hanging.
      if (agent.removeMcpTools) await agent.removeMcpTools(JSON.stringify([UI_TOOL_PREFIX + name])).catch(() => undefined);
    },
    list(): string[] {
      return [...tools.keys()].map((name) => UI_TOOL_PREFIX + name);
    },
    /** Publish every registered tool again (after a catalogue replace such as restartMcp). */
    async republish(): Promise<void> {
      if (tools.size) await agent.startMcp(JSON.stringify([...tools.values()].map(catalogueEntry)));
    },
    /** Calls still waiting for the page. */
    pending(): Array<{ toolCallId: string; tool: string }> {
      return [...open].map(([toolCallId, call]) => ({ toolCallId, tool: call.tool }));
    },
  };
}

export type UiToolRegistry = ReturnType<typeof createUiToolRegistry>;
