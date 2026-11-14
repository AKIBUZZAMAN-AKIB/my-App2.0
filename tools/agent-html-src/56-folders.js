/* ==========================================================================
   Shared folders: the user's control over which phone folders the agent can
   reach (sidebar → Folders), plus the chat rows for the folder_* device tools.

   Granting goes through the system folder picker only (Android Storage Access
   Framework, iOS document picker), so the app never holds broad storage
   access. Per folder the user picks Read-only or Read & write and can remove
   it, which hands the permission back to the OS. Changes the agent makes
   still ask first: folder_write/mkdir/move/delete/copy are always_ask.
   ========================================================================== */
const Folders = (() => {
  'use strict';
  for (const [k, v] of Object.entries({
    'folder': '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
    'folder-open': '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>',
    'folder-plus': '<path d="M12 10v6"/><path d="M9 13h6"/><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
    'folder-search': '<path d="M10.7 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v4.1"/><path d="m21 21-1.9-1.9"/><circle cx="17" cy="17" r="3"/>',
    'folder-input': '<path d="M2 9V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-1"/><path d="M2 13h10"/><path d="m9 16 3-3-3-3"/>',
    'file-pen': '<path d="M12.659 22H18a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v9.34"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="M10.378 12.622a1 1 0 0 1 3 3.003L8.36 20.637a2 2 0 0 1-.854.506l-2.867.837a.5.5 0 0 1-.62-.62l.836-2.869a2 2 0 0 1 .506-.853z"/>',
    'arrow-right-left': '<path d="m16 3 4 4-4 4"/><path d="M20 7H4"/><path d="m8 21-4-4 4-4"/><path d="M4 17h16"/>',
    'lock': '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    'triangle-alert': '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  })) if (!ICONS[k]) ICONS[k] = v;

  const api = () => (typeof window !== 'undefined' ? window.NativeKit?.folders : undefined);
  const supported = () => { try { return !!api()?.supported?.(); } catch { return false; } };
  const errCode = (e) => (e && typeof e.code === 'string' ? e.code : '');
  const errMsg = (e) => String(e?.message || e || 'Something went wrong').replace(/^Error:\s*/, '');
  let openRef = null;

  async function list() {
    const r = await api().list();
    return Array.isArray(r?.folders) ? r.folders : [];
  }

  function modeControl(f, onChange) {
    const name = `fo-mode-${f.id}`;
    const writeBlocked = f.canWrite === false;
    const opt = (value, label, hint) => {
      const input = h('input', { type: 'radio', name, value, class: 'fo-radio' });
      input.checked = (f.mode === 'readwrite' ? 'readwrite' : 'read') === value;
      input.disabled = f.available === false || (value === 'readwrite' && writeBlocked);
      input.addEventListener('change', () => { if (input.checked) onChange(value, input); });
      return h('label', { class: 'fo-seg-opt', title: hint }, input, h('span', null, label));
    };
    return h('div', { class: 'fo-seg', role: 'radiogroup', 'aria-label': `Access to ${f.name}` },
      opt('read', 'Read-only', 'The agent can list, read, search and copy into its workspace.'),
      opt('readwrite', 'Read & write', 'The agent can also create, change, move and delete files. Each change asks you first.'));
  }

  function folderRow(f, repaint) {
    const status = f.available === false
      ? h('p', { class: 'fo-status', 'data-type': 'error' }, icon('triangle-alert'), h('span', null, `Access lost${f.reason ? `: ${f.reason}` : ''}. Remove it and add it again.`))
      : f.canWrite === false
        ? h('p', { class: 'fo-status' }, icon('lock'), h('span', null, 'The system shared it read-only, so the agent cannot change it.'))
        : h('p', { class: 'fo-status' }, icon(f.mode === 'readwrite' ? 'file-pen' : 'eye'),
          h('span', null, f.mode === 'readwrite' ? 'Can read and change files. Each change asks you first.' : 'Can list, read and search files. Nothing is changed.'));
    const remove = iconButton(`Remove ${f.name}`, icon('trash'), () => confirmDialog({
      title: `Stop sharing ${f.name}?`,
      description: 'The agent loses access right away and the app gives the permission back to the system. Your files stay where they are.',
      confirmLabel: 'Remove', destructive: true,
      onConfirm: async () => {
        try { await api().remove(f.id); toast(`${f.name} is no longer shared.`, { type: 'success' }); } catch (e) { toast(errMsg(e), { type: 'error' }); }
        repaint();
      },
    }), { class: 'btn btn-ghost btn-icon fo-remove' });
    return h('li', { class: 'fo-item', 'data-id': f.id, 'data-available': String(f.available !== false) },
      h('div', { class: 'fo-head' },
        h('span', { class: 'fo-icon', 'aria-hidden': 'true' }, icon(f.available === false ? 'triangle-alert' : 'folder')),
        h('div', { class: 'fo-meta' },
          h('p', { class: 'fo-name' }, f.name),
          f.location ? h('p', { class: 'fo-where' }, f.location) : null),
        remove),
      modeControl(f, async (mode, input) => {
        try {
          await api().setMode(f.id, mode);
          toast(mode === 'readwrite' ? `The agent can now change files in ${f.name}. It asks before each change.` : `${f.name} is read-only for the agent.`, { type: 'success' });
        } catch (e) { toast(errMsg(e), { type: 'error' }); input.checked = false; }
        repaint();
      }),
      status);
  }

  async function addFolder(repaint, mode = 'read') {
    try {
      const r = await api().add({ mode });
      const f = r?.folder;
      if (f) toast(`${f.name} is shared ${f.mode === 'readwrite' ? 'read & write' : 'read-only'}.`, { type: 'success' });
    } catch (e) {
      const code = errCode(e);
      if (code === 'CANCELLED') return;
      toast(code === 'LIMIT' ? errMsg(e) : `Could not add the folder: ${errMsg(e)}`, { type: 'error' });
    }
    repaint();
  }

  function open(app) {
    if (openRef) return openRef;
    let alive = true;
    const body = h('div', { class: 'fo-body' });
    const intro = h('p', { class: 'field-hint fo-intro' },
      'Pick folders on this phone the agent may use. It sees only these folders and your workspace, nothing else.');
    const limits = h('details', { class: 'fo-limits' },
      h('summary', null, icon('info'), h('span', null, 'What can I share?')),
      h('ul', null,
        h('li', null, 'Any folder you can pick in the system folder picker, on the phone, an SD card or a cloud drive that shows up there.'),
        h('li', null, 'On Android 11 and later the system does not let apps take the whole storage, the Download folder itself or Android/data. Pick or make a sub-folder instead, for example Download/Agent.'),
        h('li', null, 'Access lasts until you remove it here. If the folder is deleted or the card is taken out, it shows as lost.')));
    const addBtn = h('button', { type: 'button', class: 'btn btn-default fo-add', onclick: () => addFolder(paint) }, icon('folder-plus'), 'Add folder');
    const listEl = h('ul', { class: 'fo-list', 'aria-label': 'Shared folders' });

    async function paint() {
      if (!alive) return;
      if (!supported()) {
        body.replaceChildren(intro, h('p', { class: 'settings-note', 'data-type': 'info' }, icon('info'), h('span', null, 'Folder sharing works in the Android and iPhone app. This preview has no phone storage.')), limits);
        return;
      }
      let folders;
      try { folders = await list(); } catch (e) {
        body.replaceChildren(intro, h('p', { class: 'settings-note', 'data-type': 'error' }, icon('circle-exclamation-point'), h('span', null, errMsg(e))), addBtn);
        return;
      }
      if (!alive) return;
      listEl.replaceChildren(...(folders.length
        ? folders.map((f) => folderRow(f, paint))
        : [h('li', { class: 'fo-empty' }, icon('folder-open'), h('p', null, 'No folders shared yet.'))]));
      body.replaceChildren(intro, listEl, h('div', { class: 'fo-actions' }, addBtn), limits);
    }

    const dialog = openDialog({ title: 'Folders', description: 'Folders the agent may read, and change if you allow it.', body, size: 'lg', align: 'top', onClose: () => { alive = false; openRef = null; } });
    dialog.panel.classList.add('sa-dialog', 'fo-dialog');
    openRef = dialog;
    body.append(h('p', { class: 'field-hint settings-loading' }, icon('loader-circle', 'spin'), 'Loading\u2026'));
    paint();
    dialog.repaint = paint;
    return dialog;
  }

  // ── Chat rows for the folder tools ──
  const textOf = (part) => {
    const r = part?.result;
    if (typeof r === 'string') return r;
    if (r && Array.isArray(r.content)) return r.content.map((c) => c?.text || '').join('\n');
    // The native engine reports { output, isError }.
    if (r && typeof r.output === 'string') return r.output;
    return '';
  };
  const inner = (t) => { const m = /<untrusted_[a-z_]+>\n?([\s\S]*?)\n?<\/untrusted_[a-z_]+>/.exec(t); return m ? m[1] : ''; };
  const where = (a) => {
    const p = typeof a.path === 'string' ? a.path.replace(/^\/+|\/+$/g, '') : '';
    const f = typeof a.folder === 'string' && a.folder ? a.folder : 'shared folder';
    return truncate(p ? `${f}/${p}` : f, 60);
  };
  // Row verb by state; 'waiting' is the approval ask, so it names what will happen.
  const ing = (s, run, done, verb, ask) => (s === 'running' ? run : s === 'waiting' ? (ask || `${verb[0].toUpperCase()}${verb.slice(1)}`) : s === 'failed' ? `Could not ${verb}` : s === 'cancelled' ? `Did not ${verb}` : done);
  const linesBody = (cls, max) => (a, r, part) => {
    const lines = inner(textOf(part)).split('\n').filter(Boolean);
    if (!lines.length) return [];
    const shown = lines.slice(0, max);
    return [h('ul', { class: `fo-lines ${cls}` }, shown.map((l) => h('li', { class: 'mono' }, l))),
      lines.length > max ? h('p', { class: 'aui-tool-dim fo-more' }, `+${lines.length - max} more`) : null].filter(Boolean);
  };

  TOOL_CARDS.device__list_folders = {
    icon: 'folder',
    title: (a, s) => (s === 'running' ? 'Checking shared folders' : 'Checked shared folders'),
    body: (a, r, part) => {
      const rows = textOf(part).split('\n').map((l) => /^- "(.+)" \(id ([\w-]+)\): (.+)$/.exec(l)).filter(Boolean);
      return rows.length ? [h('ul', { class: 'fo-lines' }, rows.map((m) => h('li', null, icon('folder'), h('span', null, m[1]), h('span', { class: 'aui-tool-dim' }, m[3]))))] : [];
    },
  };
  TOOL_CARDS.device__folder_list = { icon: 'folder-open', title: (a, s) => `${ing(s, 'Listing', 'Listed', 'list')} ${where(a)}`, body: linesBody('fo-listing', 40) };
  TOOL_CARDS.device__folder_read = {
    icon: 'file-text',
    title: (a, s) => `${ing(s, 'Reading', 'Read', 'read')} ${where(a)}`,
    body: (a, r, part) => {
      const text = inner(textOf(part));
      return text ? [h('pre', { class: 'fo-preview mono' }, text.length > 1200 ? `${text.slice(0, 1200)}\u2026` : text)] : [];
    },
  };
  TOOL_CARDS.device__folder_search = {
    icon: 'folder-search',
    title: (a, s) => `${ing(s, 'Searching', 'Searched', 'search')} ${where(a)} for "${truncate(String(a.query || ''), 30)}"`,
    body: (a, r, part) => {
      const t = textOf(part);
      const blocks = [...t.matchAll(/<untrusted_[a-z_]+>\n?([\s\S]*?)\n?<\/untrusted_[a-z_]+>/g)].map((m) => m[1]).join('\n').split('\n').filter(Boolean);
      return blocks.length ? [h('ul', { class: 'fo-lines' }, blocks.slice(0, 30).map((l) => h('li', { class: 'mono' }, l)))] : [];
    },
  };
  TOOL_CARDS.device__folder_write = { icon: 'file-pen', title: (a, s) => `${ing(s, 'Writing', a.overwrite ? 'Replaced' : 'Wrote', 'write', a.overwrite ? 'Replace' : 'Write')} ${where(a)}` };
  TOOL_CARDS.device__folder_mkdir = { icon: 'folder-plus', title: (a, s) => `${ing(s, 'Creating folder', 'Created folder', 'create folder')} ${where(a)}` };
  TOOL_CARDS.device__folder_move = {
    icon: 'arrow-right-left',
    title: (a, s) => `${ing(s, 'Moving', 'Moved', 'move')} ${where(a)} \u2192 ${truncate(String(a.to || ''), 40)}`,
  };
  TOOL_CARDS.device__folder_delete = { icon: 'trash', title: (a, s) => `${ing(s, 'Deleting', 'Deleted', 'delete')} ${where(a)}${a.recursive ? ' and everything in it' : ''}` };
  TOOL_CARDS.device__folder_copy = {
    icon: 'folder-input',
    title: (a, s) => (a.direction === 'from_workspace'
      ? `${ing(s, 'Copying', 'Copied', 'copy')} workspace/${truncate(String(a.workspace_path || ''), 30)} \u2192 ${where(a)}`
      : `${ing(s, 'Copying', 'Copied', 'copy')} ${where(a)} \u2192 workspace/${truncate(String(a.workspace_path || ''), 30)}`),
  };

  function install(app) {
    for (const footer of doc.querySelectorAll('.sidebar-footer')) {
      if (footer.querySelector('.fo-open')) continue;
      const btn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm fo-open', onclick: () => { app.setMobileSidebar?.(false); open(app); } }, icon('folder'), 'Folders');
      const anchor = footer.querySelector('.vault-open') || footer.querySelector('.fm-open');
      if (anchor) anchor.after(btn); else footer.prepend(btn);
    }
  }
  const out = { install, open, supported };
  if (typeof window !== 'undefined') window.__folders = out;
  return out;
})();
