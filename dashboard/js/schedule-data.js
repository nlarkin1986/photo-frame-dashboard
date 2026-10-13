// Kids' schedule data: loads /api/schedule (ETag polling), optimistic ticks and edits.
// Emits App 'schedule' (payload changed or error changed: rebuild) and 'schedule-tick'
// ({kid, card, done}: one card's done flag flipped locally: toggle a class, don't rebuild).
(function () {
  'use strict';
  var App = window.App;
  var SECTION_KEYS = ['morning', 'midday', 'afternoon', 'evening', 'bedtime'];

  var S = App.schedule = {
    data: null,      // display payload (photo refs rewritten to src)
    week: null,      // Monday (YYYY-MM-DD) of the loaded week
    error: null,     // null | 'not-linked' | 'unlinked' | 'offline'
    editing: false,  // set by the editor; polling pauses while true
    pending: 0       // POSTs in flight
  };

  var etag = null, etagWeek = null, pinned = null, inflight = null, inflightWeek = null, lastLoad = 0;
  var writes = 0; // bumped by every POST: a GET that started before one is stale on arrival

  // ------------------------------------------------------------ dates
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function iso(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  S.mondayOf = function (date) {
    var d = new Date(date || App.now());
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    d.setDate(d.getDate() - (d.getDay() + 6) % 7);
    return iso(d);
  };
  // 0 = Monday … 6 = Sunday
  S.todayIndex = function (date) { return (new Date(date || App.now()).getDay() + 6) % 7; };
  // Fixed hours: morning <11:00, midday 11–13, afternoon 13–17, evening 17–19:30, bedtime after.
  S.currentSection = function (date) {
    var d = new Date(date || App.now()), m = d.getHours() * 60 + d.getMinutes();
    return m < 660 ? 'morning' : m < 780 ? 'midday' : m < 1020 ? 'afternoon' : m < 1170 ? 'evening' : 'bedtime';
  };
  S.SECTION_KEYS = SECTION_KEYS;

  // ------------------------------------------------------------ lookup
  S.kid = function (kidId) {
    var kids = (S.data && S.data.kids) || [];
    for (var i = 0; i < kids.length; i++) if (kids[i].id === kidId) return kids[i];
    return null;
  };
  S.findCard = function (kidId, cardId) {
    var kid = S.kid(kidId);
    if (!kid) return null;
    for (var d = 0; d < kid.days.length; d++) {
      var secs = kid.days[d].sections;
      for (var s = 0; s < secs.length; s++) {
        var cards = secs[s].cards;
        for (var c = 0; c < cards.length; c++) if (cards[c].id === cardId) return cards[c];
      }
    }
    return null;
  };

  // ------------------------------------------------------------ state changes
  function setError(err, clearData) {
    var changed = S.error !== err || (clearData && S.data);
    S.error = err;
    if (clearData) S.data = null;
    if (changed) App.emit('schedule', S.data);
  }
  // Same payload apart from its timestamp? (Avoids rebuilding after our own tick round-trips.)
  function sameAs(a, b) {
    if (!a || !b) return false;
    var ua = a.updatedAt, ub = b.updatedAt;
    a.updatedAt = b.updatedAt = '';
    var same = JSON.stringify(a) === JSON.stringify(b);
    a.updatedAt = ua; b.updatedAt = ub;
    return same;
  }
  function setData(d, tag) {
    var quiet = sameAs(S.data, d) && !S.error;
    S.data = d;
    S.week = d.week || S.week;
    if (tag !== undefined) { etag = tag; etagWeek = S.week; }
    S.error = null;
    if (!quiet) App.emit('schedule', d);
  }
  function errorFor(status, body) {
    if (status === 401) return 'unlinked';
    if (status === 503 && body && body.error === 'not-linked') return 'not-linked';
    return 'offline';
  }
  function readJson(r) { return r.json().catch(function () { return null; }); }

  function request(url, init, ms) {
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, ms || 10000) : null;
    init.credentials = 'same-origin';
    if (ctrl) init.signal = ctrl.signal;
    return fetch(url, init).then(function (r) { clearTimeout(timer); return r; }, function (e) { clearTimeout(timer); throw e; });
  }

  // ------------------------------------------------------------ load + poll
  // load(week?) — a week other than the current one stays pinned until load() is called
  // without one (or with the current week). Never rejects.
  S.load = function (week) {
    var current = S.mondayOf(App.now());
    if (week !== undefined) pinned = week && week !== current ? week : null;
    var target = pinned || current;
    if (inflight && inflightWeek === target) return inflight;
    var headers = {};
    if (etag && etagWeek === target && S.data) headers['If-None-Match'] = etag;
    lastLoad = Date.now();
    inflightWeek = target;
    var gen = writes;
    // A tick or edit since this GET started owns the data; drop the (older) response.
    function stale() { return S.pending || gen !== writes; }
    var p = inflight = request('/api/schedule?week=' + target, { headers: headers })
      .then(function (r) {
        if (stale()) return;
        if (r.status === 304) { if (S.error) setError(null); return; }
        return readJson(r).then(function (body) {
          if (stale()) return;
          if (r.status === 200 && body && body.kids) setData(body, r.headers.get('ETag'));
          else {
            var err = errorFor(r.status, body);
            setError(err, err !== 'offline');
          }
        });
      })
      .catch(function () { setError('offline'); })
      .then(function () { if (inflight === p) inflight = null; });
    return p;
  };

  // Startup: never rejects, never waits more than 4 s.
  App.loadSchedule = function () {
    var timeout = new Promise(function (resolve) { setTimeout(resolve, 4000); });
    return Promise.race([S.load(), timeout]).catch(function () {});
  };

  function interval() { return App.current === 'schedule' || App.current === 'home' ? 30000 : 60000; }
  // Called every 30 s and on each minute tick; fetches when due (or the Monday rolled over).
  S.poll = function () {
    if (S.editing || S.pending) return Promise.resolve();
    var mondayChanged = !pinned && S.week && S.week !== S.mondayOf(App.now());
    if (!mondayChanged && Date.now() - lastLoad < interval() - 2000) return Promise.resolve();
    return S.load();
  };
  App.on('minute', function () { S.poll(); });
  setInterval(function () { S.poll(); }, 30000);

  // ------------------------------------------------------------ writes
  var FAIL = 'Couldn’t save — check the connection';

  // POST ops; resolves { ok, status, body }. Applies the returned display only when no other
  // write is still in flight (an older response would undo a newer optimistic change).
  function send(ops) {
    var week = (S.data && S.data.week) || S.week;
    S.pending++;
    writes++;
    return request('/api/schedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ week: week, ops: ops })
    }).then(function (r) {
      return readJson(r).then(function (body) {
        // System A answers {display}; the dev fixture answers the bare display.
        var disp = body && body.display ? body.display : body;
        return { ok: r.status === 200 && !!disp && !!disp.kids, status: r.status, body: r.status === 200 ? disp : body };
      });
    }, function () {
      return { ok: false, status: 0, body: null };
    }).then(function (res) {
      S.pending--;
      // The POST's display carries no GET ETag: drop ours so the next poll refetches.
      if (res.ok && !S.pending) setData(res.body, null);
      else if (!res.ok) failed(res);
      return res;
    });
  }
  function failed(res) {
    if (res.status === 401) { setError('unlinked', true); return; }
    if (res.status === 409) {
      var full = res.body && res.body.error === 'full';
      App.toast(full ? 'That section is full' : 'The schedule changed — showing the latest', { icon: 'bolt' });
      etag = null;
      S.load();
      return;
    }
    if (res.status === 403) {
      App.toast('This frame isn’t allowed to make that change', { icon: 'bolt' });
      return;
    }
    App.toast(FAIL, { icon: 'bolt' });
  }

  function setDone(kidId, cardId, on) {
    var card = S.findCard(kidId, cardId);
    if (!card) return null;
    var prev = !!card.done;
    card.done = !!on;
    App.emit('schedule-tick', { kid: kidId, card: cardId, done: card.done });
    return { card: card, prev: prev };
  }

  // tick(kidId, cardId, on?) — on defaults to toggling. Optimistic, undo toast, rollback on failure.
  // Resolves true when saved.
  S.tick = function (kidId, cardId, on, opts) {
    opts = opts || {};
    var card = S.findCard(kidId, cardId);
    if (!card || (S.data.can && !S.data.can.tick)) return Promise.resolve(false);
    if (on == null) on = !card.done;
    on = !!on;
    var local = setDone(kidId, cardId, on);
    var prev = local.prev;
    if (!opts.silent) {
      App.toast((on ? 'Done: <b>' : 'Not done: <b>') + App.esc(card.label || 'card') + '</b>', {
        icon: on ? 'check' : undefined,
        undo: function () { S.tick(kidId, cardId, prev, { silent: true }); }
      });
    }
    return send([{ op: 'tick', kid: kidId, card: cardId, on: on }]).then(function (res) {
      if (!res.ok) {
        var now = S.findCard(kidId, cardId);
        if (now && now.done === on && res.status !== 409 && res.status !== 401) setDone(kidId, cardId, prev);
      }
      return res.ok;
    });
  };

  // patch(ops, {undoOps?, message?}) — structural edits (Phase 3). No local preview: the view
  // can show S.pending; the returned display replaces data. Resolves true when saved.
  S.patch = function (ops, opts) {
    opts = opts || {};
    App.emit('schedule-pending', true);
    return send(ops).then(function (res) {
      App.emit('schedule-pending', S.pending > 0);
      if (res.ok && opts.message) {
        App.toast(opts.message, opts.undoOps ? { undo: function () { S.patch(opts.undoOps); } } : {});
      }
      return res.ok;
    });
  };
})();
