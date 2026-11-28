(function () {
  // Reader mode for the remote browser: a clean, readable overlay built from
  // the page's main text. Runs as a one-shot native -> page call; calling it
  // again removes the overlay. The page gains no channel back into native code.
  var d = document;
  var existing = d.getElementById('__nk_reader');
  if (existing) { existing.parentNode.removeChild(existing); d.documentElement.style.overflow = ''; return 'off'; }
  var best = d.querySelector('article') || d.querySelector('main') || d.body;
  var bestScore = 0;
  var candidates = d.querySelectorAll('article, main, section, div');
  for (var i = 0; i < candidates.length; i++) {
    var node = candidates[i];
    var score = 0;
    for (var c = 0; c < node.children.length; c++) {
      var child = node.children[c];
      if (child.tagName === 'P') score += (child.textContent || '').length;
    }
    if (score > bestScore) { bestScore = score; best = node; }
  }
  var overlay = d.createElement('div');
  overlay.id = '__nk_reader';
  overlay.setAttribute('style', 'position:fixed;inset:0;z-index:2147483646;overflow:auto;background:#f8f5ee;color:#1f2328;' +
    'font:19px/1.65 Georgia,"Noto Serif",serif;padding:28px 22px 120px;box-sizing:border-box;');
  var column = d.createElement('div');
  column.setAttribute('style', 'max-width:680px;margin:0 auto;');
  var meta = d.createElement('div');
  meta.textContent = location.hostname.replace(/^www\./, '') + ' \u00b7 Reader view';
  meta.setAttribute('style', 'font:13px/1.4 system-ui,sans-serif;color:#6b7280;margin-bottom:10px;');
  column.appendChild(meta);
  var title = d.createElement('h1');
  title.textContent = (d.querySelector('h1') && d.querySelector('h1').textContent.trim()) || d.title;
  title.setAttribute('style', 'font-size:30px;line-height:1.25;margin:0 0 18px;');
  column.appendChild(title);
  var blocks = best.querySelectorAll('h2, h3, p, li, blockquote, pre, img');
  var count = 0;
  for (var b = 0; b < blocks.length && count < 600; b++) {
    var el = blocks[b];
    if (el.closest('nav, footer, aside, form, #__nk_reader')) continue;
    if (el.tagName === 'IMG') {
      if (el.currentSrc && el.naturalWidth > 240) {
        var img = d.createElement('img');
        img.src = el.currentSrc;
        img.setAttribute('style', 'max-width:100%;height:auto;border-radius:8px;margin:12px 0;');
        column.appendChild(img);
        count++;
      }
      continue;
    }
    var text = (el.innerText || el.textContent || '').trim();
    if (text.length < 2) continue;
    var tag = el.tagName === 'LI' ? 'p' : el.tagName.toLowerCase();
    var out = d.createElement(tag);
    out.textContent = (el.tagName === 'LI' ? '\u2022 ' : '') + text;
    if (tag === 'pre') out.setAttribute('style', 'white-space:pre-wrap;font-size:14px;background:#eee;padding:10px;border-radius:6px;');
    column.appendChild(out);
    count++;
  }
  if (count === 0) {
    var none = d.createElement('p');
    none.textContent = 'Reader view could not find the main text of this page.';
    column.appendChild(none);
  }
  overlay.appendChild(column);
  d.documentElement.appendChild(overlay);
  d.documentElement.style.overflow = 'hidden';
  return 'on';
})();
