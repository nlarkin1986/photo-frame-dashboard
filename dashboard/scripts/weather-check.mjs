// Checks for api/weather.js (WMO mapping, hourly indexing, advice, handler). No network:
//   node scripts/weather-check.mjs
import assert from 'node:assert/strict';
import { adviceFor, conditionFor, forecastUrl, GET, mapForecast, _resetCache } from '../api/weather.js';

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; } catch (e) { console.error(`FAIL ${name}\n`, e); process.exitCode = 1; }
}
for (const k of ['VERCEL', 'FRAME_KEY', 'WEATHER_LAT', 'WEATHER_LON']) delete process.env[k];

// A 48-hour Open-Meteo-shaped response starting at local midnight on `day`.
function sample({ day = '2026-10-13', nowHour = 22, codes, probs, temp = (i) => 50 + (i % 24), isDay } = {}) {
  const time = [], t = [], wc = [], pp = [], d = [];
  for (let i = 0; i < 48; i++) {
    const date = i < 24 ? day : '2026-10-14';
    time.push(`${date}T${String(i % 24).padStart(2, '0')}:00`);
    t.push(temp(i));
    wc.push(codes ? codes(i) : 0);
    pp.push(probs ? probs(i) : 0);
    d.push(isDay ? isDay(i) : (i % 24 >= 7 && i % 24 < 18 ? 1 : 0));
  }
  return {
    current: { time: `${day}T${String(nowHour).padStart(2, '0')}:15`, temperature_2m: 61.4, apparent_temperature: 58.6, relative_humidity_2m: 60, wind_speed_10m: 9.6, weather_code: 0, is_day: nowHour >= 7 && nowHour < 18 ? 1 : 0 },
    hourly: { time, temperature_2m: t, weather_code: wc, precipitation_probability: pp, is_day: d },
    daily: { time: [day, '2026-10-14'], temperature_2m_max: [70.4, 60], temperature_2m_min: [45.6, 40], sunrise: [`${day}T07:03`], sunset: [`${day}T18:12`] },
  };
}

await test('WMO codes map to dashboard conditions', () => {
  assert.equal(conditionFor(0, true), 'sun');
  assert.equal(conditionFor(1, false), 'moon');
  assert.equal(conditionFor(2), 'partly');
  assert.equal(conditionFor(3), 'cloud');
  assert.equal(conditionFor(45), 'fog');
  assert.equal(conditionFor(48), 'fog');
  for (const c of [51, 55, 61, 63, 65, 66, 80, 82]) assert.equal(conditionFor(c), 'rain', 'code ' + c);
  for (const c of [71, 73, 75, 77, 85, 86]) assert.equal(conditionFor(c), 'snow', 'code ' + c);
  for (const c of [95, 96, 99]) assert.equal(conditionFor(c), 'storm', 'code ' + c);
  assert.equal(conditionFor(1234), 'cloud');
});

await test('forecast URL uses °F, mph, Chicago and rounded coordinates', () => {
  const u = new URL(forecastUrl());
  assert.equal(u.origin + u.pathname, 'https://api.open-meteo.com/v1/forecast');
  assert.equal(u.searchParams.get('latitude'), '43.12');
  assert.equal(u.searchParams.get('longitude'), '-87.89');
  assert.equal(u.searchParams.get('temperature_unit'), 'fahrenheit');
  assert.equal(u.searchParams.get('wind_speed_unit'), 'mph');
  assert.equal(u.searchParams.get('timezone'), 'America/Chicago');
  assert.match(u.searchParams.get('current'), /apparent_temperature/);
  assert.match(u.searchParams.get('hourly'), /precipitation_probability/);
  assert.match(u.searchParams.get('daily'), /temperature_2m_max/);
});

await test('hourly arrays hold the next 24 h by hour of day, across midnight', () => {
  const w = mapForecast(sample({ nowHour: 22, temp: (i) => i })); // temp = index into the 48 h
  assert.equal(w.t.length, 24);
  assert.equal(w.now.hour, 22);
  assert.equal(w.t[22], 22); // tonight
  assert.equal(w.t[23], 23);
  assert.equal(w.t[0], 24);  // tomorrow 00:00, not this morning
  assert.equal(w.t[21], 45); // tomorrow 21:00
  assert.equal(w.c[23], 'moon');
  assert.equal(w.c[12], 'sun');
  assert.equal(w.hi, 70);
  assert.equal(w.lo, 46);
  assert.equal(w.feels, 59);
  assert.equal(w.wind, 10);
  assert.equal(w.now.temp, 61);
});

await test('advice: rain later, raining now, snow, dry by temperature', () => {
  const h = (list) => list.map(([hr, c, p]) => ({ h: hr, t: 50, c, p }));
  assert.deepEqual(adviceFor({ cond: 'sun', feels: 60, wind: 5, hours: h([[13, 'sun', 0], [14, 'cloud', 20], [15, 'cloud', 40], [16, 'rain', 80]]) }),
    { summary: 'Rain from 4 PM', advice: 'Pack a rain jacket.' });
  assert.deepEqual(adviceFor({ cond: 'rain', feels: 60, wind: 5, hours: h([[9, 'rain', 90], [10, 'rain', 70], [11, 'cloud', 20]]) }),
    { summary: 'Rain until 11 AM', advice: 'Umbrella weather.' });
  assert.equal(adviceFor({ cond: 'cloud', feels: 25, wind: 5, hours: h([[7, 'cloud', 10], [8, 'snow', 60]]) }).summary, 'Snow from 8 AM');
  assert.deepEqual(adviceFor({ cond: 'sun', feels: 20, wind: 5, hours: h([[8, 'sun', 0]]) }), { summary: 'Clear and cold', advice: 'Hats on.' });
  assert.deepEqual(adviceFor({ cond: 'moon', feels: 70, wind: 5, hours: h([[21, 'moon', 0]]) }), { summary: 'Clear and mild', advice: 'Light layers.' });
  assert.equal(adviceFor({ cond: 'cloud', feels: 45, wind: 30, hours: h([[9, 'cloud', 0]]) }).advice, 'Windy — hold on to hats.');
  // Rain more than 12 hours out isn't mentioned.
  const far = h(Array.from({ length: 24 }, (_, i) => [i, i === 15 ? 'rain' : 'sun', i === 15 ? 90 : 0]));
  assert.equal(adviceFor({ cond: 'sun', feels: 60, wind: 5, hours: far }).summary, 'Clear and cool');
});

await test('mapped forecast advice comes from the hourly data', () => {
  const w = mapForecast(sample({ nowHour: 10, codes: (i) => (i === 16 ? 61 : 2), probs: (i) => (i === 16 ? 85 : 10) }));
  assert.equal(w.summary, 'Rain from 4 PM');
  assert.equal(w.advice, 'Pack a rain jacket.');
  assert.equal(w.c[16], 'rain');
  assert.equal(w.p[16], 85);
});

await test('handler: maps, caches 10 min, env override, 502 when upstream fails with no cache', async () => {
  _resetCache();
  const real = globalThis.fetch;
  let calls = 0, fail = false, lastUrl = '';
  globalThis.fetch = async (url) => {
    calls++; lastUrl = String(url);
    if (fail) throw new Error('down');
    return new Response(JSON.stringify(sample({ nowHour: 9 })), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const r1 = await GET(new Request('http://localhost/api/weather'));
    assert.equal(r1.status, 200);
    assert.equal(r1.headers.get('cache-control'), 'private, max-age=600');
    const w = await r1.json();
    assert.equal(w.unit, 'F');
    assert.equal(w.t.length, 24);
    assert.match(lastUrl, /latitude=43\.12/);
    await GET(new Request('http://localhost/api/weather'));
    assert.equal(calls, 1, 'second call within 10 min is cached');

    _resetCache();
    process.env.WEATHER_LAT = '43.2'; process.env.WEATHER_LON = '-88';
    await GET(new Request('http://localhost/api/weather'));
    assert.match(lastUrl, /latitude=43\.2&longitude=-88/);
    delete process.env.WEATHER_LAT; delete process.env.WEATHER_LON;

    _resetCache();
    fail = true;
    const r3 = await GET(new Request('http://localhost/api/weather'));
    assert.equal(r3.status, 502);
  } finally {
    globalThis.fetch = real;
  }
});

await test('handler: frame key gate', async () => {
  process.env.FRAME_KEY = 'secret-key';
  try {
    const r = await GET(new Request('http://localhost/api/weather'));
    assert.equal(r.status, 401);
  } finally {
    delete process.env.FRAME_KEY;
  }
});

console.log(process.exitCode ? 'weather-check: FAILED' : `weather-check: all ${passed} passed`);
