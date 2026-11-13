// Adds the engine v2 NativeKit APIs to the mock3 stub (loaded after it).
(() => {
  const k = window.NativeKit;
  if (!k || !k.agent) return;
  const calls = window.__mock.calls;
  const rec = (name, args) => { calls.push({ name, args: JSON.parse(JSON.stringify(args ?? null)) }); };
  const a = k.agent;
  const uiTools = new Map();
  window.__mock.uiTools = uiTools;
  a.getEngineFeatures = async () => { rec('agent.getEngineFeatures'); return { engineVersion: '0.6.0-test', features: ['attachments', 'imageInput', 'approvalWithArgs', 'rewindSession', 'forkSession', 'uiTools', 'removeMcpTools'], limits: { maxAttachments: 8, maxImageBase64Chars: 8388608, uiToolPrefix: 'ui__' } }; };
  const oldFollowUp = a.followUp;
  a.followUp = async (t, opts) => { if (opts) { rec('agent.followUpWith', { prompt: t, n: opts.attachments?.length, types: (opts.attachments || []).map((x) => x.mediaType) }); return {}; } return oldFollowUp(t); };
  const oldSend = a.sendMessage;
  a.sendMessage = async (o) => { if (o && o.attachments) { rec('agent.sendMessageWith', { prompt: o.prompt, sessionKey: o.sessionKey, n: o.attachments.length }); return {}; } return oldSend(o); };
  a.rewindSession = async (key, keep, opts) => { rec('agent.rewindSession', [key, keep, opts || null]); if (window.__mock.rewindFails) throw new Error('history does not match'); return { removedMessages: 2, keptUserTurns: keep }; };
  a.forkSession = async (src, opts) => { rec('agent.forkSession', [src, opts]); return { sessionKey: opts.newSessionKey, copiedMessages: 2 }; };
  a.respondToApprovalWithArgs = async (id, ok, reason, args) => { rec('agent.respondToApprovalWithArgs', [id, ok, reason ?? null, args]); return { delivered: true }; };
  a.registerUiTool = async (tool) => { rec('agent.registerUiTool', tool.name); uiTools.set(tool.name, tool); return { name: `ui__${tool.name}` }; };
  a.unregisterUiTool = async (n) => { rec('agent.unregisterUiTool', n); uiTools.delete(n); };
  const oldConnect = a.connectMcp;
  a.connectMcp = async (s, o) => {
    const r = await oldConnect(s, o);
    return {
      ...r,
      appTools: { docs__show_chart: { server: 'docs', tool: 'show_chart', resourceUri: 'ui://docs/chart', visibility: ['model', 'app'] } },
      readAppResource: async (server, uri) => { rec('mcp.readAppResource', [server, uri]); return { uri, html: '<div id="out">waiting</div><button id="b">Refresh</button><script>let rid=1;window.addEventListener("message",(e)=>{const m=e.data;if(m&&m.method==="ui/notifications/tool-input"){document.getElementById("out").textContent="input:"+JSON.stringify(m.params.arguments)}if(m&&m.id===1&&m.result){parent.postMessage({jsonrpc:"2.0",method:"ui/notifications/initialized"},"*")}if(m&&m.id===2&&m.result){document.getElementById("out").textContent="tool:"+m.result.content[0].text}});parent.postMessage({jsonrpc:"2.0",id:1,method:"ui/initialize",params:{}},"*");document.getElementById("b").onclick=()=>parent.postMessage({jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"show_chart",arguments:{q:2}}},"*");</script>', csp: { connectDomains: ['https://api.example.com'] }, prefersBorder: true }; },
      callAppTool: async (server, name, args) => { rec('mcp.callAppTool', [server, name, args]); return { content: [{ type: 'text', text: `chart ${args.q}` }] }; },
      dispose() {},
    };
  };
})();
