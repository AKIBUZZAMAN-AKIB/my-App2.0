import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createDeviceToolsTransport, defaultDeviceToolDeps, DEVICE_SERVER_NAME, type DeviceToolDeps } from '../bridge/device-tools';
import { McpClient } from '../bridge/mcp-client';
import { fetchWeather, geocode, OPEN_DATA_USER_AGENT, searchCommonsImages, weatherLabel, type FetchLike } from '../bridge/open-data';

// Responses captured from the live services on 2026-11-14.
const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', 'open-data', name), 'utf8');

type Scripted = { body: string; ok?: boolean; status?: number } | Error;

/** A fetch fake that answers by URL prefix, in order, and records every call. */
function fakeFetch(routes: Array<[string, Scripted]>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const queue = [...routes];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {} });
    const i = queue.findIndex(([prefix]) => url.startsWith(prefix));
    if (i < 0) throw new Error(`unexpected fetch ${url}`);
    const [, r] = queue.splice(i, 1)[0];
    if (r instanceof Error) throw r;
    return { ok: r.ok ?? true, status: r.status ?? 200, text: async () => r.body };
  };
  return { fetchImpl, calls };
}

const GEO = 'https://geocoding-api.open-meteo.com/v1/search';
const NOM = 'https://nominatim.openstreetmap.org/search';
const WX = 'https://api.open-meteo.com/v1/forecast';
const COMMONS = 'https://commons.wikimedia.org/w/api.php';

let clock = 1_700_000_000_000;
const now = () => (clock += 5_000); // every call is 5 s later: no Nominatim wait, no cache sharing by time
const noSleep = async () => {};

function depsWith(fetchImpl: FetchLike): DeviceToolDeps {
  const deps = defaultDeviceToolDeps();
  return { ...deps, fetchImpl, now } as DeviceToolDeps;
}
async function call(fetchImpl: FetchLike, name: string, args: Record<string, unknown>) {
  const client = new McpClient(DEVICE_SERVER_NAME, createDeviceToolsTransport(depsWith(fetchImpl), { features: {} }), { protocolVersion: 'auto' });
  const result: any = await client.callTool(name, args);
  return { result, text: String(result?.content?.find((b: any) => b.type === 'text')?.text ?? '') };
}

describe('search_images (Wikimedia Commons)', () => {
  it('returns freely licensed images with thumbnail, author, licence and page', async () => {
    const { fetchImpl, calls } = fakeFetch([[COMMONS, { body: fixture('commons-varendra.json') }]]);
    const images = await searchCommonsImages(fetchImpl, 'Varendra Research Museum', 3);
    expect(images).toHaveLength(3);
    const first = images[0];
    // Search rank (`index`), not the order of the pages object.
    expect(first.title).toBe('Varendra Research Museum (26)');
    expect(first.image).toMatch(/^https:\/\/(thumb|upload)\.wikimedia\.org\//);
    expect(first.image).not.toMatch(/utm_/);
    expect(first.author).toBe('Masum-al-hasan');
    expect(first.license).toBe('CC BY-SA 4.0');
    expect(first.page).toMatch(/^https:\/\/commons\.wikimedia\.org\/wiki\/File:/);
    expect(first.width).toBe(640);
    // Policy: identify the client; search only the File namespace, bitmaps and drawings.
    expect(calls[0].headers['Api-User-Agent']).toBe(OPEN_DATA_USER_AGENT);
    expect(calls[0].headers['User-Agent']).toMatch(/github\.com\/AKIBUZZAMAN-AKIB/);
    const url = new URL(calls[0].url);
    expect(url.searchParams.get('gsrnamespace')).toBe('6');
    expect(url.searchParams.get('gsrsearch')).toBe('filetype:bitmap|drawing Varendra Research Museum');
    expect(url.searchParams.get('origin')).toBe('*');
  });

  it('drops non-free files and formats it cannot show', async () => {
    const data = JSON.parse(fixture('commons-varendra.json'));
    data.query.pages[0].imageinfo[0].extmetadata.NonFree = { value: 'true' };
    data.query.pages[1].imageinfo[0].mime = 'application/pdf';
    const { fetchImpl } = fakeFetch([[COMMONS, { body: JSON.stringify(data) }]]);
    const images = await searchCommonsImages(fetchImpl, 'x', 12);
    const titles = images.map((i) => i.title);
    expect(titles).not.toContain('Vishnu at Varendra Research Museum');
    expect(images.length).toBe(data.query.pages.length - 2);
  });

  it('the tool lists images and credits; no match is not an error', async () => {
    const a = fakeFetch([[COMMONS, { body: fixture('commons-varendra.json') }]]);
    const ok = await call(a.fetchImpl, 'search_images', { query: 'Varendra Research Museum', maxResults: 2 });
    expect(ok.result.isError).toBeFalsy();
    expect(ok.text).toMatch(/^2 images from Wikimedia Commons/);
    expect(ok.text).toMatch(/1\. Varendra Research Museum \(26\): https:\/\/\S+ \(640×\d+\)\. By Masum-al-hasan, CC BY-SA 4\.0\. Page: https:\/\/commons/);
    expect((ok.result.structuredContent as any).images).toHaveLength(2);
    const b = fakeFetch([[COMMONS, { body: '{"batchcomplete":true}' }]]);
    const none = await call(b.fetchImpl, 'search_images', { query: 'zzzz' });
    expect(none.result.isError).toBeFalsy();
    expect(none.text).toMatch(/No freely licensed images/);
  });

  it('validates input and reports service errors as retryable', async () => {
    const { fetchImpl } = fakeFetch([[COMMONS, { body: 'busy', ok: false, status: 503 }]]);
    expect((await call(fetchImpl, 'search_images', {})).text).toMatch(/'query' is required/);
    expect((await call(fetchImpl, 'search_images', { query: 'a', maxResults: 40 })).text).toMatch(/between 1 and 12/);
    const failed = await call(fetchImpl, 'search_images', { query: 'cats' });
    expect(failed.result.isError).toBe(true);
    expect(failed.text).toMatch(/HTTP 503.*Retry once/);
  });
});

describe('geocode_location', () => {
  it('uses Open-Meteo first and returns region, coordinates and time zone', async () => {
    const { fetchImpl, calls } = fakeFetch([[GEO, { body: fixture('geocode-rajshahi.json') }]]);
    const { places } = await geocode(fetchImpl, 'Rajshahi', { limit: 2, now, sleep: noSleep });
    expect(places[0]).toMatchObject({ name: 'Rajshahi', country: 'Bangladesh', countryCode: 'BD', admin1: 'Rajshahi Division', timezone: 'Asia/Dhaka', source: 'open-meteo' });
    expect(places[0].latitude).toBeCloseTo(24.374, 3);
    expect(places[0].label).toBe('Rajshahi, Rajshahi Division, Bangladesh');
    expect(calls).toHaveLength(1);
  });

  it('narrows "Paris, Texas" by the region after the comma', async () => {
    const { fetchImpl, calls } = fakeFetch([[GEO, { body: fixture('geocode-paris.json') }]]);
    const { places } = await geocode(fetchImpl, 'Paris, Texas', { now, sleep: noSleep });
    expect(new URL(calls[0].url).searchParams.get('name')).toBe('Paris');
    expect(places.length).toBeGreaterThan(0);
    expect(places.every((p) => p.admin1 === 'Texas')).toBe(true);
  });

  it('falls back to Nominatim when Open-Meteo finds nothing, with an identifying User-Agent', async () => {
    const { fetchImpl, calls } = fakeFetch([[GEO, { body: '{"generationtime_ms":0.1}' }], [NOM, { body: fixture('nominatim-sagarpara.json') }]]);
    const { places } = await geocode(fetchImpl, 'Sagarpara Rajshahi', { now, sleep: noSleep });
    expect(places[0].source).toBe('nominatim');
    expect(places[0].name).toBe('Sagarpara');
    expect(places[0].countryCode).toBe('BD');
    expect(calls[1].headers['User-Agent']).toBe(OPEN_DATA_USER_AGENT);
    expect(new URL(calls[1].url).searchParams.get('format')).toBe('jsonv2');
  });

  it('sends street addresses straight to Nominatim, and falls back when Open-Meteo is down', async () => {
    const a = fakeFetch([[NOM, { body: fixture('nominatim-sagarpara.json') }]]);
    await geocode(a.fetchImpl, '12 Sagarpara Road, Rajshahi', { now, sleep: noSleep });
    expect(a.calls.map((c) => new URL(c.url).host)).toEqual(['nominatim.openstreetmap.org']);
    const b = fakeFetch([[GEO, new Error('offline')], [NOM, { body: fixture('nominatim-sagarpara.json') }]]);
    const r = await geocode(b.fetchImpl, 'Sagarpara', { now, sleep: noSleep });
    expect(r.places[0].source).toBe('nominatim');
    expect(r.note).toMatch(/Open-Meteo failed/);
  });

  it('spaces Nominatim requests at least 1.1 s apart and caches answers', async () => {
    let t = 10_000_000_000;
    const waits: number[] = [];
    const fixedNow = () => t;
    const sleep = async (ms: number) => { waits.push(ms); t += ms; };
    const { fetchImpl, calls } = fakeFetch([[NOM, { body: fixture('nominatim-sagarpara.json') }], [NOM, { body: fixture('nominatim-sagarpara.json') }]]);
    await geocode(fetchImpl, '1 First St, Town', { now: fixedNow, sleep });
    await geocode(fetchImpl, '2 Second St, Town', { now: fixedNow, sleep });
    expect(waits.length).toBeGreaterThanOrEqual(1);
    expect(waits[waits.length - 1]).toBeGreaterThanOrEqual(1000);
    await geocode(fetchImpl, '2 Second St, Town', { now: fixedNow, sleep });
    expect(calls).toHaveLength(2); // the third answer came from the cache
  });

  it('the tool lists matches with credit and validates the country code', async () => {
    const { fetchImpl } = fakeFetch([[GEO, { body: fixture('geocode-rajshahi.json') }]]);
    const ok = await call(fetchImpl, 'geocode_location', { query: 'Rajshahi town', countryCode: 'BD', maxResults: 1 });
    expect(ok.text).toMatch(/^1 match for "Rajshahi town":\n1\. Rajshahi, Rajshahi Division, Bangladesh: 24\.374, 88\.60114 \(Asia\/Dhaka\)/);
    expect(ok.text).toMatch(/Geocoding by Open-Meteo\.com/);
    expect((await call(fetchImpl, 'geocode_location', { query: 'x', countryCode: 'BGD' })).text).toMatch(/two-letter/);
  });
});

describe('get_weather (Open-Meteo)', () => {
  it('shapes the forecast for the Weather card', async () => {
    const { fetchImpl, calls } = fakeFetch([[WX, { body: fixture('forecast-rajshahi.json') }]]);
    const w = await fetchWeather(fetchImpl, { name: 'Rajshahi', admin1: 'Rajshahi Division', country: 'Bangladesh', latitude: 24.374, longitude: 88.60114 }, { days: 3, units: 'metric', id: 'wx-test' });
    expect(w.id).toBe('wx-test');
    expect(w.units).toEqual({ temperature: '°C', wind: 'km/h', precipitation: 'mm' });
    expect(w.current).toMatchObject({ time: '2026-11-14T09:30', temperature: 25.6, apparent_temperature: 27.7, relative_humidity: 62, weather_code: 0, is_day: true });
    expect(w.daily).toHaveLength(3);
    expect(w.daily[0]).toMatchObject({ date: '2026-11-14', sunrise: '2026-11-14T06:20' });
    expect(typeof w.daily[0].max).toBe('number');
    expect(w.hourly).toHaveLength(24);
    expect(w.location.timezone).toBe('Asia/Dhaka');
    const url = new URL(calls[0].url);
    expect(url.searchParams.get('timezone')).toBe('auto');
    expect(url.searchParams.get('forecast_days')).toBe('3');
    expect(url.searchParams.get('temperature_unit')).toBeNull();
  });

  it('asks for imperial units when told to', async () => {
    const { fetchImpl, calls } = fakeFetch([[WX, { body: fixture('forecast-rajshahi.json') }]]);
    await fetchWeather(fetchImpl, { name: 'x', latitude: 1, longitude: 2 }, { days: 1, units: 'imperial', id: 'wx-1' });
    const p = new URL(calls[0].url).searchParams;
    expect([p.get('temperature_unit'), p.get('wind_speed_unit'), p.get('precipitation_unit')]).toEqual(['fahrenheit', 'mph', 'inch']);
  });

  it('the tool geocodes a name, summarises, and ends with JSON the card can read', async () => {
    const { fetchImpl, calls } = fakeFetch([[GEO, { body: fixture('geocode-rajshahi.json') }], [WX, { body: fixture('forecast-rajshahi.json') }]]);
    const { result, text } = await call(fetchImpl, 'get_weather', { location: 'Rajshahi', days: 3 });
    expect(result.isError).toBeFalsy();
    expect(calls.map((c) => new URL(c.url).host)).toEqual(['geocoding-api.open-meteo.com', 'api.open-meteo.com']);
    expect(text).toMatch(/Weather for Rajshahi, Rajshahi Division, Bangladesh \(24\.374, 88\.60114; Asia\/Dhaka\), now 2026-11-14 09:30: 26°C, clear sky/);
    expect(text).toMatch(/2026-11-14: .*high \d+°C, low \d+°C/);
    expect(text).toMatch(/Next hours: /);
    expect(text).toMatch(/Credit: weather data by Open-Meteo\.com/);
    // The page's Weather card parses from the first line that starts with "{" to the last "}".
    const body = text.replace(/\n?<\/untrusted_[a-z_]+>$/, '');
    const json = JSON.parse(body.slice(body.indexOf('\n{') + 1, body.lastIndexOf('}') + 1));
    expect(json.id).toMatch(/^wx-[a-z0-9]+$/);
    expect(text).toContain(`whose id is ${json.id}`);
    expect(json.daily).toHaveLength(3);
    expect(json.hourly).toBeUndefined(); // only in structuredContent
    expect(result.structuredContent.hourly).toHaveLength(24);
    // The summary before the JSON must not contain a brace, or the card would parse the wrong span.
    expect(body.slice(0, body.indexOf('\n{'))).not.toMatch(/[{}]/);
  });

  it('takes coordinates directly and validates them', async () => {
    const { fetchImpl, calls } = fakeFetch([[WX, { body: fixture('forecast-rajshahi.json') }]]);
    const ok = await call(fetchImpl, 'get_weather', { latitude: 24.37, longitude: 88.6 });
    expect(ok.result.isError).toBeFalsy();
    expect(calls).toHaveLength(1);
    expect((await call(fetchImpl, 'get_weather', { latitude: 24 })).text).toMatch(/both latitude and longitude/);
    expect((await call(fetchImpl, 'get_weather', { latitude: 124, longitude: 0 })).text).toMatch(/±90/);
    expect((await call(fetchImpl, 'get_weather', {})).text).toMatch(/Pass 'location'/);
    expect((await call(fetchImpl, 'get_weather', { location: 'x', days: 30 })).text).toMatch(/between 1 and 16/);
    expect((await call(fetchImpl, 'get_weather', { location: 'x', units: 'kelvin' })).text).toMatch(/metric/);
  });

  it('says when a place is unknown, and when the service fails', async () => {
    const a = fakeFetch([[GEO, { body: '{}' }], [NOM, { body: '[]' }]]);
    const unknown = await call(a.fetchImpl, 'get_weather', { location: 'Qwertyville' });
    expect(unknown.result.isError).toBe(true);
    expect(unknown.text).toMatch(/No place matches "Qwertyville"/);
    const b = fakeFetch([[WX, { body: '', ok: false, status: 429 }]]);
    const busy = await call(b.fetchImpl, 'get_weather', { latitude: 1, longitude: 1 });
    expect(busy.text).toMatch(/HTTP 429 \(too many requests.*Retry once/);
  });

  it('names WMO weather codes', () => {
    expect(weatherLabel(0)).toBe('clear sky');
    expect(weatherLabel(95)).toBe('thunderstorm');
    expect(weatherLabel(null)).toBe('unknown');
    expect(weatherLabel(42)).toBe('code 42');
  });
});
