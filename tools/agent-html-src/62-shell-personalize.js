/* Personalization: pin a screen, move it, and remember what was opened last.
   Stored on the device; the shell reads `order()` so the bar follows the user. */
const Personalize = (() => {
  const KEY = 'app.shell.personalize.v1';
  let s = { order: [], pinned: [], recent: [] };
  const subs = new Set();
  const read = () => { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; } };
  function load(ids) {
    const saved = read();
    const known = (Array.isArray(ids) ? ids : []).filter((x) => typeof x === 'string');
    s = { order: [], pinned: [], recent: [] };
    if (saved && typeof saved === 'object') {
      s.order = (saved.order || []).filter((x) => known.includes(x));
      s.pinned = (saved.pinned || []).filter((x) => known.includes(x));
      s.recent = (saved.recent || []).filter((x) => known.includes(x)).slice(0, 5);
    }
    for (const id of known) if (!s.order.includes(id)) s.order.push(id); // never lose a screen
    return { ...s };
  }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) {} };
  const changed = () => { save(); subs.forEach((f) => { try { f(s); } catch (e) {} }); };
  /** The order a bar should draw: pinned first, then the rest, saved order kept. */
  function order(ids) {
    if (!s.order.length) load(ids || []);
    const base = (ids && ids.length ? ids : s.order).slice();
    const rank = (id) => { const i = s.order.indexOf(id); return i < 0 ? 999 : i; };
    const pinned = base.filter((id) => s.pinned.includes(id));
    const rest = base.filter((id) => !s.pinned.includes(id));
    return [...pinned.sort((a, b) => rank(a) - rank(b)), ...rest.sort((a, b) => rank(a) - rank(b))];
  }
  function move(id, dir) {
    const i = s.order.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= s.order.length) return false;
    [s.order[i], s.order[j]] = [s.order[j], s.order[i]];
    changed();
    return true;
  }
  function pin(id, on) {
    const has = s.pinned.includes(id);
    if (on === undefined ? has : !on) s.pinned = s.pinned.filter((x) => x !== id);
    else if (!has) s.pinned = [...s.pinned, id];
    changed();
    return s.pinned.includes(id);
  }
  function visited(id) {
    if (!id) return false;
    s.recent = [id, ...s.recent.filter((x) => x !== id)].slice(0, 5);
    changed();
    return true;
  }
  const out = { load, order, move, pin, visited, recent: () => s.recent.slice(), pinned: () => s.pinned.slice(), state: () => ({ ...s }), subscribe(f) { subs.add(f); return () => subs.delete(f); } };
  if (typeof window !== 'undefined') window.__personalize = out;
  return out;
})();
