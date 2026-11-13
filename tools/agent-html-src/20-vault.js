/* ==========================================================================
   Secure vault (stage D). Three kinds of secret, each in the store the app
   already uses for it:
   - provider keys: setAuthKey / deleteAuth / getAuthStatus (the page only
     ever sees the masked value the engine returns);
   - MCP server tokens: secureStorage under MCP_TOKEN_PREFIX + server name;
   - your own secrets: secureStorage under VAULT_SECRET_PREFIX + name, with a
     names-only index in preferences.
   A value is read back from secure storage only to copy it, after the
   biometric check when the app has one, and it never enters the DOM, the
   event log, local storage or a toast.
   ========================================================================== */
const Vault = (() => {
  const INDEX_KEY = 'agent.vault.index.v1';
  const SECRET_PREFIX = 'agent.vault.secret.';
  const NAME_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,47}$/;
  const MAX_VALUE = 16384;
  const KINDS = [['api_key', 'API key'], ['password', 'Password'], ['token', 'Token'], ['note', 'Secure note'], ['other', 'Other']];
  if (!ICONS['key-round']) ICONS['key-round'] = '<path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/>';
  if (!ICONS['shield-check']) ICONS['shield-check'] = '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>';

  const secureOK = () => typeof nativeKit()?.secureStorage?.set === 'function' && typeof nativeKit()?.secureStorage?.get === 'function';
  const prefsOK = () => typeof nativeKit()?.preferences?.setJSON === 'function';
  const errText = (e) => redactSecrets(e?.message || String(e), 240);

  async function loadIndex() {
    try { const v = await bridge.prefsGet(INDEX_KEY); return Array.isArray(v) ? v.filter((e) => e && typeof e.name === 'string' && NAME_RE.test(e.name)) : []; } catch { return []; }
  }
  const saveIndex = (list) => bridge.prefsSet(INDEX_KEY, list.map(({ name, kind, label, createdAt, updatedAt }) => ({ name, kind, label, createdAt, updatedAt })));
  // A fixed mask: not even the length of a value is shown or stored.
  const mask = () => '\u2022'.repeat(12);

  /** Biometric gate before a value leaves secure storage. Fails closed when the check exists but fails. */
  async function verifyOwner(reason) {
    const b = nativeKit()?.biometric;
    if (typeof b?.verify !== 'function') return true;
    try { const r = await b.verify(reason); return r === true || r?.verified === true; } catch { return false; }
  }
  async function copySecret(storageKey, label) {
    if (!(await verifyOwner(`Copy ${label}`))) { toast('Not verified, so nothing was copied.', { type: 'error' }); return false; }
    let value = null;
    try { value = await bridge.secureGet(storageKey); } catch (e) { toast(errText(e), { type: 'error' }); return false; }
    if (!value) { toast('That secret is empty or missing.', { type: 'error' }); return false; }
    const ok = await copyText(value);
    value = null;
    toast(ok ? `${label} copied. Clear your clipboard when you're done.` : 'Couldn\u2019t copy: clipboard access is blocked.', { type: ok ? 'success' : 'error' });
    return ok;
  }

  function secretField(placeholder, label) {
    // Never type=text: the value must not be readable from the page or kept by autofill.
    return h('input', { class: 'input vault-input', type: 'password', autocomplete: 'new-password', autocapitalize: 'off', autocorrect: 'off', spellcheck: false, maxlength: String(MAX_VALUE), placeholder, 'aria-label': label, 'data-1p-ignore': '', 'data-lpignore': 'true' });
  }
  const takeValue = (input) => { const v = input.value; input.value = ''; return v; };

  let openRef = null;
  function open(app) {
    if (openRef?.panel?.isConnected) return openRef;
    const body = h('div', { class: 'vault-screen' });
    let alive = true;
    let busy = false;
    const guard = async (fn) => { if (busy) return; busy = true; try { await fn(); } finally { busy = false; } };

    async function paint() {
      if (!alive) return;
      if (!bridge.available) { body.replaceChildren(h('p', { class: 'settings-note', 'data-type': 'info' }, icon('info'), h('span', null, 'The vault needs the app: secrets are kept in the phone\u2019s Keychain or Keystore.'))); return; }
      const [index, mcp] = await Promise.all([loadIndex(), loadMcpServers().catch(() => [])]);
      await app.settings.refreshFromNative().catch(() => {});
      if (!alive) return;
      body.replaceChildren(
        h('p', { class: 'settings-note', 'data-type': 'info' }, icon('shield-check'), h('span', null, 'Saved in the phone\u2019s hardware-encrypted storage. Values are never shown, never sent to the AI and never written to chats or logs. Copying asks for your fingerprint or face when the phone supports it.')),
        ownSection(index), providerSection(), mcpSection(mcp));
    }

    function row({ title, sub, value, actions, kind }) {
      return h('li', { class: 'vault-row', 'data-kind': kind },
        h('span', { class: 'sa-card-icon', 'aria-hidden': 'true' }, icon('key-round')),
        h('div', { class: 'vault-row-text' }, h('p', { class: 'vault-row-name truncate' }, title), h('p', { class: 'vault-row-sub truncate' }, sub), h('p', { class: 'vault-mask', 'aria-label': value ? 'Value hidden' : 'No value' }, value || 'Not set')),
        h('div', { class: 'vault-row-actions' }, ...actions));
    }

    function ownSection(index) {
      const list = index.sort((a, b) => a.name.localeCompare(b.name));
      const add = h('button', { type: 'button', class: 'btn btn-default btn-sm', disabled: !secureOK() || !prefsOK(), onclick: () => editOwn(null, list) }, icon('plus'), 'Add secret');
      return h('section', { class: 'sa-section', 'aria-label': 'Your secrets' },
        h('div', { class: 'sa-toolbar' }, h('h4', null, `Your secrets (${list.length})`), h('span', { class: 'sa-spacer' }), add),
        !secureOK() ? h('p', { class: 'field-hint' }, 'Secure storage is not available in this build.') : null,
        list.length ? h('ul', { class: 'vault-list' }, ...list.map((e) => row({
          kind: 'own', title: e.label || e.name, sub: `${e.name} \u00b7 ${(KINDS.find((k) => k[0] === e.kind) || KINDS[4])[1]}${e.updatedAt ? ` \u00b7 ${new Date(e.updatedAt).toLocaleDateString()}` : ''}`, value: mask(),
          actions: [
            iconButton(`Copy ${e.name}`, icon('copy'), () => guard(() => copySecret(SECRET_PREFIX + e.name, e.label || e.name))),
            iconButton(`Replace ${e.name}`, icon('pencil'), () => editOwn(e, list)),
            iconButton(`Delete ${e.name}`, icon('trash'), () => confirmDialog({ title: `Delete ${e.name}?`, description: 'It is removed from secure storage on this phone. This can\u2019t be undone.', confirmLabel: 'Delete', destructive: true, onConfirm: () => guard(async () => {
              try { await bridge.secureRemove(SECRET_PREFIX + e.name); await saveIndex(list.filter((x) => x.name !== e.name)); toast('Secret deleted.', { type: 'success' }); } catch (err) { toast(errText(err), { type: 'error' }); }
              paint();
            }) })),
          ],
        }))) : h('p', { class: 'field-hint' }, 'No secrets yet. Save passwords, keys or tokens you want kept off the chat.'));
    }

    function editOwn(entry, list) {
      const name = h('input', { class: 'input', type: 'text', maxlength: '48', value: entry?.name || '', disabled: !!entry, placeholder: 'github_token', autocapitalize: 'off', autocorrect: 'off', spellcheck: false, 'aria-label': 'Name' });
      const label = h('input', { class: 'input', type: 'text', maxlength: '60', value: entry?.label || '', placeholder: 'GitHub token (optional)', 'aria-label': 'Label' });
      const kind = h('select', { class: 'select select-sm', 'aria-label': 'Type' }, ...KINDS.map(([v, t]) => h('option', { value: v, selected: v === (entry?.kind || 'api_key') }, t)));
      const value = secretField(entry ? 'New value (replaces the old one)' : 'Value', 'Value');
      const err = h('p', { class: 'field-hint vault-error', role: 'alert' });
      let dlg = null;
      const save = h('button', { type: 'button', class: 'btn btn-default', onclick: () => guard(async () => {
        err.textContent = '';
        const n = name.value.trim();
        if (!entry && !NAME_RE.test(n)) { name.setAttribute('aria-invalid', 'true'); err.textContent = 'Name: start with a letter; letters, numbers, _ . - only; up to 48.'; name.focus(); return; }
        if (!entry && list.some((x) => x.name.toLowerCase() === n.toLowerCase())) { name.setAttribute('aria-invalid', 'true'); err.textContent = 'A secret with that name already exists. Use Replace on it instead.'; return; }
        const v = value.value;
        if (!v || !v.trim()) { value.setAttribute('aria-invalid', 'true'); err.textContent = 'Enter a value.'; value.focus(); return; }
        if (v.length > MAX_VALUE) { value.setAttribute('aria-invalid', 'true'); err.textContent = `Values can be up to ${MAX_VALUE} characters.`; return; }
        const key = entry ? entry.name : n;
        save.disabled = true;
        try {
          await bridge.secureSet(SECRET_PREFIX + key, takeValue(value));
          const now = Date.now();
          const next = { name: key, kind: kind.value, label: label.value.trim(), createdAt: entry?.createdAt || now, updatedAt: now };
          await saveIndex([...list.filter((x) => x.name !== key), next]);
          dlg.close();
          toast(entry ? 'Secret replaced.' : 'Secret saved.', { type: 'success' });
          paint();
        } catch (e2) {
          // On a failed write nothing is half-saved in the index.
          err.textContent = errText(e2);
          save.disabled = false;
        }
      }) }, icon('check'), 'Save');
      dlg = openDialog({ title: entry ? `Replace ${entry.name}` : 'Add secret', description: 'The value goes straight to secure storage and can\u2019t be shown again, only copied or replaced.', size: 'sm',
        body: h('div', { class: 'vault-form' }, h('label', { class: 'field-label' }, 'Name', name), h('label', { class: 'field-label' }, 'Label', label), h('label', { class: 'field-label' }, 'Type', kind), h('label', { class: 'field-label' }, 'Value', value), err),
        footer: [h('button', { type: 'button', class: 'btn btn-outline', onclick: () => dlg.close() }, 'Cancel'), save], initialFocus: entry ? value : name,
        onClose: () => { value.value = ''; } });
    }

    function providerSection() {
      const auth = app.settings.auth || {};
      return h('section', { class: 'sa-section', 'aria-label': 'Provider keys' },
        h('h4', null, 'AI provider keys'),
        h('p', { class: 'field-hint' }, 'Kept by the app engine. It only ever shows the masked key, so these can be replaced or removed but not copied.'),
        h('ul', { class: 'vault-list' }, ...KEY_PROVIDERS.map((p) => {
          const a = auth[p.id] || {};
          return row({
            kind: 'provider', title: p.label, sub: a.error ? `Couldn\u2019t check: ${redactSecrets(a.error, 80)}` : a.hasKey ? 'Key saved' : 'No key', value: a.hasKey ? (a.masked || mask()) : '',
            actions: [
              iconButton(`${a.hasKey ? 'Replace' : 'Add'} ${p.label} key`, icon(a.hasKey ? 'pencil' : 'plus'), () => editProvider(p)),
              a.hasKey ? iconButton(`Remove ${p.label} key`, icon('trash'), () => confirmDialog({ title: `Remove the ${p.label} key?`, description: 'Requests to this provider will fail until you save a key again.', confirmLabel: 'Remove', destructive: true, onConfirm: () => guard(async () => {
                try { await bridge.deleteAuth(p.id); toast('Key removed.', { type: 'success' }); } catch (e) { toast(errText(e), { type: 'error' }); }
                paint();
              }) })) : null,
            ].filter(Boolean),
          });
        })));
    }
    function editProvider(p) {
      const value = secretField(`${p.label} API key`, `${p.label} API key`);
      const err = h('p', { class: 'field-hint vault-error', role: 'alert' });
      let dlg = null;
      const save = h('button', { type: 'button', class: 'btn btn-default', onclick: () => guard(async () => {
        const v = value.value.trim();
        if (!v) { value.setAttribute('aria-invalid', 'true'); err.textContent = 'Enter a key.'; return; }
        if (/\s/.test(v)) { value.setAttribute('aria-invalid', 'true'); err.textContent = 'A key can\u2019t contain spaces.'; return; }
        save.disabled = true;
        value.value = '';
        try { await bridge.setAuthKey(v, p.id); dlg.close(); toast(`${p.label} key saved.`, { type: 'success' }); paint(); } catch (e) { err.textContent = errText(e); save.disabled = false; }
      }) }, icon('check'), 'Save key');
      dlg = openDialog({ title: `${p.label} key`, size: 'sm', body: h('div', { class: 'vault-form' }, value, err), footer: [h('button', { type: 'button', class: 'btn btn-outline', onclick: () => dlg.close() }, 'Cancel'), save], initialFocus: value, onClose: () => { value.value = ''; } });
    }

    function mcpSection(servers) {
      const list = Array.isArray(servers) ? servers : [];
      return h('section', { class: 'sa-section', 'aria-label': 'MCP tokens' },
        h('h4', null, `MCP server tokens (${list.length})`),
        list.length ? h('ul', { class: 'vault-list' }, ...list.map((s) => {
          const row0 = row({ kind: 'mcp', title: s.name, sub: s.url, value: '', actions: [] });
          const maskEl = row0.querySelector('.vault-mask');
          const actionsEl = row0.querySelector('.vault-row-actions');
          // Whether a token exists is checked without keeping the value.
          bridge.secureGet(MCP_TOKEN_PREFIX + s.name).then((t) => {
            const has = !!t;
            t = null;
            maskEl.textContent = has ? mask() : 'No token';
            actionsEl.replaceChildren(
              has ? iconButton(`Copy ${s.name} token`, icon('copy'), () => guard(() => copySecret(MCP_TOKEN_PREFIX + s.name, `${s.name} token`))) : null,
              iconButton(`${has ? 'Replace' : 'Add'} ${s.name} token`, icon(has ? 'pencil' : 'plus'), () => editMcp(s)),
              has ? iconButton(`Remove ${s.name} token`, icon('trash'), () => confirmDialog({ title: `Remove the ${s.name} token?`, description: 'The server stays. Reconnect it to use it without a token.', confirmLabel: 'Remove', destructive: true, onConfirm: () => guard(async () => {
                try { await bridge.secureRemove(MCP_TOKEN_PREFIX + s.name); toast('Token removed. Reconnect MCP to apply it.', { type: 'success' }); } catch (e) { toast(errText(e), { type: 'error' }); }
                paint();
              }) })) : null);
          }, (e) => { maskEl.textContent = `Couldn\u2019t check: ${errText(e)}`; });
          return row0;
        })) : h('p', { class: 'field-hint' }, 'No MCP servers. Add one in Settings \u2192 MCP servers; its token is kept here.'));
    }
    function editMcp(s) {
      const value = secretField('Bearer token', `${s.name} token`);
      const err = h('p', { class: 'field-hint vault-error', role: 'alert' });
      let dlg = null;
      const save = h('button', { type: 'button', class: 'btn btn-default', onclick: () => guard(async () => {
        const v = value.value.trim();
        if (!v || /[\s\r\n]/.test(v)) { value.setAttribute('aria-invalid', 'true'); err.textContent = 'Enter the token without spaces or line breaks.'; return; }
        save.disabled = true;
        value.value = '';
        try { await bridge.secureSet(MCP_TOKEN_PREFIX + s.name, v); dlg.close(); toast('Token saved. Reconnect MCP to apply it.', { type: 'success' }); paint(); } catch (e) { err.textContent = errText(e); save.disabled = false; }
      }) }, icon('check'), 'Save token');
      dlg = openDialog({ title: `${s.name} token`, size: 'sm', body: h('div', { class: 'vault-form' }, value, err), footer: [h('button', { type: 'button', class: 'btn btn-outline', onclick: () => dlg.close() }, 'Cancel'), save], initialFocus: value, onClose: () => { value.value = ''; } });
    }

    const dialog = openDialog({ title: 'Vault', description: 'Keys, tokens and passwords kept on this phone.', body, size: 'lg', align: 'top', onClose: () => { alive = false; openRef = null; } });
    dialog.panel.classList.add('sa-dialog', 'vault-dialog');
    openRef = dialog;
    body.append(h('p', { class: 'field-hint settings-loading' }, icon('loader-circle', 'spin'), 'Loading\u2026'));
    paint().catch((e) => { if (alive) body.replaceChildren(h('p', { class: 'settings-note', 'data-type': 'error' }, icon('circle-exclamation-point'), h('span', null, errText(e)))); });
    return dialog;
  }

  function install(app) {
    for (const footer of doc.querySelectorAll('.sidebar-footer')) {
      if (footer.querySelector('.vault-open')) continue;
      const btn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm vault-open', onclick: () => { app.setMobileSidebar?.(false); open(app); } }, icon('key-round'), 'Vault');
      const anchor = footer.querySelector('.fm-open');
      if (anchor) anchor.after(btn); else footer.prepend(btn);
    }
  }
  const api = { install, open, INDEX_KEY, SECRET_PREFIX, NAME_RE };
  if (typeof window !== 'undefined') window.__vault = api;
  return api;
})();
