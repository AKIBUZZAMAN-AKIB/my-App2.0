/* ==========================================================================
   My App — tab shell runtime

   Architecture
   ------------
   • One bottom tab bar, five destinations: Home, Academic, Agent, Calendar, More.
   • Each destination is a same-origin page mounted in its own <iframe>, created
     lazily and kept alive, so every mini app keeps its own state, its own
     NativeKit bridge instance and its own DOM. No SPA rewrite of shipped apps.
   • "More" is a real screen (not a drawer): it lists the rest of the device's
     mini apps with their own icons, plus honest device/app facts.
   • Mini apps opened from More run full-screen in the app viewer with a back bar.
   • Routing is hash based (#/tab, #/app/id) so the Android hardware back button
     walks history instead of dropping the user out of the app.
   ========================================================================== */

'use strict';

const stage = document.getElementById('stage');
const tabbar = document.getElementById('tabbar');
const moreScreen = document.getElementById('more');
const appview = document.getElementById('appview');
const appviewStage = document.getElementById('appviewStage');
const appTitle = document.getElementById('appTitle');
const splash = document.getElementById('splash');
const splashHint = document.getElementById('splashHint');
const toaster = document.getElementById('toaster');

/* ── icons ──────────────────────────────────────────────────────────────── */
const ICONS = {
  home: '<path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z"/>',
  book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19v15H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M4 20.5A2.5 2.5 0 0 1 6.5 18H19v3H6.5"/>',
  spark: '<path d="M12 3.5 13.7 9l5.3 1.8-5.3 1.8L12 18l-1.7-5.4L5 10.8 10.3 9z"/><path d="M18.5 16.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.6"/><path d="M3.5 10h17M8 3.5v3M16 3.5v3M8 14h2.5M8 17.5h2.5M14 14h2.5"/>',
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="2.2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2.2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2.2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2.2"/>',
  bluetooth: '<path d="M8 6.5 16 17.5 12 21V3l4 3.5L8 17.5"/>',
  note: '<path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H17l3 3v13.5A1.5 1.5 0 0 1 18.5 21h-12A1.5 1.5 0 0 1 5 19.5z"/><path d="M16.5 3v4h3.5M8.5 11h7M8.5 15h5"/>',
  shelf: '<path d="M4 4.5h4.5v15H4zM9.5 4.5H14v15H9.5z"/><path d="m15.2 5.6 3.8-1 3.3 14.7-3.8 1z"/>',
  alarm: '<circle cx="12" cy="13" r="7.5"/><path d="M12 9.5V13l2.5 1.8M5 4.5 7.5 2M19 4.5 16.5 2"/>',
  store: '<path d="M4 9.5V20h16V9.5"/><path d="M3 9.5 5.2 4h13.6L21 9.5a2.5 2.5 0 0 1-4.5 1.4 2.5 2.5 0 0 1-4.5 0 2.5 2.5 0 0 1-4.5 0A2.5 2.5 0 0 1 3 9.5z"/><path d="M9.5 20v-5.5h5V20"/>',
  habit: '<path d="M4 12.5 9 17.5 20 6.5"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 8h.01"/>',
  share: '<path d="M12 15.5V4M8.5 7.5 12 4l3.5 3.5"/><path d="M5.5 13v6.5A1.5 1.5 0 0 0 7 21h10a1.5 1.5 0 0 0 1.5-1.5V13"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 3.5v2.2M12 18.3v2.2M4.9 7.5l1.9 1.1M17.2 15.4l1.9 1.1M4.9 16.5l1.9-1.1M17.2 8.6l1.9-1.1"/>',
  wifi: '<path d="M4 9.5a12 12 0 0 1 16 0M6.8 12.8a8 8 0 0 1 10.4 0M9.6 16a4 4 0 0 1 4.8 0"/><circle cx="12" cy="19" r="1.1" fill="currentColor" stroke="none"/>',
  shield: '<path d="M12 3.5 19 6v6c0 4-3 7-7 8.5-4-1.5-7-4.5-7-8.5V6z"/><path d="m9 12 2 2 4-4"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5"/>',
  check: '<path d="M4.5 12.5 10 18 20 6.5"/>',
};

const icon = (name, cls = 'ico') =>
  `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ICONS.grid}</svg>`;

/* ── registry ───────────────────────────────────────────────────────────── */
/** Five bottom-bar destinations. `file` is the page mounted in the stage. */
const TABS = [
  { id: 'home', label: 'Home', file: 'home.html', icon: 'home', tint: 'var(--tint-home)' },
  { id: 'academic', label: 'Academic', file: 'academic.html', icon: 'book', tint: 'var(--tint-academic)' },
  { id: 'agent', label: 'Agent', file: 'agent.html', icon: 'spark', tint: 'var(--tint-agent)' },
  { id: 'calendar', label: 'Calendar', file: 'calendar.html', icon: 'calendar', tint: 'var(--tint-calendar)' },
  { id: 'more', label: 'More', icon: 'grid', screen: true },
];

/** Everything else on the device. These open in the full-screen app viewer. */
const MINI_APPS = [
  { id: 'bluetooth', label: 'Nearby Chat', file: 'Bluetooth.html', icon: 'bluetooth', tint: 'var(--tint-bluetooth)', desc: 'Offline peer-to-peer messaging over Nearby Connections.' },
  { id: 'note', label: 'My Notebook', file: 'my-note.html', icon: 'note', tint: 'var(--tint-note)', desc: 'Rich notes and notebook pages, stored on this device.' },
  { id: 'shelf', label: 'OpenShelf', file: 'openshelf.html', icon: 'shelf', tint: 'var(--tint-shelf)', desc: 'Your open book shelf and reading progress.' },
  { id: 'reminder', label: 'Reminders', file: 'reminder.html', icon: 'alarm', tint: 'var(--tint-reminder)', desc: 'Alarms and reminders with system notifications.' },
  { id: 'store', label: 'Store', file: 'store.html', icon: 'store', tint: 'var(--tint-store)', desc: 'Browse, install and publish mini apps for this device.' },
  { id: 'habit', label: 'Habit Tracker', file: 'habit-tracker.html', icon: 'habit', tint: 'var(--tint-habit)', desc: 'Daily habits, streaks and completion history.' },
];

const TAB_IDS = TABS.map((t) => t.id);
const allApps = [...TABS.filter((t) => t.file), ...MINI_APPS];
const appById = (id) => allApps.find((a) => a.id === id);

/* ── state ──────────────────────────────────────────────────────────────── */
const frames = new Map();       // id -> { frame, wrap, loading }
const state = { tab: 'home', app: null, booted: false };

/* ── NativeKit, always guarded ──────────────────────────────────────────── */
const kit = () => (typeof window.NativeKit === 'object' && window.NativeKit ? window.NativeKit : null);
const nativeAvailable = () => {
  try { return !!(window.NativeKit && window.NativeKit.agent && window.NativeKit.agent.supported && window.NativeKit.agent.supported()); }
  catch { return false; }
};
async function tryNative(fn, fallback = null) {
  try { return await fn(); } catch { return fallback; }
}

/* ── toast ──────────────────────────────────────────────────────────────── */
function toast(message, tone = 'ok') {
  const node = document.createElement('div');
  node.className = 'toast';
  node.dataset.tone = tone;
  node.innerHTML = `${icon(tone === 'error' ? 'info' : 'check')}<span>${esc(message)}</span>`;
  toaster.append(node);
  while (toaster.children.length > 2) toaster.firstElementChild.remove();
  setTimeout(() => {
    node.style.transition = 'opacity 200ms, transform 200ms';
    node.style.opacity = '0';
    node.style.transform = 'translateY(.35rem)';
    setTimeout(() => node.remove(), 240);
  }, 2400);
}
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ── tab bar ────────────────────────────────────────────────────────────── */
function renderTabbar() {
  tabbar.innerHTML = TABS.map((tab) => `
    <button type="button" class="tab" role="tab" id="tab-${tab.id}" data-tab="${tab.id}"
      aria-controls="stage" aria-selected="${tab.id === state.tab}"
      style="--tile-tint:${tab.tint || 'var(--accent)'}">
      ${icon(tab.icon)}
      <span class="tab-label">${esc(tab.label)}</span>
    </button>`).join('');
}

function selectTabUI(id) {
  for (const button of tabbar.querySelectorAll('[data-tab]')) {
    const on = button.dataset.tab === id;
    button.setAttribute('aria-selected', String(on));
    button.tabIndex = on ? 0 : -1;
  }
}

/* ── frames ─────────────────────────────────────────────────────────────── */
function ensureFrame(app) {
  if (frames.has(app.id)) return frames.get(app.id);
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:absolute;inset:0';
  const loading = document.createElement('div');
  loading.className = 'pane-loading';
  loading.innerHTML = '<div class="spinner" role="progressbar" aria-label="Loading"></div>';
  const frame = document.createElement('iframe');
  frame.className = 'pane';
  frame.dataset.pane = app.id;
  frame.title = app.label;
  frame.setAttribute('allow', 'clipboard-write; autoplay');
  frame.addEventListener('load', () => {
    loading.hidden = true;
    if (app.id === 'home') hideSplash();
    // Same-origin: let a page hand control back to the shell.
    try {
      frame.contentWindow.addEventListener('message', onAppMessage);
      frame.contentWindow.NativeKitShell = { openApp, toast, closeApp };
    } catch { /* nothing to inject */ }
  });
  wrap.append(loading, frame);
  stage.append(wrap);
  frame.src = app.file;
  const entry = { frame, wrap, loading };
  frames.set(app.id, entry);
  return entry;
}

function showFrame(id) {
  for (const [key, entry] of frames) {
    const active = key === id;
    entry.frame.dataset.active = String(active);
    entry.frame.setAttribute('aria-hidden', String(!active));
    entry.wrap.style.visibility = active ? 'visible' : 'hidden';
  }
}

function onAppMessage(event) {
  const data = event?.data;
  if (!data || typeof data !== 'object') return;
  if (data.type === 'open-app' && data.id) openApp(data.id);
  else if (data.type === 'toast' && data.message) toast(String(data.message), data.tone === 'error' ? 'error' : 'ok');
}

/* ── routing ────────────────────────────────────────────────────────────── */
function readRoute() {
  const hash = location.hash.replace(/^#\/?/, '');
  if (!hash) return { tab: 'home' };
  const [kind, id] = hash.split('/');
  if (kind === 'app' && appById(id) && !appById(id).screen) return { app: id };
  if (TAB_IDS.includes(kind)) return { tab: kind };
  return { tab: 'home' };
}

function navigate(hash, { replace = false } = {}) {
  const target = `#/${hash}`;
  if (location.hash === target) { applyRoute(readRoute()); return; }
  if (replace) history.replaceState(null, '', target);
  else history.pushState(null, '', target);
  applyRoute(readRoute());
}

function applyRoute(route) {
  if (route.app) { openApp(route.app, { fromRoute: true }); return; }
  closeApp({ fromRoute: true });
  const tab = route.tab || 'home';
  state.tab = tab;
  selectTabUI(tab);
  const meta = TABS.find((t) => t.id === tab);
  if (meta?.screen) {
    moreScreen.hidden = false;
    stage.setAttribute('aria-hidden', 'true');
    for (const [, entry] of frames) entry.wrap.style.visibility = 'hidden';
    renderMore();
    return;
  }
  moreScreen.hidden = true;
  stage.removeAttribute('aria-hidden');
  const entry = ensureFrame(meta);
  showFrame(meta.id);
  paintSplash(meta);
  entry.frame.contentWindow?.scrollTo?.(0, 0);
}

function paintSplash(tabMeta) {
  if (state.booted) return;
  splashHint.textContent = `Opening ${tabMeta.label}…`;
}

function hideSplash() {
  if (state.booted) return;
  state.booted = true;
  splash.dataset.hidden = 'true';
  setTimeout(() => splash.remove(), 400);
}

/* ── mini app viewer ────────────────────────────────────────────────────── */
function openApp(id, { fromRoute = false } = {}) {
  const app = appById(id);
  if (!app || app.screen) return;
  if (!fromRoute && location.hash !== `#/app/${id}`) history.pushState(null, '', `#/app/${id}`);
  if (state.app !== id) {
    appviewStage.innerHTML = '';
    const frame = document.createElement('iframe');
    frame.title = app.label;
    frame.src = app.file;
    frame.style.opacity = '0';
    frame.style.transition = 'opacity 200ms';
    frame.addEventListener('load', () => { frame.style.opacity = '1'; });
    appviewStage.append(frame);
    state.app = id;
  }
  appTitle.textContent = app.label;
  appview.hidden = false;
  requestAnimationFrame(() => { appview.dataset.shown = 'true'; });
  document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', 'false'));
}

function closeApp({ fromRoute = false } = {}) {
  if (!state.app) return;
  const wasHash = location.hash.startsWith('#/app/');
  state.app = null;
  appview.dataset.shown = 'false';
  setTimeout(() => { if (!state.app) { appview.hidden = true; appviewStage.innerHTML = ''; } }, 240);
  if (!fromRoute && wasHash) { history.back(); return; }
  selectTabUI(state.tab);
}

/* ── more screen ────────────────────────────────────────────────────────── */
function tile(app) {
  return `<button type="button" class="tile" data-app="${app.id}" style="--tile-tint:${app.tint || 'var(--accent)'}">
    <span class="tile-icon">${icon(app.icon)}</span>
    <span class="tile-text">
      <span class="tile-name">${esc(app.label)}</span>
      <span class="tile-desc">${esc(app.desc)}</span>
    </span>
  </button>`;
}

function renderMore() {
  if (moreScreen.dataset.rendered === 'v1') { void refreshDeviceRows(); return; }
  moreScreen.dataset.rendered = 'v1';
  moreScreen.innerHTML = `
    <header class="more-head">
      <p class="more-eyebrow">My App</p>
      <h1 class="more-title">More</h1>
      <p class="more-sub">Every mini app on this device, with its own icon and storage.</p>
    </header>

    <p class="section-label">Mini apps <span>${MINI_APPS.length} installed</span></p>
    <div class="app-tiles">${MINI_APPS.map(tile).join('')}</div>

    <p class="section-label">Device</p>
    <div class="rows" id="deviceRows">
      <div class="row"><span class="ico"></span><span class="row-label">Reading device…</span></div>
    </div>

    <p class="section-label">About</p>
    <div class="rows">
      <button type="button" class="row" data-row="share">${icon('share')}<span class="row-label">Share this app</span></button>
      <button type="button" class="row" data-row="settings">${icon('settings')}<span class="row-label">Open system settings</span></button>
      <button type="button" class="row" data-row="home">${icon('home')}<span class="row-label">Back to Home</span></button>
    </div>

    <p class="more-foot">Tabs: ${TABS.filter((t) => t.file).map((t) => t.label).join(' · ')}.<br>
      Every mini app runs from the bundled build — nothing is downloaded at runtime.</p>`;

  moreScreen.addEventListener('click', (event) => {
    const appTile = event.target.closest('[data-app]');
    if (appTile) { navigate(`app/${appTile.dataset.app}`); return; }
    const row = event.target.closest('[data-row]');
    if (!row) return;
    if (row.dataset.row === 'home') navigate('home');
    else if (row.dataset.row === 'settings') void onOpenSettings();
    else if (row.dataset.row === 'share') void onShare();
  });

  void refreshDeviceRows();
}

function deviceRow(iconName, label, value, tone = '') {
  return `<div class="row">${icon(iconName)}<span class="row-label">${esc(label)}</span>
    <span class="row-value"${tone ? ` data-tone="${tone}"` : ''}>${esc(value)}</span></div>`;
}

async function refreshDeviceRows() {
  const rows = document.getElementById('deviceRows');
  if (!rows) return;
  const kitRef = kit();
  if (!kitRef) {
    rows.innerHTML = [
      deviceRow('info', 'Build', 'Preview (no native host)', 'warn'),
      deviceRow('shield', 'Notifications', 'Needs the installed app', 'warn'),
      deviceRow('wifi', 'Network', 'Unavailable in preview', 'warn'),
    ].join('');
    return;
  }
  const [info, net, perms] = await Promise.all([
    tryNative(() => kitRef.app.info()),
    tryNative(() => kitRef.network.status()),
    tryNative(() => kitRef.permissions.check()),
  ]);
  const notificationState = perms?.notifications?.display ?? 'unknown';
  rows.innerHTML = [
    deviceRow('info', 'App', info ? `${info.name} ${info.version}` : 'Unavailable', info ? '' : 'warn'),
    deviceRow('info', 'Build', info?.build ? String(info.build) : 'Unavailable', info?.build ? '' : 'warn'),
    deviceRow('shield', 'Notifications', notificationState, notificationState === 'granted' ? 'ok' : 'warn'),
    deviceRow('wifi', 'Network', net ? `${net.connectionType || 'unknown'}${net.connected ? '' : ' · offline'}` : 'Unavailable', net?.connected ? 'ok' : 'warn'),
    deviceRow('grid', 'Mini apps', `${MINI_APPS.length} installed`),
  ].join('');
}

async function onShare() {
  const kitRef = kit();
  if (!kitRef) { toast('Sharing needs the installed app.', 'error'); return; }
  const info = await tryNative(() => kitRef.app.info());
  const text = info ? `${info.name} ${info.version} (${info.id})` : 'My App';
  const result = await tryNative(() => kitRef.share.show({ title: 'My App', text, dialogTitle: 'Share My App' }));
  if (!result) toast('Nothing on this device can receive the share.', 'error');
}

async function onOpenSettings() {
  const kitRef = kit();
  if (!kitRef) { toast('System settings are only reachable from the installed app.', 'error'); return; }
  const ok = await tryNative(() => kitRef.permissions.openAppSettings());
  if (!ok) toast('Could not open system settings.', 'error');
}

/* ── input wiring ───────────────────────────────────────────────────────── */
tabbar.addEventListener('click', (event) => {
  const button = event.target.closest('[data-tab]');
  if (!button) return;
  const id = button.dataset.tab;
  if (id === state.tab && !state.app) {
    // Re-tapping the active tab returns that app to the top — like every phone OS.
    const entry = frames.get(id);
    entry?.frame.contentWindow?.scrollTo?.({ top: 0, behavior: 'smooth' });
    return;
  }
  navigate(id);
});

document.getElementById('appBack').addEventListener('click', () => closeApp());
document.getElementById('appReload').addEventListener('click', () => {
  const frame = appviewStage.querySelector('iframe');
  if (frame) frame.src = frame.src;
  toast('Reloaded');
});

window.addEventListener('popstate', () => applyRoute(readRoute()));
window.addEventListener('hashchange', () => applyRoute(readRoute()));

// A tab that fails to load must say so instead of leaving a blank stage.
window.addEventListener('error', (event) => {
  if (event?.target?.tagName === 'IFRAME') toast('That page could not be loaded.', 'error');
}, true);

/* ── boot ───────────────────────────────────────────────────────────────── */
renderTabbar();
applyRoute(readRoute());
setTimeout(hideSplash, 2200);           // never trap the user behind a splash
if (!nativeAvailable()) splashHint.textContent = 'Preview mode';
