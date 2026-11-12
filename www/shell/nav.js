/* ==========================================================================
   My App — the 5-button bottom bar, shared by every main app page.

   This file is injected at build time (scripts/prepare-web.mjs) into every
   root page, so the shipped HTML files stay untouched while each one still
   runs as a real top-level page with a live native bridge.
   ========================================================================== */

(() => {
  'use strict';
  if (window.__MYAPP_NAV__) return;
  window.__MYAPP_NAV__ = true;

  /* The five destinations of the bottom bar. `files` lists every main app page
     that belongs to that destination — the extra apps behind "More" keep their
     own top-level page and simply light up the More tab. */
  const TABS = [
    { id: 'home', label: 'Home', icon: 'home', href: './home.html', files: ['index.html', 'home.html', ''] },
    { id: 'academic', label: 'Academic', icon: 'book', href: './academic.html', files: ['academic.html'] },
    { id: 'agent', label: 'Agent', icon: 'spark', href: './agent.html', files: ['agent.html'] },
    { id: 'calendar', label: 'Calendar', icon: 'calendar', href: './calendar.html', files: ['calendar.html'] },
    { id: 'more', label: 'More', icon: 'grid', href: './more.html', files: ['more.html', 'Bluetooth.html', 'my-note.html', 'openshelf.html', 'reminder.html', 'store.html', 'habit-tracker.html'] },
  ];

  const ICONS = {
    home: '<path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z"/>',
    book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19v15H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M4 20.5A2.5 2.5 0 0 1 6.5 18H19v3H6.5"/>',
    spark: '<path d="M12 3.5 13.7 9l5.3 1.8-5.3 1.8L12 18l-1.7-5.4L5 10.8 10.3 9z"/><path d="M18.5 16.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/>',
    calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.6"/><path d="M3.5 10h17M8 3.5v3M16 3.5v3M8 14h2.5M8 17.5h2.5M14 14h2.5"/>',
    grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="2.2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2.2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2.2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2.2"/>',
  };

  const icon = (name) => `<svg class="mn-ico" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

  const currentFile = (() => {
    const path = location.pathname.split('/').pop() || '';
    return path || 'index.html';
  })();
  const activeTab = (TABS.find((tab) => tab.files.includes(currentFile)) || TABS[0]).id;

  function build() {
    const nav = document.createElement('nav');
    nav.className = 'mn-nav';
    nav.id = 'mnNav';
    nav.setAttribute('aria-label', 'Main navigation');
    nav.innerHTML = TABS.map((tab) => `
      <a class="mn-tab" href="${tab.href}" data-tab="${tab.id}"
         ${tab.id === activeTab ? 'aria-current="page"' : ''}>
        ${icon(tab.icon)}
        <span class="mn-label">${tab.label}</span>
      </a>`).join('');
    document.body.append(nav);

    nav.addEventListener('click', (event) => {
      const link = event.target.closest('.mn-tab');
      if (!link) return;
      if (link.dataset.tab === activeTab) {
        // Re-tapping the current destination returns that app to the top.
        event.preventDefault();
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }
      event.preventDefault();
      document.documentElement.dataset.mnLeaving = 'true';
      location.href = link.getAttribute('href');
    });

    return nav;
  }

  let hideTimer = 0;
  function setHidden(hidden) {
    const nav = document.getElementById('mnNav');
    if (!nav) return;
    nav.dataset.hidden = hidden ? 'true' : 'false';
    nav.style.pointerEvents = hidden ? 'none' : '';
  }

  function wireAutoHide(nav) {
    let lastY = window.scrollY;
    let hidden = false;
    let typed = false;

    const reveal = () => { if (hidden) { hidden = false; setHidden(false); } };
    const conceal = () => { if (!hidden) { hidden = true; setHidden(true); } };

    window.addEventListener('scroll', () => {
      if (typed) return;
      const y = window.scrollY;
      const delta = y - lastY;
      if (y < 24) { reveal(); lastY = y; return; }
      if (delta > 10) { window.clearTimeout(hideTimer); hideTimer = window.setTimeout(conceal, 40); }
      else if (delta < -10) { window.clearTimeout(hideTimer); reveal(); }
      lastY = y;
    }, { passive: true });

    // Never sit on top of the on-screen keyboard or a focused field.
    document.addEventListener('focusin', (event) => {
      const el = event.target;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) {
        typed = true;
        conceal();
      }
    });
    document.addEventListener('focusout', () => {
      window.setTimeout(() => {
        const active = document.activeElement;
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) return;
        typed = false;
        reveal();
      }, 120);
    });

    // visualViewport shrinks when the keyboard opens, even when no field is focused.
    const vv = window.visualViewport;
    if (vv) {
      const onResize = () => {
        const shrunk = window.innerHeight - vv.height > 140;
        if (shrunk) conceal();
        else if (!typed) reveal();
      };
      vv.addEventListener('resize', onResize, { passive: true });
    }

    // A double tap on the very bottom edge re-opens a hidden bar (no app content
    // is stolen: the listener only reacts inside the bar's own hit area).
    nav.addEventListener('touchstart', reveal, { passive: true });
  }

  function mount() {
    if (!document.body) { document.addEventListener('DOMContentLoaded', mount, { once: true }); return; }
    const nav = build();
    document.documentElement.dataset.mnNav = activeTab;
    wireAutoHide(nav);
  }

  mount();
})();
