/*
 * NativeKit PageAgent bootstrap — agent panel v2.
 * Runs at document start (injected together with the vendored PageAgent IIFE).
 * window.__NATIVEKIT_PAGE_AGENT__ is written by the native side immediately
 * before this script; it carries the session relay token, the free-route model
 * name/base URL, the browser theme (dark + accent) and UX flags.
 *
 * Architecture:
 *  - LLM calls never touch page networking: they go through the
 *    NativeKitPageAgent WebMessageListener channel, relayed natively to the
 *    engine's free route (CSP-proof, no secrets in page JS, usage capped).
 *  - HEADLESS CORE + OWN UI: the vendored bundle's demo panel (a floating
 *    card built with innerHTML) is no longer used. We drive PageAgentCore +
 *    PageController directly and render our own panel inside a closed shadow
 *    root, so page CSS can't break it and it can't break the page.
 *  - SESSION CONTINUITY: a real navigation destroys the page; the native
 *    side (PageAgentHost, one session per tab) outlives it. Each step is
 *    written natively BEFORE it runs (so a click that navigates is never
 *    lost) and again with its result. A new page asks for the session back
 *    and, if a run is in progress, waits for the page to settle, puts the
 *    earlier steps back into the agent's own history (so the model sees them
 *    in <agent_history>, step numbers continue) and goes on from the next
 *    step. Plan + notes tools persist across pages too. A per-document owner
 *    lease stops stale pages (bfcache, duplicates) from driving the run.
 *  - ACCURACY: wait for load + DOM quiet + no requests before reading the
 *    page, an Observation of what really changed after every action, a cap
 *    on repeating a failing action, grounding rules in the prompt, and
 *    read_page_text / list_links so answers come from the page.
 *
 * Agent UX (modelled on ChatGPT Atlas agent mode, Perplexity Comet, Gemini in
 * Chrome, Opera Neon and Edge Copilot Mode):
 *  - Bottom sheet on phones, right side panel on wide screens; page stays
 *    visible (no dark scrim) so the user can watch the agent work.
 *  - Page-context chip: the panel always says which page it acts on.
 *  - Contextual starter chips on an empty chat (summarise, key points, fill
 *    a form when the page has one…).
 *  - Each run is a "work card": live status + step counter + elapsed time and
 *    a collapsible step timeline in plain language ("Click “Add to cart”").
 *  - While running: glowing accent border around the page (agent is in
 *    control), Stop and Take over controls instead of the composer, and a
 *    compact floating pill when the sheet is minimised.
 *  - Sensitive clicks (buy, pay, send, delete, submit…) pause for the user's
 *    Allow / Deny; ask_user questions render as an inline reply card.
 *  - Final answer as a proper message with Copy; errors with Retry.
 *  - Theme follows the browser (Light/Dark + accent) live via setTheme().
 *  - CSP / Trusted Types safe: DOM API only (no innerHTML), constructable
 *    stylesheet in the shadow root (falls back to a <style> element).
 */
(function () {
  'use strict';
  if (window.__nativekitPageAgentBooted) return;
  // Main frame only: an agent per iframe would mean several drivers per tab.
  try { if (window.top !== window) return; } catch (e) { return; }
  var cfg = window.__NATIVEKIT_PAGE_AGENT__;
  if (!cfg || typeof cfg !== 'object' || !window.PageAgentCore || !window.PageAgentController) return;
  var bridge = window[cfg.bridge || 'NativeKitPageAgent'];
  if (!bridge || typeof bridge.postMessage !== 'function') return;
  window.__nativekitPageAgentBooted = true;

  // ---------- relay (LLM) + state channel to the native side -------------
  var pending = Object.create(null);
  var seq = 0;

  function send(payload) {
    try { bridge.postMessage(JSON.stringify(payload)); } catch (error) { /* best effort */ }
  }

  bridge.onmessage = function (event) {
    var data = event && event.data;
    if (typeof data !== 'string') return;
    try { data = JSON.parse(data); } catch (error) { return; }
    if (!data) return;
    if (data.kind === 'state-resp') { onRestored(data); return; }
    if (data.kind === 'evict') { onEvicted(data); return; }
    if (typeof data.id !== 'string') return;
    var entry = pending[data.id];
    if (!entry) return;
    delete pending[data.id];
    clearTimeout(entry.timer);
    if (data.ok) entry.resolve({ status: data.status | 0, body: typeof data.body === 'string' ? data.body : '' });
    else entry.reject(new Error(String(data.error || 'NativeKit relay failed')));
  };

  function sanitizeWireRequest(bodyStr) {
    try {
      var body = JSON.parse(bodyStr);
      var changed = false;
      var disallowed = ["parallel_tool_calls","thinking","enable_thinking","reasoning","reasoning_effort","verbosity","temperature","top_p","top_k","top_logprobs","logprobs","logit_bias","store","metadata","safety_identifier","prompt_cache_key","max_tokens","max_completion_tokens","n","presence_penalty","frequency_penalty","stop","stream_options","service_tier","seed"];
      for (var i=0;i<disallowed.length;i++) {
        var k = disallowed[i];
        if (k in body) { delete body[k]; changed = true; }
      }
      for (var key in body) {
        if (key.indexOf("reasoning_")===0 || key.indexOf("thinking_")===0) { delete body[key]; changed = true; }
      }
      if (body.model && body.model !== cfg.model) { body.model = cfg.model; changed = true; }
      if (body.tool_choice) {
        if (typeof body.tool_choice === "string" && (body.tool_choice === "required" || body.tool_choice.indexOf("function")>=0)) {
          body.tool_choice = "auto"; changed = true;
        } else if (typeof body.tool_choice === "object") {
          body.tool_choice = "auto"; changed = true;
        }
      }
      if (body.response_format) {
        try {
          if (body.response_format.type && body.response_format.type.indexOf("json_schema")>=0) { delete body.response_format; changed = true; }
          else if (body.response_format.json_schema) { delete body.response_format; changed = true; }
        } catch(e) { delete body.response_format; changed = true; }
      }
      if (Array.isArray(body.tools)) {
        for (var t=0;t<body.tools.length;t++) {
          var tool = body.tools[t];
          if (tool && tool.function && tool.function.strict) { delete tool.function.strict; changed = true; }
        }
      }
      if (Array.isArray(body.messages)) {
        for (var m=0;m<body.messages.length;m++) {
          var msg = body.messages[m];
          if (msg && msg.name) {
            if (!/^[a-zA-Z0-9_-]{1,64}$/.test(msg.name)) { delete msg.name; changed = true; }
          }
          if (msg && msg.cache_control) { delete msg.cache_control; changed = true; }
        }
      }
      return changed ? JSON.stringify(body) : bodyStr;
    } catch(e) { return bodyStr; }
  }

  function relayFetch(url, init) {
    return new Promise(function (resolve, reject) {
      var id = 'nk' + (++seq);
      var timer = setTimeout(function () {
        delete pending[id];
        reject(new Error('NativeKit LLM relay timed out'));
      }, 150000);
      pending[id] = { resolve: resolve, reject: reject, timer: timer };
      var rawBody = init && init.body ? String(init.body) : '';
      var cleanBody = sanitizeWireRequest(rawBody);
      send({
        v: 1, kind: 'llm', token: cfg.token, id: id,
        url: String(url),
        body: cleanBody,
      });
    });
  }

  // ---------- task session (kept natively, survives page loads) -----------
  // pid: this document. runId: the task run it is part of. Native only lets
  // the current owner page write to a run (see PageAgentHost).
  var pid = 'p' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  var runId = '';
  var hydrated = [];      // step records done on earlier pages of this run
  var seqBase = 0;        // earlier steps folded into a summary (not in history)
  var plan = '', notes = '';
  var quiet = false;      // true while a stale page stops without writing
  var finalSent = 0;      // highest step seq already finalised natively

  var LIMITS = { task: 2000, status: 40, result: 6000, plan: 4000, notes: 6000 };
  function sendState(patch) {
    if (quiet) return;
    var payload = { v: 1, kind: 'state', token: cfg.token, pid: pid, runId: runId };
    for (var key in LIMITS) {
      if (patch && key in patch) payload[key] = String(patch[key] || '').slice(0, LIMITS[key]);
    }
    send(payload);
  }

  function sendStep(seq, record) {
    if (quiet || !runId || seq < 1) return;
    var body;
    try { body = JSON.stringify(record); } catch (e) { return; }
    if (body.length > 7800) {
      record.output = String(record.output || '').slice(0, 1200);
      record.input = {};
      body = JSON.stringify(record);
    }
    send({ v: 1, kind: 'step', token: cfg.token, pid: pid, runId: runId, seq: seq, step: body });
  }

  function requestRestore() {
    send({ v: 1, kind: 'restore', token: cfg.token, pid: pid });
  }

  // Finalise every finished step of this page natively (result + reflection).
  function syncSteps() {
    if (!agent || !runId) return;
    var steps = (agent.history || []).filter(function (h) { return h && h.type === 'step'; });
    steps.forEach(function (item, i) {
      if (item.nkHydrated) return;
      var seq = seqBase + i + 1;
      if (seq <= finalSent) return;
      finalSent = seq;
      sendStep(seq, recordFromStep(item, seq));
    });
  }

  function recordFromStep(item, seq) {
    var r = item.reflection || {};
    var act = item.action || {};
    var extra = (act.input && typeof act.input === 'object' && meta.get(act.input)) || {};
    return {
      seq: seq,
      url: extra.url || location.href,
      title: extra.title || String(document.title || '').slice(0, 120),
      label: extra.label || '',
      eval: String(r.evaluation_previous_goal || '').slice(0, 400),
      memory: String(r.memory || '').slice(0, 800),
      goal: String(r.next_goal || '').slice(0, 300),
      tool: String(act.name || ''),
      input: compactInput(act.input),
      output: String(act.output == null ? '' : act.output).slice(0, 1500),
      pending: false,
      ts: Date.now(),
    };
  }

  function compactInput(input) {
    var out = {};
    if (!input || typeof input !== 'object') return out;
    for (var k in input) {
      var v = input[k];
      if (typeof v === 'string') out[k] = v.slice(0, 400);
      else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    }
    return out;
  }

  // ---------- theme ----------------------------------------------------------
  var theme = {
    dark: cfg.dark !== false,
    accent: /^#[0-9a-fA-F]{6}$/.test(String(cfg.accent || '')) ? cfg.accent : '#60A5FA',
  };

  function themeVars() {
    var d = theme.dark;
    return {
      '--nk-accent': theme.accent,
      '--nk-accent-soft': hexAlpha(theme.accent, d ? 0.18 : 0.12),
      '--nk-bg': d ? '#16181d' : '#ffffff',
      '--nk-surface': d ? '#20232a' : '#f3f4f7',
      '--nk-surface2': d ? '#2a2e37' : '#e8eaf0',
      '--nk-text': d ? '#eceff4' : '#111827',
      '--nk-muted': d ? '#9ca3af' : '#646c7a',
      '--nk-border': d ? '#333842' : '#e1e4ea',
      '--nk-danger': d ? '#f87171' : '#dc2626',
      '--nk-success': d ? '#4ade80' : '#16a34a',
      '--nk-shadow': d ? '0 -10px 40px rgba(0,0,0,.55)' : '0 -10px 40px rgba(15,23,42,.18)',
    };
  }

  function hexAlpha(hex, a) {
    var n = parseInt(String(hex).slice(1), 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  function paintTheme() {
    if (!host) return;
    var vars = themeVars();
    for (var key in vars) host.style.setProperty(key, vars[key]);
    if (glow) glow.style.setProperty('--nk-accent', theme.accent);
  }

  // ---------- styles (inside the shadow root only) --------------------------
  var CSS = [
    ':host{all:initial}',
    '*{box-sizing:border-box;margin:0;padding:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-tap-highlight-color:transparent}',
    'button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}',
    'svg{display:block}',
    // sheet
    '.sheet{position:fixed;left:0;right:0;bottom:0;height:min(68vh,620px);display:flex;flex-direction:column;background:var(--nk-bg);color:var(--nk-text);border-radius:20px 20px 0 0;box-shadow:var(--nk-shadow);border:1px solid var(--nk-border);border-bottom:0;transform:translateY(105%);transition:transform .28s cubic-bezier(.22,.7,.28,1),height .22s ease;pointer-events:auto;font-size:14px;line-height:1.45}',
    '.sheet.open{transform:translateY(0)}',
    '.sheet.full{height:calc(100vh - 24px)}',
    '@media (min-width:720px){.sheet{left:auto;top:0;height:100vh!important;width:400px;border-radius:18px 0 0 18px;border:1px solid var(--nk-border);border-right:0;transform:translateX(105%)}.sheet.open{transform:translateX(0)}.grab{display:none!important}}',
    '.grab{display:flex;justify-content:center;padding:8px 0 2px;touch-action:none;cursor:grab}',
    '.grab i{width:38px;height:4px;border-radius:4px;background:var(--nk-border)}',
    // header
    '.head{display:flex;align-items:center;gap:8px;padding:4px 10px 8px 14px}',
    '.logo{width:28px;height:28px;border-radius:9px;display:flex;align-items:center;justify-content:center;background:var(--nk-accent-soft);color:var(--nk-accent);flex:none}',
    '.titles{flex:1;min-width:0}',
    '.title{font-weight:650;font-size:15px}',
    '.ctx{display:flex;align-items:center;gap:6px;max-width:100%;margin-top:1px;color:var(--nk-muted);font-size:12px;white-space:nowrap;overflow:hidden}',
    '.ctx .fav{width:14px;height:14px;border-radius:4px;background:var(--nk-surface2);display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;color:var(--nk-text);flex:none}',
    '.ctx span{overflow:hidden;text-overflow:ellipsis}',
    '.icon{width:36px;height:36px;border-radius:12px;display:flex;align-items:center;justify-content:center;color:var(--nk-muted)}',
    '.icon:active,.icon:hover{background:var(--nk-surface)}',
    // body
    '.body{flex:1;overflow-y:auto;padding:4px 14px 12px;overscroll-behavior:contain}',
    '.empty{padding:18px 4px 8px}',
    '.hello{font-size:20px;font-weight:650;letter-spacing:-.01em}',
    '.sub{color:var(--nk-muted);margin:4px 0 16px}',
    '.chips{display:flex;flex-wrap:wrap;gap:8px}',
    '.chip{padding:8px 12px;border-radius:999px;background:var(--nk-surface);border:1px solid var(--nk-border);font-size:13px;text-align:left}',
    '.chip:active{background:var(--nk-surface2)}',
    '.msg{margin:12px 0}',
    '.user{display:flex;justify-content:flex-end}',
    '.user p{max-width:85%;background:var(--nk-accent);color:#fff;padding:9px 13px;border-radius:18px 18px 4px 18px;white-space:pre-wrap;word-break:break-word}',
    '.answer{background:var(--nk-surface);border:1px solid var(--nk-border);padding:11px 13px;border-radius:4px 18px 18px 18px;white-space:pre-wrap;word-break:break-word}',
    '.answer.err{border-color:var(--nk-danger)}',
    '.row{display:flex;gap:6px;margin-top:6px}',
    '.mini{font-size:12px;color:var(--nk-muted);padding:5px 10px;border-radius:999px;border:1px solid var(--nk-border)}',
    '.mini:active{background:var(--nk-surface)}',
    // work card
    '.work{border:1px solid var(--nk-border);border-radius:16px;overflow:hidden;background:var(--nk-bg)}',
    '.whead{display:flex;align-items:center;gap:10px;width:100%;padding:10px 12px;text-align:left}',
    '.wstate{flex:1;min-width:0}',
    '.wtitle{font-weight:600;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.wmeta{font-size:12px;color:var(--nk-muted)}',
    '.chev{color:var(--nk-muted);transition:transform .2s}',
    '.work.closed .chev{transform:rotate(-90deg)}',
    '.work.closed .steps{display:none}',
    '.steps{list-style:none;padding:2px 12px 10px 12px;border-top:1px solid var(--nk-border)}',
    '.step{position:relative;display:flex;gap:10px;padding:8px 0 0}',
    '.dot{flex:none;width:18px;height:18px;margin-top:1px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:var(--nk-surface2);color:var(--nk-muted)}',
    '.step.done .dot{background:var(--nk-accent-soft);color:var(--nk-accent)}',
    '.step.live .dot{background:var(--nk-accent);color:#fff;animation:nkpulse 1.4s ease-in-out infinite}',
    '.step.bad .dot{background:transparent;color:var(--nk-danger);border:1.5px solid var(--nk-danger)}',
    '.stext{min-width:0;flex:1}',
    '.sgoal{font-size:13px;word-break:break-word}',
    '.sact{display:inline-block;margin-top:3px;font-size:11.5px;color:var(--nk-muted);background:var(--nk-surface);border-radius:6px;padding:1px 7px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.earlier{font-size:11.5px;color:var(--nk-muted);padding:8px 0 0 28px}',
    '@keyframes nkpulse{0%,100%{box-shadow:0 0 0 0 var(--nk-accent-soft)}50%{box-shadow:0 0 0 6px var(--nk-accent-soft)}}',
    '.spin{width:18px;height:18px;border-radius:50%;border:2.5px solid var(--nk-accent-soft);border-top-color:var(--nk-accent);animation:nkspin .8s linear infinite;flex:none}',
    '@keyframes nkspin{to{transform:rotate(360deg)}}',
    '.badge{width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex:none;color:#fff}',
    '.badge.ok{background:var(--nk-success)}.badge.no{background:var(--nk-danger)}.badge.stop{background:var(--nk-muted)}',
    // ask / confirm cards
    '.card{margin:12px 0;border:1.5px solid var(--nk-accent);background:var(--nk-accent-soft);border-radius:16px;padding:12px}',
    '.card h4{font-size:12px;font-weight:650;color:var(--nk-accent);text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px}',
    '.card p{word-break:break-word}',
    '.card .row{margin-top:10px}',
    '.btn{padding:8px 16px;border-radius:999px;font-weight:600;font-size:13px}',
    '.btn.primary{background:var(--nk-accent);color:#fff}',
    '.btn.ghost{border:1px solid var(--nk-border);background:var(--nk-bg)}',
    '.btn.danger{background:var(--nk-danger);color:#fff}',
    '.reply{display:flex;gap:6px;margin-top:10px}',
    '.reply input{flex:1;min-width:0;padding:9px 12px;border-radius:12px;border:1px solid var(--nk-border);background:var(--nk-bg);color:var(--nk-text);font:inherit;outline:none}',
    '.reply input:focus{border-color:var(--nk-accent)}',
    // footer: composer / run controls
    '.foot{padding:8px 12px calc(10px + env(safe-area-inset-bottom));border-top:1px solid var(--nk-border);background:var(--nk-bg)}',
    '.live{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--nk-muted);margin:0 2px 8px;min-height:18px}',
    '.live b{color:var(--nk-text);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.ctrl{display:flex;gap:8px}',
    '.ctrl .btn{flex:1;padding:11px 0}',
    '.box{display:flex;align-items:flex-end;gap:8px;background:var(--nk-surface);border:1px solid var(--nk-border);border-radius:22px;padding:6px 6px 6px 14px}',
    '.box:focus-within{border-color:var(--nk-accent)}',
    '.box textarea{flex:1;min-width:0;resize:none;border:0;outline:none;background:transparent;color:var(--nk-text);font:inherit;font-size:15px;line-height:1.4;max-height:120px;padding:6px 0}',
    '.box textarea::placeholder{color:var(--nk-muted)}',
    '.send{width:36px;height:36px;border-radius:50%;background:var(--nk-accent);color:#fff;display:flex;align-items:center;justify-content:center;flex:none}',
    '.send:disabled{background:var(--nk-surface2);color:var(--nk-muted)}',
    '.note{font-size:11px;color:var(--nk-muted);text-align:center;margin-top:6px}',
    // floating pill (minimised while running) and launcher
    '.pill{position:fixed;left:50%;bottom:calc(16px + env(safe-area-inset-bottom));transform:translate(-50%,140%);display:flex;align-items:center;gap:10px;max-width:min(92vw,460px);padding:8px 8px 8px 12px;border-radius:999px;background:var(--nk-bg);color:var(--nk-text);border:1px solid var(--nk-border);box-shadow:0 8px 28px rgba(0,0,0,.28);transition:transform .25s ease;pointer-events:auto;font-size:13px}',
    '.pill.show{transform:translate(-50%,0)}',
    '.pill .ptext{min-width:0;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}',
    '.pill .btn{padding:6px 12px}',
    '.fab{position:fixed;right:14px;bottom:calc(88px + env(safe-area-inset-bottom));width:46px;height:46px;border-radius:50%;background:var(--nk-bg);color:var(--nk-accent);border:1px solid var(--nk-border);box-shadow:0 6px 20px rgba(0,0,0,.25);display:none;align-items:center;justify-content:center;pointer-events:auto;touch-action:none}',
    '.fab.show{display:flex}',
    '.fab .ping{position:absolute;top:3px;right:3px;width:10px;height:10px;border-radius:50%;background:var(--nk-accent);border:2px solid var(--nk-bg);display:none}',
    '.fab.unread .ping{display:block}',
  ].join('\n');

  // ---------- tiny DOM helpers (Trusted-Types safe) --------------------------
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = String(text);
    return node;
  }

  var ICONS = {
    spark: 'M12 2l1.9 5.6L19.5 9.5l-5.6 1.9L12 17l-1.9-5.6L4.5 9.5l5.6-1.9z M19 15l.8 2.2 2.2.8-2.2.8L19 21l-.8-2.2-2.2-.8 2.2-.8z',
    close: 'M6 6l12 12M18 6L6 18',
    up: 'M12 19V5M5 12l7-7 7 7',
    chev: 'M6 9l6 6 6-6',
    check: 'M5 12.5l4.5 4.5L19 7.5',
    x: 'M7 7l10 10M17 7L7 17',
    stop: 'M8 8h8v8H8z',
    plus: 'M12 5v14M5 12h14',
    expand: 'M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5',
    min: 'M6 15l6-6 6 6',
  };

  function icon(name, size) {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    var s = String(size || 18);
    svg.setAttribute('width', s);
    svg.setAttribute('height', s);
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', name === 'spark' || name === 'stop' ? 'currentColor' : 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', name === 'spark' ? '0' : '2.2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    var path = document.createElementNS(ns, 'path');
    path.setAttribute('d', ICONS[name] || '');
    svg.appendChild(path);
    return svg;
  }

  function iconButton(name, label, onClick, cls) {
    var b = el('button', cls || 'icon');
    b.type = 'button';
    b.setAttribute('aria-label', label);
    b.title = label;
    b.appendChild(icon(name));
    b.addEventListener('click', function (e) { e.stopPropagation(); onClick(e); });
    return b;
  }

  function textButton(label, cls, onClick) {
    var b = el('button', 'btn ' + cls, label);
    b.type = 'button';
    b.addEventListener('click', function (e) { e.stopPropagation(); onClick(e); });
    return b;
  }

  function hostName() {
    try { return location.hostname.replace(/^www\./, ''); } catch (e) { return ''; }
  }

  // ---------- agent lifecycle -------------------------------------------------
  var agent = null;
  var MAX_TOTAL_STEPS = 50;          // across all pages of one run
  var meta = new WeakMap();          // action input -> { label, url, title }
  var lastReflection = {};           // model output of the step being executed
  var fails = Object.create(null);   // same failing action -> count

  // Network-activity counter, so "settled" can mean "no requests in flight".
  var inflight = 0;
  (function trackNetwork() {
    try {
      var origFetch = window.fetch;
      if (typeof origFetch === 'function') {
        window.fetch = function () {
          inflight += 1;
          var done = function () { inflight = Math.max(0, inflight - 1); };
          try {
            var p = origFetch.apply(this, arguments);
            p.then(done, done);
            return p;
          } catch (e) { done(); throw e; }
        };
      }
      var XHR = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
      if (XHR && XHR.send) {
        var origSend = XHR.send;
        XHR.send = function () {
          inflight += 1;
          var counted = true;
          this.addEventListener('loadend', function () { if (counted) { counted = false; inflight = Math.max(0, inflight - 1); } });
          return origSend.apply(this, arguments);
        };
      }
    } catch (e) { /* tracking is best effort */ }
  })();

  function ours(node) {
    try {
      var n = node && node.nodeType === 1 ? node : node && node.parentElement;
      if (!n) return false;
      if (n === host || n === glow) return true;
      if (n.closest && n.closest('[data-page-agent-ignore]')) return true;
      var mask = agent && agent.pageController && agent.pageController.mask;
      return !!(mask && mask.wrapper && mask.wrapper.contains(n));
    } catch (e) { return false; }
  }

  // Resolve once the page is loaded, the DOM has been quiet for 450 ms and no
  // requests are in flight — or after maxMs, whichever comes first.
  function settle(signal, maxMs) {
    return new Promise(function (resolve) {
      var start = Date.now();
      var last = Date.now();
      var mo = null;
      try {
        mo = new MutationObserver(function (records) {
          for (var i = 0; i < records.length; i += 1) {
            if (!ours(records[i].target)) { last = Date.now(); return; }
          }
        });
        mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      } catch (e) { mo = null; }
      (function tick() {
        var calm = Date.now() - last >= 450 && document.readyState === 'complete' && inflight <= 0;
        if (calm || Date.now() - start >= maxMs || (signal && signal.aborted)) {
          if (mo) mo.disconnect();
          resolve();
          return;
        }
        setTimeout(tick, 120);
      })();
    });
  }

  function hashText(text) {
    var h = 0;
    for (var i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(i)) | 0;
    return h;
  }

  function pageSignature() {
    try {
      var body = document.body;
      if (!body) return '';
      var text = body.innerText || '';
      return document.getElementsByTagName('*').length + ':' + text.length + ':' + hashText(text.slice(0, 20000));
    } catch (e) { return ''; }
  }

  function elementAt(target, index) {
    try {
      var entry = target.pageController.selectorMap.get(index);
      return entry && entry.ref ? entry.ref : null;
    } catch (e) { return null; }
  }

  function snapshot(target, input) {
    var node = input && typeof input.index === 'number' ? elementAt(target, input.index) : null;
    return {
      url: location.href,
      title: document.title,
      sig: pageSignature(),
      y: window.scrollY || 0,
      node: node,
      href: node && node.closest && node.closest('a[href]') ? node.closest('a[href]').href : '',
    };
  }

  // What actually happened after an action, fed back to the model with the
  // tool result so it reasons from evidence, not from what it hoped for.
  function observe(before, name, input) {
    var notes = [];
    var urlChanged = location.href !== before.url;
    if (urlChanged) notes.push('URL changed to ' + location.href);
    else if (document.title !== before.title) notes.push('page title changed to "' + String(document.title).slice(0, 80) + '"');
    var changed = pageSignature() !== before.sig;
    if (name === 'input_text' && before.node) {
      var value = 'value' in before.node ? String(before.node.value || '') : String(before.node.textContent || '');
      var want = String(input && input.text || '');
      if (want && value.indexOf(want) === -1) notes.push('\u26a0\ufe0f the field now contains "' + value.slice(0, 80) + '", not exactly the text you typed; check it');
      else if (want) notes.push('verified: the field contains the text');
    } else if (name === 'scroll' || name === 'scroll_horizontally') {
      if (!input || input.index === undefined) {
        if ((window.scrollY || 0) === before.y && name === 'scroll') notes.push('\u26a0\ufe0f the page did not move (already at the ' + (input && input.down === false ? 'top' : 'end') + '?)');
      }
    } else if (!urlChanged) {
      if (changed) notes.push('the page content changed');
      else if (before.href && before.href !== location.href) notes.push('link target ' + before.href + ' \u2014 a page load may still be starting');
      else notes.push('\u26a0\ufe0f no visible change on the page (same URL, same content). The action may not have worked; do not assume success \u2014 check the page');
    }
    return notes.length ? 'Observation: ' + notes.join('; ') + '.' : '';
  }

  var VERIFY = { click_element_by_index: 1, input_text: 1, select_dropdown_option: 1, scroll: 1, scroll_horizontally: 1 };

  function failed(output) {
    var first = String(output == null ? '' : output).split('\n')[0];
    return /^\s*(\u274c|error|failed)/i.test(first);
  }

  function stepCount(target) {
    var a = target || agent;
    var n = 0;
    (a && a.history || []).forEach(function (h) { if (h && h.type === 'step') n += 1; });
    return n;
  }

  // Every tool goes through here: records the step natively BEFORE acting (a
  // click that navigates can't be lost), pauses sensitive clicks for the user,
  // caps repeats of a failing action, waits for the page to settle and appends
  // an observation of what really changed.
  function runTool(self, name, original, input, ctx) {
    var signal = ctx && ctx.signal;
    var label = input && typeof input.index === 'number' ? elementLabel(self, input.index) : '';
    var info = { label: label, url: location.href, title: String(document.title || '').slice(0, 120) };
    if (input && typeof input === 'object') meta.set(input, info);
    var seq = seqBase + stepCount(self) + 1;
    if (name !== 'done') {
      sendStep(seq, {
        seq: seq, url: info.url, title: info.title, label: label,
        eval: String(lastReflection.eval || '').slice(0, 400),
        memory: String(lastReflection.memory || '').slice(0, 800),
        goal: String(lastReflection.goal || '').slice(0, 300),
        tool: name, input: compactInput(input), output: '', pending: true, ts: Date.now(),
      });
    }
    var sig = name + '|' + JSON.stringify(compactInput(input)) + '|' + location.pathname;
    if ((fails[sig] || 0) >= 2) {
      return Promise.resolve('\u274c Not executed: this exact action already failed twice on this page. Do NOT repeat it. Try a different element or approach (scroll, search, read_page_text), or call done with success=false and say plainly what you could not find.');
    }
    var before = VERIFY[name] ? snapshot(self, input) : null;
    var go = function () { return Promise.resolve(original.call(self, input, ctx)); };
    var run;
    if (name === 'click_element_by_index' && label && SENSITIVE.test(label)) {
      run = confirmAction('Click \u201c' + label + '\u201d', signal).then(function (allowed) {
        if (!allowed) return 'The user declined this action. Do not try it again; finish and tell the user what is left for them to do.';
        return go();
      });
    } else {
      run = go();
    }
    return run.then(function (output) {
      if (!before || failed(output)) return output;
      return settle(signal, 3500).then(function () {
        var seen = observe(before, name, input);
        return seen ? String(output) + '\n' + seen : output;
      });
    }).then(function (output) {
      if (failed(output)) fails[sig] = (fails[sig] || 0) + 1;
      return output;
    });
  }

  function wrapTools(target) {
    target.tools.forEach(function (tool, name) {
      if (!tool || typeof tool.execute !== 'function' || tool.nkWrapped) return;
      var original = tool.execute;
      target.tools.set(name, Object.assign({}, tool, {
        nkWrapped: true,
        execute: function (input, ctx) { return runTool(this, name, original, input, ctx); },
      }));
    });
  }

  // ---------- extra tools ----------------------------------------------------
  function mainText() {
    var root = document.querySelector('main, [role=main], article') || document.body;
    var text = root ? String(root.innerText || '') : '';
    if (root !== document.body && text.length < 400 && document.body) text = String(document.body.innerText || '');
    return text.replace(/[ \t\u00a0]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
  }

  function extraTools() {
    var Z = window.PageAgentZod;
    if (!Z) return {};
    return {
      read_page_text: {
        description: 'Read the visible text of the current page (main content first). Use it to answer questions about the page and to check facts before reporting them. Optional query returns only the lines that mention it.',
        inputSchema: Z.object({ query: Z.optional(Z.string()), max_chars: Z.optional(Z.int().min(500).max(12000)) }),
        execute: function (input) {
          var text = mainText();
          var limit = (input && input.max_chars) || 6000;
          var q = String(input && input.query || '').trim().toLowerCase();
          if (!text) return Promise.resolve('\u274c This page has no readable text yet. Wait or scroll, then try again.');
          if (!q) return Promise.resolve('Page text (' + text.length + ' chars' + (text.length > limit ? ', first ' + limit : '') + '):\n' + text.slice(0, limit));
          var terms = q.split(/\s+/).filter(Boolean);
          var lines = text.split('\n');
          var hits = [];
          for (var i = 0; i < lines.length && hits.length < 40; i += 1) {
            var low = lines[i].toLowerCase();
            if (terms.some(function (t) { return low.indexOf(t) !== -1; })) {
              hits.push((lines[i - 1] ? lines[i - 1].slice(0, 200) + ' / ' : '') + lines[i].slice(0, 400) + (lines[i + 1] ? ' / ' + lines[i + 1].slice(0, 200) : ''));
            }
          }
          if (!hits.length) return Promise.resolve('\u274c No text matching "' + q + '" on this page. Do not guess: scroll, search the site, open another page, or report that it was not found.');
          return Promise.resolve('Lines mentioning "' + q + '":\n- ' + hits.join('\n- ').slice(0, limit));
        },
      },
      list_links: {
        description: 'List the links on the current page (text and URL). Optional query filters by link text or URL. Use it to find the exact URL before open_url.',
        inputSchema: Z.object({ query: Z.optional(Z.string()) }),
        execute: function (input) {
          var q = String(input && input.query || '').trim().toLowerCase();
          var seen = Object.create(null);
          var out = [];
          var links = document.querySelectorAll('a[href]');
          for (var i = 0; i < links.length && out.length < 60; i += 1) {
            var a = links[i];
            var href = a.href;
            if (!/^https?:/i.test(href) || seen[href]) continue;
            var text = String(a.innerText || a.getAttribute('aria-label') || a.title || '').replace(/\s+/g, ' ').trim().slice(0, 100);
            if (q && (text + ' ' + href).toLowerCase().indexOf(q) === -1) continue;
            seen[href] = 1;
            out.push((text || '(no text)') + ' \u2192 ' + href);
          }
          if (!out.length) return Promise.resolve(q ? '\u274c No links matching "' + q + '" on this page.' : '\u274c No links on this page.');
          return Promise.resolve(out.join('\n'));
        },
      },
      open_url: {
        description: 'Open a URL in this tab (http/https only). Use only a URL the user gave, one you read on a page (list_links), or a well-known site/search URL. The task continues on the new page automatically.',
        inputSchema: Z.object({ url: Z.string() }),
        execute: function (input) {
          var url = String(input && input.url || '').trim();
          if (!/^https?:\/\//i.test(url)) return Promise.resolve('\u274c Only http(s) URLs can be opened.');
          setTimeout(function () { location.assign(url); }, 50);
          return new Promise(function (resolve) { setTimeout(function () { resolve('Opening ' + url + ' \u2014 the next step continues on that page.'); }, 4000); });
        },
      },
      go_back: {
        description: 'Go back to the previous page in this tab.',
        inputSchema: Z.object({}),
        execute: function () {
          if (window.history.length <= 1) return Promise.resolve('\u274c There is no previous page in this tab.');
          var from = location.href;
          window.history.back();
          return new Promise(function (resolve) {
            setTimeout(function () { resolve(location.href !== from ? '\u2705 Went back to ' + location.href : 'Going back \u2014 the next step continues on the previous page.'); }, 1500);
          });
        },
      },
      wait_for_text: {
        description: 'Wait until some text appears on the page (e.g. results loading), up to the given seconds.',
        inputSchema: Z.object({ text: Z.string(), seconds: Z.optional(Z.number().min(1).max(15)) }),
        execute: function (input, ctx) {
          var want = String(input && input.text || '').toLowerCase();
          var until = Date.now() + 1000 * ((input && input.seconds) || 6);
          return new Promise(function (resolve) {
            (function poll() {
              var has = want && document.body && String(document.body.innerText || '').toLowerCase().indexOf(want) !== -1;
              if (has) return resolve('\u2705 "' + input.text + '" is on the page.');
              if (Date.now() > until || (ctx && ctx.signal && ctx.signal.aborted)) return resolve('\u274c "' + input.text + '" did not appear on the page.');
              setTimeout(poll, 300);
            })();
          });
        },
      },
      update_plan: {
        description: 'Write or update the numbered plan for a multi-step / multi-page task, marking finished items with [x]. It is kept across page changes and shown to you every step.',
        inputSchema: Z.object({ plan: Z.string() }),
        execute: function (input) {
          plan = String(input && input.plan || '').slice(0, 4000);
          sendState({ plan: plan });
          return Promise.resolve('\u2705 Plan saved.');
        },
      },
      save_notes: {
        description: 'Save facts you found (names, prices, answers, URLs) so they survive page changes. Replaces the previous notes, so include everything you still need.',
        inputSchema: Z.object({ notes: Z.string() }),
        execute: function (input) {
          notes = String(input && input.notes || '').slice(0, 6000);
          sendState({ notes: notes });
          return Promise.resolve('\u2705 Notes saved.');
        },
      },
    };
  }

  var RULES = [
    'You work inside a real mobile browser tab. Tasks can span several pages; the page reloads when you navigate, but your history, plan and notes are kept.',
    'Rules for accurate work:',
    '1. agent_history may contain steps done on EARLIER pages. They are real and already done: never start over or repeat them. Continue from the next step.',
    '2. Act only on elements listed in browser_state right now. Indexes change after every page change or update; never reuse an index from an older step.',
    '3. Every action result ends with an Observation of what really changed. If it says there was no change or something failed, do not assume success: check the page and try another way.',
    '4. Never invent facts, prices, names, links or results. Before you report anything about page content, read it with read_page_text (use query to search) and use only what it returns.',
    '5. If you cannot find something after reasonable attempts (scroll, site search, read_page_text, list_links), say so plainly with done success=false. Do not guess.',
    '6. Never repeat the same failing action more than twice; change approach.',
    '7. For tasks with several steps or pages: call update_plan early (numbered items, mark done with [x]) and save_notes for facts you will need later.',
    '8. Use open_url only with a URL the user gave, one you read on a page, or a well-known site or search URL.',
    '9. The done text must start with the answer or result, then a short "What I did:" list of the key steps, then anything that is not finished.',
  ].join('\n');

  function createAgent() {
    var config = {
      baseURL: cfg.baseURL,
      apiKey: '',
      model: cfg.model,
      language: cfg.language || 'en-US',
      maxRetries: 1,
      maxSteps: 40,
      enableMask: true,
      customTools: extraTools(),
      instructions: {
        get system() {
          var text = RULES;
          if (plan) text += '\n\nCURRENT PLAN (kept across pages):\n' + plan;
          if (notes) text += '\n\nSAVED NOTES (facts you found earlier; trust these):\n' + notes;
          return text;
        },
      },
      customFetch: function (url, init) {
        return relayFetch(url, init).then(function (res) {
          captureReflection(res.body);
          return new Response(res.body, {
            status: res.status || 200,
            headers: { 'Content-Type': 'application/json' },
          });
        });
      },
      onBeforeTask: function (a) { hydrate(a); },
      onBeforeStep: function (a) {
        var total = seqBase + stepCount(a);
        if (total >= MAX_TOTAL_STEPS + 1) {
          var msg = 'Stopped after ' + total + ' steps without finishing. Try a shorter or more specific request.';
          if (run) run.result = { success: false, data: msg };
          throw new Error(msg);
        }
        if (total === MAX_TOTAL_STEPS - 4) a.pushObservation('Only 4 steps left for this task. Wrap up and call done with what you have (say what is not finished).');
        if (total >= MAX_TOTAL_STEPS - 1) a.pushObservation('Step limit reached: call done NOW with what you found and what is not finished.');
        // Read the DOM only once the page has loaded and stopped changing.
        return settle(null, 2500);
      },
    };
    var controller = new window.PageAgentController(config);
    config.pageController = controller;
    var created = new window.PageAgentCore(config);
    created.onAskUser = function (question, opts) { return askUser(question, opts && opts.signal); };
    wrapTools(created);
    window.__nativekitPageAgent = created;
    created.addEventListener('statuschange', onStatus);
    created.addEventListener('historychange', function () { syncSteps(); renderSteps(); });
    created.addEventListener('activity', onActivity);
    return created;
  }

  // The model's reflection for the step about to run (the core only records it
  // after the action finishes — too late if that action navigates away).
  function captureReflection(body) {
    try {
      var json = JSON.parse(body);
      var msg = json && json.choices && json.choices[0] && json.choices[0].message;
      if (!msg) return;
      var args = msg.tool_calls && msg.tool_calls[0] && msg.tool_calls[0].function && msg.tool_calls[0].function.arguments;
      var out = null;
      if (typeof args === 'string') out = JSON.parse(args);
      else if (typeof msg.content === 'string') {
        var m = /({[\s\S]*})/.exec(msg.content);
        if (m) out = JSON.parse(m[1]);
      }
      if (out && typeof out === 'object') {
        lastReflection = { eval: out.evaluation_previous_goal || '', memory: out.memory || '', goal: out.next_goal || '' };
      }
    } catch (e) { /* keep the previous one */ }
  }

  function recordOutput(r) {
    if (!r.pending) return String(r.output || '');
    if (r.tool === 'open_url') return 'Opened ' + String(r.input && r.input.url || '') + '. The page then loaded (now on ' + location.href + ').';
    if (r.tool === 'go_back') return 'Went back (now on ' + location.href + ').';
    return 'The action ran and the page then navigated/reloaded before its result was captured (now on ' + location.href + '). Treat it as probably done and verify on the current page.';
  }

  // Put the earlier pages' steps back into the agent's own history, so the
  // model sees them in <agent_history> and step numbers continue.
  function hydrate(a) {
    if (!hydrated.length) return;
    var keep = hydrated.slice(-30);
    var older = hydrated.slice(0, hydrated.length - keep.length);
    seqBase = older.length;
    finalSent = hydrated.length;
    if (older.length) {
      a.history.push({ type: 'observation', content: 'Earlier steps 1-' + older.length + ' (summary): ' + older.map(function (r) {
        return r.seq + '. ' + (r.goal || actionText(r.tool, r.input, r.label)) + ' -> ' + recordOutput(r).slice(0, 80);
      }).join(' | ').slice(0, 3000) });
    }
    keep.forEach(function (r) {
      var input = r.input || {};
      meta.set(input, { label: r.label || '', url: r.url || '', title: r.title || '' });
      a.history.push({
        type: 'step', stepIndex: r.seq - 1, nkHydrated: true,
        reflection: { evaluation_previous_goal: r.eval || '', memory: r.memory || '', next_goal: r.goal || actionText(r.tool, input, r.label) },
        action: { name: r.tool, input: input, output: recordOutput(r) },
      });
    });
    var last = hydrated[hydrated.length - 1] || {};
    a.history.push({ type: 'observation', content: '[Continuation] The page changed while this task was running. Steps 1-' + hydrated.length
      + ' above were ALREADY DONE on earlier pages (last one on ' + (last.url || 'the previous page') + '). Now on ' + location.href
      + '. Do NOT start over or repeat finished steps; look at this page and continue with the next step.' });
    a.dispatchEvent(new Event('historychange'));
  }

  function ensureAgent() {
    if (!agent || agent.disposed) agent = createAgent();
    return agent;
  }

  // Sensitive actions pause for the user (Atlas / Comet behaviour).
  var SENSITIVE = /\b(buy|pay|purchase|checkout|check out|place order|order now|send|submit|post|publish|delete|remove|confirm|book|reserve|subscribe|transfer|sign up|log ?out)\b/i;

  function clean(text, max) {
    text = String(text || '').replace(/\s+/g, ' ').trim();
    max = max || 48;
    return text.length > max ? text.slice(0, max - 2) + '\u2026' : text;
  }

  // Human-readable name of an indexed element: what the user sees on it, never
  // the serialised "[2]<button …>" line the model gets.
  function elementLabel(target, index) {
    try {
      var node = elementAt(target, index);
      if (node) {
        var aria = node.getAttribute && (node.getAttribute('aria-label') || '');
        var labelled = '';
        var ids = node.getAttribute && node.getAttribute('aria-labelledby');
        if (ids) ids.split(/\s+/).forEach(function (id) { var l = document.getElementById(id); if (l) labelled += ' ' + (l.innerText || l.textContent || ''); });
        var tag = String(node.tagName || '').toLowerCase();
        var isField = tag === 'input' || tag === 'textarea' || tag === 'select';
        var text = isField ? '' : (node.innerText || node.textContent || '');
        var forLabel = '';
        if (isField && node.labels && node.labels[0]) forLabel = node.labels[0].innerText || '';
        var value = tag === 'input' && /^(submit|button|reset)$/i.test(node.type || '') ? node.value : '';
        var img = node.querySelector && node.querySelector('img[alt]');
        var candidates = [aria, labelled, text, value, forLabel, node.getAttribute && node.getAttribute('placeholder'),
          node.getAttribute && node.getAttribute('title'), node.getAttribute && node.getAttribute('alt'), img && img.getAttribute('alt'),
          node.getAttribute && node.getAttribute('name')];
        for (var i = 0; i < candidates.length; i += 1) {
          var c = clean(candidates[i]);
          if (c) return c;
        }
      }
      // Fall back to the serialised line, stripped of its markup.
      var map = target.pageController && target.pageController.elementTextMap;
      var line = String(map && typeof map.get === 'function' ? map.get(index) || '' : '');
      var m = /^\[\d+\]<[^>]*>([^<]*)/.exec(line);
      if (m && clean(m[1])) return clean(m[1]);
      var attr = /(?:aria-label|placeholder|title|alt|value)=["']?([^"'>]+)/i.exec(line);
      if (attr) return clean(attr[1]);
      return '';
    } catch (e) { return ''; }
  }

  // ---------- plain-language step text --------------------------------------
  function actionText(name, input, label) {
    input = input || {};
    if (label === undefined && input && typeof input === 'object') label = (meta.get(input) || {}).label;
    switch (name) {
      case 'click_element_by_index':
        return label ? 'Click \u201c' + label + '\u201d' : 'Click an element';
      case 'input_text': return 'Type \u201c' + clean(input.text, 40) + '\u201d' + (label ? ' into \u201c' + label + '\u201d' : '');
      case 'select_dropdown_option': return 'Choose \u201c' + clean(input.text, 40) + '\u201d';
      case 'scroll': return input.down === false ? 'Scroll up' : 'Scroll down';
      case 'scroll_horizontally': return input.right === false ? 'Scroll left' : 'Scroll right';
      case 'wait': return 'Wait ' + (input.seconds || 1) + 's for the page';
      case 'wait_for_text': return 'Wait for \u201c' + clean(input.text, 30) + '\u201d';
      case 'ask_user': return 'Ask you a question';
      case 'execute_javascript': return 'Run a script on the page';
      case 'read_page_text': return input.query ? 'Look for \u201c' + clean(input.query, 30) + '\u201d on the page' : 'Read the page';
      case 'list_links': return 'Look at the links on the page';
      case 'open_url': return 'Open ' + clean(String(input.url || '').replace(/^https?:\/\/(www\.)?/, ''), 40);
      case 'go_back': return 'Go back';
      case 'update_plan': return 'Update the plan';
      case 'save_notes': return 'Save notes';
      case 'done': return input.success === false ? 'Finish (not fully done)' : 'Finish';
      default: return name ? String(name).replace(/_/g, ' ') : 'Think';
    }
  }

  function stepTitle(item) {
    var r = (item && item.reflection) || {};
    var goal = String(r.next_goal || '').trim();
    if (goal) return goal;
    return actionText(item && item.action && item.action.name, item && item.action && item.action.input);
  }

  // ---------- panel state ------------------------------------------------------
  var host = null, root = null, glow = null;
  var sheet, bodyEl, emptyEl, threadEl, footEl, liveEl, liveText, composer, input, sendBtn, ctrlEl, pill, pillText, fab, ctxText, ctxFav;
  var isOpen = false;
  var run = null;            // { card, list, title, meta, badge, start, timer, earlier }
  var pendingAsk = null;     // { resolve, card }
  var lastTask = '';

  function buildUi() {
    if (host && host.isConnected) return;
    if (host && !host.isConnected) { (document.body || document.documentElement).appendChild(host); return; }
    host = document.createElement('nativekit-agent');
    host.setAttribute('data-page-agent-ignore', 'true');
    host.setAttribute('data-browser-use-ignore', 'true');
    host.style.setProperty('position', 'fixed', 'important');
    host.style.setProperty('inset', '0', 'important');
    host.style.setProperty('z-index', '2147483646', 'important');
    host.style.setProperty('pointer-events', 'none', 'important');
    host.style.setProperty('display', 'block', 'important');
    root = host.attachShadow({ mode: 'closed' });
    try {
      var sheetCss = new CSSStyleSheet();
      sheetCss.replaceSync(CSS);
      root.adoptedStyleSheets = [sheetCss];
    } catch (e) {
      var style = document.createElement('style');
      style.textContent = CSS;
      root.appendChild(style);
    }

    sheet = el('section', 'sheet');
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-label', 'AI agent');

    var grab = el('div', 'grab');
    grab.appendChild(el('i'));
    wireGrab(grab);
    sheet.appendChild(grab);

    var head = el('div', 'head');
    var logo = el('div', 'logo');
    logo.appendChild(icon('spark', 16));
    head.appendChild(logo);
    var titles = el('div', 'titles');
    titles.appendChild(el('div', 'title', 'Agent'));
    var ctx = el('div', 'ctx');
    ctxFav = el('div', 'fav');
    ctxText = el('span');
    ctx.appendChild(ctxFav);
    ctx.appendChild(ctxText);
    titles.appendChild(ctx);
    head.appendChild(titles);
    head.appendChild(iconButton('plus', 'New chat', newChat));
    head.appendChild(iconButton('expand', 'Expand', function () { sheet.classList.toggle('full'); }));
    head.appendChild(iconButton('close', 'Close', function () { hidePanel(); }));
    sheet.appendChild(head);

    bodyEl = el('div', 'body');
    emptyEl = buildEmpty();
    threadEl = el('div');
    bodyEl.appendChild(emptyEl);
    bodyEl.appendChild(threadEl);
    sheet.appendChild(bodyEl);

    footEl = el('div', 'foot');
    liveEl = el('div', 'live');
    liveEl.appendChild(el('div', 'spin'));
    liveText = el('b', null, 'Thinking\u2026');
    liveEl.appendChild(liveText);
    ctrlEl = el('div', 'ctrl');
    ctrlEl.appendChild(textButton('Take over', 'ghost', takeOver));
    ctrlEl.appendChild(textButton('Stop', 'danger', stopRun));
    composer = el('div');
    var box = el('div', 'box');
    input = el('textarea');
    input.rows = 1;
    input.placeholder = 'Ask about this page or give a task\u2026';
    input.setAttribute('aria-label', 'Task for the agent');
    input.addEventListener('input', function () { autoGrow(); sendBtn.disabled = !input.value.trim(); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
    });
    box.appendChild(input);
    sendBtn = iconButton('up', 'Send', submit, 'send');
    sendBtn.disabled = true;
    box.appendChild(sendBtn);
    composer.appendChild(box);
    composer.appendChild(el('div', 'note', 'The agent acts on this page and can make mistakes. Check important results.'));
    footEl.appendChild(liveEl);
    footEl.appendChild(ctrlEl);
    footEl.appendChild(composer);
    sheet.appendChild(footEl);
    root.appendChild(sheet);

    pill = el('div', 'pill');
    pill.appendChild(el('div', 'spin'));
    pillText = el('div', 'ptext', 'Agent working\u2026');
    pillText.addEventListener('click', function () { showPanel(); });
    pill.appendChild(pillText);
    pill.appendChild(textButton('Stop', 'danger', stopRun));
    root.appendChild(pill);

    fab = el('button', 'fab');
    fab.type = 'button';
    fab.setAttribute('aria-label', 'Open AI agent');
    fab.appendChild(icon('spark', 20));
    fab.appendChild(el('span', 'ping'));
    wireFab(fab);
    root.appendChild(fab);

    (document.body || document.documentElement).appendChild(host);
    paintTheme();
    setRunning(false);
    updateContext();
  }

  function buildEmpty() {
    var wrap = el('div', 'empty');
    wrap.appendChild(el('div', 'hello', 'How can I help on this page?'));
    wrap.appendChild(el('div', 'sub', 'I can read this page, answer questions about it, and click, type and scroll to get things done.'));
    var chips = el('div', 'chips');
    var ideas = ['Summarize this page', 'What are the key points?'];
    try {
      if (document.querySelector('form input:not([type=hidden]), textarea')) ideas.push('Help me fill in this form');
      if (document.querySelector('[class*=price], [itemprop=price]')) ideas.push('Compare the prices here');
      if (document.querySelectorAll('a[href]').length > 20) ideas.push('Find the most useful links');
    } catch (e) { /* page may restrict queries */ }
    ideas.slice(0, 4).forEach(function (idea) {
      var c = el('button', 'chip', idea);
      c.type = 'button';
      c.addEventListener('click', function () { startTask(idea); });
      chips.appendChild(c);
    });
    wrap.appendChild(chips);
    return wrap;
  }

  function updateContext() {
    if (!ctxText) return;
    var h = hostName();
    var t = String(document.title || '').trim();
    ctxFav.textContent = (h || '?').charAt(0).toUpperCase();
    ctxText.textContent = 'Using ' + (t ? t + ' \u00b7 ' : '') + (h || 'this page');
  }

  function autoGrow() {
    input.style.height = 'auto';
    input.style.height = Math.min(120, input.scrollHeight) + 'px';
  }

  function scrollDown() {
    try { bodyEl.scrollTop = bodyEl.scrollHeight; } catch (e) { /* ignore */ }
  }

  // Drag the grab handle: up = full height, down = close.
  function wireGrab(grab) {
    var startY = null;
    grab.addEventListener('pointerdown', function (e) { startY = e.clientY; try { grab.setPointerCapture(e.pointerId); } catch (x) {} });
    grab.addEventListener('pointerup', function (e) {
      if (startY == null) return;
      var dy = e.clientY - startY;
      startY = null;
      if (dy > 60) { if (sheet.classList.contains('full')) sheet.classList.remove('full'); else hidePanel(); }
      else if (dy < -40) sheet.classList.add('full');
      else sheet.classList.toggle('full');
    });
    grab.addEventListener('pointercancel', function () { startY = null; });
  }

  // Launcher: tap opens, vertical drag moves it along the edge (position kept per site).
  function wireFab(button) {
    var start = null, moved = false;
    try {
      var saved = parseFloat(sessionStorage.getItem('nk-agent-fab-y'));
      if (saved > 0) button.style.bottom = saved + 'px';
    } catch (e) { /* storage may be blocked */ }
    button.addEventListener('pointerdown', function (e) {
      start = { y: e.clientY, bottom: parseFloat(getComputedStyle(button).bottom) || 88 };
      moved = false;
      try { button.setPointerCapture(e.pointerId); } catch (x) {}
    });
    button.addEventListener('pointermove', function (e) {
      if (!start) return;
      var dy = e.clientY - start.y;
      if (Math.abs(dy) > 6) moved = true;
      if (moved) {
        var b = Math.max(16, Math.min(window.innerHeight - 70, start.bottom - dy));
        button.style.bottom = b + 'px';
      }
    });
    button.addEventListener('pointerup', function () {
      if (!start) return;
      start = null;
      if (moved) { try { sessionStorage.setItem('nk-agent-fab-y', parseFloat(button.style.bottom) || 88); } catch (e) {} return; }
      showPanel();
    });
    button.addEventListener('pointercancel', function () { start = null; });
  }

  // ---------- open / close ---------------------------------------------------
  function showPanel() {
    buildUi();
    updateContext();
    isOpen = true;
    sheet.classList.add('open');
    fab.classList.remove('show', 'unread');
    pill.classList.remove('show');
    document.documentElement.setAttribute('data-agent-panel', 'open');
    if (!running() && window.innerWidth >= 720) setTimeout(function () { try { input.focus({ preventScroll: true }); } catch (e) {} }, 280);
    scrollDown();
  }

  function hidePanel() {
    if (!sheet) return;
    isOpen = false;
    sheet.classList.remove('open', 'full');
    document.documentElement.setAttribute('data-agent-panel', 'closed');
    try { input.blur(); } catch (e) {}
    syncFloating();
  }

  function syncFloating() {
    if (!fab) return;
    var busy = running();
    pill.classList.toggle('show', !isOpen && busy);
    fab.classList.toggle('show', !isOpen && !busy && cfg.launcher !== false);
  }

  function running() { return !!(agent && agent.status === 'running'); }

  // ---------- page glow while the agent is in control ------------------------
  function setGlow(on) {
    if (on) {
      if (!glow || !glow.isConnected) {
        glow = document.createElement('div');
        glow.setAttribute('data-page-agent-ignore', 'true');
        glow.setAttribute('data-browser-use-ignore', 'true');
        glow.setAttribute('aria-hidden', 'true');
        var s = glow.style;
        s.setProperty('position', 'fixed', 'important');
        s.setProperty('inset', '0', 'important');
        s.setProperty('pointer-events', 'none', 'important');
        s.setProperty('z-index', '2147483645', 'important');
        s.setProperty('border-radius', '0', 'important');
        (document.body || document.documentElement).appendChild(glow);
      }
      glow.style.setProperty('box-shadow', 'inset 0 0 0 3px ' + hexAlpha(theme.accent, 0.95) + ', inset 0 0 28px 6px ' + hexAlpha(theme.accent, 0.45), 'important');
      glow.style.display = 'block';
      pulseGlow();
    } else if (glow) {
      glow.style.display = 'none';
    }
  }

  var glowTimer = null;
  function pulseGlow() {
    if (glowTimer) return;
    var t = 0;
    glowTimer = setInterval(function () {
      if (!glow || glow.style.display === 'none') { clearInterval(glowTimer); glowTimer = null; return; }
      t += 1;
      glow.style.opacity = String(0.65 + 0.35 * Math.abs(Math.sin(t / 8)));
    }, 60);
  }

  // ---------- running state ---------------------------------------------------
  function setRunning(on) {
    if (!footEl) return;
    liveEl.style.display = on ? 'flex' : 'none';
    ctrlEl.style.display = on ? 'flex' : 'none';
    composer.style.display = on ? 'none' : 'block';
    setGlow(on);
    syncFloating();
  }

  function setLive(text) {
    if (liveText) liveText.textContent = text;
    if (pillText) pillText.textContent = text + (run ? ' \u00b7 step ' + (run.count + 1) : '');
    // Keep the live row in the step list in sync (it used to keep showing the
    // previous step while waiting for Allow / Deny).
    var row = run && run.list.querySelector('.step.live .sgoal');
    if (row) row.textContent = text;
  }

  function onActivity(event) {
    var d = (event && event.detail) || {};
    if (d.type === 'thinking') setLive('Thinking\u2026');
    else if (d.type === 'executing') {
      var lbl = d.input && typeof d.input.index === 'number' && agent ? elementLabel(agent, d.input.index) : undefined;
      setLive(actionText(d.tool, d.input, lbl) + '\u2026');
    }
    else if (d.type === 'retrying') setLive('Model busy, retrying (' + d.attempt + '/' + d.maxAttempts + ')\u2026');
    else if (d.type === 'error') setLive('Something went wrong');
  }

  function onStatus() {
    var status = agent ? agent.status : 'idle';
    sendState({ status: status });
    if (status === 'running') { setRunning(true); return; }
    setRunning(false);
    finishRun(status);
  }

  // ---------- conversation -----------------------------------------------------
  function submit() {
    var text = input.value.trim();
    if (!text || running()) return;
    input.value = '';
    autoGrow();
    sendBtn.disabled = true;
    startTask(text);
  }

  function newRunId() {
    return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function startTask(task, opts) {
    opts = opts || {};
    buildUi();
    if (running()) return;
    lastTask = task;
    emptyEl.style.display = 'none';
    if (!opts.resumed) {
      // A brand-new run: native replaces the old session when it sees the new id.
      addUser(task);
      runId = newRunId();
      hydrated = [];
      seqBase = 0;
      finalSent = 0;
      plan = '';
      notes = '';
      fails = Object.create(null);
      lastReflection = {};
      sendState({ task: task, status: 'running', result: '', plan: '', notes: '' });
    }
    openRun();
    setRunning(true);
    setLive(opts.resumed ? 'Continuing on this page\u2026' : 'Thinking\u2026');
    showPanel();
    var a = ensureAgent();
    a.execute(task).then(function (result) {
      if (result && typeof result.data === 'string') run && (run.result = result);
    }).catch(function (error) {
      if (run) run.result = { success: false, data: String(error && error.message || error) };
      finishRun('error');
    });
  }

  function addUser(text) {
    var m = el('div', 'msg user');
    m.appendChild(el('p', null, text));
    threadEl.appendChild(m);
    scrollDown();
  }

  function openRun(earlier) {
    var wrap = el('div', 'msg');
    var card = el('div', 'work');
    var head = el('button', 'whead');
    head.type = 'button';
    var badge = el('div', 'spin');
    var state = el('div', 'wstate');
    var title = el('div', 'wtitle', 'Working on it');
    var meta = el('div', 'wmeta', 'Starting\u2026');
    state.appendChild(title);
    state.appendChild(meta);
    var chev = el('span', 'chev');
    chev.appendChild(icon('chev', 16));
    head.appendChild(badge);
    head.appendChild(state);
    head.appendChild(chev);
    head.addEventListener('click', function () { card.classList.toggle('closed'); });
    var list = el('ol', 'steps');
    if (earlier && earlier.length) {
      earlier.forEach(function (text) { list.appendChild(stepRow(text, '', 'done')); });
      list.appendChild(el('li', 'earlier', 'Page changed \u2014 continuing here'));
    }
    card.appendChild(head);
    card.appendChild(list);
    wrap.appendChild(card);
    threadEl.appendChild(wrap);
    run = { wrap: wrap, card: card, list: list, title: title, meta: meta, badge: badge, head: head,
      start: Date.now(), count: 0, rendered: 0, base: list.childNodes.length, result: null };
    run.timer = setInterval(updateMeta, 1000);
    scrollDown();
  }

  function stepRow(text, sub, state) {
    var li = el('li', 'step ' + state);
    var dot = el('div', 'dot');
    if (state === 'done') dot.appendChild(icon('check', 12));
    else if (state === 'bad') dot.appendChild(icon('x', 12));
    li.appendChild(dot);
    var t = el('div', 'stext');
    t.appendChild(el('div', 'sgoal', text));
    if (sub) t.appendChild(el('span', 'sact', sub));
    li.appendChild(t);
    return li;
  }

  function updateMeta() {
    if (!run) return;
    var secs = Math.round((Date.now() - run.start) / 1000);
    var time = secs < 60 ? secs + 's' : Math.floor(secs / 60) + 'm ' + (secs % 60) + 's';
    run.meta.textContent = (run.count ? run.count + (run.count === 1 ? ' step' : ' steps') + ' \u00b7 ' : '') + time;
  }

  function renderSteps() {
    if (!run || !agent) return;
    var steps = (agent.history || []).filter(function (h) { return h && h.type === 'step'; });
    // Re-render only what changed: finished steps + one live row.
    while (run.list.childNodes.length > run.base) run.list.removeChild(run.list.lastChild);
    if (seqBase) run.list.appendChild(el('li', 'earlier', seqBase + ' earlier steps on previous pages'));
    var hadHydrated = false;
    steps.forEach(function (item) {
      var name = item.action && item.action.name;
      if (!item.nkHydrated && hadHydrated) {
        run.list.appendChild(el('li', 'earlier', 'Page changed \u2014 continuing here'));
        hadHydrated = false;
      }
      if (item.nkHydrated) hadHydrated = true;
      if (name === 'done') return;
      var ok = !(item.action && failed(item.action.output));
      run.list.appendChild(stepRow(stepTitle(item), actionText(name, item.action && item.action.input), ok ? 'done' : 'bad'));
    });
    if (hadHydrated && running()) run.list.appendChild(el('li', 'earlier', 'Page changed \u2014 continuing here'));
    run.count = seqBase + steps.length;
    if (running()) {
      run.list.appendChild(stepRow(liveText ? liveText.textContent : 'Thinking\u2026', '', 'live'));
      run.title.textContent = 'Working \u00b7 step ' + (run.count + 1);
    }
    updateMeta();
    setLive(liveText ? liveText.textContent : 'Thinking\u2026');
    scrollDown();
  }

  function finishRun(status) {
    if (!run) return;
    var r = run;
    run = null;
    clearInterval(r.timer);
    var live = r.list.querySelector('.step.live');
    if (live) live.parentNode.removeChild(live);
    var result = r.result || (agent && agent.lastResult) || null;
    var text = result && typeof result.data === 'string' ? result.data : '';
    var badge;
    if (status === 'completed') {
      badge = el('div', 'badge ok'); badge.appendChild(icon('check', 13));
      r.title.textContent = result && result.success === false ? 'Finished with issues' : 'Done';
      r.card.classList.add('closed');
    } else if (status === 'stopped') {
      badge = el('div', 'badge stop'); badge.appendChild(icon('stop', 11));
      r.title.textContent = 'Stopped';
      text = '';
    } else {
      badge = el('div', 'badge no'); badge.appendChild(icon('x', 13));
      r.title.textContent = 'Couldn\u2019t finish';
    }
    r.head.replaceChild(badge, r.badge);
    var secs = Math.round((Date.now() - r.start) / 1000);
    var pages = Object.create(null);
    hydrated.forEach(function (h) { if (h && h.url) pages[h.url] = 1; });
    pages[location.href] = 1;
    var pageCount = Object.keys(pages).length;
    r.meta.textContent = r.count + (r.count === 1 ? ' step' : ' steps') + (pageCount > 1 ? ' \u00b7 ' + pageCount + ' pages' : '') + ' \u00b7 ' + (secs < 60 ? secs + 's' : Math.floor(secs / 60) + 'm ' + (secs % 60) + 's');
    if (text) addAnswer(text, status !== 'completed');
    if (quiet && status === 'stopped') threadEl.appendChild(el('div', 'earlier', 'This task continued on another page.'));
    // Done / stopped / failed: native drops the run's steps so nothing resumes it.
    sendState({ status: status, result: text });
    hydrated = [];
    seqBase = 0;
    if (!isOpen && fab) fab.classList.add('unread');
    syncFloating();
  }

  function addAnswer(text, isError) {
    var m = el('div', 'msg');
    m.appendChild(el('div', 'answer' + (isError ? ' err' : ''), text));
    var row = el('div', 'row');
    var copy = el('button', 'mini', 'Copy');
    copy.type = 'button';
    copy.addEventListener('click', function () {
      try { navigator.clipboard.writeText(text).then(function () { copy.textContent = 'Copied'; }); } catch (e) { /* clipboard blocked */ }
    });
    row.appendChild(copy);
    if (isError && lastTask) {
      var retry = el('button', 'mini', 'Retry');
      retry.type = 'button';
      retry.addEventListener('click', function () { startTask(lastTask); });
      row.appendChild(retry);
    }
    m.appendChild(row);
    threadEl.appendChild(m);
    scrollDown();
  }

  function stopRun() {
    if (agent && running()) { try { agent.stop(); } catch (e) { /* ignore */ } }
    if (pendingAsk) { pendingAsk.resolve(''); pendingAsk = null; }
  }

  // Atlas-style "Take control": stop the agent and get out of the user's way.
  function takeOver() {
    stopRun();
    hidePanel();
  }

  function newChat() {
    if (running()) stopRun();
    while (threadEl.firstChild) threadEl.removeChild(threadEl.firstChild);
    emptyEl.style.display = 'block';
    lastTask = '';
    if (agent) { try { agent.dispose(); } catch (e) {} agent = null; }
    sendState({ task: '', status: 'idle', result: '' });
    runId = '';
    hydrated = [];
    seqBase = 0;
    plan = '';
    notes = '';
  }

  // ---------- ask_user + confirmations ---------------------------------------
  function askUser(question, signal) {
    return new Promise(function (resolve) {
      buildUi();
      showPanel();
      var card = el('div', 'card');
      card.appendChild(el('h4', null, 'Agent needs your input'));
      card.appendChild(el('p', null, question));
      var reply = el('div', 'reply');
      var field = el('input');
      field.type = 'text';
      field.placeholder = 'Type your answer';
      var ok = textButton('Reply', 'primary', function () { done(field.value.trim() || '(no answer)'); });
      field.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); ok.click(); } });
      reply.appendChild(field);
      reply.appendChild(ok);
      card.appendChild(reply);
      threadEl.appendChild(card);
      setLive('Waiting for your answer');
      scrollDown();
      setTimeout(function () { try { field.focus(); } catch (e) {} }, 300);
      function done(answer) {
        if (!pendingAsk) return;
        pendingAsk = null;
        reply.parentNode && card.removeChild(reply);
        card.appendChild(el('p', 'sact', 'You: ' + answer));
        setLive('Thinking\u2026');
        resolve(answer);
      }
      pendingAsk = { resolve: done, card: card };
      if (signal) signal.addEventListener('abort', function () { done('(cancelled)'); });
    });
  }

  function confirmAction(what, signal) {
    return new Promise(function (resolve) {
      buildUi();
      showPanel();
      var card = el('div', 'card');
      card.appendChild(el('h4', null, 'Confirm action'));
      card.appendChild(el('p', null, 'The agent wants to: ' + what + '. Allow it?'));
      var row = el('div', 'row');
      var settled = false;
      function finish(allowed) {
        if (settled) return;
        settled = true;
        card.removeChild(row);
        card.appendChild(el('p', 'sact', allowed ? 'Allowed' : 'Denied'));
        setLive(allowed ? 'Continuing\u2026' : 'Thinking\u2026');
        resolve(allowed);
      }
      row.appendChild(textButton('Allow', 'primary', function () { finish(true); }));
      row.appendChild(textButton('Deny', 'ghost', function () { finish(false); }));
      card.appendChild(row);
      threadEl.appendChild(card);
      setLive('Waiting for your OK');
      scrollDown();
      if (signal) signal.addEventListener('abort', function () { finish(false); });
    });
  }

  // ---------- host bridge (native toolbar) -------------------------------------
  window.__nativekitAgentPanel = {
    show: function () { showPanel(); return true; },
    hide: function () { hidePanel(); return true; },
    toggle: function () {
      if (isOpen) hidePanel(); else showPanel();
      return isOpen;
    },
    isOpen: function () { return isOpen; },
    setTheme: function (dark, accent) {
      theme.dark = !!dark;
      if (/^#[0-9a-fA-F]{6}$/.test(String(accent || ''))) theme.accent = accent;
      paintTheme();
      if (running()) setGlow(true);
      return true;
    },
  };

  // ---------- boot + restore -------------------------------------------------
  var restoreHandled = false;
  var resuming = false;

  function parseSteps(list) {
    var out = [];
    (Array.isArray(list) ? list : []).forEach(function (raw) {
      try {
        var r = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (r && typeof r === 'object' && r.tool) out.push(r);
      } catch (e) { /* skip a broken record */ }
    });
    out.sort(function (x, y) { return (x.seq | 0) - (y.seq | 0); });
    return out;
  }

  function onRestored(data) {
    var canResume = data.resume === true && !running() && !resuming;
    // A late answer (after the default boot) still resumes a running task.
    if (restoreHandled && !(canResume && threadEl && !threadEl.firstChild)) return;
    restoreHandled = true;
    if (typeof data.dark === 'boolean') theme.dark = data.dark;
    if (/^#[0-9a-fA-F]{6}$/.test(String(data.accent || ''))) theme.accent = data.accent;
    buildUi();
    paintTheme();
    var task = typeof data.task === 'string' && data.task ? data.task : null;
    var status = typeof data.status === 'string' ? data.status : '';
    var result = typeof data.result === 'string' ? data.result : '';

    if (task && canResume && data.runId) {
      // The page navigated mid-task: take the run over and continue it from
      // the next step with the full history (never restart it).
      resuming = true;
      runId = String(data.runId);
      plan = String(data.plan || '');
      notes = String(data.notes || '');
      hydrated = parseSteps(data.steps);
      seqBase = 0;
      finalSent = hydrated.length;
      fails = Object.create(null);
      lastReflection = {};
      lastTask = task;
      emptyEl.style.display = 'none';
      addUser(task);
      showPanel();
      setLive('Waiting for the page to load\u2026');
      // Let the new page finish loading (and any redirect happen) first.
      settle(null, 6000).then(function () {
        resuming = false;
        if (runId !== String(data.runId) || running()) return;
        startTask(task, { resumed: true });
      });
      return;
    }
    if (task && (status === 'completed' || status === 'error' || status === 'stopped')) {
      // Keep the last exchange readable on the new page, without popping open.
      lastTask = task;
      emptyEl.style.display = 'none';
      addUser(task);
      if (result) addAnswer(result, status !== 'completed');
      else threadEl.appendChild(el('div', 'earlier', status === 'stopped' ? 'Task was stopped on the previous page.' : 'Task ended on the previous page.'));
    }
    syncFloating();
  }

  // Native says another page now drives this run (e.g. this one came back
  // from the back/forward cache): stop here without touching the session.
  function onEvicted(data) {
    if (!data || data.runId !== runId || !running()) return;
    silentStop();
  }

  function silentStop() {
    quiet = true;
    var done = function () { quiet = false; runId = ''; };
    try { Promise.resolve(agent.stop()).then(done, done); } catch (e) { done(); }
  }

  function defaultBoot() {
    buildUi();
    if (cfg.autoShow === true) showPanel();
    syncFloating();
  }

  function boot() {
    if (!document.body) { setTimeout(boot, 100); return; }
    requestRestore();
    // If the native side never answers (older host, race), boot normally.
    setTimeout(function () { if (!restoreHandled) { restoreHandled = true; defaultBoot(); } }, 1500);
  }

  // Back/forward cache: a frozen page coming back must not keep driving an
  // old copy of the run. Stop it quietly and re-sync from native.
  window.addEventListener('pageshow', function (event) {
    if (!event || !event.persisted) return;
    if (running()) silentStop();
    setTimeout(function () { restoreHandled = false; requestRestore(); }, 300);
  });

  // SPAs that re-render <body> drop foreign nodes: keep the panel host alive.
  setInterval(function () {
    if (host && !host.isConnected && document.body) document.body.appendChild(host);
    if (isOpen) updateContext();
  }, 2000);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 0); });
  } else {
    setTimeout(boot, 0);
  }
})();
