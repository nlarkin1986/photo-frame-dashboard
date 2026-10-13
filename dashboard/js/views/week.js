// "This week" (direction B, "Needs you"): what needs one of you, the to-dos, and a 7-day strip.
// Data: App.board.data.brief. Writes: brief.assign, brief.todo, brief.owner; long-press →
// brief.dismiss with a reason; review-mode agent suggestions (pending, section 'brief') →
// pending.approve / pending.dismiss. Headline, specials, still open, coming up and notes live in
// the week sheet (tap the strip, or "Later this month"). Private items only ever appear as
// generic text or a count.
(function () {
  'use strict';
  var B = App.board;
  var V = { el: null, sig: '', dayKey: '', whoByKey: {}, justDone: {}, holdFired: false, tab: 'week' };
  var HOLD = 600;
  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var DAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var COUNT = ['Nothing', 'One thing', 'Two things', 'Three things', 'Four things', 'Five things'];

  function esc(s) { return App.esc(s == null ? '' : s); }
  function today() { return B.todayIso(); }
  function diffDays(dateIso) { var d = B.dateOf(dateIso); return d ? Math.round((d - App.dayStart(App.now())) / 864e5) : null; }
  // "Today", "Tomorrow", "Thursday", "Tue Oct 20"
  function dayName(dateIso) {
    var d = B.dateOf(dateIso), n = diffDays(dateIso);
    if (!d) return '';
    if (n === 0) return 'Today';
    if (n === 1) return 'Tomorrow';
    if (n === -1) return 'Yesterday';
    if (n > 1 && n < 7) return DAY[d.getDay()];
    return DOW[d.getDay()] + ' ' + App.fmt.monthShort(d) + ' ' + d.getDate();
  }
  function rangeLabel(mondayIso) {
    var m = B.dateOf(mondayIso);
    if (!m) return '';
    var s = App.addDays(m, 6);
    return App.fmt.monthShort(m) + ' ' + m.getDate() + '–' + (s.getMonth() === m.getMonth() ? '' : App.fmt.monthShort(s) + ' ') + s.getDate();
  }
  function longRange(mondayIso) {
    var m = B.dateOf(mondayIso);
    if (!m) return 'This week';
    var s = App.addDays(m, 6);
    return App.fmt.month(m) + ' ' + m.getDate() + '–' + (s.getMonth() === m.getMonth() ? '' : App.fmt.month(s) + ' ') + s.getDate();
  }
  function countdown(t) { var m = (t - App.now()) / 60000; return m <= 0 ? 'now' : 'in ' + App.fmt.mins(m); }
  function whoAttr(w) { var k = B.whoKey(w) || 'none'; V.whoByKey[k] = w || null; return esc(k); }
  function lockIcon(size) { return App.icon('lock', size || 16); }
  function published(isoStr) {
    var d = isoStr ? new Date(isoStr) : null;
    if (!d || isNaN(d)) return 'recently';
    var days = (App.dayStart(App.now()) - App.dayStart(d)) / 864e5;
    return (days < 1 ? 'today' : days < 2 ? 'yesterday' : days < 7 ? DOW[d.getDay()] : App.fmt.monthShort(d) + ' ' + d.getDate()) + ' ' + App.fmt.time(d);
  }

  // ------------------------------------------------------------ header (quiet status text)
  function status(b) {
    var cls = '', txt;
    var label = b && b.source && b.source.label ? b.source.label : 'Week-ahead agent';
    if (B.error === 'offline' || B.error === 'unlinked') { cls = ' is-off'; txt = (B.error === 'unlinked' ? 'Not linked' : 'Offline') + (b && b.publishedAt ? ' · showing ' + published(b.publishedAt) : ''); }
    else if (!b) txt = 'Waiting for the week-ahead agent';
    else if (b.week < B.mondayOf()) { cls = ' is-stale'; txt = 'Last week’s update · ' + label; }
    else {
      var age = b.publishedAt ? (App.now() - new Date(b.publishedAt)) / 864e5 : 99;
      txt = 'Updated ' + published(b.publishedAt) + ' · ' + label;
      if (age > 4) cls = ' is-stale';
    }
    return '<div class="wb-status' + cls + '">' + esc((b ? rangeLabel(b.week) : rangeLabel(B.mondayOf())) + ' · ' + txt) + '</div>';
  }
  function title(n) {
    if (!n) return '<h1 class="wb-h wb-h--calm">' + App.icon('check', 30) + 'Nothing needs deciding</h1>';
    return '<h1 class="wb-h">' + (COUNT[n] || n + ' things') + ' need' + (n === 1 ? 's' : '') + ' one of you</h1>';
  }

  // ------------------------------------------------------------ needs you (compact rows)
  function whoOptions(dc) {
    var out = [], seen = {};
    function push(w, sub) { var k = B.whoKey(w); if (!k || seen[k]) return; seen[k] = 1; out.push({ who: w, sub: sub }); }
    B.adults().forEach(function (p) { push({ person: p.id }, 'Parent'); });
    (dc && dc.candidates || []).forEach(function (w) { push(w, w && w.person ? (App.person(w.person).role === 'kid' ? 'Kid' : 'Parent') : 'Helper'); });
    return out;
  }
  // Filled care days become the context line ("Kristin has Wednesday and Thursday.").
  function context(dc) {
    var slots = dc.slots || [];
    if (slots.length > 1) {
      var by = {}, order = [];
      slots.forEach(function (s) {
        if (!s.who) return;
        var k = B.whoKey(s.who);
        if (!by[k]) { by[k] = { who: s.who, days: [] }; order.push(k); }
        var d = B.dateOf(s.date);
        by[k].days.push(d ? DAY[d.getDay()] : s.label);
      });
      if (order.length) {
        return order.map(function (k) {
          var ds = by[k].days;
          return B.whoName(by[k].who) + ' has ' + (ds.length > 1 ? ds.slice(0, -1).join(', ') + ' and ' + ds[ds.length - 1] : ds[0]);
        }).join('; ') + '.';
      }
    }
    return dc.context || '';
  }
  function askRow(a) {
    var dc = a.dc, at = a.time ? B.timeOn(a.date, a.time) : null;
    var when = dayName(a.date) + (a.time ? ' at ' + a.time : '');
    var soon = at && diffDays(a.date) === 0 && (at - App.now()) > -60 * 60000;
    var ctx = context(dc);
    var chips = whoOptions(dc).slice(0, 3).map(function (o) {
      var v = B.whoView(o.who);
      return '<button class="wb-pk" style="' + B.pstyle(v) + '" data-assign="' + esc(dc.id) + '" data-slot="' + esc(a.slot.id) + '" data-who="' + whoAttr(o.who) + '">' + B.avatar(o.who, 48) + '<span>' + esc(v.name) + '</span></button>';
    }).join('');
    return '<div class="wb-ask" data-dc="' + esc(dc.id) + '">' +
      '<div class="wb-ask-x" data-hold-dc="' + esc(dc.id) + '">' +
      '<div class="wb-ask-l1"><i class="wb-dot"></i><span class="wb-ask-when">' + esc(when) + (soon ? ' · <em data-cd="' + (+at) + '">' + countdown(at) + '</em>' : '') + '</span>' +
      '<span class="wb-ask-q">' + esc(dc.title) + '</span></div>' +
      (ctx ? '<div class="wb-ask-ctx">' + esc(ctx) + '</div>' : '') + '</div>' +
      '<div class="wb-who">' + chips +
      '<button class="wb-pk wb-pk--other" data-other="' + esc(dc.id) + '" data-slot="' + esc(a.slot.id) + '"><span class="wb-pk-plus">' + App.icon('plus', 22) + '</span><span>Other</span></button></div></div>';
  }
  function asksHTML(asks, max) {
    if (!asks.length) return '';
    var shown = asks.slice(0, max), more = asks.length - shown.length;
    return shown.map(askRow).join('') +
      '';
  }

  // ------------------------------------------------------------ to-dos
  function todos(b) {
    return (b.todos || []).filter(function (t) { return !t.private && !t.dismissed && (!t.done || V.justDone[t.id]); });
  }
  function dueLabel(t) {
    if (!t.due) return '';
    var over = t.due < today() && !t.done;
    return '<small class="' + (over ? 'is-over' : 'is-due') + '">' + (over ? 'Overdue · ' : 'Due ') + esc(dayName(t.due)) + '</small>';
  }
  function todoRow(t) {
    var link = t.link && t.link.host ? '<small class="wb-host">' + esc(t.link.host) + '</small>' : '';
    return '<div class="wb-td' + (t.done ? ' is-done' : '') + '" data-td="' + esc(t.id) + '">' +
      '<button class="wb-check" data-todo="' + esc(t.id) + '" aria-label="Done"><span class="wb-box">' + App.icon('check', 24) + '</span></button>' +
      '<span class="wb-td-x" data-hold-td="' + esc(t.id) + '"><b>' + esc(t.text) + '</b>' + dueLabel(t) + link + '</span>' +
      '<button class="wb-own' + (t.owner ? '' : ' wb-own--none') + '" data-owner="' + esc(t.id) + '" aria-label="Owner">' + (t.owner ? B.avatar(t.owner, 40) : App.icon('plus', 22)) + '</button></div>';
  }
  function todosHTML(b, max) {
    var list = todos(b), priv = B.privateCount();
    var shown = list.slice(0, max), more = list.length - shown.length;
    return '<div class="wb-sec-h"><h2 class="serif">To-dos</h2><span class="wb-sec-r">' +
      (priv ? '<span class="wb-private">' + lockIcon(20) + priv + ' private item' + (priv === 1 ? ' is' : 's are') + ' on your phones</span>' : '') +
      (more > 0 ? '<button class="wb-td-more" data-sheet="open">+' + more + ' more</button>' : '') + '</span></div>' +
      pendingStrip() +
      (list.length ? '<div class="wb-todos">' + shown.map(todoRow).join('') +
        '</div>'
        : '<div class="wb-calm serif">No to-dos left this week.</div>');
  }
  function pendingStrip() {
    var pd = B.pendingFor('brief');
    if (!pd.length) return '';
    return '<div class="pend-strip">' + pd.slice(0, 1).map(function (p) {
      return '<div class="pend-row"><span class="pend-x">' + B.srcChip(B.pendingSource(p) || { agent: 'agent', label: 'Agent' }) + '<b>' + esc(B.pendingText(p)) + '</b></span>' +
        '<button class="pend-btn" data-pend-no="' + esc(p.id) + '" aria-label="Dismiss">' + App.icon('x', 22) + '</button><button class="pend-btn pend-btn--yes" data-pend-yes="' + esc(p.id) + '">Approve</button></div>';
    }).join('') + (pd.length > 1 ? '<span class="label">+' + (pd.length - 1) + ' more suggestions</span>' : '') + '</div>';
  }

  // ------------------------------------------------------------ 7-day strip
  function decisionFor(b, id) { return id ? B.findIn(b.decisions, id) : null; }
  function careTime(label) { var m = /(\d{1,2}(?::\d\d)?)/.exec(label || ''); return m ? m[1] : ''; }
  // Lines for one day: open questions and care gaps first, then timed items with times.
  // Strip display text: drop a trailing parenthetical ("Lilly pickup (Kristin usually starts 11:30)").
  function short(text) { return String(text || '').replace(/\s*\([^()]*\)\s*$/, '') || String(text || ''); }
  // Lines for one day: open questions and care gaps first, then items in time order.
  function dayLines(b, day, isToday) {
    var first = [], rest = [];
    (day.items || []).forEach(function (it) {
      if (it.private) { rest.push({ t: it.time || '', x: lockIcon(14) + 'Private', cls: 'is-private' }); return; }
      var d = decisionFor(b, it.decision);
      if (d && !d.private && !d.dismissed) {
        var who = (d.slots || []).filter(function (s) { return s.who; })[0];
        if (B.decisionOpen(d) && !who) { first.push({ t: it.time || '', x: esc(short(it.text)), cls: 'is-open' }); return; }
        if (who) { rest.push({ t: it.time || '', x: esc(B.whoName(who.who)) + ': ' + esc(short(it.text)) }); return; }
      }
      if (it.kind === 'deadline') rest.push({ t: 'Due', x: esc(short(it.text)) });
      else if (it.kind === 'timed') rest.push({ t: it.time || '', x: esc(short(it.text)) });
      else rest.push({ t: it.kind === 'allDay' ? 'All day' : '', x: esc(short(it.text)), cls: 'is-soft', late: true });
    });
    var care = B.careOn(day);
    if (!care && day.care && day.care.needed) first.push({ t: '', x: 'No care yet', cls: 'is-open' });
    else if (care && isToday) rest.unshift({ t: day.care && day.care.label ? careTime(day.care.label) : '', x: esc(B.whoName(care)) + ' has the kids' });
    var mins = function (l) { var x = l.t && B.timeOn(day.date, l.t); return x ? x.getHours() * 60 + x.getMinutes() : (l.t === 'Due' ? -1 : 2000); };
    rest.sort(function (a, c) { return (a.late ? 1 : 0) - (c.late ? 1 : 0) || mins(a) - mins(c); });
    return first.concat(rest);
  }
  function lineHTML(l) {
    return '<span class="wb-d-line ' + (l.cls || '') + '">' + (l.t ? '<span class="wb-d-t">' + esc(l.t) + '</span>' : '') + '<span class="wb-d-x">' + l.x + '</span></span>';
  }
  // Every day renders all its lines; trimStrip() then drops lines per cell until each fits.
  function stripHTML(b) {
    var current = b.week === B.mondayOf(), t = today();
    var days = (b.days || []).slice().sort(function (x, y) { return x.date < y.date ? -1 : 1; });
    var hasToday = current && days.some(function (d) { return d.date === t; });
    var cols = days.map(function (d) { return hasToday && d.date === t ? '2.4fr' : '1fr'; }).join(' ');
    return '<nav class="wb-strip" style="grid-template-columns:' + cols + '">' + days.map(function (day) {
      var d = B.dateOf(day.date), isToday = current && day.date === t, past = current && day.date < t;
      var lines = dayLines(b, day, isToday).slice(0, past ? 1 : isToday ? 4 : 3);
      var total = dayLines(b, day, isToday).length;
      var gap = lines.length && lines[0].cls === 'is-open';
      var head = isToday
        ? '<span class="wb-d-top"><span class="wb-d-date num">' + d.getDate() + '</span><span class="wb-d-dow">Today</span></span>'
        : '<span class="wb-d-dow">' + DOW[d.getDay()] + '</span><span class="wb-d-date num">' + d.getDate() + '</span>';
      return '<button class="wb-d' + (isToday ? ' is-today' : '') + (past ? ' is-past' : '') + (gap && !past ? ' is-gap' : '') + '" data-sheet="week" data-total="' + total + '" data-past="' + (past ? 1 : 0) + '">' + head +
        '<span class="wb-d-lines">' + lines.map(lineHTML).join('') + '</span></button>';
    }).join('') + '</nav>';
  }
  // Per cell: drop the last line until the cell fits, then add "+N more" (never for past days).
  function trimStrip(stripEl) {
    App.$$('.wb-d', stripEl).forEach(function (cell) {
      var box = cell.querySelector('.wb-d-lines'), total = +cell.getAttribute('data-total'), past = cell.getAttribute('data-past') === '1';
      function more() {
        var old = box.querySelector('.wb-d-more');
        if (old) box.removeChild(old);
        var n = total - box.querySelectorAll('.wb-d-line').length;
        if (n > 0 && !past) { var m = document.createElement('span'); m.className = 'wb-d-more'; m.textContent = '+' + n + ' more'; box.appendChild(m); }
      }
      more();
      while (overflows(cell) && box.querySelectorAll('.wb-d-line').length > 1) {
        var ls = box.querySelectorAll('.wb-d-line');
        box.removeChild(ls[ls.length - 1]);
        more();
      }
    });
  }

  // ------------------------------------------------------------ render
  function overflows(el) { return el && el.scrollHeight > el.clientHeight + 1; }
  function render() {
    var b = B.brief();
    V.whoByKey = {};
    V.dayKey = today();
    V.sig = signature();
    if (!b) return renderEmpty();
    var asks = B.openAsks();
    V.el.innerHTML = '<div class="wb' + (asks.length ? '' : ' is-calm') + '">' +
      '<header class="wb-head"><div class="wb-head-l">' + title(asks.length) + status(b) + '</div><div class="wb-head-r">' +
      (asks.length > 2 ? '<button class="wb-later wb-later--alert" data-more-asks>+' + (asks.length - 2) + ' more to decide</button>' : '') +
      '<button class="wb-later" data-sheet="later">Later this month</button></div></header>' +
      (asks.length ? '<section class="wb-asks"></section>' : '') +
      '<section class="wb-todo-sec"></section>' +
      '<section class="wb-strip-sec"></section></div>';
    fit(b, asks);
    bindHolds();
  }
  // Fill the 752 px box: two asks, as many to-dos as fit, and a strip at least ~200 px tall.
  function fit(b, asks) {
    var root = V.el.querySelector('.wb');
    var asksEl = V.el.querySelector('.wb-asks'), todoEl = V.el.querySelector('.wb-todo-sec'), stripEl = V.el.querySelector('.wb-strip-sec');
    if (asksEl) asksEl.innerHTML = asksHTML(asks, 2);
    // To-dos give way first so the strip keeps ~220 px; lines are then fitted cell by cell.
    var plans = [6, 4, 2];
    for (var i = 0; i < plans.length; i++) {
      todoEl.innerHTML = todosHTML(b, plans[i]);
      stripEl.innerHTML = stripHTML(b);
      if (!overflows(root) && stripEl.clientHeight >= 240) break;
    }
    trimStrip(stripEl.querySelector('.wb-strip'));
  }
  function renderEmpty() {
    var off = B.error === 'offline' && !B.live;
    V.el.innerHTML = '<div class="wb is-calm">' +
      '<header class="wb-head"><div class="wb-head-l"><h1 class="wb-h wb-h--calm">' + (off ? 'Can’t reach the board' : 'No weekly update yet') + '</h1>' + status(null) + '</div></header>' +
      (B.live ? '<section class="wb-todo-sec">' + pendingStrip() + '</section>' : '') +
      '<p class="wb-calm serif">' + (off ? 'This week will show up as soon as the frame is back online.' : 'The week-ahead agent posts on Sunday. Decisions, care and to-dos for the week land here.') + '</p></div>';
  }
  function signature() {
    return JSON.stringify([B.brief(), B.pendingFor('brief'), B.error, B.live, window.DATA.people.map(function (p) { return [p.id, p.name, p.color]; })]);
  }

  // ------------------------------------------------------------ long-press → dismiss with a reason
  function bindHolds() {
    App.$$('[data-hold-dc],[data-hold-td]', V.el).forEach(function (el) {
      App.hold(el, HOLD, {
        done: function () {
          V.holdFired = true;
          if (el.hasAttribute('data-hold-dc')) dismissSheet('decision', el.getAttribute('data-hold-dc'));
          else dismissSheet('todo', el.getAttribute('data-hold-td'));
        }
      });
    });
  }
  function dismissSheet(kind, id) {
    var b = B.brief();
    var item = b && B.findIn(kind === 'decision' ? b.decisions : b.todos, id);
    if (!item) return;
    var reasons = kind === 'decision' ? ['Not needed', 'Already sorted', 'Wrong info'] : ['Already done', 'Not needed', 'Wrong info'];
    App.sheet('<div class="sheet-pad"><div class="label">' + (kind === 'decision' ? 'Decision' : 'To-do') + ' · remove from this week</div>' +
      '<h2 class="serif sheet-h wb-sheet-h">' + esc(item.title || item.text) + '</h2>' +
      '<div class="wb-reasons">' + reasons.map(function (r) { return '<button class="btn btn--ghost" data-reason="' + esc(r) + '">' + esc(r) + '</button>'; }).join('') + '</div>' +
      '<div class="sheet-note">' + App.icon('bell', 18) + 'The agent sees why, so it won’t bring this back.</div></div>', {
      onMount: function (s, close) {
        s.addEventListener('click', function (e) {
          var r = e.target.closest('[data-reason]');
          if (!r) return;
          close();
          var reason = r.getAttribute('data-reason');
          B.op([{ op: 'brief.dismiss', kind: kind, id: id, reason: reason }], {
            apply: function (d) { var x = d.brief && B.findIn(kind === 'decision' ? d.brief.decisions : d.brief.todos, id); if (x) x.dismissed = true; },
            message: 'Removed <b>' + esc(item.title || item.text) + '</b> · ' + esc(reason.toLowerCase()), icon: 'check'
          });
        });
      }
    });
  }

  // ------------------------------------------------------------ writes
  function assign(dcId, slotId, who) {
    var b = B.brief(), dc = b && B.findIn(b.decisions, dcId), slot = dc && B.findIn(dc.slots, slotId);
    if (!slot) return;
    var prev = slot.who || null;
    if (B.sameWho(prev, who)) return;
    function set(w) { return function (d) { var x = d.brief && B.findIn(d.brief.decisions, dcId), s = x && B.findIn(x.slots, slotId); if (s) s.who = w; }; }
    var d = B.dateOf(slot.date);
    B.op([{ op: 'brief.assign', decision: dcId, slot: slotId, who: who }], {
      apply: set(who),
      message: '<b>' + esc(who ? B.whoName(who) : 'Nobody') + '</b> · ' + esc(dc.title) + ((dc.slots || []).length > 1 && d ? ' (' + DAY[d.getDay()] + ')' : ''),
      icon: 'check',
      undoOps: [{ op: 'brief.assign', decision: dcId, slot: slotId, who: prev }],
      undoApply: set(prev)
    });
  }
  function toggleTodo(id) {
    var b = B.brief(), t = b && B.findIn(b.todos, id);
    if (!t) return;
    var on = !t.done;
    function set(v) { return function (d) { var x = d.brief && B.findIn(d.brief.todos, id); if (x) x.done = v; }; }
    // A to-do checked on the main view leaves it on the next repaint (it stays in the week sheet).
    delete V.justDone[id];
    B.op([{ op: 'brief.todo', id: id, done: on }], {
      apply: set(on),
      message: (on ? 'Done: <b>' : 'Not done: <b>') + esc(t.text) + '</b>', icon: on ? 'check' : undefined,
      undoOps: [{ op: 'brief.todo', id: id, done: !on }], undoApply: set(!on)
    });
  }
  function setOwner(id, who) {
    var b = B.brief(), t = b && B.findIn(b.todos, id);
    if (!t) return;
    var prev = t.owner || null;
    function set(w) { return function (d) { var x = d.brief && B.findIn(d.brief.todos, id); if (x) x.owner = w; }; }
    B.op([{ op: 'brief.owner', id: id, owner: who }], {
      apply: set(who),
      message: (who ? '<b>' + esc(B.whoName(who)) + '</b> owns ' : 'No owner for ') + esc(t.text),
      undoOps: [{ op: 'brief.owner', id: id, owner: prev }], undoApply: set(prev)
    });
  }

  // ------------------------------------------------------------ small who picker (with free text)
  function helperOptions() {
    var b = B.brief(), out = [];
    (b && b.decisions || []).forEach(function (d) { (d.candidates || []).forEach(function (w) { if (w && !w.person) out.push(w); }); });
    return out;
  }
  function whoSheet(opts) {
    var options = opts.options.concat([{ who: { name: 'Us' }, sub: 'Both of us' }]);
    var seen = {};
    options = options.filter(function (o) { var k = B.whoKey(o.who); if (seen[k]) return false; seen[k] = 1; return true; });
    var picks = {};
    var grid = options.map(function (o, i) {
      picks[i] = o.who;
      var v = B.whoView(o.who);
      return '<button class="wb-who-btn' + (opts.current && B.sameWho(opts.current, o.who) ? ' is-on' : '') + '" style="' + B.pstyle(v) + '" data-pick="' + i + '">' + B.avatar(o.who, 56) + '<span>' + esc(v.name) + '</span></button>';
    }).join('');
    App.sheet('<div class="sheet-pad"><div class="label">' + esc(opts.label) + '</div><h2 class="serif sheet-h wb-sheet-h">' + esc(opts.title) + '</h2>' +
      '<div class="wb-who-grid">' + grid + '</div>' +
      '<div class="wb-someone"><input class="wb-input" maxlength="24" placeholder="Someone else — type a name" autocomplete="off" enterkeyhint="done"><button class="btn btn--solid" data-save>Save</button></div>' +
      (opts.current || opts.dismiss ? '<div class="wb-who-alt">' + (opts.current ? '<button class="btn btn--ghost" data-clear>Clear</button>' : '') +
        (opts.dismiss ? '<button class="btn btn--ghost wb-hold" data-notneeded><span>' + esc(opts.dismiss) + ' · hold</span></button>' : '') + '</div>' : '') +
      '</div>', {
      cls: 'wb-picker',
      onMount: function (s, close) {
        var nn = s.querySelector('[data-notneeded]');
        if (nn) App.hold(nn, HOLD, { done: function () { close(); opts.onDismiss(); }, cancel: function () { App.toast('Keep holding to mark it not needed', { ms: 2000 }); } });
        var input = s.querySelector('.wb-input');
        function saveTyped() { var n = input.value.trim().slice(0, 24); if (!n) return; close(); opts.onPick({ name: n }); }
        input.addEventListener('keydown', function (e) { if (e.key === 'Enter') saveTyped(); });
        s.addEventListener('click', function (e) {
          var t;
          if ((t = e.target.closest('[data-pick]'))) { close(); opts.onPick(picks[+t.getAttribute('data-pick')]); return; }
          if (e.target.closest('[data-save]')) { saveTyped(); return; }
          if (e.target.closest('[data-clear]')) { close(); opts.onPick(null); }
        });
      }
    });
  }
  function decisionSheet(dcId, slotId) {
    var b = B.brief(), dc = b && B.findIn(b.decisions, dcId);
    if (!dc) return;
    var slot = B.findIn(dc.slots, slotId) || (dc.slots || [])[0];
    if (!slot) return;
    var date = slot.date || (dc.when && dc.when.date);
    var label = dayName(date) + ((dc.slots || []).length === 1 && dc.when && dc.when.time ? ' at ' + dc.when.time : '') + (dc.kind === 'care' ? ' · care' : '');
    whoSheet({
      label: label, title: dc.title, current: slot.who, options: whoOptions(dc),
      dismiss: (dc.slots || []).length > 1 ? 'Skip this decision' : 'Not needed',
      onPick: function (w) { assign(dc.id, slot.id, w); },
      onDismiss: function () {
        B.op([{ op: 'brief.dismiss', kind: 'decision', id: dc.id, reason: 'Not needed' }], {
          apply: function (dd) { var x = dd.brief && B.findIn(dd.brief.decisions, dc.id); if (x) x.dismissed = true; },
          message: 'Marked not needed: <b>' + esc(dc.title) + '</b>', icon: 'check'
        });
      }
    });
  }
  function ownerSheet(id) {
    var b = B.brief(), t = b && B.findIn(b.todos, id);
    if (!t) return;
    var opts = B.adults().map(function (p) { return { who: { person: p.id }, sub: 'Parent' }; })
      .concat(helperOptions().map(function (w) { return { who: w, sub: 'Helper' }; }));
    whoSheet({ label: 'To-do · who owns it?', title: t.text, current: t.owner, options: opts, onPick: function (w) { setOwner(id, w); } });
  }
  // "+N more to decide": every open ask, one tap to pick who.
  function asksSheet() {
    var asks = B.openAsks();
    App.sheet('<div class="sheet-pad"><div class="label">This week</div><h2 class="serif sheet-h wb-sheet-h">Needs one of you</h2>' +
      '<div class="wb-asks-list">' + asks.map(function (a) {
        return '<button class="wb-asks-row" data-other="' + esc(a.dc.id) + '" data-slot="' + esc(a.slot.id) + '"><i class="wb-dot"></i><span><small>' + esc(dayName(a.date) + (a.time ? ' at ' + a.time : '')) + '</small>' + esc(a.dc.title) + '</span><b>Pick</b></button>';
      }).join('') + '</div></div>', {
      cls: 'wb-picker',
      onMount: function (s, close) {
        s.addEventListener('click', function (e) {
          var t = e.target.closest('[data-other]');
          if (!t) return;
          close();
          decisionSheet(t.getAttribute('data-other'), t.getAttribute('data-slot'));
        });
      }
    });
  }

  // ------------------------------------------------------------ week sheet (tabs: The week · Coming up · Still open)
  function agendaHTML(b) {
    var current = b.week === B.mondayOf(), t = today();
    var days = (b.days || []).slice().sort(function (x, y) { return x.date < y.date ? -1 : 1; });
    return '<div class="wb-ag">' + days.map(function (day) {
      var d = B.dateOf(day.date), isToday = current && day.date === t, past = current && day.date < t;
      var care = B.careOn(day), wkend = d.getDay() === 0 || d.getDay() === 6;
      var careHTML = care ? esc(B.whoName(care)) + (day.care && day.care.label && day.care.who && B.sameWho(day.care.who, care) ? ' ' + esc(day.care.label) : '')
        : day.care && day.care.needed ? '<span class="is-gap">No care yet</span>' : '<span class="is-none">' + (wkend ? 'Weekend' : '—') + '</span>';
      var items = (day.items || []).map(function (it) {
        var dc = decisionFor(b, it.decision), open = dc && !dc.private && !dc.dismissed && B.decisionOpen(dc);
        var who = dc && !dc.private && (dc.slots || []).filter(function (s) { return s.who; })[0];
        var tl = it.kind === 'deadline' ? 'Due' : it.kind === 'allDay' ? 'All day' : it.kind === 'note' ? (it.time || 'Note') : (it.time || '');
        var x = it.private ? '<span class="wb-ag-priv">' + lockIcon(16) + 'Private</span>'
          : (who && !open ? esc(B.whoName(who.who)) + ': ' : '') + esc(it.text);
        return '<li>' + (tl ? '<div class="wb-ag-t' + (open ? ' is-open' : '') + '">' + esc(tl) + '</div>' : '') + '<div class="wb-ag-x">' + x + '</div></li>';
      }).join('');
      var specials = (day.specials || []).map(function (s) { return (s.person ? esc(App.person(s.person).name) + ': ' : '') + esc(s.text); }).join('. ');
      return '<div class="wb-ag-day' + (isToday ? ' is-today' : '') + (past ? ' is-past' : '') + '">' +
        '<span class="wb-ag-dow">' + (isToday ? 'Today' : DOW[d.getDay()]) + '</span><span class="wb-ag-date num">' + d.getDate() + '</span>' +
        '<div class="wb-ag-care">' + careHTML + '</div><ul class="wb-ag-items">' + items + '</ul>' +
        (specials ? '<p class="wb-ag-special">' + specials + '</p>' : '') + '</div>';
    }).join('') + '</div>';
  }
  function comingHTML(b) {
    var t = today();
    var up = (b.comingUp || []).filter(function (u) { return !u.date || u.date >= t; }).sort(function (x, y) { return (x.date || '') < (y.date || '') ? -1 : 1; });
    var head = (b.headline || []).map(function (h) {
      var p = h.person ? { person: h.person } : null, v = p && B.whoView(p);
      return '<span class="wb-fact"' + (v ? ' style="' + B.pstyle(v) + '"' : '') + '>' + (v ? B.avatar(p, 32) + '<b>' + esc(v.name) + '</b> ' : '') + esc(h.text) + '</span>';
    }).join('');
    return (head ? '<div class="wb-facts">' + head + '</div>' : '') +
      (up.length ? '<div class="wb-up">' + up.map(function (u) {
        var d = B.dateOf(u.date);
        return '<div class="wb-up-row"><span class="wb-up-d">' + (d ? DOW[d.getDay()] + ' ' + App.fmt.monthShort(d) + ' ' + d.getDate() : '') + '</span>' +
          '<span class="wb-up-x"><b>' + esc(u.text) + '</b>' + (u.time || u.place ? '<small>' + esc([u.time, u.place].filter(Boolean).join(' · ')) + '</small>' : '') + '</span></div>';
      }).join('') + '</div>' : '<div class="wb-calm serif">Nothing on the horizon yet.</div>');
  }
  function openHTML(b) {
    var all = (b.todos || []).filter(function (x) { return !x.private && !x.dismissed; });
    var priv = B.privateCount();
    return '<div class="wb-open-cols"><div><h3 class="wb-sh-h">To-dos</h3>' +
      (all.length ? '<div class="wb-todos wb-todos--one">' + all.map(todoRow).join('') + '</div>' : '<div class="wb-calm serif">No to-dos.</div>') +
      (priv ? '<p class="wb-private">' + lockIcon(20) + priv + ' private item' + (priv === 1 ? ' is' : 's are') + ' on your phones</p>' : '') + '</div>' +
      '<div><h3 class="wb-sh-h">Still open</h3>' +
      ((b.stillOpen || []).length ? '<div class="wb-chips">' + b.stillOpen.map(function (s) { return '<span>' + esc(s.text) + '</span>'; }).join('') + '</div>' : '<div class="wb-calm serif">Nothing.</div>') +
      ((b.notes || []).length ? '<h3 class="wb-sh-h">Notes</h3>' + b.notes.map(function (n) { return '<p class="wb-note serif">' + esc(n.text) + '</p>'; }).join('') : '') +
      '</div></div>';
  }
  function weekSheet(tab) {
    var b = B.brief();
    if (!b) return;
    V.tab = tab || 'week';
    function body() { var x = B.brief(); return V.tab === 'later' ? comingHTML(x) : V.tab === 'open' ? openHTML(x) : agendaHTML(x); }
    function seg() {
      return [['week', 'The week'], ['later', 'Coming up'], ['open', 'Still open']].map(function (s) {
        return '<button class="' + (V.tab === s[0] ? 'is-on' : '') + '" data-tab="' + s[0] + '">' + s[1] + '</button>';
      }).join('');
    }
    App.sheet('<i class="wb-grab"></i><header class="wb-sh-head"><h1 class="num">' + esc(longRange(b.week)) + '</h1><div class="seg wb-seg">' + seg() + '</div></header>' +
      '<div class="wb-sh-body">' + body() + '</div>', {
      cls: 'wb-weeksheet',
      onMount: function (s) {
        var onBoard = function () { if (s.isConnected && B.brief()) s.querySelector('.wb-sh-body').innerHTML = body(); };
        V.sheetRefresh = onBoard;
        s.addEventListener('click', function (e) {
          var t;
          if ((t = e.target.closest('[data-tab]'))) {
            V.tab = t.getAttribute('data-tab');
            s.querySelector('.wb-seg').innerHTML = seg();
            s.querySelector('.wb-sh-body').innerHTML = body();
            return;
          }
          if ((t = e.target.closest('[data-todo]'))) { toggleTodo(t.getAttribute('data-todo')); return; }
          if ((t = e.target.closest('[data-owner]'))) { ownerSheet(t.getAttribute('data-owner')); }
        });
      },
      onClose: function () { V.sheetRefresh = null; }
    });
  }

  // ------------------------------------------------------------ events
  function onClick(e) {
    if (V.holdFired) { V.holdFired = false; return; }
    var t;
    if ((t = e.target.closest('[data-assign]'))) return assign(t.getAttribute('data-assign'), t.getAttribute('data-slot'), V.whoByKey[t.getAttribute('data-who')] || null);
    if ((t = e.target.closest('[data-other]'))) return decisionSheet(t.getAttribute('data-other'), t.getAttribute('data-slot'));
    if (e.target.closest('[data-more-asks]')) return asksSheet();
    if ((t = e.target.closest('[data-todo]'))) return toggleTodo(t.getAttribute('data-todo'));
    if ((t = e.target.closest('[data-owner]'))) return ownerSheet(t.getAttribute('data-owner'));
    if ((t = e.target.closest('[data-pend-yes]')) || (t = e.target.closest('[data-pend-no]'))) {
      var yes = t.hasAttribute('data-pend-yes'), pid = t.getAttribute(yes ? 'data-pend-yes' : 'data-pend-no');
      B.op([{ op: yes ? 'pending.approve' : 'pending.dismiss', id: pid }], {
        apply: function (d) { d.pending = (d.pending || []).filter(function (p) { return p.id !== pid; }); },
        message: yes ? 'Approved' : 'Dismissed', icon: yes ? 'check' : undefined, ms: 3000
      });
      return;
    }
    if (e.target.closest('[data-refresh]')) { App.toast('Checking for updates…', { ms: 2000, icon: 'clock' }); B.load(); return; }
    if ((t = e.target.closest('[data-sheet]'))) return weekSheet(t.getAttribute('data-sheet'));
  }

  // Rail badge: things that need one of you.
  function badge() {
    var el = App.$('#weekBadge');
    if (!el) return;
    var n = B.openAsks().length;
    el.textContent = n;
    el.hidden = !n;
  }

  App.register('week', {
    show: function (el) {
      if (!V.el) {
        V.el = el;
        el.addEventListener('click', onClick);
        el.addEventListener('pointerdown', function () { V.holdFired = false; }, true);
      }
      render();
    }
  });
  App.on('board', function () {
    badge();
    if (V.sheetRefresh) V.sheetRefresh();
    if (!V.el || !V.el.firstChild) return;
    if (signature() === V.sig) return;
    if (App.current === 'week') render(); else App.markDirty('week');
  });
  App.on('ready', badge);
  // Every minute: countdowns in place; a new day re-renders (today column, past days).
  App.on('minute', function () {
    badge();
    if (!V.el || !V.el.firstChild) return;
    if (V.dayKey !== today()) { if (App.current === 'week') render(); else App.markDirty('week'); return; }
    App.$$('[data-cd]', V.el).forEach(function (em) { em.textContent = countdown(new Date(+em.getAttribute('data-cd'))); });
  });
})();
