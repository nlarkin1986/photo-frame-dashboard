// Schedule edit mode (Phase 3): press-and-hold "Edit" (kid-proof), then per card remove (×),
// up/down within its section, "Move" to another day/section, and tap to edit in a sheet. "+ Add"
// per section opens the same sheet. Every change goes through App.schedule.patch (with undo where
// it's cheap). Leaves edit mode on Done, after 2 min without a touch, or when the view hides.
(function () {
  'use strict';
  var U = App.schedUI, E = U.edit;
  var IDLE_MS = 120000, HOLD_MS = 1500, MAX_PER_SECTION = 8;
  var idleTimer = null;
  var DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  var LENGTHS = ['5 minutes', '10 minutes', '15 minutes', '20 minutes', '30 minutes', '45 minutes', '1 hour', '2 hours'];
  var TIMES = {
    morning: ['6:30', '7:00', '7:30', '8:00', '8:30'],
    midday: ['11:00', '11:30', '12:00', '12:30'],
    afternoon: ['1:00', '2:00', '3:00', '3:30', '4:00'],
    evening: ['5:00', '5:30', '6:00', '6:30', '7:00'],
    bedtime: ['7:00', '7:30', '8:00', '8:30']
  };

  function S() { return App.schedule || {}; }
  function can() { var d = U.data(); return !!(d && d.can && d.can.edit && d.planned !== false && S().patch); }
  function esc(s) { return App.esc(s == null ? '' : s); }
  function newId() {
    var abc = 'abcdefghijklmnopqrstuvwxyz0123456789', out = '', bytes = new Uint8Array(8);
    if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(bytes);
    else for (var j = 0; j < 8; j++) bytes[j] = Math.floor(Math.random() * 256);
    for (var i = 0; i < 8; i++) out += abc[bytes[i] % 36];
    return out;
  }

  // ------------------------------------------------------------ enter / exit
  function armIdle() { clearTimeout(idleTimer); idleTimer = setTimeout(function () { exit(); }, IDLE_MS); }
  function onAnyTouch() { if (E.active) armIdle(); }
  function enter() {
    if (!can()) return;
    E.active = true;
    E.enteredAt = Date.now();
    S().editing = true;
    armIdle();
    U.render();
  }
  function exit(silent) {
    if (!E.active) return;
    E.active = false;
    S().editing = false;
    clearTimeout(idleTimer);
    App.closeSheet();
    if (!silent) U.render();
  }
  E.exit = exit;

  E.headerButton = function () {
    if (!can()) return '';
    if (E.active) return '<span class="sc-editing-note">Editing · changes sync to the phone</span><button class="btn btn--solid sc-done" data-edit-done>' + App.icon('check', 22) + 'Done</button>';
    return '<button class="sc-editbtn" data-edit-hold aria-label="Press and hold to edit"><span class="sc-editfill"></span>' + App.icon('pencil', 22) + '<span class="sc-edit-t">Hold to edit</span></button>';
  };
  E.afterRender = function (root) {
    var b = root.querySelector('[data-edit-hold]');
    if (b) App.hold(b, HOLD_MS, {
      done: enter,
      cancel: function () { App.toast('Keep holding to edit the schedule', { ms: 2000, icon: 'pencil' }); }
    });
  };

  // ------------------------------------------------------------ card tools + add buttons
  E.cardTools = function (c, sec, i, n) {
    return '<div class="sc-edit-row">' +
      '<button class="sc-tool" data-up' + (i === 0 ? ' disabled' : '') + ' aria-label="Move up">' + App.icon('up', 24) + '</button>' +
      '<button class="sc-tool" data-down' + (i === n - 1 ? ' disabled' : '') + ' aria-label="Move down">' + App.icon('down', 24) + '</button>' +
      '<button class="sc-tool sc-tool--wide" data-move>Move</button>' +
      '</div>' +
      '<button class="sc-x" data-remove aria-label="Remove">' + App.icon('x', 22) + '</button>';
  };
  E.addButton = function (sec) {
    if (sec.cards.length >= MAX_PER_SECTION) return '<div class="sc-full">Full (' + MAX_PER_SECTION + ')</div>';
    return '<button class="sc-add" data-add="' + sec.key + '">' + App.icon('plus', 22) + 'Add</button>';
  };

  // ------------------------------------------------------------ picture helpers
  function pictures() {
    var d = U.data() || {}, icons = d.icons || {};
    if (d.pictures && d.pictures.length) return d.pictures.filter(function (p) { return icons[p.name]; });
    return Object.keys(icons).sort().map(function (n) { return { name: n, label: humanize(n), category: 'Pictures' }; });
  }
  function humanize(n) { var s = String(n).replace(/[-_]+/g, ' '); return s.charAt(0).toUpperCase() + s.slice(1); }
  function iconLabel(name) { var p = pictures().filter(function (x) { return x.name === name; })[0]; return p ? p.label : humanize(name); }
  // kid.library entries: {photo:{id,v}, label, src} (only when can.edit).
  function library() {
    var k = U.kid();
    return ((k && k.library) || []).map(function (p) { return { id: p.photo ? p.photo.id : p.id, label: p.label, src: p.src }; }).filter(function (p) { return p.id; });
  }
  function photoIdFromSrc(src) {
    var hit = library().filter(function (p) { return p.src === src; })[0];
    if (hit) return hit.id;
    var m = /[?&]id=([^&]+)/.exec(src || '');
    return m ? decodeURIComponent(m[1]) : null;
  }
  // The planner's picture for a display card ({kind:'icon',icon} | {kind:'photo',photo}), or null.
  function pictureOf(c) {
    if (c.icon) return { kind: 'icon', icon: c.icon };
    var id = c.photo && c.photo.id ? c.photo.id : (c.src ? photoIdFromSrc(c.src) : null);
    return id ? { kind: 'photo', photo: id } : null;
  }
  function pictureLabel(pic) {
    if (!pic) return '';
    if (pic.kind === 'icon') return iconLabel(pic.icon);
    var p = library().filter(function (x) { return x.id === pic.photo; })[0];
    return p ? p.label || '' : '';
  }
  function pictureTile(pic, size) {
    if (!pic) return '';
    if (pic.kind === 'icon') return U.svg(pic.icon, Math.round(size * 0.62));
    return pic.src ? '<img src="' + esc(pic.src) + '" alt="" width="' + size + '" height="' + size + '">' : '';
  }
  function cardBody(c) {
    return { id: c.id, picture: pictureOf(c), label: c.label || '', time: c.time || '', length: c.length || '', travel: c.travel ? { choice: c.travel.choice || null } : null };
  }

  // ------------------------------------------------------------ ops
  function ctx() { var k = U.kid(); return { kid: k ? k.id : null, day: U.dayIndex() }; }
  function pending(id) {
    var el = document.querySelector('#view-schedule [data-card="' + id + '"]');
    if (el) el.classList.add('is-pending');
  }
  function patch(ops, opts) {
    var r = S().patch(ops, opts || {});
    if (r && r.then) r.then(null, function () {});
    return r;
  }

  function remove(f) {
    var x = ctx(), c = f.card, body = cardBody(c);
    pending(c.id);
    patch([{ op: 'remove', kid: x.kid, card: c.id }], {
      message: 'Removed <b>' + esc(c.label || 'picture') + '</b>',
      undoOps: body.picture ? [{ op: 'add', kid: x.kid, day: x.day, section: f.section.key, index: f.index, card: body }] : null
    });
  }

  function step(f, dir) {
    var x = ctx(), to = f.index + dir;
    if (to < 0 || to >= f.section.cards.length) return;
    pending(f.card.id);
    patch([{ op: 'move', kid: x.kid, card: f.card.id, toDay: x.day, toSection: f.section.key, index: to }], {
      undoOps: [{ op: 'move', kid: x.kid, card: f.card.id, toDay: x.day, toSection: f.section.key, index: f.index }]
    });
  }

  // ------------------------------------------------------------ move sheet
  function moveSheet(f) {
    var k = U.kid(), x = ctx();
    var st = { day: x.day, section: f.section.key };
    function sectionChips() {
      var dy = k.days[st.day];
      return dy.sections.map(function (s) {
        var same = st.day === x.day && s.key === f.section.key;
        var full = !same && s.cards.length >= MAX_PER_SECTION;
        return '<button class="chip se-sec' + (s.key === st.section ? ' is-on' : '') + '" data-msec="' + s.key + '"' + (full ? ' disabled' : '') +
          ' style="--tint:' + (U.SECTIONS[s.key] || U.SECTIONS.morning).tint + '">' + esc(s.name) + (full ? ' · full' : '') + '</button>';
      }).join('');
    }
    App.sheet('<div class="sheet-pad se">' +
      '<div class="label">Move</div><h2 class="serif sheet-h">' + esc(f.card.label || 'Picture') + '</h2>' +
      '<div class="label">Day</div><div class="chips">' + k.days.map(function (dy, i) {
        var d = U.parseIso(dy.date);
        return '<button class="chip' + (i === st.day ? ' is-on' : '') + '" data-mday="' + i + '">' + DOW[i] + ' ' + d.getDate() + '</button>';
      }).join('') + '</div>' +
      '<div class="label">Section</div><div class="chips se-msecs">' + sectionChips() + '</div>' +
      '<div class="sheet-actions"><button class="btn btn--ghost" data-close>Cancel</button><button class="btn btn--solid" data-mgo>Move</button></div>' +
      '</div>', {
      onMount: function (s, close) {
        s.addEventListener('click', function (e) {
          var t = e.target.closest('button');
          if (!t || t.disabled) return;
          if (t.dataset.mday != null) {
            st.day = +t.dataset.mday;
            App.$$('[data-mday]', s).forEach(function (b) { b.classList.toggle('is-on', b === t); });
            var keys = k.days[st.day].sections.map(function (q) { return q.key; });
            if (keys.indexOf(st.section) < 0) st.section = keys[0] || null;
            s.querySelector('.se-msecs').innerHTML = sectionChips();
          }
          if (t.dataset.msec) {
            st.section = t.dataset.msec;
            App.$$('[data-msec]', s).forEach(function (b) { b.classList.toggle('is-on', b === t); });
          }
          if (t.hasAttribute('data-mgo')) {
            close();
            if (!st.section || (st.day === x.day && st.section === f.section.key)) return;
            var target = k.days[st.day].sections.filter(function (q) { return q.key === st.section; })[0];
            pending(f.card.id);
            patch([{ op: 'move', kid: x.kid, card: f.card.id, toDay: st.day, toSection: st.section, index: target ? target.cards.length : 0 }], {
              message: 'Moved <b>' + esc(f.card.label || 'picture') + '</b> to ' + DOW[st.day] + ' · ' + esc(target ? target.name : st.section),
              undoOps: [{ op: 'move', kid: x.kid, card: f.card.id, toDay: x.day, toSection: f.section.key, index: f.index }]
            });
          }
        });
      }
    });
  }

  // ------------------------------------------------------------ edit / add sheet
  function toMins(t) { var m = /^(\d{1,2}):(\d{2})$/.exec(t || ''); return m ? (+m[1] % 12) * 60 + +m[2] : null; }
  function fromMins(n) { n = ((n % 720) + 720) % 720; var h = Math.floor(n / 60), m = n % 60; return (h || 12) + ':' + (m < 10 ? '0' : '') + m; }
  function shortLen(s) { return s.replace(/\bminutes?\b/, 'min').replace(/\bhours?\b/, 'hr'); }

  function editSheet(f, secKey) {
    var k = U.kid(), x = ctx();
    var sec = f ? f.section : U.day().sections.filter(function (s) { return s.key === secKey; })[0];
    if (!sec) return;
    var orig = f ? cardBody(f.card) : null;
    var st = f
      ? { picture: f.card.icon ? { kind: 'icon', icon: f.card.icon } : (f.card.src ? { kind: 'photo', photo: orig.picture ? orig.picture.photo : null, src: f.card.src } : null), label: orig.label, time: orig.time, length: orig.length, travel: orig.travel }
      : { picture: null, label: '', time: '', length: '', travel: null };
    var pics = pictures(), lib = library();
    var cats = [];
    if (lib.length) cats.push('Photos');
    pics.forEach(function (p) { if (cats.indexOf(p.category || 'Pictures') < 0) cats.push(p.category || 'Pictures'); });
    var cat = cats[0];
    if (st.picture && st.picture.kind === 'icon') {
      var hit = pics.filter(function (p) { return p.name === st.picture.icon; })[0];
      if (hit) cat = hit.category || 'Pictures';
    } else if (st.picture && st.picture.kind === 'photo') cat = 'Photos';
    if (!f && cats.length > 1 && cat === 'Photos') cat = cats[1];

    function grid() {
      if (cat === 'Photos') return lib.map(function (p) {
        var on = st.picture && st.picture.kind === 'photo' && st.picture.photo === p.id;
        return '<button class="se-tile' + (on ? ' is-on' : '') + '" data-photo="' + esc(p.id) + '"><span class="se-tile-pic is-photo"><img src="' + esc(p.src) + '" alt="" width="72" height="72" loading="lazy"></span><span>' + esc(p.label || '') + '</span></button>';
      }).join('') || '<div class="sc-none">No photos yet — add them on the phone</div>';
      return pics.filter(function (p) { return (p.category || 'Pictures') === cat; }).map(function (p) {
        var on = st.picture && st.picture.kind === 'icon' && st.picture.icon === p.name;
        return '<button class="se-tile' + (on ? ' is-on' : '') + '" data-icon="' + esc(p.name) + '"><span class="se-tile-pic">' + U.svg(p.name, 44) + '</span><span>' + esc(p.label) + '</span></button>';
      }).join('');
    }
    function presets() {
      var seen = {}, out = [];
      function add(l) { l = (l || '').trim(); if (l && !seen[l.toLowerCase()] && out.length < 10) { seen[l.toLowerCase()] = 1; out.push(l); } }
      add(pictureLabel(st.picture));
      k.days.forEach(function (dy) { dy.sections.forEach(function (s) { s.cards.forEach(function (c) { if (st.picture && st.picture.kind === 'icon' && c.icon === st.picture.icon) add(c.label); }); }); });
      if (orig) add(orig.label);
      return out.map(function (l) { return '<button class="chip chip--ghost' + (l === st.label ? ' is-on' : '') + '" data-label="' + esc(l) + '">' + esc(l) + '</button>'; }).join('');
    }
    function timeChips() {
      var list = (TIMES[sec.key] || TIMES.morning).slice();
      if (st.time && list.indexOf(st.time) < 0) list.push(st.time);
      return '<button class="chip' + (!st.time ? ' is-on' : '') + '" data-time="">No time</button>' + list.map(function (t) {
        return '<button class="chip' + (t === st.time ? ' is-on' : '') + '" data-time="' + esc(t) + '">' + esc(t) + '</button>';
      }).join('');
    }
    function lengthChips() {
      var list = LENGTHS.slice();
      if (st.length && list.indexOf(st.length) < 0) list.push(st.length);
      return '<button class="chip' + (!st.length ? ' is-on' : '') + '" data-len="">None</button>' + list.map(function (l) {
        return '<button class="chip' + (l === st.length ? ' is-on' : '') + '" data-len="' + esc(l) + '">' + esc(shortLen(l)) + '</button>';
      }).join('');
    }
    function travelChips() {
      var cur = !st.travel ? 'none' : (st.travel.choice || 'open');
      return [['none', 'Not a trip'], ['open', 'Trip'], ['bike', 'Bike'], ['walk', 'Walk'], ['car', 'Car']].map(function (o) {
        var ic = { bike: 'bike', walk: 'footprints', car: 'car' }[o[0]];
        return '<button class="chip' + (o[0] === cur ? ' is-on' : '') + '" data-trip="' + o[0] + '">' + (ic ? U.svg(ic, 22) : '') + o[1] + '</button>';
      }).join('');
    }
    function preview() { return st.picture ? pictureTile(st.picture.kind === 'photo' ? { kind: 'photo', src: st.picture.src } : st.picture, 88) : App.icon('photo', 36); }

    App.sheet('<div class="sheet-pad se">' +
      '<div class="label">' + (f ? 'Edit picture' : 'Add to ' + esc(sec.name) + ' · ' + DOW[x.day]) + '</div>' +
      '<div class="se-top"><span class="se-prev' + (st.picture && st.picture.kind === 'photo' ? ' is-photo' : '') + '" style="--tint:' + (U.SECTIONS[sec.key] || U.SECTIONS.morning).tint + '">' + preview() + '</span>' +
      '<input class="big-input serif se-input" maxlength="40" placeholder="What happens?" autocomplete="off" enterkeyhint="done" value="' + esc(st.label) + '"></div>' +
      '<div class="se-labels chips">' + presets() + '</div>' +
      '<div class="label">Picture</div>' +
      '<div class="se-cats">' + cats.map(function (c) { return '<button class="chip' + (c === cat ? ' is-on' : '') + '" data-cat="' + esc(c) + '">' + esc(c) + '</button>'; }).join('') + '</div>' +
      '<div class="se-grid">' + grid() + '</div>' +
      '<div class="label">Time</div>' +
      '<div class="se-timebar"><button class="se-step" data-step="-15">−15</button><b class="num se-time">' + esc(st.time || '—') + '</b><button class="se-step" data-step="15">+15</button></div>' +
      '<div class="chips se-times">' + timeChips() + '</div>' +
      '<div class="label">How long</div><div class="chips se-lens">' + lengthChips() + '</div>' +
      '<div class="label">Trip</div><div class="chips se-trips">' + travelChips() + '</div>' +
      '<div class="sheet-actions se-actions">' +
      (f ? '<button class="btn btn--ghost se-remove" data-sremove>' + App.icon('x', 20) + 'Remove</button>' : '') +
      '<button class="btn btn--ghost" data-close>Cancel</button><button class="btn btn--solid" data-save>' + (f ? 'Save' : 'Add') + '</button></div>' +
      '</div>', {
      cls: 'sheet--wide sheet--se',
      onMount: function (s, close) {
        var input = s.querySelector('.se-input');
        input.addEventListener('input', function () {
          st.label = input.value;
          App.$$('[data-label]', s).forEach(function (b) { b.classList.toggle('is-on', b.dataset.label === st.label.trim()); });
          onAnyTouch();
        });
        // The frame has no Back key, so the sheet has to put the keyboard away itself:
        // on Enter, or on a tap anywhere outside the text box.
        input.addEventListener('keydown', function (e) { if (e.key === 'Enter') input.blur(); });
        s.addEventListener('pointerdown', function (e) { if (e.target !== input) input.blur(); });
        function paintPicture(prevDefault) {
          var p = s.querySelector('.se-prev');
          p.innerHTML = preview();
          p.classList.toggle('is-photo', !!st.picture && st.picture.kind === 'photo');
          // A fresh picture brings its own words unless the words were typed by hand.
          if (!st.label.trim() || st.label.trim() === prevDefault) { st.label = pictureLabel(st.picture); input.value = st.label; }
          s.querySelector('.se-labels').innerHTML = presets();
          s.querySelector('.se-grid').innerHTML = grid();
        }
        function paintTime() {
          s.querySelector('.se-time').textContent = st.time || '—';
          s.querySelector('.se-times').innerHTML = timeChips();
        }
        s.addEventListener('click', function (e) {
          var t = e.target.closest('button');
          if (!t) return;
          var prevDefault = pictureLabel(st.picture);
          if (t.dataset.cat) {
            cat = t.dataset.cat;
            App.$$('[data-cat]', s).forEach(function (b) { b.classList.toggle('is-on', b === t); });
            s.querySelector('.se-grid').innerHTML = grid();
            s.querySelector('.se-grid').scrollTop = 0;
          }
          if (t.dataset.icon) { st.picture = { kind: 'icon', icon: t.dataset.icon }; paintPicture(prevDefault); }
          if (t.dataset.photo) {
            var p = lib.filter(function (q) { return q.id === t.dataset.photo; })[0];
            if (p) { st.picture = { kind: 'photo', photo: p.id, src: p.src }; paintPicture(prevDefault); }
          }
          if (t.dataset.label != null) {
            st.label = t.dataset.label; input.value = st.label;
            App.$$('[data-label]', s).forEach(function (b) { b.classList.toggle('is-on', b === t); });
          }
          if (t.dataset.step) {
            var base = toMins(st.time);
            if (base == null) base = toMins((TIMES[sec.key] || TIMES.morning)[0]) - +t.dataset.step;
            st.time = fromMins(base + +t.dataset.step);
            paintTime();
          }
          if (t.dataset.time != null) { st.time = t.dataset.time; paintTime(); }
          if (t.dataset.len != null) {
            st.length = t.dataset.len;
            App.$$('[data-len]', s).forEach(function (b) { b.classList.toggle('is-on', b === t); });
          }
          if (t.dataset.trip) {
            var v = t.dataset.trip;
            st.travel = v === 'none' ? null : { choice: v === 'open' ? null : v };
            App.$$('[data-trip]', s).forEach(function (b) { b.classList.toggle('is-on', b === t); });
          }
          if (t.hasAttribute('data-sremove')) { close(); remove(f); }
          if (t.hasAttribute('data-save')) save(close);
        });
      }
    });

    function save(close) {
      if (!st.picture) { App.toast('Pick a picture first', { ms: 2500, icon: 'photo' }); return; }
      // A photo card whose id can't be recovered keeps its picture (pic stays null = unchanged).
      var pic = st.picture.kind === 'icon' ? { kind: 'icon', icon: st.picture.icon } : (st.picture.photo ? { kind: 'photo', photo: st.picture.photo } : null);
      var label = (st.label || '').trim().slice(0, 40);
      close();
      if (!f) {
        if (!pic) return;
        var id = newId();
        patch([{ op: 'add', kid: x.kid, day: x.day, section: sec.key, index: sec.cards.length, card: { id: id, picture: pic, label: label, time: st.time, length: st.length, travel: st.travel } }], {
          message: 'Added <b>' + esc(label || 'picture') + '</b> to ' + esc(sec.name),
          undoOps: [{ op: 'remove', kid: x.kid, card: id }]
        });
        return;
      }
      var set = {}, undo = {}, undoable = true, changed = false;
      function diff(key, now, was) {
        if (JSON.stringify(now) === JSON.stringify(was)) return;
        set[key] = now; undo[key] = was; changed = true;
      }
      var wasPic = orig.picture;
      if (pic && JSON.stringify(pic) !== JSON.stringify(wasPic)) {
        set.picture = pic; changed = true;
        if (wasPic) undo.picture = wasPic; else undoable = false;
      }
      diff('label', label, orig.label);
      diff('time', st.time || '', orig.time);
      diff('length', st.length || '', orig.length);
      diff('travel', st.travel, orig.travel);
      if (!changed) return;
      pending(f.card.id);
      patch([{ op: 'update', kid: x.kid, card: f.card.id, set: set }], {
        message: 'Saved <b>' + esc(label || 'picture') + '</b>',
        undoOps: undoable ? [{ op: 'update', kid: x.kid, card: f.card.id, set: undo }] : null
      });
    }
  }

  // ------------------------------------------------------------ clicks inside the schedule view
  E.handle = function (e) {
    var t = e.target;
    if (t.closest('[data-edit-hold]')) return true;
    if (t.closest('[data-edit-done]')) { if (Date.now() - (E.enteredAt || 0) > 700) exit(); return true; }
    if (!E.active) return false;
    var add = t.closest('[data-add]');
    if (add) { editSheet(null, add.dataset.add); return true; }
    var el = t.closest('[data-card]');
    if (!el) return false;
    var f = U.findCard(el.dataset.card);
    if (!f) return true;
    var b = t.closest('button');
    if (b && b.disabled) return true;
    if (t.closest('[data-remove]')) remove(f);
    else if (t.closest('[data-up]')) step(f, -1);
    else if (t.closest('[data-down]')) step(f, 1);
    else if (t.closest('[data-move]')) moveSheet(f);
    else editSheet(f);
    return true;
  };

  document.addEventListener('pointerdown', onAnyTouch, true);
})();
