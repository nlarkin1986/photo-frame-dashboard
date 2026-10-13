// Schedule: each kid's picture schedule for the week (System A's Schedule v2, via js/schedule-data.js).
// Kid tabs on top, a Mon–Sun strip, then one column per section in the phone app's section tints.
// Rebuilt only when the payload's structure changes; ticks and the "Now" marker are patched in place.
(function () {
  'use strict';
  var V = { el: null, kid: null, day: null, week: null, sig: null, scroll: {} };

  // ------------------------------------------------------------ constants
  // Section tints from the phone app (lib/schedule-v2.ts SECTION_INFO). Names/words come from the payload.
  var SECTIONS = {
    morning: { tint: '#FFEFAB', edge: '#E6CF6B' },
    midday: { tint: '#FFB98A', edge: '#E8935A' },
    afternoon: { tint: '#75BBBF', edge: '#4F9DA2' },
    evening: { tint: '#FDCDCD', edge: '#E79C9C' },
    bedtime: { tint: '#ACD6FC', edge: '#78B2E6' }
  };
  var ORDER = ['morning', 'midday', 'afternoon', 'evening', 'bedtime'];
  var NAVY = '#0E385B';
  // Kids carry no colour in the payload; give each tab a stable one by position.
  var KID_COLORS = [
    ['#2D5BFF', '45 91 255', '#FFFFFF'], ['#E4007C', '228 0 124', '#FFFFFF'], ['#00A36C', '0 163 108', '#FFFFFF'],
    ['#FFB000', '255 176 0', '#111111'], ['#7B4DFF', '123 77 255', '#FFFFFF'], ['#00A3C4', '0 163 196', '#FFFFFF']
  ];
  var TRAVEL_ICON = { bike: 'bike', walk: 'footprints', car: 'car' };
  var DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  // ------------------------------------------------------------ small helpers
  function S() { return App.schedule || {}; }
  function data() { return S().data || null; }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function iso(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parseIso(s) { var a = String(s).split('-'); return new Date(+a[0], +a[1] - 1, +a[2]); }
  function todayIso() { return iso(App.now()); }
  function mondayIso(d) { var x = App.dayStart(d); x.setDate(x.getDate() - (x.getDay() + 6) % 7); return iso(x); }
  function thisWeek() { return mondayIso(App.now()); }

  function iconMarkup(name) {
    var icons = (data() && data().icons) || {};
    return icons[name] || window.ICONS[name] || '';
  }
  function svg(name, size, cls) {
    var m = iconMarkup(name) || iconMarkup('star');
    return '<svg class="i ' + (cls || '') + '" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + m + '</svg>';
  }
  function pictureHTML(card, size) {
    if (card.src) return '<img src="' + App.esc(card.src) + '" alt="" width="' + size + '" height="' + size + '" decoding="async">';
    if (card.icon || card.icon === '') return svg(card.icon, Math.round(size * 0.62));
    return '';
  }
  function kidIndex(kid) { var d = data(); return d ? Math.max(0, d.kids.indexOf(kid)) : 0; }
  function kidStyle(kid) {
    var c = KID_COLORS[kidIndex(kid) % KID_COLORS.length];
    return '--c:' + c[0] + ';--c-rgb:' + c[1] + ';--c-ink:' + c[2];
  }
  function kidAvatar(kid, size) {
    var inner = kid.avatar && kid.avatar.src
      ? '<img src="' + App.esc(kid.avatar.src) + '" alt="" width="' + size + '" height="' + size + '" decoding="async">'
      : App.esc((kid.name || '?').charAt(0).toUpperCase());
    return '<span class="sc-ava' + (kid.avatar && kid.avatar.src ? ' has-img' : '') + '" style="' + kidStyle(kid) + ';width:' + size + 'px;height:' + size + 'px;font-size:' + Math.round(size * 0.46) + 'px">' + inner + '</span>';
  }
  function shortLength(s) { return String(s).replace(/\bminutes?\b/i, 'min').replace(/\bhours?\b/i, 'hr'); }

  function findKid(id) { var d = data(); return d ? d.kids.filter(function (k) { return k.id === id; })[0] || null : null; }
  function dayCards(day) { var out = []; (day ? day.sections : []).forEach(function (s) { out = out.concat(s.cards); }); return out; }
  function counts(day) { var all = dayCards(day); return { done: all.filter(function (c) { return c.done; }).length, total: all.length }; }

  // Section the clock is in, by the fixed hours in the design; falls forward to the next section
  // the day actually shows (hidden/off sections are dropped server-side).
  function clockSection() {
    var now = App.now(), k = null;
    try { if (typeof S().currentSection === 'function') k = S().currentSection(now); } catch (e) { k = null; }
    if (typeof k !== 'string' || ORDER.indexOf(k) < 0) {
      var m = now.getHours() * 60 + now.getMinutes();
      k = m < 660 ? 'morning' : m < 780 ? 'midday' : m < 1020 ? 'afternoon' : m < 1170 ? 'evening' : 'bedtime';
    }
    return k;
  }
  function currentSection(day) {
    if (!day || day.date !== todayIso() || !day.sections.length) return null;
    var want = ORDER.indexOf(clockSection());
    for (var i = 0; i < day.sections.length; i++) if (ORDER.indexOf(day.sections[i].key) >= want) return day.sections[i];
    return day.sections[day.sections.length - 1];
  }
  function todayOf(kid) { return kid ? kid.days.filter(function (d) { return d.date === todayIso(); })[0] || null : null; }

  // What a kid is on right now: the first unticked card in the current section ("now"), else the
  // next unticked card later today ("next").
  function nowInfo(kid) {
    var day = todayOf(kid), sec = currentSection(day), c = counts(day);
    var info = { day: day, section: sec, now: null, next: null, done: c.done, total: c.total };
    if (!sec) return info;
    info.now = sec.cards.filter(function (x) { return !x.done; })[0] || null;
    var later = false;
    for (var i = 0; i < day.sections.length && !info.next; i++) {
      if (day.sections[i] === sec) later = true;
      if (later) info.next = day.sections[i].cards.filter(function (x) { return !x.done; })[0] || null;
    }
    return info;
  }

  // ------------------------------------------------------------ selection
  function kid() { var d = data(); if (!d || !d.kids.length) return null; return findKid(V.kid) || d.kids[0]; }
  function day() {
    var k = kid();
    if (!k || !k.days.length) return null;
    return k.days[Math.min(V.day == null ? 0 : V.day, k.days.length - 1)] || null;
  }
  // When a new week arrives: the current week opens on today, another week keeps the weekday.
  function syncSelection() {
    var d = data();
    if (!d) return;
    if (V.week !== d.week) {
      var k = d.kids[0], idx = -1;
      if (k) k.days.forEach(function (x, i) { if (x.date === todayIso()) idx = i; });
      if (idx > -1) V.day = idx;
      else if (V.day == null) V.day = 0;
      V.week = d.week;
      V.scroll = {};
    }
    if (!findKid(V.kid) && d.kids.length) V.kid = d.kids[0].id;
  }

  // Payload signature without ticks, so a tick (or a poll that only changed ticks) never rebuilds.
  function signature() {
    var d = data(), E = App.schedUI.edit;
    var base = JSON.stringify(d, function (k, v) { return k === 'done' || k === 'icons' || k === 'updatedAt' ? undefined : v; });
    return base + '|' + (S().error || '') + '|' + (d ? Object.keys(d.icons || {}).length : 0) + '|' + (E && E.active ? 'e' : '') + '|' + todayIso();
  }

  // ------------------------------------------------------------ render
  function cardHTML(c, sec, i, n) {
    var E = App.schedUI.edit, editing = E && E.active;
    var meta = '';
    if (c.time) meta += '<span class="sc-chip">' + App.icon('clock', 15) + App.esc(c.time) + '</span>';
    if (c.length) meta += '<span class="sc-chip">' + App.icon('timer', 15) + App.esc(shortLength(c.length)) + '</span>';
    if (c.travel) {
      meta += c.travel.choice
        ? '<span class="sc-chip sc-trip">' + svg(TRAVEL_ICON[c.travel.choice] || 'car', 17) + '</span>'
        : '<span class="sc-chip sc-trip is-open">' + svg('bike', 15) + svg('footprints', 15) + svg('car', 15) + '</span>';
    }
    return '<div class="sc-card' + (c.done ? ' is-done' : '') + '" role="button" data-card="' + App.esc(c.id) + '">' +
      '<div class="sc-card-main">' +
      '<span class="sc-pic' + (c.src ? ' is-photo' : '') + '">' + pictureHTML(c, 72) +
      '<span class="sc-tick"><svg viewBox="0 0 24 24" width="34" height="34"><path d="M5 12.5l4.5 4.5L19 7"/></svg></span></span>' +
      '<span class="sc-text"><b>' + App.esc(c.label || '') + '</b>' + (meta ? '<span class="sc-meta">' + meta + '</span>' : '') + '</span>' +
      '</div>' +
      '<span class="sc-now">Now</span>' +
      (editing && E.cardTools ? E.cardTools(c, sec, i, n) : '') +
      '</div>';
  }

  function sectionHTML(sec) {
    var info = SECTIONS[sec.key] || SECTIONS.morning;
    var E = App.schedUI.edit, editing = E && E.active;
    return '<section class="sc-col" data-sec="' + sec.key + '" style="--tint:' + info.tint + ';--edge:' + info.edge + '">' +
      '<header class="sc-col-head"><b>' + App.esc(sec.name) + '</b>' + (sec.words ? '<span>' + App.esc(sec.words) + '</span>' : '') + '</header>' +
      '<div class="sc-list" data-scroll="' + sec.key + '">' +
      sec.cards.map(function (c, i) { return cardHTML(c, sec, i, sec.cards.length); }).join('') +
      (!sec.cards.length && !editing ? '<div class="sc-none serif"><i>Nothing here</i></div>' : '') +
      (editing && E.addButton ? E.addButton(sec) : '') +
      '</div></section>';
  }

  function message(title, sub, icon) {
    return '<div class="sc-msg">' + (icon ? '<span class="sc-msg-i">' + App.icon(icon, 44) + '</span>' : '') +
      '<h2 class="serif">' + title + '</h2>' + (sub ? '<p>' + sub + '</p>' : '') + '</div>';
  }

  function header(d) {
    var E = App.schedUI.edit;
    var err = S().error;
    var kids = d ? d.kids.map(function (k) {
      var on = kid() === k;
      return '<button class="sc-kid' + (on ? ' is-on' : '') + '" data-kid="' + App.esc(k.id) + '" style="' + kidStyle(k) + '">' + kidAvatar(k, 44) + '<span>' + App.esc(k.name) + '</span></button>';
    }).join('') : '';
    return '<header class="sc-head">' +
      '<div class="sc-kids">' + (kids || '<div class="sc-title serif">Schedule</div>') + '</div>' +
      (d ? weekNav(d) : '') +
      '<div class="sc-tools">' +
      (err === 'offline' && d ? '<span class="sc-offline">' + App.icon('wifioff', 18) + 'Offline</span>' : '') +
      (d && E && E.headerButton ? E.headerButton() : '') +
      '</div></header>';
  }

  // "Oct 12 – 18", or "Sep 29 – Oct 5" across a month, between the week arrows.
  function weekNav(d) {
    var first = parseIso(d.week), last = App.addDays(first, 6);
    var range = App.fmt.monthShort(first) + ' ' + first.getDate() + ' – ' +
      (last.getMonth() === first.getMonth() ? '' : App.fmt.monthShort(last) + ' ') + last.getDate();
    return '<div class="sc-weeknav">' +
      '<button class="icon-btn" data-wk="-1" aria-label="Previous week">' + App.icon('left', 26) + '</button>' +
      '<b class="sc-range num">' + range + '</b>' +
      '<button class="icon-btn" data-wk="1" aria-label="Next week">' + App.icon('right', 26) + '</button>' +
      (d.week === thisWeek() ? '' : '<button class="btn btn--ghost sc-thisweek" data-thisweek>This week</button>') +
      '</div>';
  }

  function progress(c) {
    return c.total ? Math.round(100 * c.done / c.total) + '%' : '0';
  }

  function strip(d) {
    var k = kid();
    if (!k) return '';
    var days = k.days.map(function (x, i) {
      var date = parseIso(x.date), c = counts(x);
      var today = x.date === todayIso();
      return '<button class="sc-day' + (i === V.day ? ' is-on' : '') + (today ? ' is-today' : '') + '" data-day="' + i + '">' +
        '<span class="sc-dow">' + (today ? 'Today' : DOW[(date.getDay() + 6) % 7]) + '</span>' +
        '<b class="num">' + date.getDate() + '</b>' +
        '<span class="sc-prog' + (c.total ? '' : ' is-empty') + '"><i style="width:' + progress(c) + '"></i></span></button>';
    }).join('');
    return '<div class="sc-strip">' + days + '</div>';
  }

  function body(d) {
    var err = S().error;
    if (!d) {
      if (err === 'not-linked') return message('Link this frame', 'From the schedule app on your phone: <b>On the frame → Link a frame</b>.', 'schedule');
      if (err === 'unlinked') return message('This frame was unlinked', 'Link it again from the schedule app: <b>On the frame → Link a frame</b>.', 'unlock');
      if (err === 'offline') return message('Can’t reach the schedule', 'It will show up here as soon as the frame is back online.', 'wifioff');
      return message('Loading the schedule…', '', 'schedule');
    }
    if (err === 'unlinked') return message('This frame was unlinked', 'Link it again from the schedule app: <b>On the frame → Link a frame</b>.', 'unlock');
    if (!d.kids.length) return message('No kids on this frame yet', 'Choose kids in the schedule app: <b>On the frame</b>.', 'person');
    if (d.planned === false) return message('This week isn’t planned yet', 'Open the schedule on your phone to plan it.', 'calendar');
    var dy = day();
    if (!dy || !dy.sections.length) return message('Nothing planned this day', '', 'calendar');
    return '<div class="sc-cols" style="grid-template-columns:repeat(' + dy.sections.length + ',minmax(0,1fr))">' + dy.sections.map(sectionHTML).join('') + '</div>';
  }

  function saveScroll() {
    if (!V.el) return;
    App.$$('[data-scroll]', V.el).forEach(function (s) { V.scroll[V.kid + '|' + V.day + '|' + s.dataset.scroll] = s.scrollTop; });
  }

  function render() {
    if (!V.el) return;
    saveScroll();
    syncSelection();
    var d = data(), E = App.schedUI.edit;
    V.el.innerHTML = '<div class="sc' + (E && E.active ? ' is-editing' : '') + '">' + header(d) + (d ? strip(d) : '') + '<div class="sc-body">' + body(d) + '</div></div>';
    App.$$('[data-scroll]', V.el).forEach(function (s) {
      var y = V.scroll[V.kid + '|' + V.day + '|' + s.dataset.scroll];
      if (y) s.scrollTop = y;
    });
    V.sig = signature();
    marks();
    if (E && E.afterRender) E.afterRender(V.el);
  }

  // Ticks, current section and the "Now" badge, patched in place (on ticks and every minute).
  function marks() {
    if (!V.el || !data()) return;
    var dy = day();
    if (!dy) return;
    var byId = {};
    dayCards(dy).forEach(function (c) { byId[c.id] = c; });
    App.$$('.sc-card', V.el).forEach(function (el) {
      var c = byId[el.dataset.card];
      if (c) el.classList.toggle('is-done', !!c.done);
    });
    var sec = currentSection(dy), now = sec ? sec.cards.filter(function (c) { return !c.done; })[0] : null;
    App.$$('.sc-col', V.el).forEach(function (el) { el.classList.toggle('is-current', !!sec && el.dataset.sec === sec.key); });
    App.$$('.sc-card', V.el).forEach(function (el) { el.classList.toggle('is-now', !!now && el.dataset.card === now.id); });
    var k = kid();
    if (k) App.$$('.sc-day', V.el).forEach(function (el) {
      var c = counts(k.days[+el.dataset.day]);
      el.querySelector('.sc-prog i').style.width = progress(c);
    });
  }

  // ------------------------------------------------------------ interaction
  function findCard(id) {
    var dy = day(), out = null;
    if (dy) dy.sections.forEach(function (s, si) { s.cards.forEach(function (c, i) { if (c.id === id) out = { card: c, section: s, index: i, sectionIndex: si }; }); });
    return out;
  }

  function tick(el) {
    var d = data(), k = kid(), f = findCard(el.dataset.card);
    if (!d || !k || !f || !d.can || !d.can.tick || !S().tick) return;
    var on = !f.card.done;
    el.classList.toggle('is-done', on);
    S().tick(k.id, f.card.id, on); // optimistic: flips card.done and emits 'schedule-tick'
    marks();
  }

  function goWeek(week) {
    if (!S().load) return;
    V.el.querySelector('.sc') && V.el.querySelector('.sc').classList.add('is-loading');
    var p = S().load(week);
    // load() never rejects; a 304/offline answer emits nothing, so clear the dimming here.
    function done() { var r = V.el.querySelector('.sc'); if (r) r.classList.remove('is-loading'); }
    if (p && p.then) p.then(done, done); else done();
  }

  function onClick(e) {
    var E = App.schedUI.edit, t;
    if (E && E.handle && E.handle(e)) return;
    if ((t = e.target.closest('[data-kid]'))) { saveScroll(); V.kid = t.dataset.kid; return render(); }
    if ((t = e.target.closest('[data-day]'))) { saveScroll(); V.day = +t.dataset.day; return render(); }
    if ((t = e.target.closest('[data-wk]'))) {
      var d = data();
      if (d && d.week) goWeek(iso(App.addDays(parseIso(d.week), 7 * +t.dataset.wk)));
      return;
    }
    if (e.target.closest('[data-thisweek]')) return goWeek(thisWeek());
    if ((t = e.target.closest('[data-card]'))) tick(t);
  }

  // ------------------------------------------------------------ shared API (home tile, ambient, edit mode)
  App.schedUI = {
    SECTIONS: SECTIONS,
    edit: { active: false },
    data: data,
    kid: kid,
    day: day,
    dayIndex: function () { return V.day || 0; },
    findCard: findCard,
    render: render,
    marks: marks,
    svg: svg,
    pictureHTML: pictureHTML,
    kidStyle: kidStyle,
    kidAvatar: kidAvatar,
    nowInfo: nowInfo,
    todayIso: todayIso,
    thisWeek: thisWeek,
    iso: iso,
    parseIso: parseIso
  };

  App.register('schedule', {
    show: function (el) {
      if (!V.el) { V.el = el; el.addEventListener('click', onClick); }
      render();
    },
    hide: function () {
      var E = App.schedUI.edit;
      if (E && E.active && E.exit) E.exit(true);
      // Leave the frame on the current week, so Home and Ambient read today.
      var d = data();
      if (d && d.week && d.week !== thisWeek() && S().load) S().load(thisWeek());
    }
  });

  // Rebuild only when the payload's structure changed; a tick-only change patches classes.
  App.on('schedule', function () {
    if (!V.el) return;
    var d = data(), E = App.schedUI.edit;
    if (E && E.active && (!d || !d.can || !d.can.edit) && E.exit) E.exit(true);
    var sig = signature();
    if (sig === V.sig) { marks(); return; }
    if (App.current === 'schedule') render();
    else App.markDirty('schedule');
  });
  // A tick (ours, an undo, or a rollback) flipped one card: patch classes only.
  App.on('schedule-tick', function () { if (V.el && V.sig) marks(); });
  App.on('minute', function () {
    if (!V.el || !V.sig) return;
    if (signature() !== V.sig) { // the date rolled over
      if (App.current === 'schedule') render(); else App.markDirty('schedule');
      return;
    }
    marks();
  });
})();
