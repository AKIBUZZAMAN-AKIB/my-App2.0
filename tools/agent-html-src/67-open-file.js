/* Hand a file to another app (problem 7).

   The Android side is done (FileProvider + FileOpener + NativeKitPro.openFile); what
   was missing was the page's half: one function any panel can call, and a visible
   affordance that appears only where it can work.

   Rules:
   * no bridge, no button — a control that does nothing is worse than none;
   * the path is checked before it is sent, so a refusal is explained instead of
     silently opening nothing;
   * the answer is reported back to the caller, so a panel can say "no app can open
     this" rather than looking broken. */
(() => {
  const pro = () => (typeof window !== 'undefined' && window.NativeKitPro && typeof window.NativeKitPro.openFile === 'function' ? window.NativeKitPro : null);

  const available = () => !!pro();

  /** Ask the system to open `path`. Returns { ok, reason? }. */
  function open(path) {
    const b = pro();
    if (!b) return { ok: false, reason: 'This build cannot hand files to other apps.' };
    if (typeof path !== 'string' || !path.trim()) return { ok: false, reason: 'No file was given.' };
    try {
      const ok = b.openFile(path);
      return ok ? { ok: true } : { ok: false, reason: 'No app on this phone can open that file.' };
    } catch (e) {
      console.warn('open-file', e);
      return { ok: false, reason: 'The file could not be handed over.' };
    }
  }

  /** Add an "Open" button next to a file row, if the platform can honour it. */
  function decorate(root) {
    if (!available() || !root || !root.querySelectorAll) return 0;
    let n = 0;
    for (const row of root.querySelectorAll('[data-path]')) {
      if (row.querySelector('.open-external')) continue;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'open-external';
      btn.textContent = 'Open';
      btn.title = 'Open this file in another app';
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const res = open(row.getAttribute('data-path'));
        btn.textContent = res.ok ? 'Opening…' : 'Cannot open';
        if (!res.ok) {
          btn.title = res.reason || '';
          setTimeout(() => { btn.textContent = 'Open'; }, 2500);
        }
      });
      row.appendChild(btn);
      n += 1;
    }
    return n;
  }

  /** The app's workspace (Capacitor's file layer), when this page runs inside the app. */
  const workspace = () => { try { return typeof bridge !== 'undefined' && typeof bridge.workspaceFiles === 'function' ? bridge.workspaceFiles() : null; } catch { return null; } };
  /** file:///data/user/0/…/files/agent/workspace/x.pdf -> /data/user/0/…/files/agent/workspace/x.pdf */
  const fileUriToPath = (uri) => { const m = /^file:\/\/(\/.*)$/.exec(String(uri || '')); if (!m) return ''; try { return decodeURIComponent(m[1]); } catch { return m[1]; } };
  /** Whether a workspace file can be handed to another app here (Open with, or at least the share sheet). */
  const canOpenWorkspace = () => !!pro() || !!workspace()?.share;

  /**
   * Open a workspace file (a path relative to the workspace, like reports/q3.pdf) straight in
   * another app, without downloading a copy first: Android's "Open with" chooser through
   * NativeKitPro.openFile (FileProvider, read-only grant). Without that bridge (iOS, an older
   * build) the system share sheet is the fallback, which also lists "Open in…" apps.
   * Returns { ok, via: 'open' | 'share', reason? }.
   */
  async function openWorkspace(path) {
    const ws = workspace();
    if (!ws) return { ok: false, reason: 'Files can only be opened in another app inside the app.' };
    let uri = '';
    try { uri = (await ws.url(path)).uri; } catch (e) { return { ok: false, reason: e?.message || 'That file is not in the workspace.' }; }
    const abs = fileUriToPath(uri);
    if (pro() && abs) {
      const r = open(abs);
      if (r.ok) return { ok: true, via: 'open' };
      if (!ws.share) return { ...r, via: 'open' };
    }
    if (!ws.share) return { ok: false, reason: 'This build cannot hand files to other apps.' };
    try { await ws.share(path); return { ok: true, via: 'share' }; } catch (e) {
      if (/cancel/i.test(String(e?.message || e))) return { ok: true, via: 'share', cancelled: true };
      return { ok: false, via: 'share', reason: e?.message || 'The file could not be shared.' };
    }
  }

  const out = { open, available, decorate, openWorkspace, canOpenWorkspace, fileUriToPath };
  if (typeof window !== 'undefined') window.__openFile = out;
  return out;
})();
