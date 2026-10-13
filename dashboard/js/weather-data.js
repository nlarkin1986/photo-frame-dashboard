// Live weather: GET /api/weather (Open-Meteo, mapped server-side) at startup, every 15 minutes and
// on waking from ambient/night. Replaces DATA.weather in place (so App.weatherNow / App.hourly and
// every view read real values) and emits App 'weather'. Offline: keeps the last good data, or the
// mock in js/data.js if nothing has loaded yet.
(function () {
  'use strict';
  var App = window.App, D = window.DATA;
  var REFRESH_MS = 15 * 60 * 1000;
  var W = App.weatherData = { live: false, error: null, loadedAt: 0 };
  var inflight = null;

  function valid(x) {
    return !!(x && typeof x.hi === 'number' && x.t && x.t.length === 24 && x.c && x.c.length === 24 && x.p && x.p.length === 24);
  }
  function apply(x) {
    var w = D.weather;
    Object.keys(w).forEach(function (k) { if (!(k in x)) delete w[k]; });
    Object.keys(x).forEach(function (k) { w[k] = x[k]; });
    W.live = true;
    W.error = null;
    W.loadedAt = Date.now();
    App.emit('weather', w);
  }

  // Never rejects.
  W.load = function () {
    if (inflight) return inflight;
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 10000) : null;
    var p = inflight = fetch('/api/weather', { credentials: 'same-origin', headers: { Accept: 'application/json' }, signal: ctrl ? ctrl.signal : undefined })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (x) { if (valid(x)) apply(x); else W.error = 'unavailable'; })
      .catch(function () { W.error = 'offline'; })
      .then(function () { clearTimeout(timer); if (inflight === p) inflight = null; });
    return p;
  };

  // Startup: never rejects, never waits more than 4 s.
  App.loadWeather = function () {
    var timeout = new Promise(function (resolve) { setTimeout(resolve, 4000); });
    return Promise.race([W.load(), timeout]).catch(function () {});
  };

  setInterval(function () { W.load(); }, REFRESH_MS);
  // Waking up (ambient/night → day): refresh if the reading is more than 5 minutes old.
  App.on('mode', function (m) { if (m === 'day' && Date.now() - W.loadedAt > 5 * 60 * 1000) W.load(); });
  // The hourly arrays are "next 24 h by hour of day"; refetch each hour so they roll forward.
  App.on('minute', function (n) { if (n.getMinutes() === 1 && Date.now() - W.loadedAt > 30 * 60 * 1000) W.load(); });
})();
