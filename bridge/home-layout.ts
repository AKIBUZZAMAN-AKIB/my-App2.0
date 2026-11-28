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
