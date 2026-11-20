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
  const bridge = () => (typeof window !== 'undefined' && window.NativeKitPro && typeof window.NativeKitPro.openFile === 'function' ? window.NativeKitPro : null);

  const available = () => !!bridge();

  /** Ask the system to open `path`. Returns { ok, reason? }. */
  function open(path) {
    const b = bridge();
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

  const out = { open, available, decorate };
  if (typeof window !== 'undefined') window.__openFile = out;
  return out;
})();
