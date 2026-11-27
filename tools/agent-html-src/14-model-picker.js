/* Model and provider pickers for a sub-agent's Settings tab.
   They read the same provider list, key status and model lists as the main
   chat's model picker (App.openModelPicker: settings.orderedProviders(),
   settings.status(), settings.modelsFor() / loadModels()), in the same
   searchable popover. Each picker writes a hidden input, so the Settings
   form's validate-and-save flow sends `provider` / `model` unchanged:
   '' means "use the main agent's", any other value is a provider id or a
   model id for the chosen provider. */
const SubagentModelPicker = (() => {
  const appOf = () => (typeof window !== 'undefined' ? window.__app : null);
  const settingsOf = () => appOf()?.settings || null;
  const provOf = (id) => (typeof AGENT_PROVIDERS !== 'undefined' ? AGENT_PROVIDERS.find((p) => p.id === id) : null) || null;
  const provLabel = (id) => provOf(id)?.label || id;
  /** The main agent's provider and model (what "Default" means). */
  function mainChoice() {
    const s = settingsOf();
    const provider = String(s?.get?.('provider') || 'auto');
    const model = provider === 'auto' ? '' : String(s?.get?.('model') || '');
    return { provider, model };
  }
  /** The provider a run really uses for a picked value. */
  const effectiveProvider = (picked) => picked || mainChoice().provider;
  const statusOf = (id) => { const s = settingsOf(); try { return s?.status ? s.status(id) : 'off'; } catch (e) { return 'off'; } };
  const usable = (id) => id === 'auto' || statusOf(id) === 'connected';

  function trigger(id, key, text, sub) {
    const label = h('span', { class: 'sa-pick-text' }, h('span', { class: 'sa-pick-main truncate' }, text), sub ? h('span', { class: 'sa-pick-sub truncate' }, sub) : null);
    return h('button', { type: 'button', id, class: 'input sa-pick', 'data-pick': key, 'aria-haspopup': 'listbox', 'aria-expanded': 'false' }, label, icon('chevron-down', 'sa-pick-chev'));
  }
  function setTrigger(btn, text, sub) {
    btn.querySelector('.sa-pick-main').textContent = text;
    let s = btn.querySelector('.sa-pick-sub');
    if (sub) { if (!s) { s = h('span', { class: 'sa-pick-sub truncate' }); btn.querySelector('.sa-pick-text').append(s); } s.textContent = sub; } else if (s) s.remove();
  }

  /** A searchable list popover like the main chat's model picker. */
  function listPopover(btn, label, build) {
    if (typeof openPopover !== 'function') return;
    openPopover(btn, (el, close) => {
      const list = h('div', { class: 'model-popover-list scroll-thin', role: 'listbox', 'aria-label': label });
      const status = h('div', { class: 'menu-label', role: 'status', hidden: true });
      const search = h('input', { type: 'search', class: 'input', placeholder: `Search ${label.toLowerCase()}`, 'aria-label': `Search ${label.toLowerCase()}`, autocomplete: 'off', spellcheck: false });
      const paint = () => {
        const { children, note } = build(search.value.trim(), close, paint);
        list.replaceChildren(...children);
        status.textContent = note || (children.length ? '' : 'Nothing matches');
        status.hidden = !status.textContent;
      };
      search.addEventListener('input', paint);
      search.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); list.querySelector('.menu-item:not([aria-disabled="true"])')?.focus(); }
        else if (e.key === 'Enter') { e.preventDefault(); list.querySelector('.menu-item:not([aria-disabled="true"])')?.click(); }
      });
      paint();
      el.append(h('div', { class: 'model-popover-search' }, icon('search'), search), list, status);
      el.addEventListener('keydown', (e) => { if (e.target !== search && typeof menuKeys === 'function') menuKeys(el, e); });
      const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
      requestAnimationFrame(() => ((coarse ? null : search) || list.querySelector('.menu-item[aria-selected="true"]') || list.querySelector('.menu-item'))?.focus({ preventScroll: true }));
    }, { class: 'model-popover sa-pick-pop', side: 'bottom', align: 'start', label: `Choose ${label.toLowerCase()}` });
  }
  const group = (label, mark, statusId, ...items) => h('div', { role: 'group', 'aria-label': label },
    h('div', { class: 'menu-label', 'aria-hidden': 'true' },
      mark ? h('span', { class: 'provider-mark is-sm' }, mark) : null,
      h('span', { class: 'truncate' }, label),
      statusId ? h('span', { class: 'status-dot', 'data-status': statusOf(statusId) }, settingsOf()?.statusLabel?.(statusId) || '') : null),
    ...items);
  const opt = (o, close) => menuItem({ role: 'option', ...o }, close);
  const hit = (q, ...xs) => !q || xs.some((x) => String(x || '').toLowerCase().includes(q.toLowerCase()));

  /**
   * Build the two pickers for record `r`. Returns { providerField, modelField,
   * inputs: { provider, model } } where each input is the hidden value the form saves.
   */
  function create(r, opts = {}) {
    const provIn = h('input', { type: 'hidden', 'data-key': 'provider', value: String(r.provider || '') });
    const modelIn = h('input', { type: 'hidden', 'data-key': 'model', value: String(r.model || '') });
    const provBtn = trigger('sa-set-provider', 'provider', '', '');
    const modelBtn = trigger('sa-set-model', 'model', '', '');
    const modelNote = h('p', { class: 'field-hint sa-pick-note', role: 'status', 'aria-live': 'polite' });
    const fire = () => { provIn.dispatchEvent(new Event('input', { bubbles: true })); modelIn.dispatchEvent(new Event('input', { bubbles: true })); opts.onChange?.(); };

    const paintProv = () => {
      const v = provIn.value;
      const main = mainChoice();
      if (!v) setTrigger(provBtn, 'Default', `Main agent \u00b7 ${provLabel(main.provider)}`);
      else setTrigger(provBtn, provLabel(v), v === 'auto' ? 'Free models only' : usable(v) ? 'Key connected' : provOf(v) ? 'No API key: runs will fail' : 'Custom provider id');
      provBtn.dataset.warn = v && v !== 'auto' && !usable(v) ? 'true' : 'false';
    };
    const paintModel = () => {
      const v = modelIn.value;
      const pid = effectiveProvider(provIn.value);
      const main = mainChoice();
      const found = (settingsOf()?.modelsFor?.(pid) || []).find((m) => m.id === v);
      if (!v) {
        const sub = !provIn.value ? `Main agent \u00b7 ${main.model || (main.provider === 'auto' ? 'Free Router' : 'its default')}` : pid === 'auto' ? 'Free Router picks a free model' : `${provLabel(pid)}\u2019s default model`;
        setTrigger(modelBtn, 'Default', sub);
      } else setTrigger(modelBtn, v, [found?.name && found.name !== v ? found.name : '', provLabel(pid)].filter(Boolean).join(' \u00b7 '));
    };
    const paint = () => { paintProv(); paintModel(); };

    provBtn.addEventListener('click', () => listPopover(provBtn, 'Providers', (q, close) => {
      const s = settingsOf();
      const all = s?.orderedProviders ? s.orderedProviders() : (typeof AGENT_PROVIDERS !== 'undefined' ? AGENT_PROVIDERS : []);
      const cur = provIn.value;
      const main = mainChoice();
      const pick = (id) => {
        if (id === provIn.value) return;
        provIn.value = id;
        // A model belongs to its provider: keep it only when the new provider lists it.
        const keep = modelIn.value && (settingsOf()?.modelsFor?.(effectiveProvider(id)) || []).some((m) => m.id === modelIn.value);
        if (modelIn.value && !keep) { modelNote.textContent = `Model reset to Default: \u201c${modelIn.value}\u201d is not a ${provLabel(effectiveProvider(id))} model.`; modelIn.value = ''; }
        else modelNote.textContent = '';
        paint(); fire();
      };
      const children = [];
      if (hit(q, 'default', 'main agent', provLabel(main.provider))) children.push(group('Default', null, null, opt({ label: 'Default', sub: `Same as the main agent \u00b7 ${provLabel(main.provider)}`, checked: !cur, onSelect: () => pick('') }, close)));
      const ready = all.filter((p) => !p.local && usable(p.id) && hit(q, p.id, p.label));
      const keyless = all.filter((p) => !p.local && !usable(p.id) && hit(q, p.id, p.label));
      if (ready.length) children.push(group('Ready to use', null, null, ...ready.map((p) => opt({ label: p.label, sub: p.id === 'auto' ? 'Free models only, no key' : `${p.id} \u00b7 key connected`, checked: cur === p.id, attrs: { 'data-provider': p.id }, onSelect: () => pick(p.id) }, close))));
      if (cur && !provOf(cur) && hit(q, cur)) children.push(group('Saved value', null, null, opt({ label: cur, sub: 'Custom provider id', checked: true, onSelect: () => pick(cur) }, close)));
      if (keyless.length) children.push(group('Needs an API key', null, null, ...keyless.map((p) => opt({ label: p.label, sub: 'Add its key in Settings \u203a Providers', checked: cur === p.id, disabled: true, attrs: { 'data-provider': p.id } }, () => {})),
        menuItem({ label: 'Manage providers\u2026', icon: 'settings', role: null, onSelect: () => appOf()?.openSettings?.('providers') }, close)));
      return { children };
    }));

    modelBtn.addEventListener('click', () => listPopover(modelBtn, 'Models', (q, close, again) => {
      const s = settingsOf();
      const pid = effectiveProvider(provIn.value);
      const models = s?.modelsFor ? s.modelsFor(pid) : [];
      const cur = modelIn.value;
      const pick = (id) => { modelIn.value = id; modelNote.textContent = ''; paint(); fire(); };
      const children = [];
      const main = mainChoice();
      const defSub = !provIn.value ? `Same as the main agent \u00b7 ${main.model || 'Free Router'}` : pid === 'auto' ? 'Free Router picks a free model' : `${provLabel(pid)}\u2019s default`;
      if (hit(q, 'default')) children.push(group('Default', null, null, opt({ label: 'Default', sub: defSub, checked: !cur, onSelect: () => pick('') }, close)));
      const prov = provOf(pid) || { label: pid, mark: '?' };
      let shown = 0, more = 0, exact = false;
      const rows = [];
      for (const m of models) {
        if (m.id.toLowerCase() === q.toLowerCase()) exact = true;
        if (!hit(q, m.id, m.name)) continue;
        if (shown >= 100) { more++; continue; }
        shown++;
        const sub = [m.name && m.name !== m.id ? m.name : '', m.isFree ? 'Free' : '', m.toolCalling === false ? 'No tools' : ''].filter(Boolean).join(' \u00b7 ');
        rows.push(opt({ label: m.id, sub: sub || undefined, checked: cur === m.id, attrs: { 'data-model': m.id }, onSelect: () => pick(m.id) }, close));
      }
      if (cur && !models.some((m) => m.id === cur) && hit(q, cur)) rows.unshift(opt({ label: cur, sub: 'Saved model id', checked: true, onSelect: () => pick(cur) }, close));
      if (rows.length) children.push(group(prov.label, prov.mark, pid, ...rows));
      if (!models.length && pid !== 'auto' && s?.loadModels) {
        const load = menuItem({ label: `Load ${prov.label} models`, icon: 'refresh-cw', role: 'option', onSelect: async () => {
          try { await s.loadModels(pid); again(); } catch (e) { toast(e?.message || 'Could not load the model list.', { type: 'error' }); }
        } }, () => {});
        load.classList.add('is-action');
        children.push(group(prov.label, prov.mark, pid, load));
      }
      if (q && !exact && pid !== 'auto') {
        const typed = q;
        const custom = menuItem({ label: `Use \u201c${typed}\u201d with ${prov.label}`, icon: 'plus', role: 'option', onSelect: () => pick(typed) }, close);
        custom.classList.add('is-action');
        children.push(h('div', { role: 'group', 'aria-label': 'Custom model' }, custom));
      }
      return { children, note: more ? `${more} more. Keep typing to narrow the list.` : '' };
    }));

    // Keep the trigger text current when the model lists or key status change.
    const s = settingsOf();
    let off = null;
    if (s?.on) { const fn = () => { if (!provBtn.isConnected) { off?.(); return; } paint(); }; off = s.on('change', fn) || (() => s.off?.('change', fn)); }
    paint();
    // Load the list for the effective provider once, so the Model picker opens filled.
    const pid = effectiveProvider(provIn.value);
    if (s?.loadModels && pid !== 'auto' && usable(pid) && !(s.modelsFor?.(pid) || []).length) Promise.resolve(s.loadModels(pid)).then(paint).catch(() => {});

    return {
      inputs: { provider: provIn, model: modelIn },
      provider: { button: provBtn, input: provIn },
      model: { button: modelBtn, input: modelIn, note: modelNote },
    };
  }

  return { create, mainChoice };
})();
