// Tasks / chores: one lane per person + "Anyone", scoped to the current time-of-day routine.
// Live: the board's chores (App.board; taps post chore.done). Fallback: the mock chores in js/data.js.
(function () {
  'use strict';
  var D = window.DATA, B = App.board;
  var V = { el: null, routine: null, pending: {} };

  function isLive() { return !!B.chores(); }
  function chores() { return B.chores() || D.chores; }
  function lanes() { return D.people.map(function (p) { return p.id; }).concat(['any']); }
  function isKid(id) { var p = App.person(id); return id !== 'any' && (p.role ? p.role === 'kid' : D.stars[id] != null); }
  // Stars: the mock running totals, or (live) the stars earned today.
  function starsFor(id) {
    if (!isLive()) return D.stars[id] || 0;
    return chores().filter(function (c) { return c.done && (c.who === id || (c.who === 'any' && c.doneBy === id)); })
      .reduce(function (n, c) { return n + (c.stars || 0); }, 0);
  }
  function routine() { return V.routine ? D.routines.filter(function (r) { return r.id === V.routine; })[0] : App.currentRoutine(); }
  function listFor(who, r) {
    return chores().filter(function (c) { return c.r === r.id && c.who === who; })
      .sort(function (a, b) { return (a.done - b.done) || ((b.overdue ? 1 : 0) - (a.overdue ? 1 : 0)); });
  }
  function byId(id) { return chores().filter(function (x) { return x.id === id; })[0]; }
  // Emoji (escaped text) or an allow-listed icon name.
  function glyph(c) {
    var g = c.emoji != null ? c.emoji : c.icon;
    if (/^[a-z][a-z0-9-]*$/.test(g || '') && window.ICONS[g]) return App.icon(g, 30);
    return App.esc(g || '•');
  }
  function doneByName(c) {
    if (c.doneByWho && !c.doneByWho.person) return B.whoName(c.doneByWho);
    return c.doneBy ? App.person(c.doneBy).name : '';
  }

  function row(c) {
    var pend = V.pending[c.id], by = doneByName(c);
    return '<button class="ch' + (c.done ? ' is-done' : '') + (pend ? ' is-checking' : '') + (c.overdue && !c.done ? ' is-overdue' : '') + '" data-ch="' + App.esc(c.id) + '">' +
      '<span class="ch-emoji">' + glyph(c) + '<span class="ch-check"><svg viewBox="0 0 24 24" width="30" height="30"><path d="M5 12.5l4.5 4.5L19 7"/></svg></span></span>' +
      '<span class="ch-text"><b>' + App.esc(c.title) + '</b>' +
      (c.overdue && !c.done ? '<small class="ch-late">Overdue</small>' : c.stars ? '<small>' + App.icon('star', 14, 'i--fill') + c.stars + (by ? ' · ' + App.esc(by) : '') + '</small>' : (by ? '<small>by ' + App.esc(by) + '</small>' : '')) +
      (B.isAgent(c.src) && !c.done ? B.srcChip(c.src, 'src-chip--sm') : '') +
      '</span>' +
      '</button>';
  }

  function weekGrid(id) {
    var w = !isLive() && D.week[id];
    if (!w) return '';
    var today = (App.now().getDay() + 6) % 7;
    return '<div class="ch-week"><div class="label">This week</div><div class="ch-week-row">' + ['M', 'T', 'W', 'T', 'F', 'S', 'S'].map(function (d, i) {
      var cls = i > today ? 'is-future' : i === today ? 'is-today' : (w[i] ? 'is-hit' : 'is-miss');
      return '<span class="' + cls + '"><i></i>' + d + '</span>';
    }).join('') + '</div></div>';
  }

  function lane(who, r) {
    var p = App.person(who), list = listFor(who, r);
    var done = list.filter(function (c) { return c.done; }).length;
    var all = list.length && done === list.length;
    var kid = isKid(who);
    return '<section class="ch-lane' + (all ? ' is-complete' : '') + '" data-lane="' + App.esc(who) + '" style="' + App.pstyle(p) + '">' +
      '<header class="ch-head">' + App.avatar(p, 42) +
      '<div><b>' + (who === 'any' ? 'Anyone' : App.esc(p.name)) + '</b>' +
      (kid ? '<span class="ch-stars">' + App.icon('star', 18, 'i--fill') + '<span class="num">' + starsFor(who) + '</span></span>' : '<span class="ch-sub">' + (who === 'any' ? 'Up for grabs' : (list.length ? done + ' of ' + list.length : 'Nothing')) + '</span>') + '</div>' +
      '<div class="ch-ring">' + App.ring(done, list.length || 1, 46) + '<span class="num">' + (all ? '✓' : list.length ? done + '/' + list.length : '–') + '</span></div>' +
      '</header>' +
      '<div class="ch-list">' + (list.length ? list.map(row).join('') : '<div class="ch-none serif"><i>Nothing this ' + (r.id === 'evening' ? 'evening' : r.id === 'morning' ? 'morning' : 'afternoon') + '</i></div>') +
      (all ? '<div class="ch-alldone serif">All done<i>!</i></div>' : '') + '</div>' +
      weekGrid(who) +
      '</section>';
  }

  // Review-mode agent chores waiting for Approve / Dismiss.
  function pendingStrip() {
    var pd = isLive() ? B.pendingFor('chores') : [];
    if (!pd.length) return '';
    return '<div class="pend-strip">' + pd.slice(0, 2).map(function (p) {
      return '<div class="pend-row"><span class="pend-x">' + B.srcChip(B.pendingSource(p) || { agent: 'agent', label: 'Agent' }) + '<b>' + App.esc(B.pendingText(p)) + '</b></span>' +
        '<button class="pend-btn" data-pend-no="' + App.esc(p.id) + '" aria-label="Dismiss">' + App.icon('x', 22) + '</button><button class="pend-btn pend-btn--yes" data-pend-yes="' + App.esc(p.id) + '">Approve</button></div>';
    }).join('') + (pd.length > 2 ? '<span class="label">+' + (pd.length - 2) + ' more</span>' : '') + '</div>';
  }

  function render() {
    var r = routine(), auto = App.currentRoutine();
    var inR = chores().filter(function (c) { return c.r === r.id; });
    var done = inR.filter(function (c) { return c.done; }).length;
    var ls = lanes();
    V.el.innerHTML = '<div class="tasks">' +
      '<header class="t-head">' +
      '<div class="t-title"><div class="label">' + (r.id === auto.id ? 'Right now · ' : '') + r.range + '</div><h1 class="serif">' + r.name + '</h1></div>' +
      '<div class="seg">' + D.routines.map(function (x) { return '<button class="' + (x.id === r.id ? 'is-on' : '') + '" data-r="' + x.id + '">' + x.name + '</button>'; }).join('') + '</div>' +
      '<div class="t-progress"><span class="num">' + done + '<small>/' + inR.length + '</small></span><div class="t-bar"><i style="width:' + (inR.length ? done / inR.length * 100 : 0) + '%"></i></div><span class="label">done</span></div>' +
      '</header>' +
      pendingStrip() +
      '<div class="ch-lanes" style="grid-template-columns:repeat(' + ls.length + ',1fr)">' + ls.map(function (w) { return lane(w, r); }).join('') + '</div>' +
      '</div>';
  }

  function toastDone(c, earner) {
    var r = routine();
    var allDone = chores().filter(function (x) { return x.r === r.id; }).every(function (x) { return x.done; });
    if (allDone) { App.toast('<b>' + r.name + ' routine complete!</b> Everyone crushed it.', { icon: 'star', ms: 5000 }); return true; }
    return false;
  }

  function complete(c, btn, by) {
    V.pending[c.id] = true;
    btn.classList.add('is-checking');
    setTimeout(function () {
      delete V.pending[c.id];
      var earner = isKid(c.who) ? c.who : (by && isKid(by) ? by : null);
      if (c.live) {
        var who = by ? { person: by } : (c.who !== 'any' ? { person: c.who } : null);
        var undo = [{ op: 'chore.done', id: c.id, by: null, done: false }];
        var setDone = function (on) {
          return function () { var it = B.findItem('chores', c.id); if (it) it.doneToday = on ? { by: who, at: new Date().toISOString() } : null; };
        };
        var msg = '<b>' + App.esc(c.title) + '</b> done' + (earner && c.stars ? ' · +' + c.stars + '★ ' + App.esc(App.person(earner).name) : '');
        B.op([{ op: 'chore.done', id: c.id, by: who, done: true }], { apply: setDone(true) });
        if (!toastDone(c)) App.toast(msg, { icon: 'check', undo: function () { B.op(undo, { apply: setDone(false) }); } });
        return;
      }
      c.done = true;
      if (by) c.doneBy = by;
      if (earner && c.stars) D.stars[earner] += c.stars;
      render();
      App.emit('data');
      if (toastDone(c)) return;
      App.toast('<b>' + App.esc(c.title) + '</b> done' + (earner && c.stars ? ' · +' + c.stars + '★ ' + App.esc(App.person(earner).name) : ''), {
        icon: 'check',
        undo: function () {
          c.done = false;
          delete c.doneBy;
          if (earner && c.stars) D.stars[earner] -= c.stars;
          render();
          App.emit('data');
        }
      });
    }, 350);
  }

  // "Anyone" chores ask who did it, so stars go to the right kid
  function whoDidIt(c, btn) {
    App.sheet('<div class="sheet-pad"><div class="label">' + glyph(c) + ' ' + App.esc(c.title) + '</div><h2 class="serif sheet-h">Who did it?</h2>' +
      '<div class="add-who add-who--big">' + D.people.map(function (p) {
        return '<button class="who-btn" data-by="' + App.esc(p.id) + '" style="' + App.pstyle(p) + '">' + App.avatar(p, 88) + '<span>' + App.esc(p.name) + '</span></button>';
      }).join('') + '</div></div>', {
      onMount: function (s, close) {
        s.addEventListener('click', function (e) {
          var b = e.target.closest('[data-by]');
          if (!b) return;
          close();
          var fresh = V.el.querySelector('[data-ch="' + c.id.replace(/["\\]/g, '') + '"]');
          complete(c, fresh || btn, b.getAttribute('data-by'));
        });
      }
    });
  }

  function onClick(e) {
    var t;
    if ((t = e.target.closest('[data-r]'))) { V.routine = t.dataset.r === App.currentRoutine().id ? null : t.dataset.r; return render(); }
    if ((t = e.target.closest('[data-pend-yes]')) || (t = e.target.closest('[data-pend-no]'))) {
      var yes = t.hasAttribute('data-pend-yes'), pid = t.getAttribute(yes ? 'data-pend-yes' : 'data-pend-no');
      B.op([{ op: yes ? 'pending.approve' : 'pending.dismiss', id: pid }], {
        apply: function (d) { d.pending = (d.pending || []).filter(function (p) { return p.id !== pid; }); },
        message: yes ? 'Approved' : 'Dismissed', icon: yes ? 'check' : undefined, ms: 3000
      });
      return;
    }
    if ((t = e.target.closest('[data-ch]'))) {
      var c = byId(t.getAttribute('data-ch'));
      if (!c || V.pending[c.id]) return;
      if (c.done) {
        if (c.live) {
          B.op([{ op: 'chore.done', id: c.id, by: null, done: false }], {
            apply: function () { var it = B.findItem('chores', c.id); if (it) it.doneToday = null; }
          });
          return;
        }
        c.done = false;
        var earner = isKid(c.who) ? c.who : (c.doneBy && isKid(c.doneBy) ? c.doneBy : null);
        if (earner && c.stars) D.stars[earner] -= c.stars;
        delete c.doneBy;
        render();
        App.emit('data');
        return;
      }
      if (c.who === 'any') return whoDidIt(c, t);
      complete(c, t);
    }
  }

  App.register('tasks', {
    show: function (el) {
      if (!V.el) { V.el = el; el.addEventListener('click', onClick); }
      render();
    }
  });
  App.on('time', function () { V.routine = null; });
  // Board changed: repaint when on screen (unless a tick is animating), else rebuild later.
  App.on('board', function () {
    if (!V.el || !V.el.firstChild) return;
    if (App.current !== 'tasks') { App.markDirty('tasks'); return; }
    if (Object.keys(V.pending).length) { setTimeout(function () { if (App.current === 'tasks' && !Object.keys(V.pending).length) render(); }, 450); return; }
    render();
  });
})();
