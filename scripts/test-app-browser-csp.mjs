#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createTlsServer } from 'node:tls';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const temp = await mkdtemp(path.join(tmpdir(), 'nativekit-csp-browser-'));
const webRoot = path.join(temp, 'www');
const tlsRoot = path.join(temp, 'tls');
await mkdir(webRoot, { recursive: true });
await mkdir(tlsRoot, { recursive: true });

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/tmp/nativekit-chrome/chrome-linux64/chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { execFileSync(candidate, ['--version'], { stdio: 'ignore' }); return candidate; }
    catch { /* Try the next candidate. */ }
  }
  throw new Error('Chrome/Chromium not found. Set CHROME_PATH to a compatible executable.');
}

const chrome = findChrome();
const keyPath = path.join(tlsRoot, 'key.pem');
const certPath = path.join(tlsRoot, 'cert.pem');
execFileSync('openssl', [
  'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1',
  '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
  '-keyout', keyPath, '-out', certPath,
], { stdio: 'ignore' });
const { readFile } = await import('node:fs/promises');
const tlsOptions = { key: await readFile(keyPath), cert: await readFile(certPath) };

await build({
  entryPoints: [path.join(root, 'bridge/app-browser.ts')],
  outfile: path.join(webRoot, 'app-browser.js'),
  bundle: true,
  format: 'iife',
  globalName: 'NativeKitAppBrowserModule',
  platform: 'browser',
  target: ['chrome120'],
  logLevel: 'silent',
});

const childScript = String.raw`
const results=window.results={inlineScript:true,classicScript:false,moduleScript:false,dataImage:false,blobImage:false,approvedImage:false,blobWorker:false,approvedFetch:false,approvedWebSocket:false,blockedWebSocket:false,blockedFetch:false,dataWorkerBlocked:false,remoteScriptBlocked:false,formAttempted:false,nativeKitFacade:false,allowOnceCall:false,allowAlwaysCall:false,storedAllowCall:false,blockOnceCall:false,blockAlwaysCall:false,storedBlockCall:false,violations:[]};
document.addEventListener('securitypolicyviolation',event=>results.violations.push({directive:event.effectiveDirective,blocked:event.blockedURI}));
addEventListener('error',event=>{if(String(event?.target?.src||'').includes('/evil.js'))results.remoteScriptBlocked=true},true);
async function image(url,key){await new Promise(resolve=>{const item=new Image();item.onload=()=>{results[key]=true;resolve()};item.onerror=resolve;item.src=url;document.body.append(item)})}
async function run(){
  await new Promise(resolve=>setTimeout(resolve,100));
  await image('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>','dataImage');
  const blobUrl=URL.createObjectURL(new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'],{type:'image/svg+xml'}));
  await image(blobUrl,'blobImage');URL.revokeObjectURL(blobUrl);
  await image('https://127.0.0.1:9443/pixel.svg','approvedImage');
  try{const response=await fetch('https://127.0.0.1:9443/json');results.approvedFetch=response.ok&&(await response.json()).ok===true}catch{}
  try{await fetch('https://blocked.invalid/nope')}catch{results.blockedFetch=true}
  await new Promise(resolve=>{try{const workerUrl=URL.createObjectURL(new Blob(["postMessage('ok')"],{type:'text/javascript'}));const worker=new Worker(workerUrl);worker.onmessage=()=>{results.blobWorker=true;worker.terminate();URL.revokeObjectURL(workerUrl);resolve()};worker.onerror=()=>resolve();setTimeout(resolve,800)}catch{resolve()}});
  try{const worker=new Worker("data:text/javascript,postMessage('bad')");worker.onerror=()=>{results.dataWorkerBlocked=true};setTimeout(()=>worker.terminate(),500)}catch{results.dataWorkerBlocked=true}
  await new Promise(resolve=>{try{const socket=new WebSocket('wss://127.0.0.1:9443/socket');socket.onmessage=event=>{results.approvedWebSocket=event.data==='approved';socket.close();resolve()};socket.onerror=()=>resolve();setTimeout(resolve,1000)}catch{resolve()}});
  try{const blocked=new WebSocket('wss://blocked.invalid/socket');blocked.onerror=()=>{results.blockedWebSocket=true};setTimeout(()=>blocked.close(),500)}catch{results.blockedWebSocket=true}
  const remote=document.createElement('script');remote.src='https://127.0.0.1:9443/evil.js';document.body.append(remote);
  const form=document.createElement('form');form.action='https://127.0.0.1:9443/form';form.method='post';document.body.append(form);results.formAttempted=true;try{form.submit()}catch{}
  results.nativeKitFacade=!!window.NativeKit&&NativeKit.appIdentity?.id==='browser.csp.test'&&await NativeKit.ready()===NativeKit;
  try{const value=await NativeKit.haptics.impact('LIGHT');results.allowOnceCall=value?.style==='LIGHT'}catch{}
  try{const value=await NativeKit.haptics.notification('SUCCESS');results.allowAlwaysCall=value?.type==='SUCCESS'}catch{}
  try{const value=await NativeKit.haptics.notification('WARNING');results.storedAllowCall=value?.type==='WARNING'}catch{}
  try{await NativeKit.haptics.vibrate(101)}catch(error){results.blockOnceCall=error?.code==='POLICY_BLOCKED_ONCE'}
  try{await NativeKit.haptics.vibrate(102)}catch(error){results.blockAlwaysCall=error?.code==='POLICY_BLOCKED_ALWAYS'}
  try{await NativeKit.haptics.vibrate(103)}catch(error){results.storedBlockCall=error?.code==='POLICY_DENIED'}
  setTimeout(()=>parent.postMessage({type:'nativekit-csp-results',results},'*'),1400);
}
run();
`;

const indexHtml = `<!doctype html><html><head><meta charset="utf-8"><title>CSP browser test package</title><script>${childScript.replaceAll('</script', '<\\/script')}</script><script src="classic.js"></script><script type="module" src="module.js"></script></head><body></body></html>`;
const packageHtmlJson = JSON.stringify(indexHtml).replaceAll('</script', '<\\/script');
const parentHtml = `<!doctype html><html><head><meta charset="utf-8"><title>NativeKit CSP browser test</title><script src="/app-browser.js"></script></head><body><main id="target"></main><script>
(async()=>{
  document.documentElement.dataset.stage='started';
  const config={enabled:true,maxApps:4,maxPackageBytes:1048576,maxFiles:32,auditLogLimit:100,maxRequestsPerMinute:100,defaultCapabilities:[],permissionPrompts:{enabled:true,requestTimeoutMs:10000,requestedCapabilityDefault:'ask',unrequestedCapabilityDefault:'block'},allowDirectWebNetwork:true,urlMode:{enabled:true,allowedHosts:['127.0.0.1:9443']},renderer:'iframe',isolated:{enabled:false,fallbackToIframe:true,stageChunkBytes:65536,androidMinApi:28,hangTerminationDelayMs:4000}};
  const nativeCalls=[];
  const nativeKit={isNative:false,config:{features:{haptics:true}},haptics:{impact:async style=>{nativeCalls.push(['impact',style]);return{style}},notification:async type=>{nativeCalls.push(['notification',type]);return{type}},vibrate:async duration=>{nativeCalls.push(['vibrate',duration]);return{duration}}}};
  const browser=NativeKitAppBrowserModule.createAppBrowser(nativeKit,config);
  const permissionEvents=[];
  addEventListener('nativekitappbrowserpermissionrequest',event=>{
    const request=event.detail;permissionEvents.push({method:request.method,capability:request.capability,argumentSummary:request.argumentSummary});
    const prior=permissionEvents.filter(item=>item.method===request.method).length;
    const action=request.method==='haptics.impact'?'allow_once':request.method==='haptics.notification'?'allow_always':prior===1?'block_once':'block_always';
    browser.resolvePermissionRequest(request.requestId,action).catch(error=>{document.documentElement.dataset.error=String(error?.stack||error)});
  });
  const remoteWindows=[];
  window.open=(url,target,features)=>{const opened={url,target,features,opener:{},closed:false,close(){this.closed=true}};remoteWindows.push(opened);return opened};
  const remoteSession=await browser.openUrl('https://127.0.0.1:9443/remote');
  const remoteReport={nativeKit:remoteSession.nativeKit,mode:remoteSession.mode,installedSessions:browser.sessions().length,urlSessions:browser.urlSessions().length,features:remoteWindows[0]?.features,opener:remoteWindows[0]?.opener};
  await remoteSession.stop();remoteReport.closed=remoteWindows[0]?.closed===true;remoteReport.urlSessionsAfterStop=browser.urlSessions().length;
  document.documentElement.dataset.stage='created';
  await browser.install({files:[
    {path:'index.html',data:${packageHtmlJson}},
    {path:'classic.js',data:"window.results.classicScript=true"},
    {path:'module.js',data:"window.results.moduleScript=true"}
  ],manifest:{id:'browser.csp.test',name:'Browser CSP Test',entry:'index.html',requestedCapabilities:['haptics'],allowedHosts:['127.0.0.1:9443']}});
  document.documentElement.dataset.stage='installed';
  const session=await browser.launch('browser.csp.test',document.getElementById('target'));
  document.documentElement.dataset.stage='launched';
  addEventListener('message',async event=>{
    if(event.source!==session.frame.contentWindow||event.data?.type!=='nativekit-csp-results')return;
    const stats=await (await fetch('/stats')).json();
    const csp=/Content-Security-Policy[^>]+content=\"([^\"]+)/i.exec(session.frame.srcdoc)?.[1]||'';
    const audit=await browser.audit.list({appId:'browser.csp.test',limit:20});
    const policy=await browser.getPolicy('browser.csp.test');
    document.documentElement.dataset.result=btoa(unescape(encodeURIComponent(JSON.stringify({results:event.data.results,stats,csp,permissionEvents,nativeCalls,audit,policy,remoteReport}))));
  });
})().catch(error=>{document.documentElement.dataset.error=String(error?.stack||error)});
</script></body></html>`;
await writeFile(path.join(webRoot, 'index.html'), parentHtml);

const stats = { pixel: 0, json: 0, websocket: 0, evilScript: 0, form: 0 };
const tlsServer = createTlsServer(tlsOptions, (socket) => {
  let buffer = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    const marker = buffer.indexOf('\r\n\r\n');
    if (marker < 0) return;
    const request = buffer.subarray(0, marker).toString('utf8');
    buffer = Buffer.alloc(0);
    const [requestLine, ...lines] = request.split('\r\n');
    const [, requestPath = '/'] = requestLine.split(' ');
    const headers = Object.fromEntries(lines.map((line) => { const at = line.indexOf(':'); return [line.slice(0, at).toLowerCase(), line.slice(at + 1).trim()]; }));
    if (headers.upgrade?.toLowerCase() === 'websocket' && requestPath === '/socket') {
      stats.websocket += 1;
      const accept = createHash('sha1').update(`${headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      const payload = Buffer.from('approved');
      socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
      return;
    }
    const common = "Access-Control-Allow-Origin: null\r\nCache-Control: no-store\r\nConnection: close\r\n";
    let body = 'not found'; let type = 'text/plain'; let status = '404 Not Found';
    if (requestPath === '/pixel.svg') { stats.pixel += 1; status = '200 OK'; type = 'image/svg+xml'; body = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'; }
    else if (requestPath === '/json') { stats.json += 1; status = '200 OK'; type = 'application/json'; body = '{"ok":true}'; }
    else if (requestPath === '/evil.js') { stats.evilScript += 1; status = '200 OK'; type = 'text/javascript'; body = 'window.remoteScriptExecuted=true'; }
    else if (requestPath === '/form') { stats.form += 1; status = '204 No Content'; body = ''; }
    socket.end(`HTTP/1.1 ${status}\r\n${common}Content-Type: ${type}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  });
});

const httpServer = createServer(async (request, response) => {
  if (request.url === '/stats') {
    const body = JSON.stringify(stats);
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
    response.end(body); return;
  }
  const file = request.url === '/app-browser.js' ? 'app-browser.js' : 'index.html';
  const body = await readFile(path.join(webRoot, file));
  response.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : 'text/html', 'cache-control': 'no-store', 'content-length': body.length });
  response.end(body);
});

await new Promise((resolve, reject) => tlsServer.once('error', reject).listen(9443, '127.0.0.1', resolve));
await new Promise((resolve, reject) => httpServer.once('error', reject).listen(0, '127.0.0.1', resolve));
const port = httpServer.address().port;

try {
  const child = spawn(chrome, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-proxy-server',
    '--ignore-certificate-errors', '--disable-background-networking', '--remote-debugging-port=0', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  const debuggerUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Chrome DevTools did not start: ${stderr.slice(-2000)}`)), 10_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderr);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  const debugOrigin = debuggerUrl.replace(/^ws:/, 'http:').replace(/\/devtools\/browser\/.*$/, '');
  const pages = await (await fetch(`${debugOrigin}/json/list`)).json();
  const page = pages.find((item) => item.type === 'page');
  assert.ok(page?.webSocketDebuggerUrl, 'Chrome did not expose a debuggable page');
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id); pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
  });
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
  });
  await command('Runtime.enable');
  await command('Page.enable');
  await command('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  let browserState = {};
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const evaluated = await command('Runtime.evaluate', {
      expression: "JSON.stringify({result:document.documentElement.dataset.result||'',error:document.documentElement.dataset.error||'',stage:document.documentElement.dataset.stage||''})",
      returnByValue: true,
    });
    browserState = JSON.parse(evaluated.result.value || '{}');
    if (browserState.result || browserState.error) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  socket.close();
  child.kill('SIGTERM');
  await new Promise((resolve) => { child.once('close', resolve); setTimeout(resolve, 2_000); });
  assert.equal(browserState.error, '', `Browser harness failed: ${browserState.error}`);
  const encoded = browserState.result;
  assert.ok(encoded, `Browser harness did not return CSP results; stage=${browserState.stage}; server stats=${JSON.stringify(stats)}; Chrome=${stderr.slice(-2000)}`);
  const report = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  const values = report.results;
  for (const key of ['inlineScript', 'classicScript', 'moduleScript', 'dataImage', 'blobImage', 'approvedImage', 'blobWorker', 'approvedFetch', 'approvedWebSocket', 'blockedWebSocket', 'blockedFetch', 'dataWorkerBlocked', 'remoteScriptBlocked', 'formAttempted', 'nativeKitFacade', 'allowOnceCall', 'allowAlwaysCall', 'storedAllowCall', 'blockOnceCall', 'blockAlwaysCall', 'storedBlockCall']) {
    assert.equal(values[key], true, `${key} did not have the expected browser outcome`);
  }
  assert.deepEqual(report.permissionEvents.map((item) => item.method), ['haptics.impact', 'haptics.notification', 'haptics.vibrate', 'haptics.vibrate'], 'Call-time permission queue/events were not emitted exactly as expected');
  assert.ok(report.permissionEvents.every((item) => item.capability === 'haptics' && typeof item.argumentSummary === 'string'), 'Permission event identity or redacted argument summary is missing');
  assert.deepEqual(report.nativeCalls, [['impact', 'LIGHT'], ['notification', 'SUCCESS'], ['notification', 'WARNING']], 'Blocked calls reached the trusted NativeKit implementation or an allowed call was lost');
  assert.equal(report.policy.methodDecisions['haptics.notification'], 'allow', 'Allow always was not persisted');
  assert.equal(report.policy.methodDecisions['haptics.vibrate'], 'block', 'Block always was not persisted');
  assert.equal(report.audit.length, 6, 'Every brokered NativeKit call was not audited');
  assert.equal(report.audit.filter((item) => item.outcome === 'success').length, 3, 'Unexpected successful-call audit count');
  assert.equal(report.audit.filter((item) => item.outcome === 'denied').length, 3, 'Unexpected denied-call audit count');
  assert.ok(report.audit.some((item) => item.authorization === 'allow_once'), 'Allow-once authorization was not audited');
  assert.ok(report.audit.some((item) => item.authorization === 'stored_allow'), 'Stored allow authorization was not audited');
  assert.ok(report.audit.some((item) => item.error === 'POLICY_BLOCKED_ONCE'), 'Block-once code was not retained in audit');
  assert.ok(report.audit.some((item) => item.error === 'POLICY_BLOCKED_ALWAYS'), 'Block-always code was not retained in audit');
  assert.deepEqual(report.remoteReport, { nativeKit: false, mode: 'url', installedSessions: 0, urlSessions: 1, features: 'noopener,noreferrer', opener: null, closed: true, urlSessionsAfterStop: 0 }, 'Bridge-free web URL session metadata/lifecycle is incorrect');
  assert.equal(report.stats.pixel, 1, 'Approved HTTPS image was not requested exactly once');
  assert.equal(report.stats.json, 1, 'Approved HTTPS fetch was not requested exactly once');
  assert.equal(report.stats.websocket, 1, 'Approved WSS connection was not established exactly once');
  assert.equal(report.stats.evilScript, 0, 'Remote executable script reached the server');
  assert.equal(report.stats.form, 0, 'Denied form submission reached the server');
  assert.match(report.csp, /connect-src https:\/\/127\.0\.0\.1:9443 wss:\/\/127\.0\.0\.1:9443/);
  assert.match(report.csp, /worker-src blob:/);
  assert.match(report.csp, /form-action 'none'/);
  assert.match(report.csp, /script-src 'unsafe-inline' data: blob:/);
  const directives = new Set(values.violations.map((item) => item.directive));
  assert.ok([...directives].some((item) => item.startsWith('script-src')), 'No remote-script CSP violation was observed');
  assert.ok(directives.has('connect-src'), 'No blocked connection/WebSocket CSP violation was observed');
  assert.ok(directives.has('worker-src'), 'No data-worker CSP violation was observed');
  console.log(JSON.stringify({ ok: true, chrome, checks: 43, permissions: report.permissionEvents.length, auditedCalls: report.audit.length, stats: report.stats, violationDirectives: [...directives].sort() }, null, 2));
} finally {
  await Promise.all([
    new Promise((resolve) => httpServer.close(resolve)),
    new Promise((resolve) => tlsServer.close(resolve)),
  ]);
  await rm(temp, { recursive: true, force: true });
}
