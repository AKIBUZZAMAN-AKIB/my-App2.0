/* ==========================================================================
   Tool rows for the open-data device tools (bridge/open-data.ts):
   search_images, geocode_location, get_weather. The row says what was
   looked up; the body previews the answer (thumbnails, places, forecast).
   ========================================================================== */
(() => {
  'use strict';
  // Lucide icons (ISC) these rows and the notepad use.
  for (const [k, v] of Object.entries({
    'map-pin': '<path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/>',
    'cloud-sun': '<path d="M12 2v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="M20 12h2"/><path d="m19.07 4.93-1.41 1.41"/><path d="M15.947 12.65a4 4 0 0 0-5.925-4.128"/><path d="M13 22H7a5 5 0 1 1 4.9-6H13a3 3 0 0 1 0 6Z"/>',
    'notebook-pen': '<path d="M13.4 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7.4"/><path d="M2 6h4"/><path d="M2 10h4"/><path d="M2 14h4"/><path d="M2 18h4"/><path d="M21.378 5.626a1 1 0 1 0-3.004-3.004l-5.01 5.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z"/>',
  })) if (!ICONS[k]) ICONS[k] = v;
  const textOf = (part) => {
    const r = part?.result;
    if (typeof r === 'string') return r;
    if (r && Array.isArray(r.content)) return r.content.map((c) => c?.text || '').join('\n');
    if (r && typeof r.output === 'string') return r.output;
    return '';
  };
  const clean = (t) => t.replace(/^<untrusted_[a-z_]+>\n?|\n?<\/untrusted_[a-z_]+>$/g, '');
  const q = (a) => (a.query || a.location ? ` for "${truncate(String(a.query || a.location), 40)}"` : '');

  TOOL_CARDS.device__search_images = {
    icon: 'image',
    title: (a, s) => `${s === 'running' ? 'Finding images' : 'Found images'}${q(a)}`,
    body: (a, r, part) => {
      const lines = clean(textOf(part)).split('\n');
      const imgs = [];
      for (const l of lines) {
        const m = /^\d+\. (.+?): (https:\/\/\S+) \(\d+×\d+\)\. By (.+?), (.+?)\. Page: (https:\/\/\S+)/.exec(l);
        if (m) imgs.push({ title: m[1], src: m[2], credit: `${m[3]}, ${m[4]}`, page: m[5] });
      }
      if (!imgs.length) return [];
      return [h('ul', { class: 'od-thumbs', 'aria-label': 'Images found' }, imgs.slice(0, 12).map((i) => h('li', {},
        h('a', { href: i.page, target: '_blank', rel: 'noopener noreferrer', title: `${i.title} — ${i.credit}` },
          h('img', { src: i.src, alt: i.title, loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer', onerror: (e) => e.target.closest('li')?.remove() })))))];
    },
  };

  TOOL_CARDS.device__geocode_location = {
    icon: 'map-pin',
    title: (a, s) => `${s === 'running' ? 'Looking up' : 'Looked up'} ${a.query ? `"${truncate(String(a.query), 40)}"` : 'a place'}`,
    body: (a, r, part) => {
      const rows = clean(textOf(part)).split('\n').map((l) => /^\d+\. (.+): (-?[\d.]+), (-?[\d.]+)/.exec(l)).filter(Boolean);
      return rows.length ? listOf(rows, (m) => [icon('map-pin'), h('span', null, m[1]), h('span', { class: 'mono aui-tool-dim' }, `${m[2]}, ${m[3]}`)], 8) : [];
    },
  };

  TOOL_CARDS.device__get_weather = {
    icon: 'cloud-sun',
    title: (a, s) => {
      const where = a.location || (a.latitude != null && a.longitude != null ? `${Number(a.latitude).toFixed(2)}, ${Number(a.longitude).toFixed(2)}` : '');
      return `${s === 'running' ? 'Checking the weather' : 'Checked the weather'}${where ? ` for ${truncate(String(where), 40)}` : ''}`;
    },
    body: (a, r, part) => {
      const lines = clean(textOf(part)).split('\n').filter((l) => /^(Weather for|\d{4}-\d\d-\d\d:)/.test(l)).slice(0, 8);
      return lines.length ? [h('ul', { class: 'od-lines' }, lines.map((l) => h('li', {}, l)))] : [];
    },
  };
})();
