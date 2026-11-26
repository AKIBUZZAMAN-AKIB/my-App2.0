/* Bring the app's existing screens into the new shell without rewriting them.
   Discovery, not a hard-coded list: anything on `window` that looks like a panel
   (a `__` name with `mount` or `render`) can be hosted; anything that does not is
   left alone. A screen that is not in this build is reported, never invented. */
const Screens = (() => {
  const KNOWN = {
    vault: ['__vault', '__vaultScreen'],
    notes: ['__notes', '__noteScreen'],
    genui: ['__genui', '__genuiCore'],
    folders: ['__folders'],
    memory: ['__memory'],
    contextPolicies: ['__contextPolicies'],
    opendata: ['__openData', '__opendata'],
    ask: ['__ask'],
  };
  const found = new Map(); // panel name -> module

  function discover() {
    found.clear();
    if (typeof window === 'undefined') return found;
    for (const [key, names] of Object.entries(KNOWN)) {
      for (const n of names) {
        const mod = window[n];
        if (mod && typeof mod.available === 'function' && !mod.available()) continue; // feature off in this engine
        if (mod && (typeof mod.mount === 'function' || typeof mod.render === 'function')) { found.set(key, mod); break; }
      }
    }
    return found;
  }

  /** Host one screen in `host`. Returns a short status string for the caller. */
  function show(key, host) {
    if (!host) return 'no host';
    discover();
    const mod = found.get(key);
    if (!mod) return 'missing';
    try {
      if (typeof mod.mount === 'function') { mod.mount(host); return 'mounted'; }
      const html = mod.render();
      if (typeof html === 'string') { host.innerHTML = html; return 'rendered'; }
      if (html && html.nodeType === 1) { host.replaceChildren(html); return 'rendered'; }
      return 'nothing to draw';
    } catch (e) {
      console.warn('screens:', key, e);
      return 'failed';
    }
  }

  const list = () => { discover(); return [...found.keys()]; };
  const out = { discover, show, list, has: (k) => { discover(); return found.has(k); } };
  if (typeof window !== 'undefined') window.__screens = out;
  return out;
})();
