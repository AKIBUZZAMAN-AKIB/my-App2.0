// Local test stub of the app's NativeKit bridge. It records every call and lets the test emit engine events.
(() => {
  const calls = [];
  const rec = (name, args) => { calls.push({ name, args: JSON.parse(JSON.stringify(args ?? null)) }); };
  let listener = null;
  const prefs = { 'nativekit.agent.mcp.servers.v1': [{ name: 'docs', url: 'https://mcp.example.com/mcp', protocolVersion: '2026-07-28', alwaysAsk: true }] };
  const secure = { 'nativekit.agent.mcp.token.docs': 'tok_123' };
  const sessions = [
    { sessionKey: 'chat-1700000000000', provider: 'auto', model: 'kilo-auto/free', updatedAt: Date.now() - 3600e3 },
    { sessionKey: 'chat-1690000000000', provider: 'openai', model: 'gpt-5', updatedAt: Date.now() - 86400e3 },
  ];
  const stored = {
    'chat-1700000000000': [
      { role: 'user', content: 'What files do I have?', createdAt: Date.now() - 3600e3 },
      { role: 'assistant', content: [{ type: 'text', text: 'Let me look.' }], tool_calls: [{ id: 'tc_old', name: 'list_files', input: { path: '.' } }], createdAt: Date.now() - 3599e3 },
      { role: 'assistant', content: 'You have **notes.md** and `todo.txt`.', tool_results: [{ tool_call_id: 'tc_old', output: '{"entries":[{"name":"notes.md","type":"file"}]}' }], createdAt: Date.now() - 3598e3 },
    ],
    'chat-1690000000000': [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'Hi!' }],
  };
  const agent = {
    supported: async () => { rec('agent.supported'); return true; },
    checkAvailability: async () => { rec('agent.checkAvailability'); return { available: true, abi: 7 }; },
    initialize: async (o) => { rec('agent.initialize', o); return {}; },
    onEvent: async (cb) => { rec('agent.onEvent'); listener = cb; return { remove() {} }; },
    listSessions: async (a) => { rec('agent.listSessions', a); return { sessionsJson: JSON.stringify(sessions) }; },
    loadSession: async (k, a) => { rec('agent.loadSession', [k, a]); return { messagesJson: JSON.stringify(stored[k] || []) }; },
    resumeSession: async (o) => { rec('agent.resumeSession', o); return {}; },
    sendMessage: async (o) => { rec('agent.sendMessage', o); return {}; },
    followUp: async (t) => { rec('agent.followUp', t); return {}; },
    abort: async () => { rec('agent.abort'); return {}; },
    respondToApproval: async (id, ok, reason) => { rec('agent.respondToApproval', [id, ok, reason ?? null]); return {}; },
    connectMcp: async (s, o) => { rec('agent.connectMcp', [s, o]); return { toolCount: 12, failures: [] }; },
    invokeTool: async (n, a) => {
      rec('agent.invokeTool', [n, a]);
      const r = n === 'memory_list' ? [{ key: 'user.name', text: 'Akib' }] : n === 'read_file' ? { content: 'Be concise.' } : { ok: true };
      return { resultJson: JSON.stringify(r) };
    },
    getAuthStatus: async (p) => { rec('agent.getAuthStatus', p); return p === 'openai' ? { hasKey: true, masked: 'sk-…a1b2' } : { hasKey: false }; },
    setAuthKey: async (k, p) => { rec('agent.setAuthKey', [k ? '<key>' : '', p]); return {}; },
    getModels: async (p) => { rec('agent.getModels', p); return { modelsJson: JSON.stringify([{ id: 'gpt-5', name: 'GPT-5', toolCalling: true }, { id: 'gpt-5-mini', isFree: false }]) }; },
    getRuntimeConfig: async () => { rec('agent.getRuntimeConfig'); return { defaultMaxTurns: 12, maxTokens: 4096, temperature: 0.7, contextCharBudget: 120000, mcpToolTimeoutMs: 60000, autoRouting: { failoverOnTransient: true, maxFallbacks: 3 } }; },
    setRuntimeConfig: async (c) => { rec('agent.setRuntimeConfig', c); return {}; },
    listToolPermissions: async () => { rec('agent.listToolPermissions'); return { permissionsJson: JSON.stringify([{ toolName: 'read_file', permission: 'always_allow', enabled: true }, { toolName: 'write_file', permission: 'always_ask', enabled: true }]) }; },
    setToolPermission: async (...a) => { rec('agent.setToolPermission', a); return {}; },
    seedToolPermissions: async (l) => { rec('agent.seedToolPermissions', l); return {}; },
    listCronJobs: async () => { rec('agent.listCronJobs'); return { jobsJson: JSON.stringify([{ id: 'j1', name: 'Morning summary', prompt: 'Summarize', enabled: true, nextRunAt: Date.now() + 3600e3, deliveryMode: 'notification' }]) }; },
    listSkills: async () => { rec('agent.listSkills'); return { skillsJson: JSON.stringify([{ id: 's1', name: 'Tidy notes', allowedTools: ['read_file'] }]) }; },
    getWakeStatus: async () => { rec('agent.getWakeStatus'); return { intervalMinutes: 30, jobScheduled: true, mechanism: 'WorkManager' }; },
    getSchedulerConfig: async () => { rec('agent.getSchedulerConfig'); return { heartbeat: { enabled: false, everyMs: 1800000 } }; },
    loadSurfacedMessages: async (n) => { rec('agent.loadSurfacedMessages', n); return { messagesJson: '[]' }; },
    deleteAuth: async (p) => { rec('agent.deleteAuth', p); return {}; },
    resetToolPermissions: async () => { rec('agent.resetToolPermissions'); return {}; },
    addCronJob: async (j) => { rec('agent.addCronJob', j); return {}; },
  };
  window.NativeKit = {
    agent,
    secureStorage: {
      get: async (key) => { rec('secureStorage.get', key); return secure[key] ?? null; },
      set: async (key, value) => { rec('secureStorage.set', key); secure[key] = value; return {}; },
      remove: async (key) => { rec('secureStorage.remove', key); delete secure[key]; return {}; },
    },
    preferences: {
      getJSON: async (key) => { rec('preferences.getJSON', key); return prefs[key] ?? null; },
      setJSON: async (key, value) => { rec('preferences.setJSON', [key, value]); prefs[key] = value; return {}; },
    },
    biometric: { verify: async (reason) => { rec('biometric.verify', reason); return { verified: true }; } },
  };
  window.__mock = {
    calls,
    emit(eventType, payload) { listener && listener({ eventType, payloadJson: JSON.stringify(payload) }); },
  };
})();
