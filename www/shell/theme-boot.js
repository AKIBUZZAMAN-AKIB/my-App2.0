/* ==========================================================================
   My App — first-paint colour.

   This is the first script the shell injects, and it runs while the document is
   still parsing: it repaints the canvas in the colour the previous page was
   using, so switching apps never flashes a white (or black) frame before the
   new page has drawn itself. shell/nav.js stores the value.
   ========================================================================== */

(() => {
  'use strict';
  try {
    const color = window.localStorage.getItem('mn:color');
    if (!color) return;
    const root = document.documentElement;
    root.style.backgroundColor = color;
    root.style.setProperty('--mn-page-color', color);
  } catch { /* private mode or no storage: the page's own colour is used */ }
})();
