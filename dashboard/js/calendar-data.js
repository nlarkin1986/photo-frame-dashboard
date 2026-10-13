// Family calendar: GET /api/calendar (Google Calendar ICS, expanded server-side) at startup, every
// 5 minutes and on waking. Replaces DATA.events in place with real events, so the Calendar view,
// the Home "Next up" card, the per-person lanes and the ambient/night lines all read them.
// Event lanes: person ids, or ["family"] → every person (shown as a Family event everywhere).
// Production: not-configured → no events and a quiet "Calendar not connected" state; offline →
// keep the last good events. Local dev with no API: the mock events stay.
(function () {
  'use strict';
  var App = window.App, D = window.DATA;
  var DEV = !!(import.meta.env && import.meta.env.DEV);
  var C = App.calendarData = { state: DEV ? 'mock' : 'loading', loadedAt: 0, sig: '' };
  var inflight = null;

  // Production never shows the demo events, even for a moment.
  if (!DEV) { D.events.length = 0; D.busyExtras.length = 0; }

  function localDate(s) { var m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(s); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(s); }
  function toEvent(x) {
    var ids = D.people.map(function (p) { return p.id; });
    var lanes = (x.lanes || []).filter(function (id) { return id === 'family' || ids.indexOf(id) > -1; });
    var people = !lanes.length || lanes.indexOf('family') > -1 ? ids.slice() : lanes;
    var start = x.allDay ? localDate(x.start) : new Date(x.start);
    var end = x.allDay ? localDate(x.end) : new Date(x.end);
    if (!(end > start)) end = x.allDay ? new Date(+start + 864e5) : new Date(+start + 30 * 60000);
    var e = { id: String(x.id).replace(/[^A-Za-z0-9_-]/g, ''), title: String(x.title || 'Busy'), start: start, end: end, people: people, live: true };
    if (x.allDay) e.allDay = true;
    if (x.location) e.loc = String(x.location);
    return e;
  }
  function apply(list, state) {
    var events = list.map(toEvent);
    var sig = JSON.stringify(list) + state;
    C.state = state;
    C.loadedAt = Date.now();
    if (sig === C.sig) return;
    C.sig = sig;
    D.events.length = 0;
    Array.prototype.push.apply(D.events, events);
    D.busyExtras.length = 0;
    App.emit('calendar', C.state);
    if (App.current) App.emit('data');
  }
  function setState(state) {
    if (C.state === state) return;
    C.state = state;
    App.emit('calendar', state);
    if (App.current) App.emit('data');
  }

  // Never rejects.
  C.load = function () {
    if (inflight) return inflight;
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 12000) : null;
    var p = inflight = fetch('/api/calendar', { credentials: 'same-origin', headers: { Accept: 'application/json' }, signal: ctrl ? ctrl.signal : undefined })
      .then(function (r) {
        return r.json().catch(function () { return null; }).then(function (body) {
          if (r.status === 200 && body && Array.isArray(body.events)) { apply(body.events, 'live'); return; }
          if (r.status === 503 && body && body.error === 'not-configured') {
            if (DEV) return; // local dev keeps the mock
            apply([], 'not-connected');
            return;
          }
          if (!DEV && C.state === 'loading') setState('offline');
        });
      })
      .catch(function () { if (!DEV && C.state === 'loading') setState('offline'); })
      .then(function () { clearTimeout(timer); if (inflight === p) inflight = null; });
    return p;
  };

  App.loadCalendar = function () {
    var timeout = new Promise(function (resolve) { setTimeout(resolve, 4000); });
    return Promise.race([C.load(), timeout]).catch(function () {});
  };
  // A short note for views when there are no real events to show (null when fine).
  App.calendarNote = function () {
    if (C.state === 'not-connected') return 'Calendar not connected';
    if (C.state === 'offline' || C.state === 'loading') return 'Calendar offline';
    return null;
  };

  setInterval(function () { C.load(); }, 5 * 60 * 1000);
  App.on('mode', function (m) { if (m === 'day' && Date.now() - C.loadedAt > 2 * 60 * 1000) C.load(); });
})();
