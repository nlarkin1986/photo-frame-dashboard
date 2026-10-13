// Local weather for the frame, from Open-Meteo (no API key), fetched server-side and mapped to the
// shape the dashboard views use (js/data.js `weather`): hi/lo/feels/humidity/wind plus 24-entry
// t/c/p arrays indexed by local hour of day for the next 24 hours, the current reading, and a
// deterministic summary + advice line. °F and mph, America/Chicago.
// Location: rounded coordinates only (WEATHER_LAT / WEATHER_LON override). Never a street address.
import { isAuthorized, unauthorized } from '../lib/frame-key.js';

export const DEFAULT_LAT = 43.12;
export const DEFAULT_LON = -87.89;
export const TZ = 'America/Chicago';
const TTL_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 8000;

let cache = null; // { at, key, data }
export function _resetCache() { cache = null; }

// ------------------------------------------------------------ WMO weather codes → dashboard icons
export function conditionFor(code, isDay = true) {
  const c = Number(code);
  if (c === 0 || c === 1) return isDay ? 'sun' : 'moon';
  if (c === 2) return 'partly';
  if (c === 3) return 'cloud';
  if (c === 45 || c === 48) return 'fog';
  if ((c >= 51 && c <= 67) || (c >= 80 && c <= 82)) return 'rain';
  if ((c >= 71 && c <= 77) || c === 85 || c === 86) return 'snow';
  if (c === 95 || c === 96 || c === 99) return 'storm';
  return 'cloud';
}

export function forecastUrl(lat = DEFAULT_LAT, lon = DEFAULT_LON) {
  const q = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    current: 'temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code,is_day',
    hourly: 'temperature_2m,precipitation_probability,weather_code,is_day',
    daily: 'temperature_2m_max,temperature_2m_min,sunrise,sunset',
    temperature_unit: 'fahrenheit',
    wind_speed_unit: 'mph',
    timezone: TZ,
    forecast_days: '2',
  });
  return 'https://api.open-meteo.com/v1/forecast?' + q.toString();
}

function hourLabel(h) { return (h % 12 || 12) + ' ' + (h >= 12 ? 'PM' : 'AM'); }
const WET = { rain: 1, snow: 1, storm: 1 };

// Deterministic one-liner for the Home tile: "Rain from 4 PM." + "Pack a rain jacket."
// `hours`: [{ h, t, c, p }] for the next hours, starting now.
export function adviceFor({ cond, feels, wind, hours }) {
  const wetAt = (x) => WET[x.c] || x.p >= 50;
  const firstWet = hours.findIndex(wetAt);
  if (firstWet === 0) {
    let end = 0;
    while (end < hours.length && wetAt(hours[end])) end++;
    const kind = hours[0].c === 'snow' ? 'Snow' : hours[0].c === 'storm' ? 'Storms' : 'Rain';
    const summary = end >= hours.length ? kind + ' all day' : kind + ' until ' + hourLabel(hours[end].h);
    const advice = kind === 'Snow' ? 'Boots and mittens.' : kind === 'Storms' ? 'Stay close to home.' : 'Umbrella weather.';
    return { summary, advice };
  }
  if (firstWet > 0 && firstWet <= 12) {
    const x = hours[firstWet];
    const kind = x.c === 'snow' ? 'Snow' : x.c === 'storm' ? 'Storms' : 'Rain';
    const advice = kind === 'Snow' ? 'Boots by the door.' : 'Pack a rain jacket.';
    return { summary: kind + ' from ' + hourLabel(x.h), advice };
  }
  const sky = { sun: 'Clear', moon: 'Clear', partly: 'Partly cloudy', cloud: 'Cloudy', fog: 'Foggy' }[cond] || 'Dry';
  let temp, advice;
  if (feels <= 32) { temp = 'cold'; advice = 'Hats on.'; }
  else if (feels < 50) { temp = 'chilly'; advice = 'Jacket weather.'; }
  else if (feels < 65) { temp = 'cool'; advice = 'Grab a sweater.'; }
  else if (feels < 82) { temp = 'mild'; advice = 'Light layers.'; }
  else { temp = 'hot'; advice = 'Water bottles.'; }
  if (wind >= 25) advice = 'Windy — hold on to hats.';
  return { summary: sky + ' and ' + temp, advice };
}

// Open-Meteo JSON → dashboard weather shape. Hourly arrays are indexed by local hour of day and
// hold the NEXT occurrence of that hour (so 11 PM → 1 AM reads tonight, then tomorrow morning).
export function mapForecast(j) {
  const cur = j.current || {};
  const H = j.hourly || {};
  const times = H.time || [];
  const nowHour = String(cur.time || times[0] || '').slice(0, 13); // "YYYY-MM-DDTHH"
  let start = times.findIndex((t) => String(t).slice(0, 13) === nowHour);
  if (start < 0) start = 0;
  const t = new Array(24).fill(null), c = new Array(24).fill('cloud'), p = new Array(24).fill(0);
  const hours = [];
  for (let i = 0; i < 24 && start + i < times.length; i++) {
    const k = start + i;
    const h = Number(String(times[k]).slice(11, 13));
    const x = {
      h,
      t: Math.round(H.temperature_2m[k]),
      c: conditionFor(H.weather_code[k], H.is_day ? H.is_day[k] !== 0 : true),
      p: H.precipitation_probability && H.precipitation_probability[k] != null ? H.precipitation_probability[k] : 0,
    };
    t[h] = x.t; c[h] = x.c; p[h] = x.p;
    hours.push(x);
  }
  const D = j.daily || {};
  const nowH = hours.length ? hours[0].h : 0;
  const now = { hour: nowH, temp: Math.round(cur.temperature_2m), cond: conditionFor(cur.weather_code, cur.is_day !== 0) };
  const feels = Math.round(cur.apparent_temperature);
  const wind = Math.round(cur.wind_speed_10m);
  // Hours not covered (short responses) borrow the nearest known value so the views never see null.
  for (let i = 0; i < 24; i++) if (t[i] == null) t[i] = now.temp;
  const { summary, advice } = adviceFor({ cond: now.cond, feels, wind, hours });
  return {
    unit: 'F',
    hi: Math.round(D.temperature_2m_max ? D.temperature_2m_max[0] : Math.max(...hours.map((x) => x.t))),
    lo: Math.round(D.temperature_2m_min ? D.temperature_2m_min[0] : Math.min(...hours.map((x) => x.t))),
    feels, humidity: Math.round(cur.relative_humidity_2m), wind,
    t, c, p, now, summary, advice,
    sunrise: D.sunrise ? D.sunrise[0] : null, sunset: D.sunset ? D.sunset[0] : null,
    observedAt: cur.time || null,
  };
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

async function fetchForecast(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error('upstream ' + r.status);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function GET(request) {
  if (!isAuthorized(request)) return unauthorized();
  const lat = Number(process.env.WEATHER_LAT) || DEFAULT_LAT;
  const lon = Number(process.env.WEATHER_LON) || DEFAULT_LON;
  const key = lat + ',' + lon;
  const headers = { 'Cache-Control': 'private, max-age=600' };
  if (cache && cache.key === key && Date.now() - cache.at < TTL_MS) return json(cache.data, 200, headers);
  try {
    const data = mapForecast(await fetchForecast(forecastUrl(lat, lon)));
    cache = { at: Date.now(), key, data };
    return json(data, 200, headers);
  } catch (e) {
    // Serve the last good forecast when Open-Meteo is unreachable; the frame falls back otherwise.
    if (cache && cache.key === key) return json({ ...cache.data, stale: true }, 200, { 'Cache-Control': 'private, max-age=60' });
    return json({ error: 'weather-unavailable' }, 502, { 'Cache-Control': 'no-store' });
  }
}
