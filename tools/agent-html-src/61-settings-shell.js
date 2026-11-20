/* ==========================================================================
   Appearance settings: theme, density, text size, language.

   Four choices, all stored on the device, all applied as attributes on <html> so
   that nothing has to be re-rendered to change them. A missing or corrupt stored
   value falls back to the default — the same rule the context tree follows: a
   preference that can break the screen is not a preference.
   ========================================================================== */
const Appearance = (() => {
  const KEY = 'app.appearance.v1';
  const DEFAULTS = { theme: 'system', density: 'comfortable', text: 'md', lang: 'en' };
  const CHOICES = {
    theme: [['system', 'System', 'সিস্টেম'], ['light', 'Light', 'লাইট'], ['dark', 'Dark', 'ডার্ক']],
    density: [['comfortable', 'Comfortable', 'আরামদায়ক'], ['compact', 'Compact', 'কম্প্যাক্ট']],
    text: [['sm', 'Small', 'ছোট'], ['md', 'Medium', 'মাঝারি'], ['lg', 'Large', 'বড়']],
    lang: [['en', 'English', 'English'], ['bn', 'বাংলা', 'বাংলা']],
  };
  const LABEL = {
    en: { title: 'Appearance', theme: 'Theme', density: 'Density', text: 'Text size', lang: 'Language', reset: 'Reset', saved: 'Saved on this device.' },
    bn: { title: 'চেহারা', theme: 'থিম', density: 'ঘনত্ব', text: 'লেখার আকার', lang: 'ভাষা', reset: 'আগের অবস্থায়', saved: 'এই ডিভাইসে সংরক্ষিত।' },
  };
  let current = { ...DEFAULTS };
  const subs = new Set();

  const safeGet = () => {
    try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; }
  };
  const valid = (k, v) => CHOICES[k].some((c) => c[0] === v);

  /** Read the saved choice, and reject anything that is not one of the options. */
  function load() {
    const saved = safeGet();
    current = { ...DEFAULTS };
    if (saved && typeof saved === 'object') {
      for (const k of Object.keys(DEFAULTS)) if (valid(k, saved[k])) current[k] = saved[k];
    }
    return current;
  }

  function apply() {
    if (typeof document === 'undefined') return;
    const html = document.documentElement;
    html.setAttribute('data-theme', current.theme);
    html.setAttribute('data-density', current.density);
    html.setAttribute('data-text', current.text);
    html.setAttribute('lang', current.lang === 'bn' ? 'bn' : 'en');
  }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(current)); } catch (e) { /* private mode: the choice lasts the session */ }
  }

  /** Change one setting. Returns the whole state, so a caller never guesses. */
  function set(key, value) {
    if (!CHOICES[key] || !valid(key, value)) return { ok: false, error: `unknown ${key}: ${value}` };
    current = { ...current, [key]: value };
    apply();
    save();
    paint();
    subs.forEach((fn) => { try { fn(current); } catch (e) { console.warn('appearance', e); } });
    return { ok: true, state: { ...current } };
  }

  function t(key) { return (LABEL[current.lang] || LABEL.en)[key]; }

  function rows() {
    return Object.keys(CHOICES).map((key) => {
      const opts = CHOICES[key].map(([v, en, bn]) => `<button class="ap-opt${current[key] === v ? ' is-on' : ''}" type="button"
          data-key="${key}" data-value="${v}" aria-pressed="${current[key] === v}">${current.lang === 'bn' ? bn : en}</button>`).join('');
      return `<div class="ap-row" role="group" aria-label="${t(key)}"><span class="ap-name">${t(key)}</span><span class="ap-opts">${opts}</span></div>`;
    }).join('');
  }

  function panel() {
    return `<h3 class="ap-title">${t('title')}</h3>${rows()}
      <div class="ap-foot"><span>${t('saved')}</span><button class="ap-reset" type="button">${t('reset')}</button></div>`;
  }

  function paint() {
    const host = document.querySelector('[data-appearance]');
    if (!host) return;
    host.innerHTML = panel();
  }

  function mount(host) {
    const target = host || document.querySelector('[data-appearance]') || null;
    if (!target) return null;
    target.setAttribute('data-appearance', '');
    target.addEventListener('click', (ev) => {
      const b = ev.target.closest ? ev.target.closest('.ap-opt, .ap-reset') : null;
      if (!b) return;
      if (b.classList.contains('ap-reset')) { current = { ...DEFAULTS }; apply(); save(); paint(); return; }
      set(b.dataset.key, b.dataset.value);
    });
    paint();
    return target;
  }

  /** Where Appearance belongs: a Settings container, never the page top. */
  function settingsHost() {
    return document.querySelector('[data-settings-appearance], [data-slot="settings-appearance"], [data-slot="settings-body"], .settings-body, #settings') || null;
  }

  /** Mount into Settings; returns false when there is no Settings panel in this build. */
  function open(host) {
    const target = host || settingsHost();
    if (!target) return false;
    mount(target);
    try { target.scrollIntoView({ block: 'nearest' }); } catch (e) { /* jsdom */ }
    return true;
  }

  const out = { load, apply, set, mount, open, settingsHost, paint, choices: () => CHOICES, state: () => ({ ...current }), keys: Object.keys(DEFAULTS), subscribe(fn) { subs.add(fn); return () => subs.delete(fn); } };
  if (typeof window !== 'undefined') {
    window.__appearance = out;
    load();
    apply();
    // Deliberately NOT auto-mounted: the panel belongs inside Settings. Mounting it at
    // boot is what put "Appearance" above the chat header, where nothing may sit above
    // "New Chat". `open()` mounts it on demand, into Settings if a host exists there.
    const boot = () => {
      try {
        if (window.__appearanceAutoMount === true) mount();
      } catch (e) { console.warn('appearance boot', e); }
    };
    if (typeof document !== 'undefined') {
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
      else setTimeout(boot, 0);
    }
  }
  return out;
})();
