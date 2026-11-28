/**
 * In-app Home screen layout — the shared model behind www/home.html and the
 * agent's home_* device tools.
 *
 * The Home page and the Agent page are both top-level pages of the same
 * WebView origin, so the layout lives in one localStorage key. The agent edits
 * it through the device tools while the Agent screen is open; Home re-reads it
 * whenever it is shown (pageshow / visibilitychange / storage event), so the
 * user sees the agent's changes the moment they return to Home.
 *
 * Everything here is pure (no DOM) so it can be unit-tested; the storage
 * adapter is injected.
 */

export const HOME_LAYOUT_KEY = 'myapp.home.layout.v2';
export const HOME_LAYOUT_EVENT = 'myapp:home-layout';
export const HOME_MAX_WIDGETS = 24;

export type HomeWidgetSize = 's' | 'm' | 'l';
export const HOME_WIDGET_SIZES: readonly HomeWidgetSize[] = ['s', 'm', 'l'];

export interface HomeWidget {
  id: string;
  type: HomeWidgetType;
  size: HomeWidgetSize;
  title?: string;
  accent?: string;
  config: Record<string, unknown>;
}

export interface HomeLayout {
  version: 2;
  widgets: HomeWidget[];
  updatedAt: number;
  updatedBy: 'user' | 'agent' | 'default';
}

export interface HomeWidgetTypeInfo {
  label: string;
  description: string;
  sizes: readonly HomeWidgetSize[];
  defaultSize: HomeWidgetSize;
  /** config keys the widget reads, with a one-line meaning each */
  config: Record<string, string>;
}

/** The catalogue — the same list home.html renders and the tools document. */
export const HOME_WIDGET_TYPES = {
  clock: {
    label: 'Clock',
    description: 'Live time and date. s = digital, m = digital + date + next alarm, l = analog dial.',
    sizes: ['s', 'm', 'l'],
    defaultSize: 'm',
    config: { style: '"digital" or "analog"', hour12: 'true for 12-hour time', timezone: 'IANA zone such as "Europe/London" for a world clock; omit for the phone\'s zone', label: 'caption under the time, e.g. "London"' },
  },
  weather: {
    label: 'Weather',
    description: 'Current weather from Open-Meteo. m adds the next hours, l adds a 5-day forecast.',
    sizes: ['s', 'm', 'l'],
    defaultSize: 'm',
    config: { place: 'place name shown on the card', lat: 'latitude', lon: 'longitude', unit: '"c" or "f"' },
  },
  calendar: {
    label: 'Calendar',
    description: 'Today\'s date; m = week strip with the next event, l = month grid with events.',
    sizes: ['s', 'm', 'l'],
    defaultSize: 'm',
    config: { events: 'array of { date: "YYYY-MM-DD", time?: "HH:MM", title }' },
  },
  battery: {
    label: 'Battery',
    description: 'Battery level ring, charging state and network status.',
    sizes: ['s', 'm'],
    defaultSize: 's',
    config: {},
  },
  alarms: {
    label: 'Alarms',
    description: 'The next native alarm (set with schedule_alarm) and the ones after it.',
    sizes: ['s', 'm', 'l'],
    defaultSize: 'm',
    config: {},
  },
  notes: {
    label: 'Notes',
    description: 'A note or checklist. Checklist items can be ticked on Home.',
    sizes: ['s', 'm', 'l'],
    defaultSize: 'm',
    config: { text: 'note text (plain, line breaks kept)', items: 'checklist: array of strings or { text, done }' },
  },
  stopwatch: {
    label: 'Stopwatch / Timer',
    description: 'Interactive stopwatch with laps, or a countdown timer when seconds is set.',
    sizes: ['s', 'm'],
    defaultSize: 'm',
    config: { mode: '"stopwatch" or "timer"', seconds: 'timer length in seconds' },
  },
  agent: {
    label: 'Agent',
    description: 'The on-device agent: last conversation, running jobs, memories and a shortcut to the Agent screen.',
    sizes: ['m', 'l'],
    defaultSize: 'm',
    config: {},
  },
  apps: {
    label: 'Apps',
    description: 'Shortcut icons to the app\'s screens.',
    sizes: ['m', 'l'],
    defaultSize: 'm',
    config: { apps: 'array of page ids: agent, calendar, browser, notes, reminder, habits, academic, store, more' },
  },
  stat: {
    label: 'Stat',
    description: 'One big number the agent keeps up to date (steps, spend, streak...).',
    sizes: ['s', 'm'],
    defaultSize: 's',
    config: { value: 'the big value, e.g. "8,420"', unit: 'unit after the value', caption: 'line under the value', progress: '0..1 for a progress bar', trend: 'e.g. "+12%" (a leading - shows red)', icon: 'one emoji' },
  },
  list: {
    label: 'List',
    description: 'A short ranked or bulleted list (headlines, top tasks, prices...).',
    sizes: ['m', 'l'],
    defaultSize: 'm',
    config: { items: 'array of strings or { text, detail?, url? }', ordered: 'true for numbers instead of bullets' },
  },
  html: {
    label: 'Custom HTML',
    description: 'Agent-built HTML/CSS/JS in a sandboxed frame (no access to the app). Keep it small and self-contained.',
    sizes: ['s', 'm', 'l'],
    defaultSize: 'm',
    config: { html: 'full HTML for the widget body' },
  },
} as const satisfies Record<string, HomeWidgetTypeInfo>;

export type HomeWidgetType = keyof typeof HOME_WIDGET_TYPES;
export const HOME_WIDGET_TYPE_IDS = Object.keys(HOME_WIDGET_TYPES) as HomeWidgetType[];

const ACCENT_RE = /^(#[0-9a-fA-F]{3,8}|[a-z]+)$/;
const MAX_CONFIG_BYTES = 24_000;

export function isWidgetType(value: unknown): value is HomeWidgetType {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(HOME_WIDGET_TYPES, value);
}

export function fitSize(type: HomeWidgetType, size: unknown): HomeWidgetSize {
  const info: HomeWidgetTypeInfo = HOME_WIDGET_TYPES[type];
  if (typeof size === 'string') {
    const s = ({ small: 's', medium: 'm', large: 'l' } as Record<string, string>)[size] ?? size;
    if ((info.sizes as readonly string[]).includes(s)) return s as HomeWidgetSize;
  }
  return info.defaultSize;
}

let seq = 0;
export function newWidgetId(type: string, now = Date.now()): string {
  seq = (seq + 1) % 1296;
  return `${type}-${now.toString(36).slice(-5)}${seq.toString(36).padStart(2, '0')}`;
}

function cleanConfig(config: unknown): Record<string, unknown> {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return {};
  const json = JSON.stringify(config);
  if (json.length > MAX_CONFIG_BYTES) throw new Error(`Widget config is too large (${json.length} bytes, max ${MAX_CONFIG_BYTES}).`);
  return JSON.parse(json);
}

/** Validate one widget; throws a clear message for the agent on bad input. */
export function normalizeWidget(raw: any, now = Date.now()): HomeWidget {
  if (!raw || typeof raw !== 'object') throw new Error('A widget must be an object.');
  if (!isWidgetType(raw.type)) throw new Error(`Unknown widget type "${raw.type}". Use one of: ${HOME_WIDGET_TYPE_IDS.join(', ')}.`);
  const widget: HomeWidget = {
    id: typeof raw.id === 'string' && /^[\w.-]{1,48}$/.test(raw.id) ? raw.id : newWidgetId(raw.type, now),
    type: raw.type,
    size: fitSize(raw.type, raw.size),
    config: cleanConfig(raw.config),
  };
  if (typeof raw.title === 'string' && raw.title.trim()) widget.title = raw.title.trim().slice(0, 60);
  if (typeof raw.accent === 'string' && ACCENT_RE.test(raw.accent.trim())) widget.accent = raw.accent.trim();
  return widget;
}

export function defaultHomeLayout(now = Date.now()): HomeLayout {
  const w = (id: string, type: HomeWidgetType, size: HomeWidgetSize, config: Record<string, unknown> = {}): HomeWidget => ({ id, type, size, config });
  return {
    version: 2,
    updatedAt: now,
    updatedBy: 'default',
    widgets: [
      w('clock-main', 'clock', 'm'),
      w('weather-main', 'weather', 's', { place: 'Dhaka', lat: 23.8103, lon: 90.4125 }),
      w('battery-main', 'battery', 's'),
      w('agent-main', 'agent', 'm'),
      w('calendar-main', 'calendar', 's'),
      w('alarms-main', 'alarms', 's'),
      w('apps-main', 'apps', 'm'),
      w('notes-main', 'notes', 'm', { items: [{ text: 'Long-press Home to edit widgets', done: false }, { text: 'Ask the agent to set up your Home', done: false }] }),
      w('stopwatch-main', 'stopwatch', 'm'),
    ],
  };
}

/** Parse whatever is stored; anything unreadable falls back to the default. */
export function parseHomeLayout(json: string | null | undefined, now = Date.now()): HomeLayout {
  if (!json) return defaultHomeLayout(now);
  try {
    const raw = JSON.parse(json);
    if (!raw || !Array.isArray(raw.widgets)) return defaultHomeLayout(now);
    const seen = new Set<string>();
    const widgets: HomeWidget[] = [];
    for (const item of raw.widgets) {
      try {
        const widget = normalizeWidget(item, now);
        if (seen.has(widget.id)) widget.id = newWidgetId(widget.type, now);
        seen.add(widget.id);
        widgets.push(widget);
      } catch { /* drop unreadable widget */ }
    }
    return { version: 2, widgets: widgets.slice(0, HOME_MAX_WIDGETS), updatedAt: Number(raw.updatedAt) || now, updatedBy: raw.updatedBy === 'agent' ? 'agent' : raw.updatedBy === 'default' ? 'default' : 'user' };
  } catch {
    return defaultHomeLayout(now);
  }
}

export interface HomeStore {
  read(): string | null;
  write(json: string): void;
}

/** localStorage adapter used on device; also tells an open Home page to re-render. */
export function localHomeStore(): HomeStore {
  return {
    read: () => {
      try { return globalThis.localStorage?.getItem(HOME_LAYOUT_KEY) ?? null; } catch { return null; }
    },
    write: (json) => {
      globalThis.localStorage?.setItem(HOME_LAYOUT_KEY, json);
      try { globalThis.dispatchEvent?.(new CustomEvent(HOME_LAYOUT_EVENT)); } catch { /* no DOM */ }
    },
  };
}

function findIndex(layout: HomeLayout, id: unknown): number {
  const index = layout.widgets.findIndex((widget) => widget.id === id);
  if (index < 0) throw new Error(`No widget with id "${id}" on Home. Call home_get_layout to see the ids.`);
  return index;
}

function clampPosition(position: unknown, length: number): number {
  const n = Number(position);
  if (!Number.isFinite(n)) return length;
  return Math.max(0, Math.min(length, Math.trunc(n)));
}

export function addWidget(layout: HomeLayout, input: any, now = Date.now()): { layout: HomeLayout; widget: HomeWidget } {
  if (layout.widgets.length >= HOME_MAX_WIDGETS) throw new Error(`Home already has ${HOME_MAX_WIDGETS} widgets; remove one first.`);
  const widget = normalizeWidget({ ...input, id: undefined }, now);
  const widgets = [...layout.widgets];
  widgets.splice(clampPosition(input?.position, widgets.length), 0, widget);
  return { layout: { ...layout, widgets, updatedAt: now, updatedBy: 'agent' }, widget };
}

export function updateWidget(layout: HomeLayout, input: any, now = Date.now()): { layout: HomeLayout; widget: HomeWidget } {
  const index = findIndex(layout, input?.id);
  const current = layout.widgets[index];
  const config = input?.replaceConfig ? cleanConfig(input.config) : { ...current.config, ...cleanConfig(input?.config) };
  const next = normalizeWidget({
    ...current,
    config,
    size: input?.size ?? current.size,
    title: input?.title === '' ? undefined : input?.title ?? current.title,
    accent: input?.accent === '' ? undefined : input?.accent ?? current.accent,
  }, now);
  const wanted = typeof input?.size === 'string' ? (({ small: 's', medium: 'm', large: 'l' } as Record<string, string>)[input.size] ?? input.size) : undefined;
  if (wanted !== undefined && !(HOME_WIDGET_TYPES[current.type].sizes as readonly string[]).includes(wanted)) {
    throw new Error(`Size "${input.size}" is not available for ${current.type}; use one of ${HOME_WIDGET_TYPES[current.type].sizes.join(', ')}.`);
  }
  const widgets = [...layout.widgets];
  widgets[index] = next;
  return { layout: { ...layout, widgets, updatedAt: now, updatedBy: 'agent' }, widget: next };
}

export function removeWidget(layout: HomeLayout, id: unknown, now = Date.now()): { layout: HomeLayout; widget: HomeWidget } {
  const index = findIndex(layout, id);
  const widgets = [...layout.widgets];
  const [widget] = widgets.splice(index, 1);
  return { layout: { ...layout, widgets, updatedAt: now, updatedBy: 'agent' }, widget };
}

export function moveWidget(layout: HomeLayout, id: unknown, position: unknown, now = Date.now()): { layout: HomeLayout; widget: HomeWidget; position: number } {
  const index = findIndex(layout, id);
  const widgets = [...layout.widgets];
  const [widget] = widgets.splice(index, 1);
  const at = clampPosition(position, widgets.length);
  widgets.splice(at, 0, widget);
  return { layout: { ...layout, widgets, updatedAt: now, updatedBy: 'agent' }, widget, position: at };
}

export function replaceWidgets(layout: HomeLayout, list: unknown, now = Date.now()): HomeLayout {
  if (!Array.isArray(list)) throw new Error('widgets must be an array.');
  if (list.length > HOME_MAX_WIDGETS) throw new Error(`At most ${HOME_MAX_WIDGETS} widgets.`);
  const seen = new Set<string>();
  const widgets = list.map((item, i) => {
    try {
      const widget = normalizeWidget(item, now);
      if (seen.has(widget.id)) widget.id = newWidgetId(widget.type, now);
      seen.add(widget.id);
      return widget;
    } catch (error) {
      throw new Error(`widgets[${i}]: ${(error as Error).message}`);
    }
  });
  return { ...layout, widgets, updatedAt: now, updatedBy: 'agent' };
}

/** Compact description for the agent: ids, order and settings. */
export function describeLayout(layout: HomeLayout): Record<string, unknown> {
  return {
    widgets: layout.widgets.map((widget, position) => ({ position, ...widget })),
    updatedAt: new Date(layout.updatedAt).toISOString(),
    updatedBy: layout.updatedBy,
    grid: 'Two columns on a phone. s = one square cell (half width), m = full width and one cell tall, l = full width and two cells tall. Widgets flow in order; small ones pair up side by side.',
  };
}

export function describeCatalog(): Record<string, unknown> {
  return Object.fromEntries(HOME_WIDGET_TYPE_IDS.map((id) => {
    const info: HomeWidgetTypeInfo = HOME_WIDGET_TYPES[id];
    return [id, { description: info.description, sizes: info.sizes, defaultSize: info.defaultSize, config: info.config }];
  }));
}

// ── Agent control of the Home screen ─────────────────────────────────────────
// Everything the user can do on Home, the agent can do too. Settings and widget
// state live in localStorage next to the layout, so a change lands even when
// Home is not open; actions that only make sense on a visible page (open an app,
// enter edit mode, open the add sheet) go through a one-shot command that an
// open Home page runs at once and a closed one runs the next time it is shown.

export const HOME_PREFS_KEY = 'myapp.home.prefs.v1';
export const HOME_COMMAND_KEY = 'myapp.home.command.v1';
export const HOME_STOPWATCH_KEY = 'myapp.home.stopwatch.v1';
export const HOME_COMMAND_EVENT = 'myapp:home-command';

export type HomeTheme = 'system' | 'light' | 'dark';
export type HomeTextSize = 'compact' | 'default' | 'large';
export type HomeDensity = 'comfortable' | 'compact';

export interface HomePrefs {
  theme: HomeTheme;
  textSize: HomeTextSize;
  density: HomeDensity;
  /** hex accent used for buttons and highlights; empty = the agent app's neutral primary */
  accent: string;
  greeting: string;
}

export const DEFAULT_HOME_PREFS: HomePrefs = { theme: 'system', textSize: 'default', density: 'comfortable', accent: '', greeting: '' };

export const HOME_APP_IDS = ['agent', 'calendar', 'browser', 'notes', 'reminder', 'habits', 'academic', 'store', 'more'] as const;

/** Every action home_control accepts, with what it needs. Shown to the model in the tool description. */
export const HOME_CONTROL_ACTIONS = {
  get_state: 'Read Home settings, the layout summary and each stopwatch/timer state.',
  set_theme: 'value: "system" | "light" | "dark".',
  set_text_size: 'value: "compact" | "default" | "large" — scales every font on Home.',
  set_density: 'value: "comfortable" | "compact" — spacing between and inside widgets.',
  set_accent: 'value: hex colour like "#6366f1", or "" for the default neutral accent.',
  set_greeting: 'value: custom greeting line (max 40 chars), or "" for the time-of-day greeting.',
  stopwatch_start: 'id: stopwatch widget id (optional when Home has one stopwatch).',
  stopwatch_pause: 'id: stopwatch widget id (optional).',
  stopwatch_reset: 'id: stopwatch widget id (optional).',
  stopwatch_lap: 'id: stopwatch widget id (optional); only while running.',
  check_item: 'id: notes widget id (optional when one checklist), index: 0-based item, done: true|false (omit to toggle).',
  open_app: 'value: one of ' + HOME_APP_IDS.join(', ') + ' — opens that screen from Home.',
  edit_mode: 'value: true | false — the wobbling rearrange mode.',
  open_add_sheet: 'Open the "Add a widget" sheet.',
  refresh: 'Reload live data (weather, battery, alarms, agent status).',
  scroll_to: 'id: widget id to scroll into view and highlight.',
} as const;
export type HomeControlAction = keyof typeof HOME_CONTROL_ACTIONS;
export const HOME_CONTROL_ACTION_IDS = Object.keys(HOME_CONTROL_ACTIONS) as HomeControlAction[];

/** Actions that need a visible Home page; they are queued as a command. */
export const HOME_PAGE_ACTIONS: readonly HomeControlAction[] = ['open_app', 'edit_mode', 'open_add_sheet', 'refresh', 'scroll_to'];

export interface HomeCommand { id: string; action: HomeControlAction; args: Record<string, unknown>; at: number }

export interface StopwatchState { run: boolean; start: number; acc: number; laps: number[]; done: boolean }

export interface HomeStateStore {
  readPrefs(): string | null;
  writePrefs(json: string): void;
  readStopwatches(): string | null;
  writeStopwatches(json: string): void;
  sendCommand(json: string): void;
}

export function parseHomePrefs(json: string | null | undefined): HomePrefs {
  let raw: any = null;
  try { raw = json ? JSON.parse(json) : null; } catch { raw = null; }
  const p = { ...DEFAULT_HOME_PREFS };
  if (!raw || typeof raw !== 'object') return p;
  if (['system', 'light', 'dark'].includes(raw.theme)) p.theme = raw.theme;
  if (['compact', 'default', 'large'].includes(raw.textSize)) p.textSize = raw.textSize;
  if (['comfortable', 'compact'].includes(raw.density)) p.density = raw.density;
  if (typeof raw.accent === 'string' && (raw.accent === '' || /^#[0-9a-f]{6}$/i.test(raw.accent))) p.accent = raw.accent;
  if (typeof raw.greeting === 'string') p.greeting = raw.greeting.slice(0, 40);
  return p;
}

export function applyPref(prefs: HomePrefs, action: HomeControlAction, value: unknown): HomePrefs {
  const next = { ...prefs };
  const pick = <T extends string>(allowed: readonly T[], label: string): T => {
    if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) throw new Error(`${label} must be one of ${allowed.join(', ')}.`);
    return value as T;
  };
  switch (action) {
    case 'set_theme': next.theme = pick(['system', 'light', 'dark'] as const, 'value'); break;
    case 'set_text_size': next.textSize = pick(['compact', 'default', 'large'] as const, 'value'); break;
    case 'set_density': next.density = pick(['comfortable', 'compact'] as const, 'value'); break;
    case 'set_accent': {
      const v = typeof value === 'string' ? value.trim() : '';
      if (v !== '' && !/^#[0-9a-f]{6}$/i.test(v)) throw new Error('value must be a hex colour like #6366f1, or "" for the default.');
      next.accent = v; break;
    }
    case 'set_greeting': next.greeting = typeof value === 'string' ? value.trim().slice(0, 40) : ''; break;
    default: throw new Error(`${action} is not a setting.`);
  }
  return next;
}

function pickWidget(layout: HomeLayout, type: HomeWidgetType, id: unknown): HomeWidget {
  if (id !== undefined && id !== null && id !== '') {
    const w = layout.widgets.find((x) => x.id === id);
    if (!w) throw new Error(`No widget with id "${id}" on Home. Call home_get_layout to see the ids.`);
    if (w.type !== type) throw new Error(`Widget "${id}" is a ${w.type}, not a ${type}.`);
    return w;
  }
  const all = layout.widgets.filter((x) => x.type === type);
  if (all.length === 1) return all[0];
  if (!all.length) throw new Error(`Home has no ${type} widget. Add one with home_add_widget first.`);
  throw new Error(`Home has ${all.length} ${type} widgets (${all.map((x) => x.id).join(', ')}); pass id.`);
}

export function parseStopwatches(json: string | null | undefined): Record<string, StopwatchState> {
  try { const v = json ? JSON.parse(json) : {}; return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}

export function stopwatchAction(layout: HomeLayout, all: Record<string, StopwatchState>, action: HomeControlAction, id: unknown, now = Date.now()): { all: Record<string, StopwatchState>; widget: HomeWidget; state: StopwatchState } {
  const widget = pickWidget(layout, 'stopwatch', id);
  const s: StopwatchState = Object.assign({ run: false, start: 0, acc: 0, laps: [], done: false }, all[widget.id] || {});
  const elapsed = () => s.acc + (s.run ? now - s.start : 0);
  if (action === 'stopwatch_start' && !s.run) { s.start = now; s.run = true; s.done = false; }
  if (action === 'stopwatch_pause' && s.run) { s.acc = elapsed(); s.run = false; }
  if (action === 'stopwatch_reset') Object.assign(s, { run: false, start: 0, acc: 0, laps: [], done: false });
  if (action === 'stopwatch_lap') { if (!s.run) throw new Error('The stopwatch is not running; start it first.'); s.laps = [...s.laps, elapsed()]; }
  return { all: { ...all, [widget.id]: s }, widget, state: s };
}

export function checkItem(layout: HomeLayout, id: unknown, index: unknown, done: unknown, now = Date.now()): { layout: HomeLayout; widget: HomeWidget; item: { text: string; done: boolean } } {
  const candidates = id ? [pickWidget(layout, 'notes', id)] : layout.widgets.filter((w) => w.type === 'notes' && Array.isArray(w.config.items) && (w.config.items as unknown[]).length);
  if (candidates.length !== 1) throw new Error(candidates.length ? 'Home has several checklists; pass id.' : 'Home has no checklist. Add a notes widget with config.items first.');
  const widget = candidates[0];
  const items = (Array.isArray(widget.config.items) ? widget.config.items : []).map((it: any) => typeof it === 'string' ? { text: it, done: false } : { text: String(it?.text ?? ''), done: !!it?.done });
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= items.length) throw new Error(`index must be 0..${items.length - 1}.`);
  items[i] = { ...items[i], done: typeof done === 'boolean' ? done : !items[i].done };
  const next = { ...widget, config: { ...widget.config, items } };
  const widgets = layout.widgets.map((w) => (w.id === widget.id ? next : w));
  return { layout: { ...layout, widgets, updatedAt: now, updatedBy: 'agent' }, widget: next, item: items[i] };
}

export function makeCommand(action: HomeControlAction, args: Record<string, unknown>, now = Date.now()): HomeCommand {
  if (action === 'open_app' && !(HOME_APP_IDS as readonly string[]).includes(String(args.value))) throw new Error(`value must be one of ${HOME_APP_IDS.join(', ')}.`);
  return { id: `cmd-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`, action, args, at: now };
}

/** localStorage adapter for prefs, stopwatch state and page commands. */
export function localHomeStateStore(): HomeStateStore {
  const get = (k: string) => { try { return globalThis.localStorage?.getItem(k) ?? null; } catch { return null; } };
  const set = (k: string, v: string, event: string) => {
    globalThis.localStorage?.setItem(k, v);
    try { globalThis.dispatchEvent?.(new CustomEvent(event)); } catch { /* no DOM */ }
  };
  return {
    readPrefs: () => get(HOME_PREFS_KEY),
    writePrefs: (json) => set(HOME_PREFS_KEY, json, HOME_LAYOUT_EVENT),
    readStopwatches: () => get(HOME_STOPWATCH_KEY),
    writeStopwatches: (json) => set(HOME_STOPWATCH_KEY, json, HOME_LAYOUT_EVENT),
    sendCommand: (json) => set(HOME_COMMAND_KEY, json, HOME_COMMAND_EVENT),
  };
}
