/* Remove the duplicate "Section" destination (problem 4).

   The side panel already offers Agents / Files / Vault / Folders / Settings, so a
   separate "Section" button is a second way to say the same thing — and the panel
   it opens is empty next to them. Rather than delete code we cannot see (the
   button is rendered by a screen this repository builds elsewhere), this module
   hides exactly that one destination and its panel, and says so in one place:

   * it matches the *label*, not an id, because the id is not known here;
   * it matches whole words only ("Section", "Sections", "সেকশন"), so "Sections in
     memory" or "Section headers" inside a card are never touched;
   * it re-applies after the app repaints (a MutationObserver), because a nav is
     usually rebuilt on every screen change;
   * it is reversible: set `window.__hideSectionNav = false` before the app boots.

   Everything else — every other button, tab and panel — is left exactly as it is. */
(() => {
  const WORDS = /^(section|sections|সেকশন)$/i;
  const SEL = 'button, a, [role="tab"], [role="menuitem"], .sa-tab, .segmented > *, nav *';
  let observer = null;

  const label = (el) => (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ');

  function hideOne(el) {
    if (el.dataset.hiddenSectionNav === '1') return false;
    el.dataset.hiddenSectionNav = '1';
    el.setAttribute('hidden', '');
    el.style.display = 'none';
    return true;
  }

  function sweep(root) {
    let n = 0;
    const scope = root && root.querySelectorAll ? root : document;
    for (const el of scope.querySelectorAll(SEL)) {
      if (WORDS.test(label(el))) n += hideOne(el) ? 1 : 0;
    }
    // The panel the button opened: a container whose only heading is that word.
    for (const panel of document.querySelectorAll('[data-slot*="section"], .panel--section')) {
      const head = panel.querySelector('h1,h2,h3,h4');
      if (head && WORDS.test(label(head))) {
        panel.setAttribute('hidden', '');
        panel.style.display = 'none';
        n += 1;
      }
    }
    return n;
  }

  function apply() {
    if (window.__hideSectionNav === false) return 0;
    const n = sweep(document);
    if (observer || typeof MutationObserver === 'undefined') return n;
    observer = new MutationObserver(() => {
      // Only re-sweep when something was added; the sweep itself is idempotent.
      try { sweep(document); } catch (e) { console.warn('hide-section-nav', e); }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return n;
  }

  const out = { apply, sweep, words: WORDS };
  if (typeof window !== 'undefined') {
    window.__hideSectionNav = window.__hideSectionNav !== false;
    window.__sectionNavHider = out;
    const boot = () => { try { apply(); } catch (e) { console.warn('hide-section-nav boot', e); } };
    if (typeof document !== 'undefined') {
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
      else setTimeout(boot, 0);
    }
  }
})();
