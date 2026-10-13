// Self-update for the wall frame: the kiosk WebView keeps running old code after a deploy.
// Every 10 minutes fetch a fresh copy of the page and compare its module entry script (Vite gives
// it a content hash) with the one running now; when it changed, reload — but only while idle
// (no sheet, takeover, demo drawer, focused input, schedule edit or board write in flight, and
// no touch for a minute), or straight away in ambient/night mode.
(function () {
  'use strict';
  var App = window.App, $ = App.$;
  var CHECK_MS = 10 * 60 * 1000, IDLE_MS = 60 * 1000;
  var lastTouch = Date.now(), stale = false;

  function entryOf(html) {
    var tags = String(html).match(/<script\b[^>]*>/gi) || [];
    for (var i = 0; i < tags.length; i++) {
      if (!/type\s*=\s*["']?module/i.test(tags[i])) continue;
      var m = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tags[i]);
      if (m) return m[1];
    }
    return null;
  }
  function running() {
    var s = document.querySelector('script[type="module"][src]');
    return s ? s.getAttribute('src') : null;
  }
  var current = running();

  function check() {
    if (stale || !current || typeof fetch !== 'function') return;
    fetch('/?v=' + Date.now(), { cache: 'no-store', credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.text() : null; })
      .then(function (html) {
        var next = html && entryOf(html);
        if (next && next !== current) { stale = true; tryReload(); }
      })
      .catch(function () {});
  }

  function busy() {
    var open = function (sel) { var el = $(sel); return !!(el && el.classList.contains('is-open')); };
    var a = document.activeElement;
    return open('#sheetLayer') || open('#takeover') || open('#demo') ||
      !!(a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')) ||
      !!(App.schedule && (App.schedule.editing || App.schedule.pending)) ||
      !!(App.board && App.board.pending);
  }
  function tryReload() {
    if (!stale) return;
    var ambient = App.mode === 'ambient' || App.mode === 'night';
    if (busy() || (!ambient && Date.now() - lastTouch < IDLE_MS)) return;
    location.reload();
  }

  document.addEventListener('pointerdown', function () { lastTouch = Date.now(); }, true);
  setInterval(check, CHECK_MS);
  setInterval(tryReload, 15000);
  App.on('mode', function () { setTimeout(tryReload, 1000); });
  App.autoUpdate = { check: check, entryOf: entryOf };
})();
