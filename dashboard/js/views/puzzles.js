// Puzzles: the Final Timer app's reward puzzles (Curosorios/Rewards) on the frame. A picture is cut
// into a 2×2, 3×3 or 4×4 jigsaw; a grown-up awards the next piece by hand (lowest index first, as
// Puzzle.nextPieceToEarn; timers don't earn pieces); a kid drags earned pieces from the tray onto
// the board, where a piece only snaps into its own slot; the last piece completes the puzzle and,
// after the app's 1.2 s beat, the celebration. Pieces are one image cut with background-position
// and clip-path: path(), using the app's JigsawPieceShape curves. Everything lives in
// localStorage 'timer.puzzles' (versioned).
(function () {
  'use strict';
  var D = window.DATA;
  var KEY = 'timer.puzzles', VERSION = 1;

  // ------------------------------------------------------------ constants (from the app)
  // PuzzleDifficulty: easy 2×2, medium 3×3, hard 4×4.
  var SIZES = [
    { n: 2, label: 'Small', sub: '4 pieces' },
    { n: 3, label: 'Medium', sub: '9 pieces' },
    { n: 4, label: 'Big', sub: '16 pieces' }
  ];
  // PuzzleGeometry: tab depth and width as fractions of the piece edge.
  var TAB_DEPTH = 0.18, TAB_WIDTH = 0.22;
  var BOARD = 640;                 // board side on the 1280×800 stage
  var SNAP = 0.3 * BOARD;          // dropSnapThreshold: 110pt on a ~370pt phone board
  var FINISH_DELAY = 1200;         // PuzzleGameViewModel.scheduleCompletionIfNeeded
  var NOT_EARNED = 0, EARNED = 1, PLACED = 2;

  var V = {
    el: null, root: null, mode: 'list', tab: 'current', kid: 'all', id: null,
    drag: null, finishTimer: null, finishPending: false, celebrate: false,
    justPlaced: -1, justEarned: -1, trayCell: 0
  };

  // ------------------------------------------------------------ storage
  function blank() { return { v: VERSION, puzzles: [] }; }
  function validPuzzle(p) {
    return p && typeof p.id === 'string' && typeof p.src === 'string' && [2, 3, 4].indexOf(p.grid) > -1 &&
      Array.isArray(p.pieces) && p.pieces.length === p.grid * p.grid;
  }
  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return blank();
      var d = JSON.parse(raw);
      if (!d || d.v !== VERSION || !Array.isArray(d.puzzles)) return blank();
      d.puzzles = d.puzzles.filter(validPuzzle);
      return d;
    } catch (e) { return blank(); }
  }
  var S = load();

  // Run a mutation and write it through. A mutation returning false is a no-op (its guard
  // failed). If the write throws, the in-memory state rolls back (the app's DurableCommit).
  function commit(fn, quiet) {
    var before = JSON.stringify(S);
    var r = fn();
    if (r === false) return false;
    try {
      localStorage.setItem(KEY, JSON.stringify(S));
      return true;
    } catch (e) {
      S = JSON.parse(before);
      if (!quiet) App.toast("Couldn't save the puzzle. Please try again.", { tone: 'error' });
      return false;
    }
  }

  // ------------------------------------------------------------ model (Puzzle / PuzzlePiece)
  function find(id) { for (var i = 0; i < S.puzzles.length; i++) if (S.puzzles[i].id === id) return S.puzzles[i]; return null; }
  function counts(p) {
    var c = { placed: 0, inTray: 0, total: p.pieces.length };
    p.pieces.forEach(function (s) { if (s === PLACED) c.placed++; else if (s === EARNED) c.inTray++; });
    c.earned = c.placed + c.inTray;
    return c;
  }
  function isCurrent(p) { return !p.completedAt && !p.archived; }
  function isDone(p) { return !!p.completedAt && !p.archived; }
  // Can still take a piece: not archived, not complete, something left to earn.
  function earnable(p) { return !!p && !p.archived && !p.completedAt && p.pieces.indexOf(NOT_EARNED) > -1; }
  // Puzzle.awardNextPiece: the first not-earned piece by index.
  function award(p) {
    if (!earnable(p)) return -1;
    var i = p.pieces.indexOf(NOT_EARNED);
    p.pieces[i] = EARNED;
    return i;
  }
  // Puzzle.placePiece: only an in-tray piece can be placed; the last one completes the puzzle.
  function place(p, i) {
    if (p.pieces[i] !== EARNED) return false;
    p.pieces[i] = PLACED;
    if (p.pieces.every(function (s) { return s === PLACED; }) && !p.completedAt) p.completedAt = Date.now();
    return true;
  }
  // Puzzle.unplacePiece: back to the tray, and the puzzle is no longer complete.
  function unplace(p, i) {
    if (p.pieces[i] !== PLACED) return false;
    p.pieces[i] = EARNED;
    p.completedAt = null;
    return true;
  }
  // ------------------------------------------------------------ pictures
  function kids() { return (D.people || []).filter(function (x) { return x.role === 'kid'; }); }
  function kidOf(id) { return kids().filter(function (k) { return k.id === id; })[0] || null; }
  function characters() {
    var T = window.TimerAssets;
    return T && Array.isArray(T.characters) ? T.characters.filter(function (c) { return c && c.image; }) : [];
  }
  // The frame's photos: synced album photos or the sample set. Samples come square from the
  // image proxy; album photos are measured when a puzzle first opens.
  function photos() {
    return (D.photos || []).slice(0, 24).map(function (ph) {
      if (ph.seed) return { src: App.img(ph.seed, 900, 900), thumb: App.img(ph.seed, 240, 240), aspect: 1, name: ph.place || 'Photo' };
      return { src: App.photoSrc(ph, true), thumb: App.photoSrc(ph, false), aspect: ph.o === 'p' ? 2 / 3 : 1.6, name: ph.place || 'Photo' };
    });
  }
  // Correct a guessed aspect ratio once the picture loads.
  function measure(p) {
    if (p.measured) return;
    var img = new Image();
    img.onload = function () {
      if (!img.naturalWidth || !img.naturalHeight) return;
      var a = img.naturalWidth / img.naturalHeight;
      commit(function () { p.aspect = a; p.measured = true; }, true);
      if (Math.abs(a - 1) > 0.01 && App.current === 'puzzles') render();
    };
    img.src = p.src;
  }

  // ------------------------------------------------------------ geometry
  function r1(n) { return Math.round(n * 10) / 10; }
  // The picture, cropped square (cover), laid over a B×B board and shifted so board point (x, y)
  // sits at the element's top-left.
  function bg(p, B, x, y) {
    var a = p.aspect || 1, bw = a >= 1 ? B * a : B, bh = a >= 1 ? B : B / a;
    return 'background-image:url("' + p.src + '");background-size:' + r1(bw) + 'px ' + r1(bh) + 'px;' +
      'background-position:' + r1((B - bw) / 2 - x) + 'px ' + r1((B - bh) / 2 - y) + 'px';
  }
  // JigsawEdgeConfig.forPiece: flat on the border, tabs on right/bottom, blanks on top/left.
  function edges(i, n) {
    var col = i % n, row = (i / n) | 0;
    return { top: row === 0 ? 0 : 2, right: col === n - 1 ? 0 : 1, bottom: row === n - 1 ? 0 : 1, left: col === 0 ? 0 : 2 };
  }
  // JigsawPieceShape.drawEdge, ported: 0 flat, 1 tab, 2 blank (perpendicular reversed).
  function edge(out, sx, sy, ex, ey, type, len) {
    if (!type) { out.push('L', r1(ex), r1(ey)); return; }
    var dx = ex - sx, dy = ey - sy, L = Math.sqrt(dx * dx + dy * dy), ax = dx / L, ay = dy / L, px = -ay, py = ax;
    if (type === 2) { px = -px; py = -py; }
    var t0 = 0.5 - TAB_WIDTH, t1 = 0.5 + TAB_WIDTH, d = len * TAB_DEPTH;
    var p1x = sx + ax * L * t0, p1y = sy + ay * L * t0;
    var p3x = sx + ax * L * 0.5 + px * d, p3y = sy + ay * L * 0.5 + py * d;
    var p5x = sx + ax * L * t1, p5y = sy + ay * L * t1;
    out.push('L', r1(p1x), r1(p1y),
      'C', r1(p1x + px * d * 0.5), r1(p1y + py * d * 0.5), r1(p3x - ax * L * 0.1), r1(p3y - ay * L * 0.1), r1(p3x), r1(p3y),
      'C', r1(p3x + ax * L * 0.1), r1(p3y + ay * L * 0.1), r1(p5x + px * d * 0.5), r1(p5y + py * d * 0.5), r1(p5x), r1(p5y),
      'L', r1(ex), r1(ey));
  }
  function shape(i, n, x, y, w) {
    var e = edges(i, n), out = ['M', r1(x), r1(y)];
    edge(out, x, y, x + w, y, e.top, w);
    edge(out, x + w, y, x + w, y + w, e.right, w);
    edge(out, x + w, y + w, x, y + w, e.bottom, w);
    edge(out, x, y + w, x, y, e.left, w);
    out.push('Z');
    return out.join(' ');
  }
  // One piece at `cell` px per grid square: a box with room for tabs, the picture clipped to the
  // jigsaw outline, and the outline drawn on top.
  function pieceHTML(p, i, cell, cls) {
    var n = p.grid, m = cell * TAB_DEPTH, size = r1(cell + 2 * m), col = i % n, row = (i / n) | 0;
    var d = shape(i, n, m, m, cell);
    return '<div class="pz-piece ' + (cls || '') + '" data-i="' + i + '" style="width:' + size + 'px;height:' + size + 'px">' +
      '<div class="pz-pimg" style="' + App.esc(bg(p, cell * n, col * cell - m, row * cell - m) + ";clip-path:path('" + d + "');-webkit-clip-path:path('" + d + "')") + '"></div>' +
      '<svg class="pz-pline" width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '"><path d="' + d + '"/></svg></div>';
  }
  function outlineHTML(p, i, cell) {
    var m = cell * TAB_DEPTH, size = r1(cell + 2 * m);
    return '<svg class="pz-hole" width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '"><path d="' + shape(i, p.grid, m, m, cell) + '"/></svg>';
  }

  // ------------------------------------------------------------ list
  function visible() {
    return S.puzzles.filter(function (p) { return V.kid === 'all' || p.kid === V.kid; });
  }
  function thumbHTML(p, size) {
    var cells = p.pieces.map(function (s) { return '<i class="' + (s === PLACED ? 'is-placed' : s === EARNED ? 'is-ready' : '') + '"></i>'; }).join('');
    return '<div class="pz-thumb" style="width:' + size + 'px;height:' + size + 'px;' + App.esc(bg(p, size, 0, 0)) + '">' +
      (p.completedAt ? '' : '<div class="pz-cells" style="grid-template-columns:repeat(' + p.grid + ',1fr)">' + cells + '</div>') + '</div>';
  }
  function kidLine(p) {
    var k = kidOf(p.kid);
    return k ? '<span class="pz-who">' + App.avatar(k, 28) + App.esc(k.name) + '</span>' : '';
  }
  function dateText(t) { var d = new Date(t); return App.fmt.monthShort(d) + ' ' + d.getDate(); }

  function cardHTML(p) {
    var c = counts(p), done = !!p.completedAt;
    var status = done ? 'Completed ' + dateText(p.completedAt)
      : c.inTray ? c.inTray + (c.inTray === 1 ? ' piece' : ' pieces') + ' ready to place'
      : c.earned >= c.total ? 'All pieces ready' : 'No pieces ready yet';
    var actions = done
      ? '<button class="pz-act" data-archive="' + p.id + '">' + App.icon('box', 22) + 'Archive</button>'
      : (c.earned < c.total ? '<button class="pz-act pz-hold" data-add="' + p.id + '"><span class="pz-holdfill"></span>' + App.icon('plus', 22) + '<span>Hold to add a piece</span></button>' : '');
    return '<div class="pz-card' + (done ? ' is-done' : '') + '" role="button" data-open="' + p.id + '">' +
      thumbHTML(p, 168) +
      '<div class="pz-info">' +
      '<b class="pz-name">' + App.esc(p.name) + '</b>' +
      '<span class="pz-meta">' + kidLine(p) + '<span>' + c.placed + ' of ' + c.total + ' placed</span></span>' +
      '<span class="pz-bar"><i style="width:' + Math.round(100 * c.placed / c.total) + '%"></i></span>' +
      '<span class="pz-status' + (c.inTray && !done ? ' is-ready' : '') + '">' + status + '</span>' +
      '<div class="pz-acts">' + actions + '</div>' +
      '</div></div>';
  }

  function emptyHTML(title, sub, cta) {
    var T = window.TimerAssets, art = T && T.tools && T.tools.rewards;
    return '<div class="pz-empty">' + (art ? '<img src="' + App.esc(art) + '" alt="" width="200" height="200">' : '<span class="pz-empty-i">' + App.icon('star', 64) + '</span>') +
      '<h2 class="serif">' + title + '</h2><p>' + sub + '</p>' +
      (cta ? '<button class="btn btn--solid" data-new>' + App.icon('plus', 24) + 'New puzzle</button>' : '') + '</div>';
  }

  function listHTML() {
    var all = visible(), cur = all.filter(isCurrent), done = all.filter(isDone);
    var archived = S.puzzles.filter(function (p) { return p.archived; });
    var shown = V.tab === 'current' ? cur : done;
    var kidChips = kids().length ? '<div class="pz-kids">' +
      '<button class="pz-kid' + (V.kid === 'all' ? ' is-on' : '') + '" data-kid="all">Everyone</button>' +
      kids().map(function (k) {
        return '<button class="pz-kid' + (V.kid === k.id ? ' is-on' : '') + '" data-kid="' + k.id + '" style="' + App.pstyle(k) + '">' + App.avatar(k, 40) + App.esc(k.name) + '</button>';
      }).join('') + '</div>' : '<div class="pz-kids"></div>';
    var hint = App.icon('star', 22) + '<span>Grown-ups: press and hold <b>Hold to add a piece</b> to reward a kid</span>';
    var body;
    if (!S.puzzles.length) body = emptyHTML('Reward puzzles', 'Turn a photo into a puzzle your kids build piece by piece, one earned piece at a time.', true);
    else if (!shown.length) body = V.tab === 'current'
      ? emptyHTML('No puzzles in progress', 'Make another when it would help.', true)
      : emptyHTML('No finished puzzles yet', 'Finished puzzles show up here.', false);
    else body = '<div class="pz-grid">' + shown.map(function (p) { return cardHTML(p); }).join('') + '</div>';
    return '<div class="pz pz--list">' +
      '<header class="pz-head">' +
      '<h1 class="pz-title serif">Puzzles</h1>' + kidChips +
      '<div class="seg"><button class="' + (V.tab === 'current' ? 'is-on' : '') + '" data-tab="current">Current<span class="num">' + cur.length + '</span></button>' +
      '<button class="' + (V.tab === 'done' ? 'is-on' : '') + '" data-tab="done">Done<span class="num">' + done.length + '</span></button></div>' +
      '<button class="btn btn--solid pz-newbtn" data-new>' + App.icon('plus', 24) + 'New puzzle</button>' +
      '</header>' +
      '<div class="pz-hint">' + hint + (archived.length ? '<button class="pz-archbtn" data-archived>' + App.icon('box', 20) + 'Archived (' + archived.length + ')</button>' : '') + '</div>' +
      '<div class="pz-scroll">' + body + '</div>' +
      '</div>';
  }

  // ------------------------------------------------------------ game
  function gameHTML(p) {
    var n = p.grid, cell = BOARD / n, c = counts(p), solved = p.completedAt && !V.finishPending;
    var slots = '';
    for (var i = 0; i < p.pieces.length; i++) {
      var m = cell * TAB_DEPTH, col = i % n, row = (i / n) | 0, placed = p.pieces[i] === PLACED;
      slots += '<div class="pz-slot' + (placed ? ' is-placed' : '') + (V.justPlaced === i ? ' is-just' : '') + '" data-slot="' + i + '" style="left:' + r1(col * cell - m) + 'px;top:' + r1(row * cell - m) + 'px">' +
        (placed ? pieceHTML(p, i, cell, '') : outlineHTML(p, i, cell)) + '</div>';
    }
    // Tray: the app's grid, 2/3/4 columns by difficulty, pieces in index order.
    var trayW = 1156 - BOARD - 24 - 32, gap = n === 4 ? 8 : 12;
    var slotW = Math.floor((trayW - gap * (n - 1)) / n);
    V.trayCell = slotW / (1 + 2 * TAB_DEPTH);
    var tray = [];
    p.pieces.forEach(function (s, idx) { if (s === EARNED) tray.push(idx); });
    var trayBody;
    if (solved) {
      trayBody = '<div class="pz-traymsg"><span class="pz-trophy">' + App.icon('star', 40, 'i--fill') + '</span><h3 class="serif">Finished!</h3><p>Completed ' + dateText(p.completedAt) + '</p>' +
        '<button class="btn btn--solid" data-celebrate>See it again</button></div>';
    } else if (!tray.length) {
      var left = c.total - c.earned;
      trayBody = '<div class="pz-traymsg"><span class="pz-trophy">' + App.icon('star', 40) + '</span><h3 class="serif">No pieces yet</h3>' +
        '<p>A grown-up adds pieces from the puzzle list.' + (left ? ' ' + left + (left === 1 ? ' piece' : ' pieces') + ' to go!' : '') + '</p></div>';
    } else {
      trayBody = '<div class="pz-traygrid" style="grid-template-columns:repeat(' + n + ',' + slotW + 'px);gap:' + gap + 'px">' +
        tray.map(function (idx) {
          return '<div class="pz-trayslot' + (V.justEarned === idx ? ' is-new' : '') + '" style="height:' + slotW + 'px" data-tray="' + idx + '">' + pieceHTML(p, idx, V.trayCell, '') + '</div>';
        }).join('') + '</div>';
    }
    return '<div class="pz pz--game">' +
      '<header class="pz-head">' +
      '<button class="icon-btn" data-back aria-label="Back to puzzles">' + App.icon('left', 30) + '</button>' +
      '<div class="pz-gtitle"><b class="serif">' + App.esc(p.name) + '</b><span class="pz-meta">' + kidLine(p) + '<span>' + c.placed + ' of ' + c.total + ' placed</span></span></div>' +
      '<span class="pz-bar pz-bar--big"><i style="width:' + Math.round(100 * c.placed / c.total) + '%"></i></span>' +
      '</header>' +
      '<div class="pz-play">' +
      '<div class="pz-boardwrap"><div class="pz-board' + (p.completedAt ? ' is-complete' : '') + (V.finishPending ? ' is-unity' : '') + '" style="width:' + BOARD + 'px;height:' + BOARD + 'px">' +
      '<div class="pz-ghost" style="' + App.esc(bg(p, BOARD, 0, 0)) + '"></div>' + slots + '</div></div>' +
      '<aside class="pz-tray">' +
      '<div class="pz-trayhead"><span class="label">Ready pieces</span><b class="num">' + c.inTray + '</b>' +
      (tray.length && !solved ? '<button class="btn btn--solid pz-placebtn" data-placenext>' + App.icon('check', 22) + 'Place a piece</button>' : '') + '</div>' +
      '<div class="pz-traybody">' + trayBody + '</div>' +
      '</aside></div>' +
      (V.celebrate ? celebrateHTML(p) : '') +
      '</div>';
  }

  // PuzzleCelebrationView: the finished picture on a random textured frame, "You Did It!", Done.
  var CONFETTI = ['#FED615', '#FA9A9B', '#75BBBF', '#B1C677', '#578EE5', '#FFB98A'];
  function celebrateHTML(p) {
    var T = window.TimerAssets, frame = '';
    if (T && T.frames && T.frameOrder && T.frameOrder.length) frame = T.frames[T.frameOrder[(Math.random() * T.frameOrder.length) | 0]] || '';
    var bits = '';
    for (var i = 0; i < 36; i++) {
      bits += '<i style="left:' + (Math.random() * 100).toFixed(1) + '%;background:' + CONFETTI[i % CONFETTI.length] +
        ';animation-delay:' + (Math.random() * 0.9).toFixed(2) + 's;animation-duration:' + (2.2 + Math.random() * 1.4).toFixed(2) + 's;--rot:' + ((Math.random() * 720) | 0) + 'deg"></i>';
    }
    return '<div class="pz-cele">' +
      '<div class="pz-confetti">' + bits + '</div>' +
      '<div class="pz-cele-card">' +
      '<div class="pz-frame"' + (frame ? ' style="' + App.esc('background-image:url("' + frame + '")') + '"' : '') + '>' +
      '<div class="pz-final" style="' + App.esc(bg(p, 340, 0, 0)) + '"></div></div>' +
      '<div class="pz-cele-text"><h2 class="pz-cele-h">You did it!</h2><p>You completed “' + App.esc(p.name) + '”</p>' +
      '<button class="btn btn--solid pz-done" data-done>Done</button></div>' +
      '</div></div>';
  }

  // ------------------------------------------------------------ render + events
  function render() {
    if (!V.el) return;
    cancelDrag(true);
    var p = V.mode === 'game' ? find(V.id) : null;
    if (V.mode === 'game' && (!p || p.archived)) { V.mode = 'list'; p = null; }
    V.el.innerHTML = p ? gameHTML(p) : listHTML();
    V.root = V.el.firstChild;
    V.justEarned = -1;
    if (p) {
      wireGame(p);
      measure(p);
    } else {
      App.$$('[data-add]', V.root).forEach(function (b) {
        App.hold(b, 1200, { done: function () { grownUpAward(find(b.dataset.add)); } });
      });
    }
  }

  // Awarding by hand is a grown-up decision (RewardListView.awardPiece): one piece, by index.
  function grownUpAward(p) {
    var idx = -1;
    if (!p || !commit(function () { idx = award(p); if (idx < 0) return false; })) return;
    App.toast('Piece ready in <b>' + App.esc(p.name) + '</b>', { icon: 'star' });
    render();
  }

  function open(id) {
    var p = find(id);
    if (!p) return;
    V.mode = 'game'; V.id = id; V.celebrate = false; V.finishPending = false;
    clearTimeout(V.finishTimer);
    render();
  }
  function back() {
    clearTimeout(V.finishTimer);
    V.mode = 'list'; V.celebrate = false; V.finishPending = false;
    render();
  }

  function onClick(e) {
    if (V.drag) return;
    var t = e.target.closest('button, [data-open]');
    if (!t || !V.root || !V.root.contains(t)) return;
    var d = t.dataset;
    if (d.new != null) return newSheet();
    if (d.tab) { V.tab = d.tab; return render(); }
    if (d.kid) { V.kid = d.kid; return render(); }
    if (d.archived != null) return archivedSheet();
    if (d.archive) {
      var a = find(d.archive);
      if (a && commit(function () { if (!isDone(a)) return false; a.archived = true; a.archivedAt = Date.now(); })) {
        App.toast('Archived <b>' + App.esc(a.name) + '</b>', { icon: 'box', undo: function () { commit(function () { a.archived = false; a.archivedAt = null; }); render(); } });
        render();
      }
      return;
    }
    if (d.add) return;                                   // press-and-hold only
    if (d.back != null || d.done != null) return back();
    if (d.celebrate != null) { V.celebrate = true; return render(); }
    if (d.placenext != null) {
      var p = find(V.id), first = p ? p.pieces.indexOf(EARNED) : -1;
      if (first > -1) placeWithFlight(p, first, V.root.querySelector('[data-tray="' + first + '"]'));
      return;
    }
    if (d.open) return open(d.open);
  }

  // ------------------------------------------------------------ drag + drop (pointer events)
  function k() { var r = V.root.getBoundingClientRect(); return { r: r, k: r.width / (V.root.offsetWidth || 1) || 1 }; }
  function local(x, y) { var s = k(); return { x: (x - s.r.left) / s.k, y: (y - s.r.top) / s.k }; }
  function rectLocal(el) {
    var s = k(), b = el.getBoundingClientRect();
    return { x: (b.left - s.r.left) / s.k, y: (b.top - s.r.top) / s.k, w: b.width / s.k, h: b.height / s.k };
  }
  function centerLocal(el) { var b = rectLocal(el); return { x: b.x + b.w / 2, y: b.y + b.h / 2 }; }
  function setPos(ov, size, x, y, s) {
    ov.style.transform = 'translate(' + r1(x - size / 2) + 'px,' + r1(y - size / 2) + 'px) scale(' + s + ')';
  }
  function slotCenter(p, i) {
    var b = rectLocal(V.root.querySelector('.pz-board')), cell = BOARD / p.grid;
    return { x: b.x + (i % p.grid + 0.5) * cell, y: b.y + (((i / p.grid) | 0) + 0.5) * cell };
  }
  // PuzzleGeometry.findTargetedSlot: the nearest slot centre within the snap distance.
  function targetSlot(p, x, y) {
    var best = null, bestD = SNAP;
    for (var i = 0; i < p.pieces.length; i++) {
      var c = slotCenter(p, i), dd = Math.sqrt((x - c.x) * (x - c.x) + (y - c.y) * (y - c.y));
      if (dd < bestD) { bestD = dd; best = i; }
    }
    return best;
  }
  function markSlot(i, match) {
    App.$$('.pz-slot.is-target', V.root).forEach(function (s) { s.classList.remove('is-target', 'is-match'); });
    if (i == null) return;
    var s = V.root.querySelector('[data-slot="' + i + '"]');
    if (s && !s.classList.contains('is-placed')) { s.classList.add('is-target'); if (match) s.classList.add('is-match'); }
  }

  function makeOverlay(p, i) {
    var cell = BOARD / p.grid, ov = document.createElement('div');
    ov.className = 'pz-drag';
    ov.innerHTML = pieceHTML(p, i, cell, 'is-lifted');
    V.root.appendChild(ov);
    return { ov: ov, size: cell * (1 + 2 * TAB_DEPTH), ratio: V.trayCell / cell };
  }

  function wireGame(p) {
    App.$$('[data-tray]', V.root).forEach(function (el) {
      el.addEventListener('pointerdown', function (e) { startDrag(e, p, el); });
    });
    // Long-press a placed piece to send it back to the tray (the app's "Return to Tray").
    App.$$('.pz-slot.is-placed', V.root).forEach(function (el) {
      App.hold(el, 700, {
        enabled: function () { return !V.drag && !(p.completedAt && !V.finishPending); },
        done: function () { returnToTray(p, +el.dataset.slot); }
      });
    });
  }

  function startDrag(e, p, el) {
    if (V.drag || e.button > 0) return;
    e.preventDefault();
    var i = +el.dataset.tray, c0 = centerLocal(el), pt = local(e.clientX, e.clientY);
    var o = makeOverlay(p, i);
    var d = V.drag = { p: p, i: i, el: el, ov: o.ov, size: o.size, ratio: o.ratio, c0: c0, start: pt, g: { x: pt.x - c0.x, y: pt.y - c0.y }, moved: false, slot: null, id: e.pointerId };
    setPos(o.ov, o.size, c0.x, c0.y, o.ratio);
    el.classList.add('is-lifted');
    try { el.setPointerCapture(e.pointerId); } catch (err) { /* capture is best effort */ }
    function move(ev) {
      if (V.drag !== d || ev.pointerId !== d.id) return;
      var q = local(ev.clientX, ev.clientY);
      if (!d.moved) {
        if (Math.abs(q.x - d.start.x) + Math.abs(q.y - d.start.y) < 10) return;
        d.moved = true;
        d.ov.classList.add('is-up');
        setTimeout(function () { d.ov.classList.remove('is-up'); }, 180);
      }
      var cx = q.x - d.g.x, cy = q.y - d.g.y;
      setPos(d.ov, d.size, cx, cy, 1);
      d.slot = targetSlot(p, cx, cy);
      markSlot(d.slot, d.slot === d.i);
    }
    function up(ev) {
      if (V.drag !== d || ev.pointerId !== d.id) return;
      off();
      if (ev.type === 'pointercancel') return settleBack(d);
      // A tap places the piece too (PieceTrayView's tap gesture, placePieceWithoutDragging).
      var slot = d.moved ? d.slot : d.i;
      markSlot(null);
      if (slot === d.i) drop(d); else settleBack(d);
    }
    function off() {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    }
    d.off = off;
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  // Wrong slot or no slot: no buzz, no shake, the piece just settles back (provisional Q7).
  function settleBack(d) {
    d.ov.classList.add('is-back');
    setPos(d.ov, d.size, d.c0.x, d.c0.y, d.ratio);
    setTimeout(function () {
      if (d.ov.parentNode) d.ov.parentNode.removeChild(d.ov);
      d.el.classList.remove('is-lifted');
      if (V.drag === d) V.drag = null;
    }, 230);
  }

  function drop(d) {
    var p = d.p;
    if (!commit(function () { return place(p, d.i); })) return settleBack(d);
    var c = slotCenter(p, d.i);
    d.ov.classList.add('is-snap');
    setPos(d.ov, d.size, c.x, c.y, 1);
    setTimeout(function () { if (V.drag === d) V.drag = null; placed(p, d.i); }, 280);
  }

  // "Place a piece" button: the same flight from the tray, without dragging.
  function placeWithFlight(p, i, el) {
    if (V.drag || !el) return;
    var o = makeOverlay(p, i), c0 = centerLocal(el);
    var d = V.drag = { p: p, i: i, el: el, ov: o.ov, size: o.size, ratio: o.ratio, c0: c0 };
    setPos(o.ov, o.size, c0.x, c0.y, o.ratio);
    el.classList.add('is-lifted');
    o.ov.offsetWidth;
    drop(d);
  }

  function placed(p, i) {
    V.justPlaced = i;
    if (p.completedAt) {
      // The app waits 1.2 s (with a unity pulse) before the celebration; removing the last
      // piece in that window cancels it.
      V.finishPending = true;
      clearTimeout(V.finishTimer);
      V.finishTimer = setTimeout(function () {
        V.finishPending = false;
        if (!p.completedAt || V.mode !== 'game' || V.id !== p.id) return;
        V.celebrate = true;     // visual only: no completion sound
        render();
      }, FINISH_DELAY);
    }
    render();
    setTimeout(function () { if (V.justPlaced === i) V.justPlaced = -1; }, 700);
  }

  function returnToTray(p, i) {
    if (!commit(function () { return unplace(p, i); })) return;
    clearTimeout(V.finishTimer);
    V.finishPending = false;
    render();
  }

  function cancelDrag(silent) {
    var d = V.drag;
    if (!d) return;
    if (d.off) d.off();
    if (d.ov && d.ov.parentNode) d.ov.parentNode.removeChild(d.ov);
    V.drag = null;
    if (!silent && d.el) d.el.classList.remove('is-lifted');
  }

  // ------------------------------------------------------------ sheets
  function newSheet() {
    var pics = { photos: photos(), characters: characters() };
    var st = { from: pics.photos.length ? 'photos' : 'characters', pick: 0, grid: 3, kid: V.kid !== 'all' ? V.kid : null };
    if (!pics.photos.length && !pics.characters.length) { App.toast('No pictures to make a puzzle from yet'); return; }
    function body() {
      var list = pics[st.from];
      var tabs = pics.photos.length && pics.characters.length
        ? '<div class="pz-srcs"><button class="chip' + (st.from === 'photos' ? ' is-on' : '') + '" data-from="photos">' + App.icon('photo', 22) + 'Photos</button>' +
          '<button class="chip' + (st.from === 'characters' ? ' is-on' : '') + '" data-from="characters">' + App.icon('star', 22) + 'Characters</button></div>' : '';
      return '<div class="sheet-pad pz-new">' +
        '<h2 class="sheet-h">New puzzle</h2>' +
        '<div class="pz-row"><span class="label">Picture</span>' + tabs + '</div>' +
        '<div class="pz-picks">' + list.map(function (x, i) {
          return '<button class="pz-pick' + (i === st.pick ? ' is-on' : '') + '" data-pick="' + i + '" aria-label="' + App.esc(x.name) + '"><img src="' + App.esc(x.thumb || x.image || x.src) + '" alt="" loading="lazy"></button>';
        }).join('') + '</div>' +
        '<div class="pz-row"><span class="label">Size</span></div>' +
        '<div class="pz-sizes">' + SIZES.map(function (z) {
          var cells = ''; for (var i = 0; i < z.n * z.n; i++) cells += '<i></i>';
          return '<button class="pz-size' + (st.grid === z.n ? ' is-on' : '') + '" data-grid="' + z.n + '"><span class="pz-mini" style="grid-template-columns:repeat(' + z.n + ',1fr)">' + cells + '</span><span><b>' + z.label + '</b><small>' + z.sub + '</small></span></button>';
        }).join('') + '</div>' +
        (kids().length ? '<div class="pz-row"><span class="label">For</span></div><div class="chips">' +
          '<button class="chip' + (!st.kid ? ' is-on' : '') + '" data-for="">Anyone</button>' +
          kids().map(function (k) { return '<button class="chip' + (st.kid === k.id ? ' is-on' : '') + '" data-for="' + k.id + '" style="' + App.pstyle(k) + '">' + App.avatar(k, 44) + App.esc(k.name) + '</button>'; }).join('') +
          '</div>' : '') +
        '<div class="sheet-actions"><button class="btn btn--ghost" data-close>Cancel</button><button class="btn btn--solid" data-make>' + App.icon('check', 24) + 'Make puzzle</button></div>' +
        '</div>';
    }
    App.sheet('<div class="pz-sheetbody">' + body() + '</div>', {
      cls: 'sheet--wide',
      onMount: function (sheet, close) {
        var box = sheet.querySelector('.pz-sheetbody');
        box.addEventListener('click', function (e) {
          var b = e.target.closest('button');
          if (!b) return;
          var d = b.dataset;
          if (d.close != null) return close();
          if (d.from) { st.from = d.from; st.pick = 0; }
          else if (d.pick) st.pick = +d.pick;
          else if (d.grid) st.grid = +d.grid;
          else if (d.for != null) st.kid = d.for || null;
          else if (d.make != null) {
            var x = pics[st.from][st.pick];
            if (!x) return;
            var src = x.src || x.image;
            var p = {
              id: 'pz' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
              name: x.name || 'Puzzle', src: src, aspect: x.aspect || 1, measured: st.from === 'characters',
              grid: st.grid, kid: st.kid, createdAt: Date.now(), completedAt: null, archived: false, archivedAt: null,
              pieces: new Array(st.grid * st.grid).fill(NOT_EARNED)
            };
            if (!commit(function () { S.puzzles.push(p); })) return;
            close();
            V.tab = 'current';
            if (V.kid !== 'all' && V.kid !== p.kid) V.kid = 'all';
            App.toast('<b>' + App.esc(p.name) + '</b> is ready. Hold <b>Hold to add a piece</b> to award one.', { icon: 'star' });
            render();
            return;
          } else return;
          var scroll = box.querySelector('.pz-picks').scrollTop;
          box.innerHTML = body();
          box.querySelector('.pz-picks').scrollTop = d.from ? 0 : scroll;
          App.$$('[data-close]', box).forEach(function (c) { c.addEventListener('click', close); });
        });
      }
    });
  }

  // ArchivedRewardsSheet: restore, or delete (press and hold).
  function archivedSheet() {
    function body() {
      var list = S.puzzles.filter(function (p) { return p.archived; }).sort(function (a, b) { return (b.archivedAt || 0) - (a.archivedAt || 0); });
      if (!list.length) return '<div class="sheet-pad"><h2 class="sheet-h">Archived</h2><p class="sheet-p">Nothing archived.</p></div>';
      return '<div class="sheet-pad"><h2 class="sheet-h">Archived</h2><div class="pz-arch">' + list.map(function (p) {
        return '<div class="pz-archrow">' + thumbHTML(p, 88) +
          '<div class="pz-archtext"><b>' + App.esc(p.name) + '</b><span>' + (p.completedAt ? 'Completed ' + dateText(p.completedAt) : '') + '</span></div>' +
          '<button class="btn btn--ghost" data-restore="' + p.id + '">' + App.icon('undo', 22) + 'Restore</button>' +
          '<button class="btn btn--ghost pz-hold pz-del" data-del="' + p.id + '"><span class="pz-holdfill"></span>' + App.icon('x', 22) + '<span>Hold to delete</span></button>' +
          '</div>';
      }).join('') + '</div></div>';
    }
    App.sheet('<div class="pz-sheetbody">' + body() + '</div>', {
      onMount: function (sheet) {
        var box = sheet.querySelector('.pz-sheetbody');
        function wire() {
          App.$$('[data-del]', box).forEach(function (b) {
            App.hold(b, 1200, { done: function () {
              var id = b.dataset.del;
              if (commit(function () { S.puzzles = S.puzzles.filter(function (p) { return p.id !== id; }); })) { box.innerHTML = body(); wire(); render(); }
            } });
          });
        }
        wire();
        box.addEventListener('click', function (e) {
          var b = e.target.closest('[data-restore]');
          if (!b) return;
          var p = find(b.dataset.restore);
          if (p && commit(function () { if (!p.archived) return false; p.archived = false; p.archivedAt = null; })) { box.innerHTML = body(); wire(); render(); }
        });
      }
    });
  }

  // ------------------------------------------------------------ view
  App.register('puzzles', {
    show: function (el) {
      if (V.el !== el) { V.el = el; el.addEventListener('click', onClick); }
      render();
    },
    resume: function () { render(); },
    hide: function () { cancelDrag(); }
  });
})();
