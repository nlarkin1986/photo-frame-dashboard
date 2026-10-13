// Shopping: categorized list (left) + quick-add with usuals (right).
// Live: the board's shopping items (App.board, POST ops). Fallback: the mock list in js/data.js.
// Agent-added items carry a "✦ <agent>" chip; low-confidence agent items (suggested: true) and
// review-mode agent writes (board.pending, section 'shopping') wait in a "Suggested" group.
// Approving a suggested item posts shopping.add with the same text (the server merges it into the
// open item and clears `suggested`); dismissing posts shopping.remove. Pending suggestions use
// pending.approve / pending.dismiss.
(function () {
  'use strict';
  var D = window.DATA, B = App.board;
  var V = { el: null, store: 'all', query: '', drawer: false, pending: {}, sig: '', deferred: false };
  var tmp = 0;

  function isLive() { return !!B.groceries(); }
  function items() { return B.groceries() || D.groceries; }
  function catOf(g) { return g.cat || categorize(g.name); }
  function inStore(g) { return V.store === 'all' || g.store === V.store; }
  function open() { return items().filter(function (g) { return !g.done && !g.suggested && inStore(g); }); }
  function done() { return items().filter(function (g) { return g.done && inStore(g); }); }
  function suggested() { return items().filter(function (g) { return g.suggested && !g.done; }); }
  function pendings() { return isLive() ? B.pendingFor('shopping') : []; }
  function byId(id) { return items().filter(function (x) { return x.id === id; })[0]; }
  function stores() {
    if (!isLive()) return D.stores.map(function (s) { return [s.id, s.name]; });
    var seen = {}, out = [];
    items().forEach(function (g) { if (g.store && !g.done && !seen[g.store]) { seen[g.store] = 1; out.push([g.store, g.store]); } });
    return out;
  }
  function catOrder() { return (isLive() ? D.catOrder.all : D.catOrder[V.store] || D.catOrder.all).concat(['Other']); }

  function categorize(name) {
    var n = String(name).toLowerCase();
    var hit = D.catalog.filter(function (c) { return c[0].toLowerCase() === n; })[0] ||
      D.catalog.filter(function (c) { var a = c[0].toLowerCase(); return a.indexOf(n) > -1 || n.indexOf(a) > -1; })[0] ||
      D.catalog.filter(function (c) { return n.split(/\s+/).some(function (w) { return w.length > 3 && c[0].toLowerCase().indexOf(w) > -1; }); })[0];
    return hit ? hit[1] : 'Other';
  }
  function find(name, isDone) {
    return items().filter(function (g) { return !!g.done === isDone && !g.suggested && g.name.toLowerCase() === String(name).toLowerCase(); })[0];
  }
  function attr(s) { return App.esc(s); }

  function row(g) {
    var live = !!g.live;
    var sub = B.srcChip(g.src) + (g.note ? App.esc(g.note) : '');
    return '<div class="s-row' + (V.pending[g.id] ? ' is-checking' : '') + '" data-id="' + attr(g.id) + '">' +
      '<button class="s-hit" data-check="' + attr(g.id) + '">' +
      '<span class="s-box">' + App.icon('check', 22) + '</span>' +
      '<span class="s-name"><b>' + App.esc(g.name) + '</b>' + (sub ? '<small>' + sub + '</small>' : '') + '</span>' +
      (V.store === 'all' && g.store && (live || g.store === 'costco') ? '<span class="s-store">' + App.esc(live ? g.store : 'Costco') + '</span>' : '') +
      '</button>' +
      (live
        ? (g.qty > 1 ? '<div class="s-qty s-qty--ro"><span class="num">×' + g.qty + '</span></div>' : '')
        : '<div class="s-qty"><button data-qty="-1" data-id="' + attr(g.id) + '" aria-label="Less">' + App.icon('minus', 22) + '</button><span class="num">' + g.qty + '</span><button data-qty="1" data-id="' + attr(g.id) + '" aria-label="More">' + App.icon('plus', 22) + '</button></div>') +
      '</div>';
  }

  // "Suggested (n)": agent suggestions waiting for a tap.
  function suggestedHTML() {
    var sg = suggested(), pd = pendings();
    var n = sg.length + pd.length;
    if (!n) return '';
    return '<div class="s-cat s-sugg"><div class="s-cat-h"><span class="label">Suggested <span class="num">(' + n + ')</span></span>' +
      (sg.length > 1 ? '<button class="s-sugg-all" data-addall>' + App.icon('plus', 18) + 'Add all</button>' : '') + '</div>' +
      sg.map(function (g) {
        return '<div class="s-row s-row--sugg" data-id="' + attr(g.id) + '">' +
          '<span class="s-name"><b>' + App.esc(g.name) + (g.qty > 1 ? ' <span class="s-x">×' + g.qty + '</span>' : '') + '</b><small>' + B.srcChip(g.src) + (g.note ? App.esc(g.note) : '') + '</small></span>' +
          '<button class="s-sugg-no" data-sugg-no="' + attr(g.id) + '" aria-label="Dismiss">' + App.icon('x', 24) + '</button>' +
          '<button class="s-sugg-yes" data-sugg-yes="' + attr(g.id) + '">' + App.icon('plus', 22) + 'Add</button>' +
          '</div>';
      }).join('') +
      pd.map(function (p) {
        return '<div class="s-row s-row--sugg" data-pid="' + attr(p.id) + '">' +
          '<span class="s-name"><b>' + App.esc(B.pendingText(p)) + '</b><small>' + B.srcChip(B.pendingSource(p) || { agent: 'agent', label: 'Agent' }) + 'Waiting for approval</small></span>' +
          '<button class="s-sugg-no" data-pend-no="' + attr(p.id) + '" aria-label="Dismiss">' + App.icon('x', 24) + '</button>' +
          '<button class="s-sugg-yes" data-pend-yes="' + attr(p.id) + '">' + App.icon('check', 22) + 'Approve</button>' +
          '</div>';
      }).join('') + '</div>';
  }

  function listHTML() {
    var list = open();
    var groups = catOrder().map(function (cat) { return { cat: cat, items: list.filter(function (g) { return catOf(g) === cat; }) }; }).filter(function (x) { return x.items.length; });
    var d = done(), sug = suggestedHTML();
    return sug + (list.length ? groups.map(function (gr) {
      return '<div class="s-cat" data-cat="' + attr(gr.cat) + '"><div class="s-cat-h"><span class="label">' + App.esc(gr.cat) + '</span><span class="label" data-cat-count>' + gr.items.length + '</span></div>' + gr.items.map(row).join('') + '</div>';
    }).join('') : (sug ? '' : '<div class="s-empty serif">All stocked up.<br><i>Nothing left to buy.</i></div>')) +
      (d.length ? '<div class="s-drawer' + (V.drawer ? ' is-open' : '') + '">' +
        '<button class="s-drawer-h" data-drawer><span>' + App.icon('check', 22) + ' Got it <b class="num">(' + d.length + ')</b></span><span class="label">' + (V.drawer ? 'Hide' : 'Show') + '</span></button>' +
        (V.drawer ? '<div class="s-drawer-list">' + d.map(function (g) {
          return '<button class="s-got" data-revive="' + attr(g.id) + '">' + App.esc(g.name) + '<span class="label">Add back</span></button>';
        }).join('') + '<button class="btn btn--ghost s-clear" data-clear>Clear ' + d.length + ' checked items</button></div>' : '') +
        '</div>' : '');
  }

  function suggestHTML() {
    var q = V.query.trim().toLowerCase();
    if (q) {
      var matches = D.catalog.filter(function (c) { return c[0].toLowerCase().indexOf(q) === 0; })
        .concat(D.catalog.filter(function (c) { var i = c[0].toLowerCase().indexOf(q); return i > 0; })).slice(0, 5);
      var exact = matches.some(function (m) { return m[0].toLowerCase() === q; });
      return '<div class="label">Suggestions</div><div class="s-ac">' + matches.map(function (m) {
        var on = find(m[0], false);
        return '<button class="s-ac-row" data-add="' + attr(m[0]) + '"><b>' + App.esc(m[0]) + '</b><span class="label">' + (on ? 'On list · ×' + on.qty : App.esc(m[1])) + '</span>' + App.icon('plus', 26) + '</button>';
      }).join('') + (exact ? '' : '<button class="s-ac-row s-ac-row--new" data-add="' + attr(V.query.trim()) + '"><b>Add “' + App.esc(V.query.trim()) + '”</b><span class="label">' + App.esc(categorize(V.query)) + '</span>' + App.icon('plus', 26) + '</button>') + '</div>';
    }
    return '<div class="label">Usuals · tap to add</div><div class="s-usuals">' + D.usuals.map(usualTile).join('') + '</div>';
  }
  function usualTile(name) {
    var on = find(name, false);
    return '<button class="s-tile' + (on ? ' is-on' : '') + '" data-add="' + attr(name) + '">' +
      '<b>' + App.esc(name) + '</b><span>' + (on ? App.icon('check', 16) + 'On list' + (on.qty > 1 ? ' ×' + on.qty : '') : App.esc(categorize(name))) + '</span></button>';
  }

  // ---- granular updates (full list + usuals rebuild costs ~500ms on the wall tablet)
  function swap(old, html) {
    var t = document.createElement('div');
    t.innerHTML = html;
    old.parentNode.replaceChild(t.firstChild, old);
  }
  function refreshSuggestFor(g) {
    if (V.query.trim()) return paintSuggest();
    var tiles = V.el.querySelectorAll('.s-usuals [data-add]');
    for (var i = 0; i < tiles.length; i++) if (tiles[i].getAttribute('data-add').toLowerCase() === g.name.toLowerCase()) swap(tiles[i], usualTile(tiles[i].getAttribute('data-add')));
  }
  function rowEl(id) {
    var rows = V.el.querySelectorAll('.s-list [data-id]');
    for (var i = 0; i < rows.length; i++) if (rows[i].getAttribute('data-id') === id) return rows[i];
    return null;
  }
  function catEl(cat) {
    var cats = V.el.querySelectorAll('.s-cat[data-cat]');
    for (var i = 0; i < cats.length; i++) if (cats[i].getAttribute('data-cat') === cat) return cats[i];
    return null;
  }
  function catCount(cat) {
    var c = catEl(cat);
    if (!c) return;
    var n = c.querySelectorAll('.s-row').length;
    if (!n) c.parentNode.removeChild(c);
    else c.querySelector('[data-cat-count]').textContent = n;
  }
  function insertRow(g) {
    var cat = catEl(catOf(g));
    if (!inStore(g)) return paintHead();
    if (!cat) return paintList();
    var t = document.createElement('div');
    t.innerHTML = row(g);
    cat.appendChild(t.firstChild);
    catCount(catOf(g));
    paintHead();
  }
  function removeRow(g) {
    var r = rowEl(g.id);
    var drawer = V.el.querySelector('.s-drawer');
    if (!r || !drawer || V.drawer || !open().length) return paintList();
    r.parentNode.removeChild(r);
    catCount(catOf(g));
    drawer.querySelector('.num').textContent = '(' + done().length + ')';
    paintHead();
  }
  function flash(g) {
    var r = rowEl(g.id);
    if (!r) return;
    r.classList.add('is-flash');
    if (r.scrollIntoView) r.scrollIntoView({ block: 'nearest' });
    setTimeout(function () { r.classList.remove('is-flash'); }, 1200);
  }

  // What the list shows; a board change that doesn't alter it skips the (slow) repaint.
  function signature() {
    return JSON.stringify(items().map(function (g) { return [g.id, g.name, g.qty, g.done, g.suggested, g.store, g.cat, g.note, g.src && g.src.label]; })) +
      JSON.stringify(pendings().map(function (p) { return p.id; })) + V.store + V.drawer + (isLive() ? 'L' : 'M');
  }
  function paintList() {
    var l = V.el.querySelector('.s-list'); var st = l.scrollTop;
    l.innerHTML = listHTML(); l.scrollTop = st; paintHead();
    V.sig = signature();
  }
  function paintSuggest() { V.el.querySelector('.s-suggest').innerHTML = suggestHTML(); }
  function paintHead() {
    var all = items().filter(function (g) { return !g.done && !g.suggested; });
    var st = stores();
    if (V.store !== 'all' && !st.some(function (s) { return s[0] === V.store; })) V.store = 'all';
    V.el.querySelector('.s-count').innerHTML = '<span class="num">' + open().length + '</span> to get';
    V.el.querySelector('.s-stores').innerHTML = st.length ? [['all', 'All']].concat(st).map(function (s) {
      var n = s[0] === 'all' ? all.length : all.filter(function (g) { return g.store === s[0]; }).length;
      return '<button class="' + (V.store === s[0] ? 'is-on' : '') + '" data-store="' + attr(s[0]) + '">' + App.esc(s[1]) + ' <span class="num">' + n + '</span></button>';
    }).join('') : '';
  }
  function render() {
    V.el.innerHTML = '<div class="shop">' +
      '<header class="s-head"><div><div class="label">Shared list</div><h1 class="serif">Groceries</h1></div><div class="s-count"></div><div class="seg s-stores"></div></header>' +
      '<div class="s-list"></div>' +
      '<aside class="s-side">' +
      '  <div class="s-add">' +
      '    <label class="s-input-wrap">' + App.icon('plus', 30) + '<input class="s-input" placeholder="Add an item…" autocomplete="off" enterkeyhint="done" maxlength="60"></label>' +
      '  </div>' +
      '  <div class="s-suggest"></div>' +
      '</aside></div>';
    var input = V.el.querySelector('.s-input');
    input.value = V.query;
    input.addEventListener('input', function () { V.query = input.value; paintSuggest(); });
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter' && input.value.trim()) { add(input.value); } });
    paintList(); paintSuggest();
  }
  function clearQuery(g) {
    var hadQuery = !!V.query.trim();
    V.query = '';
    var input = V.el.querySelector('.s-input');
    if (input) input.value = '';
    if (hadQuery) paintSuggest(); else if (g) refreshSuggestFor(g);
  }

  // ------------------------------------------------------------ live (board) writes
  function liveItem(id) { return B.findItem('shopping', id); }
  function chunks(ops) { var out = []; for (var i = 0; i < ops.length; i += 20) out.push(ops.slice(i, i + 20)); return out; }

  function addLive(name) {
    var g = find(name, false);
    if (g) {
      var q = Math.min(99, g.qty + 1);
      B.op([{ op: 'shopping.add', text: g.name, qty: q }], {
        apply: function () { var it = liveItem(g.id); if (it) it.qty = q; },
        message: 'Already on the list · now <b>×' + q + '</b> ' + App.esc(g.name), icon: 'cart', ms: 3000
      });
      clearQuery(g);
      return;
    }
    if ((g = find(name, true))) {
      B.op([{ op: 'shopping.toggle', id: g.id, done: false }], {
        apply: function () { var it = liveItem(g.id); if (it) { it.done = false; it.doneBy = null; } },
        message: 'Added back <b>' + App.esc(g.name) + '</b>', icon: 'cart', ms: 3000
      });
      clearQuery(g);
      return;
    }
    var cat = D.catalog.filter(function (c) { return c[0].toLowerCase() === name.toLowerCase(); })[0];
    var text = (cat ? cat[0] : name.charAt(0).toUpperCase() + name.slice(1)).slice(0, 60);
    var op = { op: 'shopping.add', text: text };
    if (V.store !== 'all') op.store = V.store;
    var temp = 'tmp_' + (++tmp), now = new Date().toISOString();
    B.op([op], {
      apply: function (d) {
        d.shopping.items.push({ id: temp, text: text, qty: 1, store: op.store || null, category: categorize(text), note: '', suggested: false, done: false, doneBy: null, doneAt: null, addedBy: { agent: 'frame', label: 'Frame' }, addedAt: now, updatedAt: now });
      },
      message: 'Added <b>' + App.esc(text) + '</b> to ' + App.esc(categorize(text)), icon: 'cart', ms: 3000
    });
    clearQuery({ name: text });
  }

  function setDoneLive(id, on) {
    return function () {
      var it = liveItem(id);
      if (it) { it.done = on; it.doneBy = null; it.doneAt = on ? new Date().toISOString() : null; }
    };
  }

  // ------------------------------------------------------------ actions
  function add(name) {
    name = String(name).trim();
    if (!name) return;
    if (isLive()) return addLive(name);
    var g = find(name, false), msg;
    if (g) {
      g.qty++;
      msg = 'Already on the list · now <b>×' + g.qty + '</b> ' + App.esc(g.name);
      var r = rowEl(g.id), q = r && r.querySelector('.s-qty .num');
      if (q) q.textContent = g.qty;
    } else if ((g = find(name, true))) {
      g.done = false; g.qty = 1;
      msg = 'Added back <b>' + App.esc(g.name) + '</b>';
      paintList();
    } else {
      var cat = D.catalog.filter(function (c) { return c[0].toLowerCase() === name.toLowerCase(); })[0];
      g = { id: D._gid(), name: cat ? cat[0] : name.charAt(0).toUpperCase() + name.slice(1), cat: categorize(name), qty: 1, store: V.store === 'all' ? 'grocer' : V.store, done: false, note: '' };
      D.groceries.push(g);
      msg = 'Added <b>' + App.esc(g.name) + '</b> to ' + App.esc(g.cat);
      insertRow(g);
    }
    clearQuery(g);
    flash(g);
    App.emit('data');
    App.toast(msg, { icon: 'cart', ms: 3000 });
  }

  function check(g) {
    V.pending[g.id] = true;
    var r = rowEl(g.id);
    if (r) r.classList.add('is-checking');
    setTimeout(function () {
      if (!V.pending[g.id]) return;
      delete V.pending[g.id];
      if (g.live) {
        B.op([{ op: 'shopping.toggle', id: g.id, done: true }], { apply: setDoneLive(g.id, true) });
        return;
      }
      g.done = true;
      removeRow(g);
      refreshSuggestFor(g);
      App.emit('data');
    }, 1200);
    App.toast('<b>' + App.esc(g.name) + '</b> checked off', {
      icon: 'check',
      undo: function () {
        var wasPending = !!V.pending[g.id];
        delete V.pending[g.id];
        if (g.live) {
          if (wasPending) { var rr = rowEl(g.id); if (rr) rr.classList.remove('is-checking'); }
          else B.op([{ op: 'shopping.toggle', id: g.id, done: false }], { apply: setDoneLive(g.id, false) });
          return;
        }
        var wasDone = g.done;
        g.done = false;
        if (wasDone) paintList();
        else { var r2 = rowEl(g.id); if (r2) r2.classList.remove('is-checking'); }
        refreshSuggestFor(g);
        App.emit('data');
      }
    });
  }

  function approve(list) {
    if (!list.length) return;
    var ids = list.map(function (g) { return g.id; });
    var ops = list.map(function (g) {
      var o = { op: 'shopping.add', text: g.name, qty: g.qty };
      if (g.store) o.store = g.store;
      return o;
    });
    var apply = function () { ids.forEach(function (id) { var it = liveItem(id); if (it) it.suggested = false; }); };
    chunks(ops).forEach(function (part, i) {
      B.op(part, i === 0 ? {
        apply: apply,
        message: list.length > 1 ? 'Added <b>' + list.length + ' suggestions</b>' : 'Added <b>' + App.esc(list[0].name) + '</b>',
        icon: 'cart', ms: 3000
      } : {});
    });
  }

  function onClick(e) {
    var t;
    if ((t = e.target.closest('[data-check]'))) {
      var g = byId(t.getAttribute('data-check'));
      if (g && !V.pending[g.id]) check(g);
      else if (g) { delete V.pending[g.id]; t.parentNode.classList.remove('is-checking'); }
      return;
    }
    if ((t = e.target.closest('[data-qty]'))) {
      var q = byId(t.getAttribute('data-id'));
      if (!q || q.live) return;
      q.qty = Math.max(1, q.qty + +t.dataset.qty);
      t.parentNode.querySelector('.num').textContent = q.qty;
      refreshSuggestFor(q);
      return;
    }
    if ((t = e.target.closest('[data-sugg-yes]'))) { var sy = byId(t.getAttribute('data-sugg-yes')); if (sy) approve([sy]); return; }
    if (e.target.closest('[data-addall]')) { approve(suggested()); return; }
    if ((t = e.target.closest('[data-sugg-no]'))) {
      var sn = byId(t.getAttribute('data-sugg-no'));
      if (sn) B.op([{ op: 'shopping.remove', id: sn.id }], {
        apply: function (d) { d.shopping.items = d.shopping.items.filter(function (x) { return x.id !== sn.id; }); },
        message: 'Dismissed <b>' + App.esc(sn.name) + '</b>', ms: 3000
      });
      return;
    }
    if ((t = e.target.closest('[data-pend-yes]')) || (t = e.target.closest('[data-pend-no]'))) {
      var yes = t.hasAttribute('data-pend-yes');
      var pid = t.getAttribute(yes ? 'data-pend-yes' : 'data-pend-no');
      B.op([{ op: yes ? 'pending.approve' : 'pending.dismiss', id: pid }], {
        apply: function (d) { d.pending = (d.pending || []).filter(function (p) { return p.id !== pid; }); },
        message: yes ? 'Approved' : 'Dismissed', icon: yes ? 'check' : undefined, ms: 3000
      });
      return;
    }
    if ((t = e.target.closest('[data-add]'))) return add(t.getAttribute('data-add'));
    if ((t = e.target.closest('[data-store]'))) { V.store = t.getAttribute('data-store'); return paintList(); }
    if ((t = e.target.closest('[data-drawer]'))) { V.drawer = !V.drawer; return paintList(); }
    if ((t = e.target.closest('[data-revive]'))) {
      var r = byId(t.getAttribute('data-revive'));
      if (!r) return;
      if (r.live) {
        B.op([{ op: 'shopping.toggle', id: r.id, done: false }], { apply: setDoneLive(r.id, false), message: 'Added back <b>' + App.esc(r.name) + '</b>', icon: 'cart', ms: 2500 });
        return;
      }
      r.done = false; paintList(); paintSuggest(); App.emit('data');
      return App.toast('Added back <b>' + App.esc(r.name) + '</b>', { icon: 'cart', ms: 2500 });
    }
    if ((t = e.target.closest('[data-clear]'))) {
      var gone = done();
      V.drawer = false;
      if (isLive()) {
        var ids = gone.map(function (x) { return x.id; });
        chunks(ids.map(function (id) { return { op: 'shopping.remove', id: id }; })).forEach(function (part, i) {
          B.op(part, i === 0 ? {
            apply: function (d) { d.shopping.items = d.shopping.items.filter(function (x) { return ids.indexOf(x.id) < 0; }); },
            message: 'Cleared ' + gone.length + ' items', icon: 'check'
          } : {});
        });
        return;
      }
      D.groceries = D.groceries.filter(function (x) { return gone.indexOf(x) < 0; });
      paintList();
      App.toast('Cleared ' + gone.length + ' items', {
        icon: 'check', undo: function () { D.groceries = D.groceries.concat(gone); paintList(); }
      });
    }
  }

  // Board changed: repaint the list (in place) when it is on screen and nothing is mid-check.
  function onBoard() {
    if (!V.el || !V.el.firstChild) return;
    if (App.current !== 'shopping') { App.markDirty('shopping'); return; }
    if (Object.keys(V.pending).length) { V.deferred = true; return; }
    if (signature() === V.sig) return;
    paintList();
    if (!V.query.trim()) paintSuggest();
  }
  App.on('board', onBoard);
  setInterval(function () { if (V.deferred && !Object.keys(V.pending).length) { V.deferred = false; onBoard(); } }, 1000);

  App.register('shopping', {
    show: function (el) {
      if (!V.el) { V.el = el; el.addEventListener('click', onClick); }
      render();
    }
  });
})();
