/* "Ask + fingerprint" only where a fingerprint can actually be checked (problem 2).

   The option was offered on every device and always answered "biometric
   unavailable": the app has a 'nativeKit().biometric' bridge, but nothing asked it
   before offering the choice. Two rules:

   1. Never offer a choice the device cannot honour, and never take one away that it
      can — availability is read from the bridge, not guessed from a platform name.
   2. If the bridge does not answer at all (an older build, a preview), treat it as
      "no", because a policy that silently does nothing is worse than a missing
      option: the tool would run without the check the user asked for.

   When the option is hidden, a policy already saved as 'always_ask_biometric' is
   shown as "Always ask" so nothing is left selected-but-invisible. */
(() => {
  const VALUE = 'always_ask_biometric';
  const TEXT = /ask\s*\+\s*(fingerprint|biometric)|বায়োমেট্রিক/i;
  let available = null;

  function bridge() {
    if (typeof window === 'undefined') return null;
    const kit = (window.nativeKit && window.nativeKit()) || window.NativeKit || null;
    return kit && kit.biometric ? kit.biometric : null;
  }

  async function detect() {
    if (available !== null) return available;
    // The native interface, when this build has one: it answers synchronously and
    // knows about enrolment (a sensor with no fingerprint is not "available").
    if (typeof window !== 'undefined' && window.NativeKitPro && typeof window.NativeKitPro.biometricState === 'function') {
      try {
        const st = String(window.NativeKitPro.biometricState());
        available = st === 'ready';
        return available;
      } catch (e) { console.warn('biometric state', e); }
    }
    const b = bridge();
    available = false;
    if (!b) return available;
    try {
      const r = typeof b.isAvailable === 'function' ? await b.isAvailable() : typeof b.available === 'function' ? await b.available() : typeof b === 'boolean' ? b : false;
      // Accept either a boolean or a result object with one.
      available = r === true || (r && (r.available === true || r.ok === true));
    } catch (e) {
      console.warn('biometric availability', e);
      available = false;
    }
    return available;
  }

  function sweep() {
    if (available !== false) return 0;
    let n = 0;
    for (const opt of document.querySelectorAll('option[value="${VALUE}"], [data-policy="${VALUE}"], button')) {
      const isOption = opt.tagName === 'OPTION' || opt.getAttribute('data-policy') === VALUE;
      const text = (opt.textContent || '').trim();
      if (!(isOption || TEXT.test(text))) continue;
      if (opt.dataset.hiddenBiometric === '1') continue;
      opt.dataset.hiddenBiometric = '1';
      opt.setAttribute('hidden', '');
      opt.style.display = 'none';
      // A chosen value that no longer exists would look like an empty policy.
      if (isOption && opt.selected && opt.parentElement) {
        const fallback = [...opt.parentElement.querySelectorAll('option')].find((o) => o.value === 'always_ask');
        if (fallback) fallback.selected = true;
      }
      n += 1;
    }
    for (const el of document.querySelectorAll('[data-policy-value], [data-approval]')) {
      if ((el.getAttribute('data-policy-value') || el.getAttribute('data-approval')) === VALUE && el.dataset.hiddenBiometric !== '1') {
        el.dataset.hiddenBiometric = '1';
        el.setAttribute('hidden', '');
        el.style.display = 'none';
        n += 1;
      }
    }
    return n;
  }

  function apply() {
    return detect().then((ok) => {
      if (!ok) sweep();
      if (typeof MutationObserver !== 'undefined' && document.body) {
        // Nothing to hide while biometrics work; otherwise one sweep per frame.
        let frame = 0;
        const mo = new MutationObserver((records) => {
          if (available !== false || frame || records.every((r) => !r.addedNodes.length)) return;
          frame = requestAnimationFrame(() => { frame = 0; try { sweep(); } catch (e) { console.warn('biometric sweep', e); } });
        });
        mo.observe(document.body, { childList: true, subtree: true });
      }
      return ok;
    });
  }

  const out = { apply, sweep, detect, available: () => available };
  if (typeof window !== 'undefined') {
    window.__biometricOption = out;
    const boot = () => { apply().catch((e) => console.warn('biometric boot', e)); };
    if (typeof document !== 'undefined') {
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
      else setTimeout(boot, 0);
    }
  }
})();
