/* ==========================================================================
   Widget tools — work on UI the agent already showed, or is about to show.
     edit_widget     exact, ordered string replacements on a shown widget,
                     all or nothing; the edited version is drawn below and
                     the older card folds to "updated below"
     preview_widget  renders HTML or a spec offscreen and reports errors,
                     blocked network requests, blank output, height,
                     sideways overflow and the visible text
     read_me         the guidance modules from GenUICore
   The code of a widget is never kept on the side: it is replayed from the
   tool calls in the thread (show_html, html show_widget, render_spec,
   present, edit_widget), so it is the same after a reload.
   ========================================================================== */
const WidgetTools = (() => {
  'use strict';
  const C = GenUICore;
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const tkey = (title) => String(title || '').trim().toLowerCase();
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many || `${one}s`}`;
  const EDIT_KEY = 'genuiEditedSpecs';
  const MAX_CODE = 200000;
  const PREVIEW_TIMEOUT = 6000;
  const SETTLE_MS = 250;

  /* ---------- the thread a tool call lives in ---------- */
  function runtimes() { return app?.chat?.runtimes ? [...app.chat.runtimes.values()] : []; }
  function messagesOf(rt) { try { return rt?.messages || []; } catch { return []; } }
  function runtimeFor(ctx, toolCallId) {
    if (ctx?.sessionKey && app?.chat?.runtimes?.get(ctx.sessionKey)) return app.chat.runtimes.get(ctx.sessionKey);
    if (toolCallId) for (const rt of runtimes()) if (findPart(messagesOf(rt), toolCallId)) return rt;
    return app?.chat?.main || null;
  }
  function* toolParts(messages) {
    for (const m of messages) for (const p of Array.isArray(m?.content) ? m.content : []) if (p?.type === 'tool-call') yield p;
  }
  function findPart(messages, id) { for (const p of toolParts(messages)) if (p.toolCallId === id) return p; return null; }
  const bare = (name) => String(name || '').replace(/^ui__/, '');

  /* ---------- edited specs survive a reload (their base may hold user values) ---------- */
  const editStore = {
    read() { try { const v = JSON.parse(localStorage.getItem(EDIT_KEY) || '{}'); return isObj(v) ? v : {}; } catch { return {}; } },
    get(id) { const v = this.read()[id]; return isObj(v?.spec) ? v.spec : null; },
    put(id, spec) {
      try {
        const all = this.read();
        all[id] = { at: Date.now(), spec };
        const keys = Object.keys(all).sort((a, b) => (all[b].at || 0) - (all[a].at || 0));
        for (const k of keys.slice(40)) delete all[k];
        const text = JSON.stringify(all);
        if (text.length < 600000) localStorage.setItem(EDIT_KEY, text);
      } catch { /* storage full or blocked */ }
    },
  };

  /* ---------- replaying a thread into "the current code of each title" ---------- */
  const htmlById = new Map(); // toolCallId -> { title, html, number }
  const edits = new Map(); // edit_widget toolCallId -> { kind, title, number, html?, versionId?, error? }

  function htmlSource(part) {
    const tool = bare(part.toolName);
    const a = isObj(part.args) ? part.args : {};
    if (tool === 'show_html' && typeof a.html === 'string' && a.html.trim()) return { title: String(a.title || '').trim() || `html_${String(part.toolCallId).slice(-6)}`, html: a.html };
    if (tool === 'show_widget' && isObj(a.spec) && String(a.spec.type).toLowerCase() === 'html') {
      const html = typeof a.spec.html === 'string' ? a.spec.html : typeof a.spec.content === 'string' ? a.spec.content : '';
      if (html.trim()) return { title: String(a.spec.title || '').trim() || `widget_${String(part.toolCallId).slice(-6)}`, html };
    }
    return null;
  }

  /** Walks the thread in order; stops before `stopId`. Returns title -> current entry. */
  function replay(messages, stopId, ctx) {
    const cur = new Map();
    for (const p of toolParts(messages)) {
      if (p.toolCallId === stopId) break;
      if (p.isError) continue;
      const tool = bare(p.toolName);
      if (tool === 'show_html' || tool === 'show_widget') {
        const src = htmlSource(p);
        if (!src) continue;
        const prev = cur.get(tkey(src.title));
        const entry = { kind: 'html', id: p.toolCallId, title: src.title, html: src.html, number: prev?.kind === 'html' ? prev.number + 1 : 1 };
        htmlById.set(p.toolCallId, entry);
        cur.set(tkey(src.title), entry);
      } else if (tool === 'render_spec' || tool === 'present') {
        let v;
        try { v = GenUI.ensureVersion(p, ctx); } catch { continue; }
        if (!v || GenUI.isFatal(v)) continue;
        cur.set(tkey(v.title), { kind: 'spec', id: v.id, title: v.title, version: v, number: v.number });
      } else if (tool === 'edit_widget') {
        if (p.result === undefined && !edits.has(p.toolCallId)) continue; // still running or never finished
        const done = edits.get(p.toolCallId) || computeEdit(p, cur, ctx);
        if (!done || done.error) continue;
        if (done.kind === 'html') cur.set(tkey(done.title), { kind: 'html', id: p.toolCallId, title: done.title, html: done.html, number: done.number });
        else { const v = GenUI.calls.get(done.versionId); if (v) cur.set(tkey(v.title), { kind: 'spec', id: v.id, title: v.title, version: v, number: v.number }); }
      }
    }
    return cur;
  }

  const specCode = (spec) => JSON.stringify({ root: spec.root, elements: spec.elements, state: spec.state }, null, 2);

  /** Applies one edit_widget call to the current code of its title; cached per call. */
  function computeEdit(part, cur, ctx) {
    const id = String(part.toolCallId);
    const a = isObj(part.args) ? part.args : {};
    const title = String(a.title || '').trim();
    const fail = (error) => { const r = { error }; edits.set(id, r); return r; };
    if (!title) return fail('title is required: the title of the widget to edit.');
    const target = cur.get(tkey(title));
    if (!target) {
      const known = [...cur.values()].map((e) => `"${e.title}"`);
      return fail(`No widget titled "${title}" is shown in this chat.${known.length ? ` Shown: ${known.slice(-12).join(', ')}.` : ' Nothing editable is shown yet: show it first with show_html or render_spec.'}`);
    }
    const list = Array.isArray(a.edits) ? a.edits : isObj(a.edits) ? [a.edits] : (a.old_string != null ? [{ old_string: a.old_string, new_string: a.new_string }] : null);
    if (target.kind === 'html') {
      const r = C.applyEdits(target.html, list);
      if (!r.ok) return fail(`${r.error} Nothing was changed.`);
      if (!r.source.trim()) return fail('The edits would leave the widget empty. Nothing was changed.');
      if (r.source.length > MAX_CODE) return fail(`The edited code is ${r.source.length} characters; the limit is ${MAX_CODE}. Nothing was changed.`);
      const done = { kind: 'html', title: target.title, html: r.source, number: target.number + 1, count: list.length, prevId: target.id };
      edits.set(id, done);
      htmlById.set(id, { kind: 'html', id, title: target.title, html: r.source, number: done.number });
      return done;
    }
    let spec = editStore.get(id);
    if (!spec) {
      const r = C.applyEdits(specCode(target.version.spec), list);
      if (!r.ok) return fail(`${r.error} Nothing was changed. The code of a render_spec/present widget is its spec as JSON with 2-space indent: {"root", "elements", "state"}.`);
      try { spec = JSON.parse(r.source); } catch (e) { return fail(`After the edits the spec is not valid JSON (${e.message}). Nothing was changed.`); }
      if (!isObj(spec)) return fail('After the edits the spec is not a JSON object. Nothing was changed.');
      editStore.put(id, spec);
    }
    const v = GenUI.ensureVersion({ toolCallId: id, toolName: 'render_spec', args: { title: target.version.title, spec } }, ctx);
    const done = { kind: 'spec', title: v.title, versionId: v.id, number: v.number, count: list?.length || 0 };
    edits.set(id, done);
    return done;
  }

  /* ---------- HTML cards that fold when a newer version shows ---------- */
  const htmlCards = new Map(); // toolCallId -> { el, title }
  function foldOlder(title, newestId) {
    const k = tkey(title);
    for (const [id, c] of htmlCards) {
      if (id === newestId || tkey(c.title) !== k) continue;
      if (!c.el.isConnected) { htmlCards.delete(id); continue; }
      fold(c.el, c.title);
    }
  }
  function fold(el, title) {
    if (el.classList.contains('gu-old')) return;
    el.classList.add('gu-old');
    const toggle = h('button', { type: 'button', class: 'gu-old-toggle', 'aria-expanded': 'false' }, icon('chevron-down'), h('span', {}, 'Show'));
    const bar = h('div', { class: 'gu-old-bar' },
      h('span', { class: 'gu-old-text' }, icon('arrow-down'), h('span', {}, `${String(title).replace(/[_-]+/g, ' ')}: updated below`)), toggle);
    toggle.addEventListener('click', () => {
      const open = el.classList.toggle('gu-old-open');
      toggle.setAttribute('aria-expanded', String(open));
      toggle.lastChild.textContent = open ? 'Hide' : 'Show';
    });
    el.prepend(bar);
  }
  /** Wraps an HTML widget card so it can fold; folds at once when a newer version exists. */
  function htmlCardFor(part, html, title, number) {
    const wrap = h('div', { class: 'wt-html', 'data-title': title, 'data-version': String(number || 1) });
    wrap.append(h('div', { class: 'gu-body' }, htmlWidgetCard({ html, title, height: part.args?.height })));
    htmlCards.set(part.toolCallId, { el: wrap, title });
    if (htmlCards.size > 200) for (const [id, c] of htmlCards) { if (htmlCards.size <= 150) break; if (!c.el.isConnected) htmlCards.delete(id); }
    const rt = runtimeFor(null, part.toolCallId);
    if (rt) {
      const cur = replay(messagesOf(rt), null, { sessionKey: rt.id });
      const newest = cur.get(tkey(title));
      if (newest && newest.id !== part.toolCallId && newest.kind === 'html') queueMicrotask(() => fold(wrap, title));
    }
    queueMicrotask(() => { if (wrap.isConnected && !wrap.classList.contains('gu-old')) foldOlder(title, part.toolCallId); });
    return wrap;
  }

  /* ---------- edit_widget ---------- */
  async function editExecute(args, ctx) {
    if (!isObj(args)) throw new Error('Pass { title, edits: [{ old_string, new_string }] }.');
    const id = String(ctx?.toolCallId || `local-${Date.now()}`);
    const rt = runtimeFor(ctx, id);
    const cur = replay(messagesOf(rt), id, ctx);
    const done = computeEdit({ toolCallId: id, toolName: 'edit_widget', args }, cur, ctx);
    if (done.error) throw new Error(done.error);
    if (done.kind === 'spec') {
      const v = GenUI.calls.get(done.versionId);
      const text = GenUI.resultText(v).replace(/^Rendered /, `Applied ${plural(done.count, 'edit')}. Rendered `);
      if (GenUI.isFatal(v)) throw new Error(`The edited spec has nothing to draw. ${text}`);
      return text;
    }
    const lines = [`Applied ${plural(done.count, 'edit')} to "${done.title}" (now version ${done.number}). The new version is shown below the old one.`];
    try {
      const r = await previewHtml(done.html, { width: 320, appearance: currentTheme() });
      lines.push(r.problems.length ? `Render check at 320 px found ${plural(r.problems.length, 'problem')}:\n${r.problems.map((p) => `- ${p}`).join('\n')}\nFix them with another edit_widget call.` : `Render check at 320 px: no errors, no blocked requests, no sideways overflow, ${r.height} px tall.`);
    } catch { /* the check is a bonus */ }
    return lines.join('\n');
  }

  function editCard(part, status) {
    const id = part.toolCallId;
    if (part.isError) return h('p', { class: 'field-hint wt-edit-failed' }, 'The widget edit did not apply.');
    let done = edits.get(id);
    if (!done && part.result !== undefined) {
      const rt = runtimeFor(null, id);
      if (rt) { const cur = replay(messagesOf(rt), id, { sessionKey: rt.id }); done = computeEdit(part, cur, { sessionKey: rt.id }); }
    }
    if (!done) return h('p', { class: 'field-hint' }, status?.type === 'running' ? `Editing ${String(part.args?.title || 'the widget')}…` : 'The widget edit did not finish.');
    if (done.error) return h('p', { class: 'field-hint wt-edit-failed' }, 'The widget edit did not apply.');
    if (done.kind === 'spec') {
      const v = GenUI.calls.get(done.versionId);
      return v ? v.card() : h('p', { class: 'field-hint' }, 'This version is no longer available.');
    }
    return htmlCardFor(part, done.html, done.title, done.number);
  }

  /* ---------- theme tokens for an appearance (the app's own CSS rules) ---------- */
  let tokenCache = null;
  function tokens(appearance) {
    if (!tokenCache) {
      tokenCache = { light: {}, dark: {} };
      for (const sheet of doc.styleSheets) {
        let rules; try { rules = sheet.cssRules; } catch { continue; }
        for (const r of rules) {
          const sel = r.selectorText;
          if (sel !== ':root' && sel !== '.dark') continue;
          for (const n of r.style) if (n.startsWith('--')) {
            const val = r.style.getPropertyValue(n).trim();
            if (sel === ':root') { tokenCache.light[n] = val; } else tokenCache.dark[n] = val;
          }
        }
      }
    }
    return appearance === 'dark' ? { ...tokenCache.light, ...tokenCache.dark } : { ...tokenCache.light };
  }
  function widgetVars(appearance) {
    const t = tokens(appearance);
    const v = (n, f = '') => t[n] || f;
    return { '--aui-bg': v('--background'), '--aui-fg': v('--foreground'), '--aui-muted': v('--muted-foreground'), '--aui-border': v('--border'), '--aui-accent': v('--primary', v('--foreground')), '--aui-card': v('--muted') };
  }

  /* ---------- preview: HTML in a hidden sandboxed frame ---------- */
  // Runs first in the frame: collects errors, blocked requests and console
  // output, then measures once the page has loaded and painted.
  const PROBE = (token, settle) => `(()=>{const T=${JSON.stringify(token)};const R={errors:[],blocked:[],console:[]};
const post=(m)=>{try{parent.postMessage(Object.assign({__auiPreview:T},m),"*")}catch(e){}};
const cut=(s,n)=>{s=String(s);return s.length>n?s.slice(0,n)+"…":s};
addEventListener("error",(e)=>{const t=e.target;if(t&&t!==window&&t.tagName){R.errors.push({kind:"resource",message:"Could not load <"+t.tagName.toLowerCase()+"> "+cut(t.currentSrc||t.src||t.href||"",160)});return}R.errors.push({kind:"script",message:cut(e.message||"Script error",300),line:e.lineno||0,col:e.colno||0})},true);
addEventListener("unhandledrejection",(e)=>{const r=e.reason;R.errors.push({kind:"promise",message:"Unhandled promise rejection: "+cut(r&&r.message||r,300)})});
addEventListener("securitypolicyviolation",(e)=>{if(R.blocked.length<30)R.blocked.push({uri:cut(e.blockedURI||"",200),directive:String(e.effectiveDirective||e.violatedDirective||"")})});
for(const k of ["error","warn"]){const o=console[k];console[k]=function(...a){try{if(R.console.length<20)R.console.push(k+": "+cut(a.map((x)=>{if(typeof x==="string")return x;if(x&&x.message)return x.message;try{return JSON.stringify(x)}catch(_){return String(x)}}).join(" "),300))}catch(_){}return o.apply(this,a)}}
const desc=(el)=>{let s=el.tagName.toLowerCase();if(el.id)s+="#"+el.id;const c=typeof el.className==="string"?el.className.trim().split(/\\s+/).filter(Boolean).slice(0,2):[];if(c.length)s+="."+c.join(".");return s};
const clipped=(el,b)=>{for(let p=el.parentElement;p&&p!==b&&p!==document.documentElement;p=p.parentElement){const o=getComputedStyle(p).overflowX;if(o==="auto"||o==="scroll"||o==="hidden"||o==="clip")return true}return false};
const painted=(el,r)=>{if(r.width<8||r.height<8)return false;const cs=getComputedStyle(el);if(cs.visibility==="hidden"||Number(cs.opacity)===0)return false;const bg=cs.backgroundColor;return(bg&&bg!=="transparent"&&!/rgba\\([^)]*,\\s*0\\)$/.test(bg))||cs.backgroundImage!=="none"||parseFloat(cs.borderTopWidth)>0||parseFloat(cs.borderLeftWidth)>0||cs.boxShadow!=="none"};
const measure=()=>{const de=document.documentElement,b=document.body||de;const W=de.clientWidth;const br=b.getBoundingClientRect();
const height=Math.ceil(Math.max(b.scrollHeight,br.bottom+(parseFloat(getComputedStyle(b).marginBottom)||0)));
const scrollWidth=Math.max(de.scrollWidth,b.scrollWidth);const wide=[];let media=0,box=0,smallTaps=0,noAlt=0,controls=0,unlabeled=0;
const all=b.querySelectorAll("*");for(let i=0;i<all.length&&i<5000;i++){const el=all[i];const r=el.getBoundingClientRect();if(!r.width&&!r.height)continue;const tag=el.tagName;
if((r.right>W+1||r.left<-1)&&!clipped(el,b)&&!wide.some((w)=>w.el.contains(el)))wide.push({el,left:Math.round(r.left),right:Math.round(r.right)});
if(/^(IMG|SVG|CANVAS|VIDEO|PICTURE|svg)$/.test(tag)&&r.width>=2&&r.height>=2)media++;else if(painted(el,r))box++;
if(tag==="IMG"&&!el.hasAttribute("alt"))noAlt++;
if(/^(BUTTON|SELECT|TEXTAREA)$/.test(tag)||(tag==="INPUT"&&el.type!=="hidden")||(tag==="A"&&el.hasAttribute("href"))||el.getAttribute("role")==="button"){controls++;if(r.height<32||r.width<32)smallTaps++;
if(/^(INPUT|SELECT|TEXTAREA)$/.test(tag)&&!el.labels?.length&&!el.getAttribute("aria-label")&&!el.getAttribute("aria-labelledby")&&!el.getAttribute("title")&&!el.getAttribute("placeholder")&&!/^(submit|button|reset)$/.test(el.type))unlabeled++}}
const text=(b.innerText||"").replace(/[ \\t]+/g," ").replace(/\\n\\s*\\n+/g,"\\n").trim();
return{width:W,height,scrollWidth,overflow:Math.max(0,scrollWidth-W),wide:wide.slice(0,5).map((w)=>({what:desc(w.el),left:w.left,right:w.right})),
blank:!text&&!media&&!box||height<4,text:cut(text,1500),textLength:text.length,media,controls,smallTaps,noAlt,unlabeled,errors:R.errors.slice(0,20),blocked:R.blocked,console:R.console}};
let sent=0;const done=()=>{if(sent++)return;try{post({report:measure()})}catch(e){post({report:{fatal:String(e&&e.message||e)},partial:R})}};
addEventListener("load",()=>requestAnimationFrame(()=>setTimeout(done,${settle})));})();`;

  function previewSrcdoc(html, token, appearance) {
    const body = String(html);
    const vars = widgetVars(appearance);
    const rootStyle = Object.entries(vars).filter(([, v]) => v).map(([k, v]) => `${k}:${v}`).join(';');
    const probe = `\x3cscript>${PROBE(token, SETTLE_MS)}<\/script>`;
    const head = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${WIDGET_CSP}">${probe}<style>${WIDGET_BASE_CSS}</style>\x3cscript>${WIDGET_BRIDGE}<\/script>`;
    const dark = appearance === 'dark';
    const full = /<html[\s>]/i.test(body);
    let out; let prefix;
    if (full) {
      const withClass = body.replace(/<html([^>]*)>/i, (m, attrs) => `<html${attrs} data-theme="${appearance}"${dark ? ' class="dark"' : ''} style="${rootStyle}">`);
      const m = /<head[^>]*>/i.exec(withClass);
      out = m ? withClass.slice(0, m.index + m[0].length) + head + withClass.slice(m.index + m[0].length) : withClass.replace(/<html[^>]*>/i, (x) => `${x}<head>${head}</head>`);
      prefix = head;
    } else {
      prefix = `<!doctype html><html class="${dark ? 'dark' : ''}" data-theme="${appearance}" style="${rootStyle}"><head>${head}</head><body>`;
      out = `${prefix}${body}</body></html>`;
    }
    return { srcdoc: out, lineOffset: (prefix.match(/\n/g) || []).length };
  }

  let previewSeq = 0;
  function previewHost(width) {
    // Fixed at the top-left at (almost) zero opacity: browsers stop timers and
    // animation frames in frames outside the viewport, so it has to be "on screen".
    return h('div', {
      class: 'wt-preview-host', 'aria-hidden': 'true', inert: '',
      style: { position: 'fixed', left: '0', top: '0', width: `${width}px`, height: '1px', overflow: 'hidden', opacity: '0.01', pointerEvents: 'none', zIndex: '-1', contain: 'strict' },
    });
  }

  function previewHtml(html, { width, appearance }) {
    return new Promise((resolve) => {
      const token = `pv${Date.now().toString(36)}${++previewSeq}`;
      const { srcdoc, lineOffset } = previewSrcdoc(html, token, appearance);
      const host = previewHost(width);
      const frame = h('iframe', { sandbox: 'allow-scripts', referrerpolicy: 'no-referrer', tabindex: '-1', title: 'Widget preview', style: { width: `${width}px`, height: '800px', border: '0', display: 'block' } });
      let finished = false;
      const finish = (report, timedOut) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        removeEventListener('message', onMessage);
        host.remove();
        resolve(summarizeHtml(report, { width, appearance, timedOut, lineOffset }));
      };
      const onMessage = (e) => {
        const d = e.data;
        if (!d || d.__auiPreview !== token || e.source !== frame.contentWindow) return;
        finish(d.report || {}, false);
      };
      addEventListener('message', onMessage);
      const timer = setTimeout(() => finish(null, true), PREVIEW_TIMEOUT);
      frame.srcdoc = srcdoc;
      host.append(frame);
      doc.body.append(host);
    });
  }

  function summarizeHtml(r, { width, appearance, timedOut, lineOffset }) {
    const problems = []; const notes = [];
    if (timedOut || !r) {
      problems.push(`It did not finish loading within ${PREVIEW_TIMEOUT / 1000} s: a script may be stuck in a loop, or the page never fired "load".`);
      return { kind: 'html', width, appearance, problems, notes, height: 0, text: '', report: null };
    }
    if (r.fatal) problems.push(`The preview could not measure the page: ${r.fatal}`);
    for (const e of r.errors || []) {
      if (e.kind === 'script') {
        const line = e.line ? e.line - lineOffset : 0;
        problems.push(`Script error: ${e.message}${line > 0 ? ` (line ${line} of your HTML)` : ''}`);
      } else problems.push(e.message);
    }
    const blocked = new Map();
    for (const b of r.blocked || []) { const k = `${b.directive}|${b.uri}`; if (!blocked.has(k)) blocked.set(k, b); }
    for (const b of [...blocked.values()].slice(0, 8)) {
      const what = b.uri === 'inline' ? 'an inline resource' : b.uri === 'eval' ? 'eval()/new Function()' : b.uri || 'a request';
      problems.push(`Blocked by the sandbox (${b.directive || 'policy'}): ${what}. Widgets have no network: inline it, use a data: URL or inline SVG.`);
    }
    if (r.blank) problems.push('Blank: nothing visible was drawn (no text, images or painted boxes).');
    if (r.overflow > 1) {
      const widest = (r.wide || []).map((w) => `${w.what} (${w.left}–${w.right} px)`).join(', ');
      problems.push(`Sideways overflow: the content is ${r.scrollWidth} px wide in a ${width} px frame${widest ? `; too wide: ${widest}` : ''}. Use max-width:100%, flex-wrap, min-width:0 or overflow-x:auto on that part.`);
    } else if (r.wide?.length) {
      notes.push(`Content sticks out of the frame and is cut off: ${r.wide.map((w) => w.what).join(', ')}.`);
    }
    if (r.height > 640) notes.push(`It is ${r.height} px tall; the chat frame stops at 640 px and scrolls inside. Make it more compact if it should fit.`);
    if (r.smallTaps) notes.push(`${plural(r.smallTaps, 'control')} smaller than 32 px: hard to tap on a phone (aim for 44 px).`);
    if (r.noAlt) notes.push(`${plural(r.noAlt, 'image')} without alt text.`);
    if (r.unlabeled) notes.push(`${plural(r.unlabeled, 'input')} without a label.`);
    for (const c of r.console || []) notes.push(`console ${c}`);
    return { kind: 'html', width, appearance, problems, notes, height: r.height || 0, text: r.text || '', report: r };
  }

  /* ---------- preview: a spec drawn by the app's own renderer, offscreen ---------- */
  async function previewSpec(spec, { width, appearance, title, issues = [], patchErrors = [] }) {
    const host = previewHost(width);
    host.style.height = 'auto';
    host.style.maxHeight = '1px';
    const dark = appearance === 'dark';
    for (const [k, val] of Object.entries(tokens(appearance))) host.style.setProperty(k, val);
    host.style.colorScheme = appearance;
    host.style.color = 'var(--foreground)';
    if (dark) host.classList.add('dark');
    const inner = h('div', { class: 'wt-preview-inner', style: { width: `${width}px` } });
    host.append(inner);
    if (!isObj(spec.state)) spec.state = {};
    if (!isObj(spec.elements)) spec.elements = {};
    const v = new GenUI.Version({ id: `preview-${++previewSeq}`, key: `preview|${previewSeq}`, title: title || 'preview', tool: 'render_spec', spec, issues, patchErrors, number: 1 });
    v.userPaths = new Set();
    doc.body.append(host);
    let report;
    try {
      inner.append(v.card());
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, SETTLE_MS))));
      report = measureDom(inner, width);
    } catch (e) {
      report = { fatal: String(e?.message || e) };
    } finally { host.remove(); }
    const problems = []; const notes = [];
    if (report.fatal) problems.push(`It could not be drawn: ${report.fatal}`);
    if (GenUI.isFatal(v)) problems.push(`Nothing to draw: the root "${String(spec.root || '')}" is not an element of the spec.`);
    for (const e of patchErrors.slice(0, 12)) problems.push(`Patch line ${e.line} skipped: ${e.message}`);
    const errs = issues.filter((i) => i.level === 'error'); const warns = issues.filter((i) => i.level !== 'error');
    for (const i of errs.slice(0, 15)) problems.push(`${i.path ? `${i.path}: ` : ''}${i.message}${i.fix ? ` Fix: ${i.fix}` : ''}`);
    for (const i of warns.slice(0, 10)) notes.push(`${i.path ? `${i.path}: ` : ''}${i.message}${i.fix ? ` Fix: ${i.fix}` : ''}`);
    for (const e of [...new Set(v.runtimeErrors)].slice(0, 10)) problems.push(`While drawing: ${e}`);
    if (!report.fatal) {
      if (report.blank) problems.push('Blank: nothing visible was drawn.');
      if (report.overflow > 1) problems.push(`Sideways overflow: ${report.scrollWidth} px wide in a ${width} px frame${report.wide.length ? `; too wide: ${report.wide.map((w) => `${w.what} (${w.left}–${w.right} px)`).join(', ')}` : ''}.`);
      if (report.remote) notes.push(`${plural(report.remote, 'image')} or map tile${report.remote === 1 ? '' : 's'} load from the network when shown.`);
    }
    return { kind: 'spec', width, appearance, problems, notes, height: report.height || 0, text: report.text || '', report };
  }

  function measureDom(root, width) {
    const base = root.getBoundingClientRect();
    const wide = [];
    let media = 0; let remote = 0;
    const all = root.querySelectorAll('*');
    const scrolls = (el) => { for (let p = el.parentElement; p && p !== root; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden' || o === 'clip') return true; } return false; };
    for (let i = 0; i < all.length && i < 5000; i++) {
      const el = all[i];
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      if ((r.right - base.left > width + 1 || r.left - base.left < -1) && !scrolls(el) && !wide.some((w) => w.el.contains(el))) wide.push({ el, left: Math.round(r.left - base.left), right: Math.round(r.right - base.left) });
      if (/^(IMG|CANVAS|VIDEO|svg)$/.test(el.tagName) && r.width >= 2 && r.height >= 2) media++;
      if (el.tagName === 'IMG' && /^https:/i.test(el.getAttribute('src') || '')) remote++;
    }
    const desc = (el) => { let s = el.tagName.toLowerCase(); const c = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : []; if (c.length) s += `.${c.join('.')}`; return s; };
    const text = (root.innerText || '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
    const scrollWidth = Math.max(root.scrollWidth, ...wide.map((w) => w.right));
    return { height: Math.ceil(base.height), scrollWidth, overflow: Math.max(0, scrollWidth - width), wide: wide.slice(0, 5).map((w) => ({ what: desc(w.el), left: w.left, right: w.right })), blank: !text && !media, text: text.length > 1500 ? `${text.slice(0, 1500)}…` : text, media, remote };
  }

  function reportText(r, label) {
    const lines = [`Preview of ${label} at ${r.width} px wide, ${r.appearance} theme (not shown to the user).`];
    lines.push(r.problems.length ? `${plural(r.problems.length, 'problem')} to fix:` : 'No problems: no errors, nothing blocked, not blank, no sideways overflow.');
    for (const p of r.problems) lines.push(`- ${p}`);
    if (r.notes.length) { lines.push('Notes:'); for (const n of r.notes.slice(0, 12)) lines.push(`- ${n}`); }
    if (r.height) lines.push(`Height: ${r.height} px.`);
    lines.push(r.text ? `Visible text:\n${r.text}` : 'Visible text: none.');
    return lines.join('\n');
  }

  async function previewExecute(args, ctx) {
    const a = isObj(args) ? args : {};
    const width = Math.round(clamp(Number(a.width) || 320, 240, 1600));
    const appearance = a.appearance === 'dark' || a.appearance === 'light' ? a.appearance : a.theme === 'dark' || a.theme === 'light' ? a.theme : currentTheme();
    const html = typeof a.html === 'string' ? a.html : typeof a.code === 'string' ? a.code : null;
    const patches = a.patches ?? a.jsonl ?? a.ops;
    const title = String(a.title || '').trim();
    if (html != null) {
      if (!html.trim()) throw new Error('html is empty.');
      if (html.length > MAX_CODE) throw new Error(`html is ${html.length} characters; the limit is ${MAX_CODE}.`);
      return reportText(await previewHtml(html, { width, appearance }), 'the HTML');
    }
    let base = null; let current = null;
    if (title) {
      const id = String(ctx?.toolCallId || '');
      current = replay(messagesOf(runtimeFor(ctx, id)), id, ctx).get(tkey(title)) || null;
      if (!current && !isObj(a.spec) && !isObj(a.tree) && patches == null) throw new Error(`No widget titled "${title}" is shown in this chat. Pass html, spec or patches to preview new code.`);
    }
    if (current?.kind === 'html' && !isObj(a.spec) && patches == null) return reportText(await previewHtml(current.html, { width, appearance }), `"${current.title}" (version ${current.number})`);
    if (isObj(a.tree) || a.tree != null) {
      const r = C.treeToSpec(a.tree);
      return reportText(await previewSpec(r.spec, { width, appearance, title, issues: r.issues }), 'the present tree');
    }
    if (isObj(a.spec)) base = C.clone(a.spec);
    else if (current?.kind === 'spec') base = C.clone(current.version.spec);
    if (patches == null && !base) throw new Error('Pass one of: html (an HTML widget), spec or patches (a render_spec UI), tree (a present tree), or the title of a widget already shown.');
    if (base && !isObj(base.state)) base.state = {};
    const r = patches != null && patches !== '' ? C.applyPatches(base, patches) : { spec: base, errors: [] };
    const issues = C.validateSpec(r.spec).issues;
    const label = current?.kind === 'spec' ? `"${current.title}"${patches != null ? ' with your patches' : ` (version ${current.number})`}` : 'the spec';
    return reportText(await previewSpec(r.spec, { width, appearance, title, issues, patchErrors: r.errors }), label);
  }

  function previewCard(part, status) {
    const running = status?.type === 'running' || part.result === undefined;
    const failed = !!part.isError;
    const a = isObj(part.args) ? part.args : {};
    const what = typeof a.html === 'string' ? 'HTML widget' : a.title ? String(a.title).replace(/[_-]+/g, ' ') : 'UI';
    const text = typeof part.result === 'string' ? part.result : '';
    const count = /^(\d+) problems? to fix/m.exec(text);
    const label = running ? `Checking the ${what}…` : failed ? `Could not check the ${what}` : count ? `Checked the ${what}: ${plural(Number(count[1]), 'problem')} found` : `Checked the ${what}: looks good`;
    return h('div', { class: 'wt-check', 'data-state': running ? 'running' : failed ? 'failed' : count ? 'issues' : 'ok', role: 'status' },
      icon(running ? 'loader' : failed || count ? 'circle-exclamation-point' : 'circle-check'), h('span', {}, label));
  }

  /* ---------- tools ---------- */
  const TOOLS = [
    {
      name: 'edit_widget',
      description: 'Change a widget already shown in this chat (show_html, an html show_widget, render_spec or present) by its title, without resending it. `edits` is a list of exact replacements {old_string, new_string} applied in order, all or nothing: each old_string must match exactly one place in the CURRENT code, copied with its whitespace. For render_spec/present the code is the spec as JSON with 2-space indent ({"root","elements","state"}). The new version is drawn at the bottom of the chat and keeps what the user typed; the older card folds. HTML edits come back with a render check (errors, blocked requests, overflow). See read_me(["editing"]).',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'The title of the shown widget (as passed to show_html, render_spec or present, or returned by them).' },
          edits: {
            type: 'array', minItems: 1, maxItems: 50,
            description: 'Replacements, applied in order. Each old_string must occur exactly once in the code at that point.',
            items: { type: 'object', properties: { old_string: { type: 'string', description: 'Exact text to replace (include enough context to be unique).' }, new_string: { type: 'string', description: 'The replacement text (may be empty to delete).' } }, required: ['old_string', 'new_string'] },
          },
        },
        required: ['title', 'edits'],
      },
      execute: editExecute,
    },
    {
      name: 'preview_widget',
      description: 'Render a widget offscreen and get a report WITHOUT showing anything to the user: script errors (with the line in your HTML), requests the sandbox blocked, blank output, height, sideways overflow at the given width, small tap targets, and the visible text. Pass `html` for show_html code, `spec` or `patches` for a render_spec UI (with `title` the patches apply to that shown UI, so you can test a change first), `tree` for present, or only `title` to check a widget already shown. Use it before showing any non-trivial HTML. Defaults: 320 px wide (the narrowest phone), the current theme.',
      inputSchema: {
        type: 'object',
        properties: {
          html: { type: 'string', description: 'HTML widget code to check.' },
          spec: { type: 'object', description: 'A complete render_spec spec to check.' },
          patches: { type: 'string', description: 'render_spec JSONL patches to check (applied to the shown UI with `title`, or to an empty spec).' },
          tree: { description: 'A present tree to check.' },
          title: { type: 'string', description: 'Title of a widget already shown: check it as it is, or with `patches` applied.' },
          width: { type: 'number', description: 'Frame width in px (240–1600, default 320).' },
          appearance: { type: 'string', enum: ['light', 'dark'], description: 'Theme to check in (default: the current theme).' },
        },
      },
      execute: previewExecute,
    },
    {
      name: 'read_me',
      description: `Read the guidance for building UI before you write it: the render_spec format, the component catalog and $calc, present, show_widget, show_html sandbox rules, charts, theme, editing/previewing. Call with no modules for the list. Modules: ${C.MODULE_NAMES.join(', ')}.`,
      inputSchema: { type: 'object', properties: { modules: { type: 'array', items: { type: 'string', enum: C.MODULE_NAMES }, description: 'The modules to read, e.g. ["spec"].' } } },
      execute(args) {
        const m = isObj(args) ? args.modules ?? args.module : undefined;
        return C.readMe(m);
      },
    },
  ];

  function readMeCard(part, status) {
    const mods = Array.isArray(part.args?.modules) ? part.args.modules : [];
    const running = status?.type === 'running' || part.result === undefined;
    return h('div', { class: 'wt-check', 'data-state': running ? 'running' : 'ok', role: 'status' }, icon(running ? 'loader' : 'file-text'),
      h('span', {}, `${running ? 'Reading' : 'Read'} the UI guide${mods.length ? `: ${mods.join(', ')}` : ''}`));
  }

  function install() {
    GenUI.addTools([TOOLS[0]], editCard);
    GenUI.addTools([TOOLS[1]], previewCard);
    GenUI.addTools([TOOLS[2]], readMeCard);
    // HTML widgets from show_html and html show_widget take part in versions:
    // they fold to "updated below" when edit_widget draws a newer one.
    const baseHtml = TOOLKIT.ui__show_html?.ui;
    TOOLKIT.ui__show_html = { ...(TOOLKIT.ui__show_html || {}), ui: (part, status) => {
      const src = htmlSource(part);
      return src ? htmlCardFor(part, src.html, src.title, 1) : baseHtml(part, status);
    } };
    const baseWidget = TOOLKIT.ui__show_widget?.ui;
    TOOLKIT.ui__show_widget = { ...(TOOLKIT.ui__show_widget || {}), ui: (part, status) => {
      const src = htmlSource(part);
      return src ? htmlCardFor(part, src.html, src.title, 1) : baseWidget(part, status);
    } };
    // Give show_html a title in its result so edit_widget can find it.
    const showHtml = UI_TOOLS.find((t) => t.name === 'show_html');
    if (showHtml && !showHtml.__titled) {
      const run = showHtml.execute;
      showHtml.execute = async function (args, ctx) {
        const out = await run.call(this, args, ctx);
        const title = String(args?.title || '').trim() || `html_${String(ctx?.toolCallId || '').slice(-6)}`;
        return `${typeof out === 'string' ? out : 'Shown to the user.'} Its title is "${title}": change it with edit_widget, check it with preview_widget.`;
      };
      if (!/preview_widget/.test(showHtml.description || '')) showHtml.description = `${showHtml.description || ''} Check non-trivial HTML with preview_widget before showing it; change it afterwards with edit_widget by its title.`.trim();
      showHtml.__titled = true;
    }
    addEventListener('aui-theme-tokens', () => { tokenCache = null; });
  }

  return { install, TOOLS, replay, computeEdit, previewHtml, previewSpec, reportText, tokens };
})();
