// The real bridge/workspace-files.ts, bundled for the browser and installed as
// NativeKit.agent.workspace over an in-page file map. The local file server is
// a blob: URL per file and fetch() is the page's own, so the streaming reader,
// the size checks, the "changed while reading" check, binary detection and
// office text extraction all run the shipped code. Mock NativeKit only.
const path = require('path');
const esbuild = require(path.resolve(__dirname, '../../node_modules/esbuild'));

let bundle = null;
function bundled() {
  if (!bundle) {
    bundle = esbuild.buildSync({
      entryPoints: [path.resolve(__dirname, '../../bridge/workspace-files.ts')],
      bundle: true, format: 'iife', globalName: '__WSF', write: false, platform: 'browser', target: 'es2020',
    }).outputFiles[0].text;
  }
  return bundle;
}

// Runs in the page after mock3.js. window.__ws.files: path -> Uint8Array.
function install() {
  const ws = window.__ws || (window.__ws = {});
  ws.files = ws.files || {};
  ws.mtimes = ws.mtimes || {};
  ws.reads = ws.reads || [];
  ws.urls = ws.urls || [];
  ws.fetches = 0;
  const blobs = new Map();
  const rel = (p) => String(p).replace(/^agent\/workspace\//, '');
  const deps = {
    getUri: async (p) => `file:///data/user/0/app/files/${p}`,
    stat: async (p) => {
      const r = rel(p);
      if (ws.statError && ws.statError[r]) throw new Error(ws.statError[r]);
      const b = ws.files[r];
      if (b == null) throw new Error('File does not exist');
      return { size: (ws.sizes && ws.sizes[r]) || b.length, mtime: ws.mtimes[r] || 1, type: 'file' };
    },
    toWebUrl: (uri) => {
      const r = rel(uri.replace('file:///data/user/0/app/files/', ''));
      const b = ws.files[r];
      const key = r + ':' + (b ? b.length : 0) + ':' + (ws.mtimes[r] || 1);
      if (!blobs.has(key)) blobs.set(key, URL.createObjectURL(new Blob([b || new Uint8Array(0)], { type: window.__WSF.mimeTypeOf(r) })));
      ws.urls.push(r);
      return blobs.get(key);
    },
    fetch: async (u, init) => {
      ws.fetches++;
      if (ws.fetchFails) throw new TypeError('Failed to fetch');
      // A file that grows between stat and read.
      const grow = ws.growOnRead;
      if (grow) { ws.growOnRead = null; const b = ws.files[grow]; const n = new Uint8Array(b.length + 10); n.set(b); n.fill(65, b.length); return new Response(new Blob([n])); }
      return window.fetch(u, init);
    },
    readFileBase64: async (p) => {
      const b = ws.files[rel(p)];
      if (!b) throw new Error('File does not exist');
      let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(b.subarray(i, i + 0x8000)));
      return btoa(s);
    },
    shareFile: async (uri, name) => { ws.shared = (ws.shared || []).concat([{ uri, name }]); return {}; },
  };
  const api = window.__WSF.createWorkspaceFiles(deps);
  const wrap = (name) => { const f = api[name]; api[name] = async (p, o) => { ws.reads.push({ op: name, path: p, maxBytes: o && o.maxBytes }); return f(p, o); }; };
  ['read', 'readBytes', 'documentText', 'url', 'share'].forEach(wrap);
  window.NativeKit.agent.workspace = api;
}

function realWorkspaceScript() {
  return `${bundled()}\nwindow.__WSF = __WSF;\n(${install.toString()})();`;
}

module.exports = { realWorkspaceScript };
