// Agent-published board (Shopping, Chores, "What to know this week"): loads GET /api/board with
// ETag polling and writes taps back with POST /api/board {ops} (optimistic, rollback on failure).
// Contract: docs/plans/board-contract.md. Emits App 'board' only when the document really changed
// (or a local optimistic change was applied). Until the API has answered once with a board,
// `live` is false and Shopping/Chores keep using the mock data in js/data.js.
(function () {
  'use strict';
  var App = window.App, D = window.DATA;

  var B = App.board = {
    data: null,     // board document (see contract) or null
    live: false,    // true once /api/board answered with a board
    error: null,    // null | 'offline' | 'unlinked' | 'missing'
    pending: 0,     // POSTs in flight
    updatedAt: 0    // ms timestamp of the last successful GET/POST
  };

  var etag = null, etagWeek = null, inflight = null, lastLoad = 0, writes = 0;
  var MOCK_PEOPLE = D.people.map(function (p) { return Object.assign({}, p); });

  // ------------------------------------------------------------ dates
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function iso(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  B.iso = iso;
  B.todayIso = function () { return iso(App.now()); };
  B.mondayOf = function (date) {
    var d = new Date(date || App.now());
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    d.setDate(d.getDate() - (d.getDay() + 6) % 7);
    return iso(d);
  };
  // "2026-10-13" → local midnight Date
  B.dateOf = function (s) {
    var m = /^(\d{4})-(\d\d)-(\d\d)/.exec(s || '');
    return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
  };
  // Free-text agent times ("10:55", "3:00", "7:00 AM", "8:25–8:45 AM") → Date on that day, or null.
  // Without AM/PM, 1–6 o'clock reads as PM (school-day times), 7–11 as AM, 12 as noon.
  B.timeOn = function (dateIso, text) {
    var d = B.dateOf(dateIso);
    var m = /(\d{1,2})(?::(\d\d))?\s*(a\.?m\.?|p\.?m\.?)?/i.exec(text || '');
    if (!d || !m) return null;
    var h = +m[1], min = m[2] ? +m[2] : 0, ap = m[3] ? m[3].charAt(0).toLowerCase() : null;
    if (!ap) { var rest = /[–-][^ap]*(a\.?m|p\.?m)/i.exec(text); if (rest) ap = rest[1].charAt(0).toLowerCase(); }
    if (h > 23 || min > 59) return null;
    if (ap === 'p' && h < 12) h += 12;
    else if (ap === 'a' && h === 12) h = 0;
    else if (!ap && h >= 1 && h <= 6) h += 12;
    d.setHours(h, min, 0, 0);
    return d;
  };

  // ------------------------------------------------------------ people + "who"
  function hexRgb(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return null;
    var n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function inkFor(rgb) {
    var l = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
    return l > 0.62 ? '#0E385B' : '#FFFFFF';
  }
  function styled(id, name, color) {
    var rgb = hexRgb(color) || [14, 56, 91];
    return { id: id, name: name, color: '#' + (hexRgb(color) ? color.replace('#', '') : '0E385B'), rgb: rgb.join(' '), ink: inkFor(rgb) };
  }
  // Server people override the mock household (keeping mock-only fields such as presence).
  function applyPeople(list) {
    if (!list || !list.length) return;
    var next = list.filter(function (p) { return p && p.id; }).map(function (p) {
      var mock = MOCK_PEOPLE.filter(function (m) { return m.id === p.id; })[0] || { home: true, status: '' };
      var s = styled(p.id, String(p.name || p.id), p.color || mock.color);
      return Object.assign({}, mock, s, { role: p.role || mock.role || 'adult' });
    });
    if (!next.length) return;
    D.people.length = 0;
    Array.prototype.push.apply(D.people, next);
  }
  B.people = function () { return D.people; };
  B.adults = function () { return D.people.filter(function (p) { return p.role !== 'kid'; }); };
  B.kids = function () { return D.people.filter(function (p) { return p.role === 'kid'; }); };

  var HELPER_COLORS = ['#FFB98A', '#B1C677', '#ACD6FC', '#FA9A9B'];
  var helperSeen = {};
  function isUs(name) { return /^(us|both of us|both|family|everyone)$/i.test(String(name).trim()); }
  B.whoKey = function (w) {
    if (!w) return '';
    if (w.person) return 'p:' + w.person;
    if (w.name) return 'n:' + String(w.name).trim().toLowerCase();
    return '';
  };
  B.sameWho = function (a, b) { return B.whoKey(a) === B.whoKey(b); };
  // Display object (id, name, color, rgb, ink) for a who value; null for null.
  B.whoView = function (w) {
    if (!w) return null;
    if (w.person) {
      var p = D.people.filter(function (x) { return x.id === w.person; })[0];
      return p || styled(w.person, w.person, '#6E889D');
    }
    var name = String(w.name || '').trim() || 'Someone';
    if (isUs(name)) return { id: 'family', name: name, color: D.family.color, rgb: D.family.rgb, ink: D.family.ink };
    var k = name.toLowerCase();
    if (helperSeen[k] == null) helperSeen[k] = Object.keys(helperSeen).length % HELPER_COLORS.length;
    return styled('n:' + k, name, HELPER_COLORS[helperSeen[k]]);
  };
  B.whoName = function (w) { var v = B.whoView(w); return v ? v.name : ''; };
  B.pstyle = function (v) { return '--c:' + v.color + ';--c-rgb:' + v.rgb + ';--c-ink:' + v.ink; };
  // Escaped avatar for a who value or display object.
  B.avatar = function (w, size, cls) {
    var v = w && w.rgb ? w : B.whoView(w);
    if (!v) return '';
    size = size || 40;
    var init = v.id === 'family' ? '★' : App.esc((v.name || '?').charAt(0).toUpperCase());
    return '<span class="avatar ' + (cls || '') + '" style="' + B.pstyle(v) + ';width:' + size + 'px;height:' + size + 'px;font-size:' + Math.round(size * 0.46) + 'px">' + init + '</span>';
  };
  // "✦ Grocery agent" for anything an agent added (not the frame itself).
  B.isAgent = function (src) { return !!(src && src.agent && src.agent !== 'frame'); };
  B.srcChip = function (src, cls) {
    if (!B.isAgent(src)) return '';
    return '<span class="src-chip ' + (cls || '') + '">✦ ' + App.esc(src.label || 'Agent') + '</span>';
  };

  // ------------------------------------------------------------ view models
  // Shopping items in the mock shape the Shopping view already understands, or null when not live.
  B.groceries = function () {
    var s = B.live && B.data && B.data.shopping;
    if (!s) return null;
    return (s.items || []).map(function (it) {
      return {
        id: it.id, name: String(it.text || ''), cat: it.category || null, qty: it.qty || 1,
        store: it.store || null, done: !!it.done, note: it.note || '', suggested: !!it.suggested && !it.done,
        src: it.addedBy || null, live: true
      };
    });
  };
  // Chores in the mock shape (r, who, title, emoji|icon, stars, done, doneBy), or null when not live.
  B.chores = function () {
    var c = B.live && B.data && B.data.chores;
    if (!c) return null;
    var today = B.todayIso();
    return (c.items || []).map(function (x) {
      var by = x.doneToday && x.doneToday.by;
      return {
        id: x.id, r: x.routine, who: x.person || 'any', title: String(x.title || ''), icon: x.icon || '',
        stars: x.stars || 0, done: !!x.doneToday, doneBy: by && by.person ? by.person : null, doneByWho: by || null,
        overdue: !!(x.due && x.due < today && !x.doneToday), src: x.addedBy || null, live: true
      };
    });
  };
  B.findItem = function (section, id) {
    var list = B.data && B.data[section] && B.data[section].items;
    if (!list) return null;
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  };

  // ------------------------------------------------------------ brief helpers
  B.brief = function () { return (B.data && B.data.brief) || null; };
  B.findIn = function (list, id) {
    for (var i = 0; list && i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  };
  B.decisionOpen = function (d) {
    return !!d && !d.done && !d.dismissed && (d.slots || []).some(function (s) { return !s.who; });
  };
  B.decisionAt = function (d) {
    if (!d || !d.when) return null;
    return d.when.time ? B.timeOn(d.when.date, d.when.time) : B.dateOf(d.when.date);
  };
  // Open, non-private, still-current decisions, soonest first.
  B.openDecisions = function () {
    var b = B.brief();
    if (!b) return [];
    var now = App.now(), today = App.dayStart(now);
    var t = B.todayIso();
    // A decision whose day (and every slot's day) has passed is no longer actionable.
    function current(d) {
      var dates = (d.slots || []).map(function (x) { return x.date; }).concat([d.when && d.when.date]).filter(Boolean);
      return !dates.length || dates.some(function (x) { return x >= t; });
    }
    return (b.decisions || []).filter(function (d) { return !d.private && B.decisionOpen(d) && current(d); }).sort(function (a, c) {
      var ta = B.decisionAt(a), tc = B.decisionAt(c);
      var pa = ta && ta < today ? 1 : 0, pc = tc && tc < today ? 1 : 0;
      return pa - pc || (ta ? +ta : 9e15) - (tc ? +tc : 9e15);
    });
  };
  // What needs someone: one entry per unfilled slot of each open decision (a multi-day care
  // decision becomes one ask per day still missing someone), soonest first.
  B.openAsks = function () {
    var t = B.todayIso(), out = [];
    B.openDecisions().forEach(function (d) {
      (d.slots || []).forEach(function (s) {
        if (s.who) return;
        var date = s.date || (d.when && d.when.date) || null;
        if ((d.slots || []).length > 1 && date && date < t) return;
        out.push({ dc: d, slot: s, date: date, time: (d.slots || []).length === 1 && d.when ? d.when.time || null : null });
      });
    });
    return out.sort(function (a, b) {
      var ta = a.time ? B.timeOn(a.date, a.time) : B.dateOf(a.date), tb = b.time ? B.timeOn(b.date, b.time) : B.dateOf(b.date);
      return (ta ? +ta : 9e15) - (tb ? +tb : 9e15);
    });
  };
  // Who has the kids on a day: the day's care, or a care decision's slot for that date.
  B.careOn = function (day) {
    if (day.care && day.care.who) return day.care.who;
    var b = B.brief();
    var hit = null;
    (b && b.decisions || []).forEach(function (d) {
      if (d.kind !== 'care' || d.private) return;
      (d.slots || []).forEach(function (s) { if (!hit && s.date === day.date && s.who) hit = s.who; });
    });
    return hit;
  };
  B.careGaps = function () {
    var b = B.brief(), today = B.todayIso();
    if (!b || b.week !== B.mondayOf()) return [];
    return (b.days || []).filter(function (d) { return d.date >= today && d.care && d.care.needed && !B.careOn(d); });
  };
  B.openTodos = function () {
    var b = B.brief();
    return b ? (b.todos || []).filter(function (t) { return !t.private && !t.done && !t.dismissed; }) : [];
  };
  B.privateCount = function () {
    var b = B.brief();
    if (!b) return 0;
    return (b.todos || []).filter(function (t) { return t.private && !t.done && !t.dismissed; }).length +
      (b.decisions || []).filter(function (d) { return d.private && !d.done && !d.dismissed; }).length;
  };
  // Review-mode agent writes awaiting Approve / Dismiss, for one section ('shopping'|'chores'|'brief').
  B.pendingFor = function (section) {
    var list = (B.data && B.data.pending) || [];
    return list.filter(function (p) { return p && (p.section || p.kind || 'brief') === section; });
  };
  // Display text for a pending suggestion (shape is loose; never trust it as HTML).
  B.pendingText = function (p) {
    var x = p.summary || p.text || p.title || (p.item && (p.item.text || p.item.title)) || (p.data && (p.data.text || p.data.title)) || 'Suggested change';
    return String(x);
  };
  B.pendingSource = function (p) { return p.source || p.addedBy || p.actor || null; };

  // ------------------------------------------------------------ state changes
  function setError(err) {
    if (B.error === err) return;
    B.error = err;
    App.emit('board', { error: err });
  }
  function setData(doc, tag) {
    var before = B.data ? JSON.stringify(B.data) : '';
    var wasLive = B.live;
    applyPeople(doc.people);
    B.data = doc;
    B.live = true;
    B.updatedAt = Date.now();
    if (tag !== undefined) { etag = tag; etagWeek = B.mondayOf(); }
    var errChanged = B.error !== null;
    B.error = null;
    if (!wasLive || errChanged || JSON.stringify(doc) !== before) {
      if (!wasLive && App.current) App.emit('data');   // mock → live after startup: rebuild views
      App.emit('board', { server: true });
    }
  }
  function isBoard(body) {
    return !!(body && typeof body === 'object' && (body.shopping || body.chores || 'brief' in body || body.rev != null));
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
  // Never rejects.
  B.load = function () {
    if (inflight) return inflight;
    var week = B.mondayOf();
    var headers = { Accept: 'application/json' };
    if (etag && etagWeek === week && B.data) headers['If-None-Match'] = etag;
    lastLoad = Date.now();
    var gen = writes;
    function stale() { return B.pending || gen !== writes; }
    var p = inflight = request('/api/board?week=' + week, { headers: headers })
      .then(function (r) {
        if (stale()) return;
        if (r.status === 304) { if (B.error) setError(null); return; }
        return readJson(r).then(function (body) {
          if (stale()) return;
          if (r.status === 200 && isBoard(body)) setData(body, r.headers.get('ETag'));
          else if (r.status === 401) setError('unlinked');
          // No board API (dev without the backend; the SPA fallback answers HTML): stay on mock data.
          else if (r.status === 404 || (r.status === 200 && !isBoard(body))) setError('missing');
          else setError('offline');
        });
      })
      .catch(function () { setError('offline'); })
      .then(function () { if (inflight === p) inflight = null; });
    return p;
  };

  // Startup: never rejects, never waits more than 4 s.
  App.loadBoard = function () {
    var timeout = new Promise(function (resolve) { setTimeout(resolve, 4000); });
    return Promise.race([B.load(), timeout]).catch(function () {});
  };

  var FAST = { week: 1, shopping: 1, tasks: 1, home: 1 };
  function interval() { return FAST[App.current] ? 30000 : 60000; }
  B.poll = function () {
    if (B.pending) return Promise.resolve();
    var weekChanged = B.live && etagWeek && etagWeek !== B.mondayOf();
    if (!weekChanged && Date.now() - lastLoad < interval() - 2000) return Promise.resolve();
    return B.load();
  };
  App.on('minute', function () { B.poll(); });
  setInterval(function () { B.poll(); }, 30000);

  // ------------------------------------------------------------ writes
  var FAIL = 'Couldn’t save — check the connection';
  function clone(x) { return x == null ? x : JSON.parse(JSON.stringify(x)); }

  function failed(res) {
    if (res.status === 409) {
      App.toast('The board changed — showing the latest', { icon: 'bolt' });
      etag = null;
      B.load();
      return;
    }
    if (res.status === 401) { App.toast('This frame isn’t linked — changes can’t be saved', { icon: 'bolt' }); return; }
    if (res.status === 403) { App.toast('This frame isn’t allowed to make that change', { icon: 'bolt' }); return; }
    App.toast(FAIL, { icon: 'bolt' });
  }

  // op(ops, {apply?, message?, undoOps?, undoApply?, icon?}) — POST ops to /api/board.
  // apply(data) mutates B.data optimistically (emits 'board' with {local:true}); it is rolled back
  // when the write fails (409 reloads instead). The server's {board} replaces the data once no
  // other write is in flight. Resolves true when saved.
  B.op = function (ops, opts) {
    opts = opts || {};
    if (!B.live || !B.data) return Promise.resolve(false);
    var snapshot = clone(B.data);
    if (opts.apply) {
      try { opts.apply(B.data); } catch (e) { /* optimistic preview only */ }
      App.emit('board', { local: true });
    }
    if (opts.message) {
      App.toast(opts.message, {
        icon: opts.icon,
        ms: opts.ms,
        undo: opts.undoOps ? function () { B.op(opts.undoOps, { apply: opts.undoApply }); } : undefined
      });
    }
    B.pending++;
    var gen = ++writes;
    return request('/api/board', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ ops: ops })
    }).then(function (r) {
      return readJson(r).then(function (body) {
        var doc = body && body.board ? body.board : null;
        return { ok: r.status === 200 && isBoard(doc), status: r.status, body: doc || body };
      });
    }, function () {
      return { ok: false, status: 0, body: null };
    }).then(function (res) {
      B.pending--;
      if (res.ok) {
        etag = null; // the POST's board carries no GET ETag: the next poll refetches
        if (!B.pending) setData(res.body);
      } else {
        if (res.status !== 409 && gen === writes) { B.data = snapshot; App.emit('board', { local: true, rollback: true }); }
        else if (res.status !== 409) B.load();
        failed(res);
      }
      return res.ok;
    });
  };
})();
