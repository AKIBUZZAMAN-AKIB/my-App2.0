/**
 * Free, keyless open-data services behind three device tools:
 *   search_images     Wikimedia Commons (freely licensed photos, with credit)
 *   geocode_location  Open-Meteo geocoding, falling back to Nominatim (OSM)
 *   get_weather       Open-Meteo forecast, shaped for the chat's Weather card
 *
 * Everything goes through the injected `fetchImpl` (CapacitorHttp on native,
 * a scripted fake in tests). Usage policies honoured:
 *   - Wikimedia and Nominatim require an identifying User-Agent with contact
 *     details; browsers drop `User-Agent`, so `Api-User-Agent` is sent too.
 *   - Nominatim allows at most 1 request per second and asks clients to
 *     cache: requests are spaced >= 1.1 s apart and answers are cached.
 *   - Results carry the attribution each service asks for.
 */

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export const OPEN_DATA_USER_AGENT = 'my-App2.0/1.0 (+https://github.com/AKIBUZZAMAN-AKIB/my-App2.0; akibuzzaman999@gmail.com)';
const HEADERS = { 'User-Agent': OPEN_DATA_USER_AGENT, 'Api-User-Agent': OPEN_DATA_USER_AGENT, Accept: 'application/json' };
const TIMEOUT_MS = 12_000;

export class OpenDataError extends Error {
  constructor(message: string, readonly retryable = false) { super(message); }
}

async function getJson(fetchImpl: FetchLike, url: string, service: string, timeoutMs = TIMEOUT_MS): Promise<any> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new OpenDataError(`${service} did not answer within ${Math.round(timeoutMs / 1000)} s.`, true)), timeoutMs);
  });
  try {
    const response = await Promise.race([fetchImpl(url, { method: 'GET', headers: { ...HEADERS } }), timeout]);
    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      throw new OpenDataError(`${service} answered HTTP ${response.status}${response.status === 429 ? ' (too many requests; wait a little)' : ''}.`, retryable);
    }
    const text = await Promise.race([response.text(), timeout]);
    try { return JSON.parse(text); } catch { throw new OpenDataError(`${service} sent something that is not JSON.`, true); }
  } catch (error) {
    if (error instanceof OpenDataError) throw error;
    throw new OpenDataError(`${service} could not be reached: ${error instanceof Error ? error.message : String(error)}`, true);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Small TTL cache (insertion-ordered, bounded). */
class TtlCache<T> {
  private map = new Map<string, { at: number; value: T }>();
  constructor(private ttlMs: number, private max = 100) {}
  get(key: string, now: number): T | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (now - hit.at > this.ttlMs) { this.map.delete(key); return undefined; }
    return hit.value;
  }
  set(key: string, value: T, now: number) {
    this.map.delete(key);
    this.map.set(key, { at: now, value });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
  }
}

const stripHtml = (s: unknown): string => String(s ?? '')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
  .replace(/\s+/g, ' ')
  .trim();
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;
/** Removes Wikimedia's tracking query from media URLs (the files are the same without it). */
const cleanMediaUrl = (u: unknown): string => {
  const s = typeof u === 'string' ? u : '';
  if (!/^https:\/\//.test(s)) return '';
  try {
    const url = new URL(s);
    for (const k of [...url.searchParams.keys()]) if (k.startsWith('utm_')) url.searchParams.delete(k);
    return url.toString();
  } catch { return ''; }
};

/* ─────────────────────────── search_images ─────────────────────────── */

export interface ImageResult {
  title: string;
  /** A thumbnail sized for the chat (about 640 px wide). */
  image: string;
  width: number;
  height: number;
  /** The original file. */
  original: string;
  /** The Commons page with the full licence and history. */
  page: string;
  description: string;
  author: string;
  license: string;
  licenseUrl: string;
  mime: string;
}

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/svg+xml', 'image/tiff']);

export async function searchCommonsImages(fetchImpl: FetchLike, query: string, limit: number, thumbWidth = 640): Promise<ImageResult[]> {
  const params = new URLSearchParams({
    action: 'query', format: 'json', formatversion: '2', origin: '*',
    generator: 'search', gsrsearch: `filetype:bitmap|drawing ${query}`, gsrnamespace: '6', gsrlimit: String(Math.min(50, limit * 3)),
    prop: 'imageinfo', iiprop: 'url|size|mime|extmetadata', iiurlwidth: String(thumbWidth),
    iiextmetadatafilter: 'Artist|Credit|LicenseShortName|LicenseUrl|ImageDescription|ObjectName|Restrictions|NonFree',
    iiextmetadatalanguage: 'en',
  });
  const data = await getJson(fetchImpl, `https://commons.wikimedia.org/w/api.php?${params}`, 'Wikimedia Commons');
  if (data?.error) throw new OpenDataError(`Wikimedia Commons: ${stripHtml(data.error.info || data.error.code)}`);
  const pages: any[] = Array.isArray(data?.query?.pages) ? data.query.pages : [];
  pages.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const out: ImageResult[] = [];
  for (const p of pages) {
    const info = p?.imageinfo?.[0];
    if (!info) continue;
    const mime = String(info.mime || '');
    if (!ALLOWED_MIME.has(mime)) continue;
    const meta = info.extmetadata || {};
    const val = (k: string) => stripHtml(meta?.[k]?.value);
    if (/^true$/i.test(val('NonFree'))) continue;
    const image = cleanMediaUrl(info.thumburl || info.url);
    if (!image) continue;
    const title = val('ObjectName') || String(p.title || '').replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, '').replace(/_/g, ' ');
    out.push({
      title: cut(title, 140),
      image,
      width: Number(info.thumbwidth || info.width) || 0,
      height: Number(info.thumbheight || info.height) || 0,
      original: cleanMediaUrl(info.url),
      page: String(info.descriptionurl || `https://commons.wikimedia.org/wiki/${encodeURIComponent(String(p.title || ''))}`),
      description: cut(val('ImageDescription'), 240),
      author: cut(val('Artist') || val('Credit') || 'Unknown author', 120),
      license: val('LicenseShortName') || 'See the file page',
      licenseUrl: /^https?:\/\//.test(val('LicenseUrl')) ? val('LicenseUrl') : '',
      mime,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/* ─────────────────────────── geocode_location ─────────────────────────── */

export interface Place {
  name: string;
  /** "Rajshahi Division, Bangladesh" */
  region: string;
  /** The full label, e.g. "Rajshahi, Rajshahi Division, Bangladesh". */
  label: string;
  latitude: number;
  longitude: number;
  country: string;
  countryCode: string;
  admin1: string;
  timezone: string;
  population?: number;
  kind: string;
  source: 'open-meteo' | 'nominatim';
}

const geoCache = new TtlCache<Place[]>(24 * 60 * 60_000, 200);
let lastNominatimAt = 0;
const NOMINATIM_GAP_MS = 1100;

export interface GeoOptions {
  limit?: number;
  /** ISO 3166-1 alpha-2 country code to narrow the search. */
  countryCode?: string;
  language?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const label = (...parts: Array<string | undefined>) => parts.filter((p, i, a) => p && a.indexOf(p) === i).join(', ');

async function openMeteoGeocode(fetchImpl: FetchLike, query: string, o: GeoOptions): Promise<Place[]> {
  // Open-Meteo matches place names, not "street, city" strings: search the first part.
  const name = query.split(',')[0].trim();
  const params = new URLSearchParams({ name, count: String(Math.min(10, Math.max(o.limit ?? 5, 5))), language: o.language || 'en', format: 'json' });
  if (o.countryCode) params.set('countryCode', o.countryCode.toUpperCase());
  const data = await getJson(fetchImpl, `https://geocoding-api.open-meteo.com/v1/search?${params}`, 'Open-Meteo geocoding');
  const rows: any[] = Array.isArray(data?.results) ? data.results : [];
  let places = rows.filter((r) => Number.isFinite(r?.latitude) && Number.isFinite(r?.longitude)).map((r): Place => ({
    name: String(r.name || name),
    region: label(r.admin1, r.country),
    label: label(r.name, r.admin1, r.country),
    latitude: round(r.latitude, 5),
    longitude: round(r.longitude, 5),
    country: String(r.country || ''),
    countryCode: String(r.country_code || '').toUpperCase(),
    admin1: String(r.admin1 || ''),
    timezone: String(r.timezone || ''),
    population: Number.isFinite(r.population) ? r.population : undefined,
    kind: String(r.feature_code || 'place'),
    source: 'open-meteo',
  }));
  // "Paris, Texas": keep the rows whose region mentions the rest of the query.
  const rest = query.split(',').slice(1).map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (rest.length) {
    const hit = places.filter((p) => rest.every((r) => `${p.admin1} ${p.country} ${p.countryCode}`.toLowerCase().includes(r)));
    places = hit;
  }
  return places.slice(0, o.limit ?? 5);
}

async function nominatimGeocode(fetchImpl: FetchLike, query: string, o: GeoOptions): Promise<Place[]> {
  const now = o.now ?? Date.now;
  const wait = lastNominatimAt + NOMINATIM_GAP_MS - now();
  if (wait > 0) await (o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(wait);
  lastNominatimAt = now();
  const params = new URLSearchParams({ q: query, format: 'jsonv2', limit: String(o.limit ?? 5), addressdetails: '1', 'accept-language': o.language || 'en' });
  if (o.countryCode) params.set('countrycodes', o.countryCode.toLowerCase());
  const rows = await getJson(fetchImpl, `https://nominatim.openstreetmap.org/search?${params}`, 'Nominatim');
  if (!Array.isArray(rows)) return [];
  return rows.filter((r) => Number.isFinite(Number(r?.lat)) && Number.isFinite(Number(r?.lon))).map((r): Place => {
    const a = r.address || {};
    const name = String(r.name || a.city || a.town || a.village || a.suburb || String(r.display_name || '').split(',')[0] || query);
    const city = a.city || a.town || a.village || a.municipality || '';
    return {
      name,
      region: label(city !== name ? city : undefined, a.state, a.country),
      label: cut(String(r.display_name || label(name, a.state, a.country)), 200),
      latitude: round(Number(r.lat), 5),
      longitude: round(Number(r.lon), 5),
      country: String(a.country || ''),
      countryCode: String(a.country_code || '').toUpperCase(),
      admin1: String(a.state || ''),
      timezone: '',
      kind: String(r.addresstype || r.type || 'place'),
      source: 'nominatim',
    };
  });
}

/**
 * Open-Meteo first (fast, has timezones and population); Nominatim when it
 * finds nothing or fails, and for addresses ("12 Main St, ...") it cannot match.
 */
export async function geocode(fetchImpl: FetchLike, query: string, o: GeoOptions = {}): Promise<{ places: Place[]; note?: string }> {
  const now = o.now ?? Date.now;
  const key = `${query.toLowerCase()}|${o.countryCode || ''}|${o.language || 'en'}|${o.limit ?? 5}`;
  const cached = geoCache.get(key, now());
  if (cached) return { places: cached };
  const looksLikeAddress = /\d/.test(query.split(',')[0]) || query.split(',').length > 2;
  let places: Place[] = [];
  let firstError: OpenDataError | undefined;
  if (!looksLikeAddress) {
    try { places = await openMeteoGeocode(fetchImpl, query, o); } catch (e) { firstError = e instanceof OpenDataError ? e : new OpenDataError(String(e)); }
  }
  if (!places.length) {
    try { places = await nominatimGeocode(fetchImpl, query, o); } catch (e) {
      const err = e instanceof OpenDataError ? e : new OpenDataError(String(e));
      throw new OpenDataError(firstError ? `${firstError.message} ${err.message}` : err.message, err.retryable);
    }
  }
  if (places.length) geoCache.set(key, places, now());
  return { places, note: firstError && places.length ? `Open-Meteo failed (${firstError.message}); used OpenStreetMap Nominatim.` : undefined };
}

/* ─────────────────────────── get_weather ─────────────────────────── */

export interface WeatherDay {
  date: string;
  weather_code: number | null;
  max: number | null;
  min: number | null;
  precipitation_probability: number | null;
  precipitation: number | null;
  wind_max: number | null;
  uv_index_max: number | null;
  sunrise: string;
  sunset: string;
}

export interface WeatherData {
  id: string;
  source: string;
  location: { name: string; admin1: string; country: string; latitude: number; longitude: number; timezone: string };
  units: { temperature: string; wind: string; precipitation: string };
  current: {
    time: string; temperature: number | null; apparent_temperature: number | null; relative_humidity: number | null;
    wind_speed: number | null; wind_direction: number | null; precipitation: number | null; weather_code: number | null; is_day: boolean;
  };
  daily: WeatherDay[];
  hourly: Array<{ time: string; temperature: number | null; precipitation_probability: number | null; weather_code: number | null }>;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const at = (arr: unknown, i: number): unknown => (Array.isArray(arr) ? arr[i] : undefined);

export async function fetchWeather(
  fetchImpl: FetchLike,
  place: { name: string; admin1?: string; country?: string; latitude: number; longitude: number },
  o: { days: number; units: 'metric' | 'imperial'; id: string },
): Promise<WeatherData> {
  const imperial = o.units === 'imperial';
  const params = new URLSearchParams({
    latitude: String(place.latitude), longitude: String(place.longitude), timezone: 'auto', forecast_days: String(o.days),
    current: 'temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,wind_direction_10m,is_day',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max,uv_index_max,sunrise,sunset',
    hourly: 'temperature_2m,precipitation_probability,weather_code',
    forecast_hours: '24',
  });
  if (imperial) { params.set('temperature_unit', 'fahrenheit'); params.set('wind_speed_unit', 'mph'); params.set('precipitation_unit', 'inch'); }
  const d = await getJson(fetchImpl, `https://api.open-meteo.com/v1/forecast?${params}`, 'Open-Meteo forecast');
  if (d?.error) throw new OpenDataError(`Open-Meteo: ${String(d.reason || 'request refused')}`);
  const c = d?.current || {};
  const daily = d?.daily || {};
  const times: unknown[] = Array.isArray(daily.time) ? daily.time : [];
  const hourly = d?.hourly || {};
  const htimes: unknown[] = Array.isArray(hourly.time) ? hourly.time : [];
  return {
    id: o.id,
    source: 'Open-Meteo.com (CC BY 4.0)',
    location: { name: place.name, admin1: place.admin1 || '', country: place.country || '', latitude: place.latitude, longitude: place.longitude, timezone: String(d?.timezone || '') },
    units: { temperature: String(d?.current_units?.temperature_2m || (imperial ? '°F' : '°C')), wind: String(d?.current_units?.wind_speed_10m || (imperial ? 'mp/h' : 'km/h')), precipitation: String(d?.daily_units?.precipitation_sum || (imperial ? 'inch' : 'mm')) },
    current: {
      time: String(c.time || ''),
      temperature: num(c.temperature_2m), apparent_temperature: num(c.apparent_temperature), relative_humidity: num(c.relative_humidity_2m),
      wind_speed: num(c.wind_speed_10m), wind_direction: num(c.wind_direction_10m), precipitation: num(c.precipitation), weather_code: num(c.weather_code),
      is_day: c.is_day === 1 || c.is_day === true,
    },
    daily: times.map((t, i) => ({
      date: String(t),
      weather_code: num(at(daily.weather_code, i)), max: num(at(daily.temperature_2m_max, i)), min: num(at(daily.temperature_2m_min, i)),
      precipitation_probability: num(at(daily.precipitation_probability_max, i)), precipitation: num(at(daily.precipitation_sum, i)),
      wind_max: num(at(daily.wind_speed_10m_max, i)), uv_index_max: num(at(daily.uv_index_max, i)),
      sunrise: String(at(daily.sunrise, i) ?? ''), sunset: String(at(daily.sunset, i) ?? ''),
    })),
    hourly: htimes.slice(0, 24).map((t, i) => ({ time: String(t), temperature: num(at(hourly.temperature_2m, i)), precipitation_probability: num(at(hourly.precipitation_probability, i)), weather_code: num(at(hourly.weather_code, i)) })),
  };
}

/** WMO weather interpretation codes (Open-Meteo docs), for the text summary. */
export function weatherLabel(code: number | null): string {
  if (code === null) return 'unknown';
  const table: Record<number, string> = {
    0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'freezing fog',
    51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 56: 'light freezing drizzle', 57: 'freezing drizzle',
    61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'light freezing rain', 67: 'freezing rain',
    71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains', 80: 'light showers', 81: 'showers', 82: 'violent showers',
    85: 'light snow showers', 86: 'snow showers', 95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'thunderstorm with heavy hail',
  };
  return table[code] ?? `code ${code}`;
}

/** A short, brace-free summary for the model; the data follows it as JSON. */
export function weatherSummary(w: WeatherData): string {
  const t = (v: number | null) => (v === null ? '?' : `${Math.round(v)}${w.units.temperature}`);
  const where = label(w.location.name, w.location.admin1, w.location.country);
  const c = w.current;
  const lines = [`Weather for ${where} (${w.location.latitude}, ${w.location.longitude}; ${w.location.timezone || 'local time'}), now ${c.time.replace('T', ' ')}: ${t(c.temperature)}, ${weatherLabel(c.weather_code)}, feels like ${t(c.apparent_temperature)}, humidity ${c.relative_humidity ?? '?'}%, wind ${c.wind_speed ?? '?'} ${w.units.wind}.`];
  const next = w.hourly.filter((_, i) => i % 3 === 0).slice(0, 8);
  if (next.length) lines.push(`Next hours: ${next.map((h) => `${h.time.slice(11, 16)} ${t(h.temperature)}${h.precipitation_probability ? ` (${h.precipitation_probability}% rain)` : ''}`).join(', ')}.`);
  for (const d of w.daily) lines.push(`${d.date}: ${weatherLabel(d.weather_code)}, high ${t(d.max)}, low ${t(d.min)}, rain chance ${d.precipitation_probability ?? '?'}%, ${d.precipitation ?? 0} ${w.units.precipitation}.`);
  lines.push(`Show it to the user as a Weather card whose id is ${w.id} (present, or a render_spec Weather element with props.id = "${w.id}"). Credit: weather data by Open-Meteo.com.`);
  return lines.join('\n');
}
