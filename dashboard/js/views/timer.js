// Timer: the Final Timer app's character reveal timer (CircularRevealTimer), set for the wall.
// Left: the friend behind a coloured wedge that shrinks clockwise from 12 o'clock as time passes.
// Right: the duration grid (DurationPickerStepView) when idle, transport controls while running.
// Time comes from an end timestamp, never from counting ticks, so the timer keeps running while
// another tab is showing and survives a reload ('timer.state'). The finish is a full-stage
// takeover (ImmersiveCelebrationView) and emits 'timer:done' (nothing listens; timers don't earn puzzle pieces).
(function () {
  'use strict';
  var $ = App.$;
  var STATE_KEY = 'timer.state', PREFS_KEY = 'timer.prefs';

  // ------------------------------------------------------------ constants (from the app)
  // DurationScrollDial.stops, and ClockSliceIndicator's hand-tuned slice angles for each.
  var STOPS = [30, 60, 120, 180, 300, 420, 600, 900, 1200];
  var SLICE = { 30: 35, 60: 65, 120: 105, 180: 140, 300: 185, 420: 225, 600: 275, 900: 315, 1200: 345 };
  var ADD = [[15, '+15s'], [30, '+30s'], [60, '+1m']];
  var MIN_SECONDS = 15, MAX_SECONDS = 3600;
  // Overlay wedge colour: discrete brand stops keyed off elapsed progress (CircularRevealTimer).
  var WEDGE = [[0.35, '#578EE5'], [0.65, '#B1C677'], [0.85, '#FED615'], [2, '#FA9A9B']];
  // ImmersiveCelebrationView.characterSpecificMessage
  var CHEERS = {
    bee: 'Bee-utiful Job!', butterfly: 'Flutter-tastic!', cat: 'Purr-fect Timing!', dog: 'Paw-some Work!',
    dolphin: 'Fin-tastic Work!', eagle: 'Soaring Success!', elephant: 'Elephant-astic!', giraffe: 'Neck-cellent!',
    kangaroo: "Hoppin' Great!", ladybug: 'Spot-On Timing!', lion: 'Roar-some Job!', monkey: 'Monkey Business Done!',
    octopus: 'Octo-tastic!', panda: 'Panda-monium Over!', parrot: 'Polly-tively Perfect!', penguin: 'Cool Success!',
    rabbit: 'Hoppy Timing!', shark: 'Jaw-some Job!', tiger: 'Grrr-eat Work!', unicorn: 'Magical Finish!',
    whale: 'Whale Done!', ambulance: 'Rescue Complete!', balance_bike: 'Balanced Perfectly!',
    bulldozer: 'Job Well Done!', fire_truck: 'Emergency Success!', helicopter: 'Mission Complete!',
    hot_air_balloon: 'Sky-High Success!', pirate_ship: 'Treasure Found!', police_car: 'Case Closed!',
    race_car: 'Checkered Flag!', sailboat: 'Smooth Sailing!', school_bus: 'All Aboard Success!',
    scooter: 'Scooted to Success!', train_engine: 'Full Steam Ahead!'
  };
  // CelebrationConfettiProfile: Party fires three cannons, Gentle one small burst, Quiet nothing.
  var CONFETTI = { party: [120, 80, 80], gentle: [48, 0, 0], quiet: [0, 0, 0] };
  var CONFETTI_COLORS = ['#FA9A9B', '#B1C677', '#FED615', '#578EE5', '#E6ECFF', '#75BBBF', '#FFB98A'];

  // Dial geometry, in viewBox units (the app's 20pt image padding at 380pt, scaled to 560).
  var D = 560, C = D / 2, R_IMG = 252, R_RING = 258, R_OUTER = 267;
  var RING_LEN = 2 * Math.PI * R_RING;

  // ------------------------------------------------------------ state
  // phase: idle | running | paused. A finished run goes straight back to idle behind the takeover.
  var S = { phase: 'idle', duration: 300, end: 0, remaining: 0, character: null, locked: false };
  var P = { seconds: 300, character: null, showCountdown: false, finishStyle: 'party', music: '' };
  var V = { el: null, raf: 0, timeout: 0, lastText: '', lastColor: '', noteTimer: 0, unlockedAt: 0, last: null };

  function TA() { return window.TimerAssets || {}; }
  function load(key) { try { return JSON.parse(window.localStorage.getItem(key) || 'null'); } catch (e) { return null; } }
  function store(key, val) {
    try { if (val == null) window.localStorage.removeItem(key); else window.localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* private mode */ }
  }
  function savePrefs() { store(PREFS_KEY, P); }
  function saveState() {
    if (S.phase === 'idle') { store(STATE_KEY, null); return; }
    store(STATE_KEY, { phase: S.phase, end: S.end, remaining: S.remaining, duration: S.duration, character: S.character, locked: S.locked });
  }

  // ------------------------------------------------------------ characters (defensive: TimerAssets may be empty)
  function chars() { var c = TA().characters; return c && c.length ? c : []; }
  function charById(id) {
    var list = chars();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    try { if (TA().character) return TA().character(id) || null; } catch (e) { /* fall through */ }
    return list[0] || null;
  }
  function currentCharId() { return S.phase === 'idle' ? P.character : S.character; }
  function currentChar() { return charById(currentCharId() || TA().defaultCharacter); }
  function cheer(id) { return CHEERS[id] || 'Great job!'; }

  // ------------------------------------------------------------ time
  function remainingMs() {
    if (S.phase === 'running') return Math.max(0, S.end - Date.now());
    if (S.phase === 'paused') return S.remaining;
    return P.seconds * 1000;
  }
  function progress() {
    if (S.phase === 'idle') return 0;
    return Math.min(1, Math.max(0, 1 - remainingMs() / (S.duration * 1000)));
  }
  // TimerDisplay.clock: round UP, so 00:00 only shows once the timer has really ended.
  function wholeSeconds(ms) { return ms > 1 ? Math.ceil((ms - 1) / 1000) : 0; }
  function clock(ms) {
    var s = wholeSeconds(ms), m = Math.floor(s / 60), r = s % 60;
    return (m < 10 ? '0' : '') + m + ':' + (r < 10 ? '0' : '') + r;
  }
  function compact(ms) { var s = wholeSeconds(ms); return Math.floor(s / 60) + ':' + ('0' + s % 60).slice(-2); }
  // DurationPickerStepView.friendlyLabel / contextPhrase
  function friendly(sec) {
    if (sec < 60) return sec + ' sec';
    var m = Math.floor(sec / 60), s = sec % 60;
    return s ? m + ':' + ('0' + s).slice(-2) : m + ' min';
  }
  function phrase(sec) {
    return sec <= 60 ? 'super quick' : sec <= 180 ? 'a short while' : sec <= 420 ? 'a little bit' : sec <= 600 ? 'a good stretch' : 'a long time';
  }
  function zoneColor(sec) {
    return sec <= 120 ? '#75BBBF' : sec <= 300 ? '#B1C677' : sec <= 420 ? '#FED615' : sec <= 600 ? '#FFB98A' : '#FA9A9B';
  }
  function wedgeColor(p) { for (var i = 0; i < WEDGE.length; i++) if (p < WEDGE[i][0]) return WEDGE[i][1]; return WEDGE[0][1]; }

  // ------------------------------------------------------------ geometry
  // A point at `deg` clockwise from 12 o'clock.
  function pt(cx, cy, r, deg) {
    var a = deg * Math.PI / 180;
    return (cx + r * Math.sin(a)).toFixed(2) + ' ' + (cy - r * Math.cos(a)).toFixed(2);
  }
  // The covering wedge: from the elapsed angle clockwise round to 12 o'clock, so the friend is
  // uncovered clockwise like a clock hand sweeping (OverlayWedgeShape).
  function wedgePath(p, cx, cy, r) {
    if (p >= 1) return '';
    if (p <= 0) return 'M' + (cx - r) + ' ' + cy + 'A' + r + ' ' + r + ' 0 1 1 ' + (cx + r) + ' ' + cy + 'A' + r + ' ' + r + ' 0 1 1 ' + (cx - r) + ' ' + cy + 'Z';
    return 'M' + cx + ' ' + cy + 'L' + pt(cx, cy, r, p * 360) + 'A' + r + ' ' + r + ' 0 ' + (p < 0.5 ? 1 : 0) + ' 1 ' + cx + ' ' + (cy - r) + 'Z';
  }
  // ClockSliceIndicator: a cream disc, a zone-coloured slice from 12 o'clock, navy outlines.
  function sliceSVG(sec, size) {
    var deg = SLICE[sec] || Math.pow(sec / 1200, 0.4) * 345, c = 23, r = 21;
    var d = 'M' + c + ' ' + c + 'L' + c + ' ' + (c - r) + 'A' + r + ' ' + r + ' 0 ' + (deg > 180 ? 1 : 0) + ' 1 ' + pt(c, c, r, deg) + 'Z';
    return '<svg class="tm-slice" width="' + size + '" height="' + size + '" viewBox="0 0 46 46" aria-hidden="true">' +
      '<circle cx="23" cy="23" r="21" fill="#FCF8ED" stroke="#0E385B" stroke-width="1.5"/>' +
      '<path d="' + d + '" fill="' + zoneColor(sec) + '" stroke="#0E385B" stroke-width="1.5" stroke-linejoin="round"/>' +
      '<path d="M23 2v5" stroke="#0E385B" stroke-width="2" stroke-linecap="round"/></svg>';
  }

  // ------------------------------------------------------------ markup
  function friendImg(ch, cls, size) {
    if (!ch || !ch.thumb) return '<span class="' + cls + ' tm-disc" style="width:' + size + 'px;height:' + size + 'px"></span>';
    return '<img class="' + cls + '" src="' + App.esc(ch.thumb) + '" alt="" width="' + size + '" height="' + size + '" decoding="async">';
  }
  function dialHTML() {
    var ch = currentChar(), img = ch && ch.image;
    return '<div class="tm-dial">' +
      '<svg viewBox="0 0 ' + D + ' ' + D + '" width="' + D + '" height="' + D + '" aria-hidden="true">' +
      '<defs><clipPath id="tmClip"><circle cx="' + C + '" cy="' + C + '" r="' + R_IMG + '"/></clipPath></defs>' +
      '<circle class="tm-outer" cx="' + C + '" cy="' + C + '" r="' + R_OUTER + '"/>' +
      '<circle class="tm-disc-fill" cx="' + C + '" cy="' + C + '" r="' + R_IMG + '"/>' +
      (img ? '<image class="tm-img" href="' + App.esc(img) + '" x="' + (C - R_IMG) + '" y="' + (C - R_IMG) + '" width="' + 2 * R_IMG + '" height="' + 2 * R_IMG + '" preserveAspectRatio="xMidYMid slice" clip-path="url(#tmClip)"/>' : '') +
      '<path class="tm-wedge" d="" clip-path="url(#tmClip)"/>' +
      '<circle class="tm-ring" cx="' + C + '" cy="' + C + '" r="' + R_RING + '" transform="rotate(-90 ' + C + ' ' + C + ')" stroke-dasharray="' + RING_LEN.toFixed(2) + '" stroke-dashoffset="' + RING_LEN.toFixed(2) + '"/>' +
      '</svg></div>';
  }
  function friendChip() {
    var ch = currentChar();
    return '<button class="tm-friend" data-friend>' + friendImg(ch, 'tm-friend-img', 52) +
      '<span><small>Friend</small><b>' + App.esc(ch ? ch.name : 'Timer') + '</b></span>' + App.icon('pencil', 22) + '</button>';
  }
  function setupHTML() {
    var custom = STOPS.indexOf(P.seconds) < 0;
    return '<div class="tm-head"><h2 class="tm-title">How long?</h2>' +
      '<button class="tm-optbtn" data-options>' + App.icon('sliders', 26) + '<span>Options</span></button></div>' +
      '<div class="tm-grid">' + STOPS.map(function (s) {
        var on = !custom && P.seconds === s;
        return '<button class="tm-card' + (on ? ' is-on' : '') + '" data-preset="' + s + '" aria-pressed="' + on + '">' +
          sliceSVG(s, 64) + '<b>' + friendly(s) + '</b><small>' + phrase(s) + '</small>' +
          (on ? '<i class="tm-check">' + App.icon('check', 18) + '</i>' : '') + '</button>';
      }).join('') + '</div>' +
      '<div class="tm-sumrow"><span class="tm-sum">' + App.icon(custom ? 'pencil' : 'timer', 22) + '<b>' + friendly(P.seconds) + '</b>' +
      (custom ? '' : '<span>' + phrase(P.seconds) + '</span>') + '</span>' +
      '<button class="tm-pillbtn" data-custom>' + App.icon('sliders', 22) + (custom ? 'Adjust' : 'Custom') + '</button></div>' +
      '<button class="tm-start" data-start>' + App.icon('play', 30) + '<span>Start Timer</span></button>';
  }
  function runHTML() {
    var running = S.phase === 'running', lockCls = S.locked ? ' is-locked' : '';
    return '<div class="tm-head"><span class="tm-status"><i class="tm-dot' + (running ? '' : ' is-paused') + '"></i>' + (running ? 'Counting down' : 'Paused') + '</span>' +
      '<button class="tm-optbtn' + lockCls + '" data-options>' + App.icon('sliders', 26) + '<span>Options</span></button></div>' +
      '<div class="tm-readout">' +
      (P.showCountdown ? '<div class="tm-digits" data-digits>' + clock(remainingMs()) + '</div>' : '') +
      '<div class="tm-ends" data-ends>' + endsText() + '</div></div>' +
      '<div class="tm-transport' + lockCls + '">' +
      '<button class="tm-round" data-restart aria-label="Restart timer">' + App.icon('undo', 34) + '</button>' +
      '<button class="tm-hero' + (running ? '' : ' is-go') + '" data-toggle aria-label="' + (running ? 'Pause timer' : 'Resume timer') + '">' + App.icon(running ? 'pause' : 'play', 52) + '</button>' +
      '<button class="tm-round tm-lock' + (S.locked ? ' is-on' : '') + '" data-lock aria-label="' + (S.locked ? 'Unlock controls (press and hold)' : 'Lock controls') + '">' + App.icon(S.locked ? 'lock' : 'unlock', 32) + '</button>' +
      '</div>' +
      '<div class="tm-adds' + lockCls + '">' + ADD.map(function (a) { return '<button class="tm-add" data-add="' + a[0] + '">' + a[1] + '</button>'; }).join('') + '</div>' +
      '<button class="tm-stop' + lockCls + '" data-stop>' + App.icon('x', 24) + 'Stop timer</button>';
  }
  function endsText() {
    if (S.phase === 'paused') return friendly(Math.max(1, wholeSeconds(S.remaining))) + ' left';
    return 'Ends at ' + App.fmt.time(new Date(App.now().getTime() + remainingMs()));
  }

  function render() {
    if (!V.el) return;
    var idle = S.phase === 'idle';
    V.el.innerHTML = '<div class="tm tm--' + S.phase + '">' +
      '<div class="tm-stage">' + dialHTML() + friendChip() + '</div>' +
      '<div class="tm-panel">' + (idle ? setupHTML() : runHTML()) + '</div>' +
      '<div class="tm-note" data-note>' + App.icon('lock', 20) + 'Timer is running</div></div>';
    V.wedge = $('.tm-wedge', V.el);
    V.ring = $('.tm-ring', V.el);
    V.digits = $('[data-digits]', V.el);
    V.ends = $('[data-ends]', V.el);
    var img = $('.tm-img', V.el);
    if (img) img.addEventListener('error', function () { img.remove(); });
    var lock = $('[data-lock]', V.el);
    if (lock) App.hold(lock, 1200, { enabled: function () { return S.locked; }, done: function () { V.unlockedAt = Date.now(); setLocked(false); } });
    V.lastText = ''; V.lastColor = '';
    draw();
  }

  // One frame: patch the wedge, the ring and the digits in place.
  function draw() {
    if (!V.wedge) return;
    var p = progress(), active = S.phase !== 'idle';
    V.wedge.setAttribute('d', active ? wedgePath(p, C, C, R_IMG + 2) : '');
    var col = wedgeColor(p);
    if (col !== V.lastColor) { V.wedge.setAttribute('fill', col); V.lastColor = col; }
    V.ring.setAttribute('stroke-dashoffset', (RING_LEN * (1 - p)).toFixed(2));
    V.ring.style.opacity = active && p > 0.002 ? 1 : 0;
    if (V.digits) {
      var t = clock(remainingMs());
      if (t !== V.lastText) { V.digits.textContent = t; V.lastText = t; }
    }
  }

  // ------------------------------------------------------------ animation loop (only while visible + running)
  function visible() { return App.current === 'timer' && V.el && V.el.classList.contains('is-active'); }
  function frame() {
    V.raf = 0;
    if (S.phase === 'running' && Date.now() >= S.end) { complete(false); return; }
    draw();
    if (S.phase === 'running' && visible()) V.raf = requestAnimationFrame(frame);
  }
  function loop() { if (!V.raf && S.phase === 'running' && visible()) V.raf = requestAnimationFrame(frame); }
  function stopLoop() { if (V.raf) cancelAnimationFrame(V.raf); V.raf = 0; }

  // Finish exactly on time even when the view is hidden (the 'second' tick is the backstop).
  function arm() {
    clearTimeout(V.timeout);
    if (S.phase === 'running') V.timeout = setTimeout(function () { if (S.phase === 'running' && Date.now() >= S.end - 5) complete(false); else arm(); }, Math.max(0, S.end - Date.now()));
  }

  // ------------------------------------------------------------ controls
  function music(on) {
    try {
      if (on && P.music) TA().playMusic(P.music);
      else if (TA().stopMusic) TA().stopMusic();
    } catch (e) { /* audio is optional */ }
  }
  function changed() { saveState(); render(); loop(); arm(); railUpdate(); }

  function start(sec, charId) {
    sec = Math.max(1, Math.min(MAX_SECONDS, Math.round(sec || P.seconds)));
    var ch = charById(charId || P.character || TA().defaultCharacter);
    S.phase = 'running'; S.duration = sec; S.end = Date.now() + sec * 1000; S.remaining = 0;
    S.character = ch ? ch.id : null; S.locked = false;
    music(true);
    changed();
  }
  function pause() {
    if (S.phase !== 'running') return;
    if (Date.now() >= S.end) { complete(false); return; }
    S.remaining = S.end - Date.now(); S.phase = 'paused';
    stopLoop(); music(false); changed();
  }
  function resume() {
    if (S.phase !== 'paused') return;
    S.end = Date.now() + S.remaining; S.phase = 'running';
    music(true); changed();
  }
  function stop() {
    S.phase = 'idle'; S.locked = false;
    stopLoop(); clearTimeout(V.timeout); music(false); changed();
  }
  // TimerViewModel.addTime: elapsed time is fixed, so the total grows and the end moves out.
  function addTime(sec) {
    if (S.phase === 'running') S.end += sec * 1000;
    else if (S.phase === 'paused') S.remaining += sec * 1000;
    else return;
    S.duration += sec;
    saveState(); arm(); draw(); railUpdate();
    if (V.ends) V.ends.textContent = endsText();
    App.toast('Added ' + (sec < 60 ? sec + ' seconds' : '1 minute'), { icon: 'plus', ms: 1800 });
  }
  function setLocked(on) { S.locked = on; saveState(); render(); loop(); }

  // A locked control was touched: say so (rate limited), never how to unlock (a child reads it too).
  function refuse() {
    var n = $('[data-note]', V.el);
    if (!n) return;
    n.classList.add('is-in');
    clearTimeout(V.noteTimer);
    V.noteTimer = setTimeout(function () { n.classList.remove('is-in'); }, 1500);
  }

  // ------------------------------------------------------------ completion
  function complete(late) {
    if (S.phase !== 'running') return;
    var run = { seconds: S.duration, character: S.character || currentCharId() };
    S.phase = 'idle'; S.locked = false;
    stopLoop(); clearTimeout(V.timeout);
    saveState(); railUpdate();
    try { if (TA().stopMusic) TA().stopMusic(500); } catch (e) { /* ignore */ }
    V.last = run;
    App.emit('timer:done', { seconds: Math.round(run.seconds), character: run.character, at: Date.now() });
    if (late) {
      // Ended long ago while the frame was off or reloading: no party, just say so.
      render();
      App.toast(App.esc(cheer(run.character)) + ' Your ' + friendly(Math.round(run.seconds)) + ' timer finished.', { icon: 'timer' });
      return;
    }
    // Let the friend show fully uncovered for a beat before the celebration (the app waits 180 ms).
    if (visible() && V.wedge) { V.wedge.setAttribute('d', ''); V.ring.setAttribute('stroke-dashoffset', '0'); }
    setTimeout(function () { render(); celebrate(run); }, visible() ? 180 : 0);
  }

  // ------------------------------------------------------------ celebration takeover
  var celebrateTimer = 0;
  function celebrate(run) {
    var el = $('#takeover'), ch = charById(run.character);
    App.closeSheet();
    el.className = 'takeover takeover--timer';
    el.innerHTML = '<div class="tm-cel">' +
      '<canvas class="tm-confetti" width="1280" height="800"></canvas>' +
      '<div class="tm-cel-body">' +
      '  <div class="tm-cel-glow"></div>' +
      '  <button class="tm-cel-char" data-burst aria-label="More confetti">' +
      (ch && ch.image ? '<img src="' + App.esc(ch.image) + '" alt="">' : '<span class="tm-disc"></span>') + '</button>' +
      '  <h1 class="tm-cel-msg">' + App.esc(cheer(run.character)) + '</h1>' +
      '  <p class="tm-cel-sub">' + friendly(Math.round(run.seconds)) + ' timer · done at ' + App.fmt.time(App.now()) + '</p>' +
      '  <div class="tm-cel-actions">' +
      (CONFETTI[P.finishStyle][0] ? '<button class="tm-cel-spark" data-burst aria-label="Replay confetti">' + App.icon('star', 30) + '</button>' : '') +
      '    <button class="tm-cel-btn tm-cel-btn--hi" data-again>' + App.icon('undo', 28) + 'Again · ' + friendly(Math.round(run.seconds)) + '</button>' +
      '    <button class="tm-cel-btn" data-new>' + App.icon('timer', 28) + 'New timer</button>' +
      '    <button class="tm-cel-btn tm-cel-btn--ink" data-done>' + App.icon('check', 28) + 'Done</button>' +
      '  </div>' +
      '</div></div>';
    el.classList.add('is-open');
    if (App.mode !== 'day') App.setMode('day');
    var canvas = $('.tm-confetti', el), lastBurst = 0;
    burst(canvas);
    App.$$('[data-burst]', el).forEach(function (b) {
      b.addEventListener('click', function () {
        if (Date.now() - lastBurst < 300) return;   // the app's tap rate limit
        lastBurst = Date.now();
        b.classList.remove('is-pressed'); b.offsetWidth; b.classList.add('is-pressed');
        burst(canvas);
      });
    });
    function close() { clearTimeout(celebrateTimer); if (App.closeTakeover) App.closeTakeover(); else { el.classList.remove('is-open'); el.innerHTML = ''; } }
    $('[data-again]', el).onclick = function () { close(); start(run.seconds, run.character); App.go('timer'); };
    $('[data-new]', el).onclick = function () { close(); App.go('timer'); };
    $('[data-done]', el).onclick = close;
    clearTimeout(celebrateTimer);
    celebrateTimer = setTimeout(function () { if (el.contains(canvas)) close(); }, 5 * 60 * 1000);
  }

  // Confetti cannons on a canvas: centre fountain plus left/right corners (ConfettiCannons).
  var parts = [], confettiRaf = 0;
  function burst(canvas) {
    var counts = CONFETTI[P.finishStyle] || CONFETTI.party;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    function add(n, x, y, ang, spread, speed) {
      for (var i = 0; i < n; i++) {
        var a = (ang + (Math.random() - 0.5) * spread) * Math.PI / 180, v = speed * (0.55 + Math.random() * 0.6);
        parts.push({ x: x, y: y, vx: Math.sin(a) * v, vy: -Math.cos(a) * v, r: Math.random() * 6.28, vr: (Math.random() - 0.5) * 0.4,
          w: 10 + Math.random() * 10, h: 6 + Math.random() * 6, c: CONFETTI_COLORS[(Math.random() * CONFETTI_COLORS.length) | 0], round: Math.random() < 0.3, t: 0 });
      }
    }
    add(counts[0], 640, 360, 0, 110, 19);
    add(counts[1], 0, 800, 38, 30, 27);
    add(counts[2], 1280, 800, -38, 30, 27);
    if (!confettiRaf) confettiRaf = requestAnimationFrame(function step() {
      confettiRaf = 0;
      if (!canvas.isConnected) { parts = []; return; }
      var g = canvas.getContext('2d');
      g.clearRect(0, 0, 1280, 800);
      parts = parts.filter(function (p) { return p.y < 840 && p.t < 420; });
      parts.forEach(function (p) {
        p.t++; p.vy += 0.42; p.vx *= 0.985; p.vy *= 0.985; p.x += p.vx; p.y += p.vy; p.r += p.vr;
        g.save(); g.translate(p.x, p.y); g.rotate(p.r); g.fillStyle = p.c;
        if (p.round) { g.beginPath(); g.arc(0, 0, p.h * 0.7, 0, 6.283); g.fill(); }
        else g.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.t / 6 + p.r)) + 1);
        g.restore();
      });
      if (parts.length) confettiRaf = requestAnimationFrame(step);
    });
  }

  // ------------------------------------------------------------ sheets
  function optionsSheet() {
    var ch = currentChar(), tracks = (TA().sounds && TA().sounds.music) || [];
    function seg(key, opts) {
      return '<div class="tm-seg" data-seg="' + key + '">' + opts.map(function (o) {
        return '<button data-val="' + App.esc(o[0]) + '" class="' + (String(P[key]) === String(o[0]) ? 'is-on' : '') + '">' + App.esc(o[1]) + '</button>';
      }).join('') + '</div>';
    }
    App.sheet('<div class="sheet-pad tm-opts">' +
      '<h2 class="sheet-h">Timer options</h2>' +
      '<div class="tm-row"><div><b>Friend</b><span>Who hides behind the timer.</span></div>' +
      '<button class="tm-friend tm-friend--sm" data-pick>' + friendImg(ch, 'tm-friend-img', 44) + '<span><b>' + App.esc(ch ? ch.name : 'None') + '</b></span>' + App.icon('right', 22) + '</button></div>' +
      '<div class="tm-row"><div><b>Show countdown</b><span>Minutes and seconds alongside the picture.</span></div>' + seg('showCountdown', [['false', 'Off'], ['true', 'On']]) + '</div>' +
      '<div class="tm-row"><div><b>Finish</b><span>How much confetti when time is up.</span></div>' + seg('finishStyle', [['quiet', 'Quiet'], ['gentle', 'Gentle'], ['party', 'Party']]) + '</div>' +
      (tracks.length ? '<div class="tm-row"><div><b>Music</b><span>Plays softly while the timer runs.</span></div>' +
        seg('music', [['', 'Off']].concat(tracks.map(function (t) { return [t.id, t.name]; }))) + '</div>' : '') +
      '<p class="tm-opts-foot">Saved for timers on this frame.</p></div>', {
      cls: 'sheet--wide tm-sheet',
      onMount: function (sheet) {
        sheet.addEventListener('click', function (e) {
          if (e.target.closest('[data-pick]')) { friendSheet(); return; }
          var b = e.target.closest('[data-val]'); if (!b) return;
          var key = b.parentNode.dataset.seg, v = b.dataset.val;
          P[key] = key === 'showCountdown' ? v === 'true' : v;
          savePrefs();
          App.$$('button', b.parentNode).forEach(function (x) { x.classList.toggle('is-on', x === b); });
          if (key === 'music' && S.phase === 'running') music(true);
          if (key === 'showCountdown') { render(); loop(); }
        });
      }
    });
  }

  // The character library, animals then vehicles, in the app's fixed order.
  function friendSheet() {
    var list = chars(), cats = TA().categories || {}, cur = currentCharId();
    if (!list.length) { App.toast('No friends are available yet', { icon: 'star' }); return; }
    function group(title, ids) {
      var items = list.filter(function (c) { return !ids || ids.indexOf(c.id) > -1; });
      if (!items.length) return '';
      return '<h3 class="tm-pick-h">' + title + '</h3><div class="tm-pick">' + items.map(function (c) {
        return '<button class="tm-pick-item' + (c.id === cur ? ' is-on' : '') + '" data-char="' + App.esc(c.id) + '">' +
          '<img src="' + App.esc(c.thumb || c.image) + '" alt="" width="96" height="96" decoding="async" loading="lazy"><span>' + App.esc(c.name) + '</span></button>';
      }).join('') + '</div>';
    }
    var body = cats.animals ? group('Animals', cats.animals) + group('Things that go', cats.vehicles || []) : group('Friends', null);
    App.sheet('<div class="sheet-pad"><h2 class="sheet-h">Pick a friend</h2>' + body + '</div>', {
      cls: 'sheet--wide tm-sheet',
      onMount: function (sheet, close) {
        sheet.addEventListener('click', function (e) {
          var b = e.target.closest('[data-char]'); if (!b) return;
          P.character = b.dataset.char; savePrefs();
          if (S.phase !== 'idle') { S.character = P.character; saveState(); }
          close(); render(); loop();
        });
      }
    });
  }

  // Custom time: minutes 0-60 and seconds in 15s steps, at least 15 seconds (CustomTimeSheet).
  function customSheet() {
    var m = Math.floor(P.seconds / 60), s = P.seconds % 60 - P.seconds % 15;
    function body() {
      return '<div class="tm-steppers">' +
        stepper('m', 'Minutes', m) + '<span class="tm-colon">:</span>' + stepper('s', 'Seconds', s) + '</div>' +
        '<p class="tm-custom-sum">' + friendly(Math.max(MIN_SECONDS, m * 60 + s)) + '</p>';
    }
    function stepper(k, label, v) {
      return '<div class="tm-stepper"><small>' + label + '</small><div>' +
        '<button data-step="' + k + '" data-d="-1" aria-label="Fewer ' + label.toLowerCase() + '">' + App.icon('minus', 30) + '</button>' +
        '<b>' + ('0' + v).slice(-2) + '</b>' +
        '<button data-step="' + k + '" data-d="1" aria-label="More ' + label.toLowerCase() + '">' + App.icon('plus', 30) + '</button></div></div>';
    }
    App.sheet('<div class="sheet-pad"><h2 class="sheet-h">Set custom time</h2><div data-body>' + body() + '</div>' +
      '<div class="sheet-actions"><button class="btn" data-close>Cancel</button><button class="btn btn--solid" data-set>Set time</button></div></div>', {
      cls: 'tm-sheet',
      onMount: function (sheet, close) {
        sheet.addEventListener('click', function (e) {
          var b = e.target.closest('[data-step]');
          if (b) {
            var d = +b.dataset.d;
            if (b.dataset.step === 'm') m = Math.max(0, Math.min(60, m + d));
            else { s += d * 15; if (s > 45) s = 0; if (s < 0) s = 45; }
            if (m === 60) s = 0;
            $('[data-body]', sheet).innerHTML = body();
            return;
          }
          if (e.target.closest('[data-set]')) { P.seconds = Math.max(MIN_SECONDS, m * 60 + s); savePrefs(); close(); render(); }
        });
      }
    });
  }

  function confirmStop() {
    App.sheet('<div class="sheet-pad"><h2 class="sheet-h">Stop this timer?</h2><p class="sheet-p">Stopping ends the countdown.</p>' +
      '<div class="sheet-actions"><button class="btn" data-close>Keep going</button><button class="btn btn--solid tm-btn-stop" data-yes>Stop</button></div></div>', {
      cls: 'tm-sheet',
      onMount: function (sheet, close) { $('[data-yes]', sheet).onclick = function () { close(); stop(); }; }
    });
  }

  // ------------------------------------------------------------ input
  function onClick(e) {
    var t = e.target.closest('button');
    if (!t || !V.el.contains(t)) return;
    var d = t.dataset;
    if (d.lock !== undefined) {
      if (!S.locked && Date.now() - V.unlockedAt > 500) setLocked(true);
      return;
    }
    if (S.locked && S.phase !== 'idle') { refuse(); return; }
    if (d.preset) { P.seconds = +d.preset; savePrefs(); render(); return; }
    if (d.custom !== undefined) { customSheet(); return; }
    if (d.start !== undefined) { start(P.seconds); return; }
    if (d.toggle !== undefined) { if (S.phase === 'running') pause(); else resume(); return; }
    if (d.restart !== undefined) { start(S.duration, S.character); return; }
    if (d.add) { addTime(+d.add); return; }
    if (d.stop !== undefined) {
      if (S.duration - wholeSeconds(remainingMs()) > 10) confirmStop(); else stop();
      return;
    }
    if (d.options !== undefined) { optionsSheet(); return; }
    if (d.friend !== undefined) { friendSheet(); return; }
  }

  // ------------------------------------------------------------ rail pill
  // The Timer tab shows the time left while a timer runs on any tab.
  function railUpdate() {
    var b = $('.rail-item[data-go="timer"]');
    if (!b) return;
    var pill = $('.tm-rail', b);
    if (!pill) { pill = document.createElement('b'); pill.className = 'tm-rail'; b.appendChild(pill); }
    var on = S.phase !== 'idle';
    b.classList.toggle('tm-on', on);
    b.classList.toggle('tm-paused', S.phase === 'paused');
    if (on) pill.textContent = compact(remainingMs());
  }

  // ------------------------------------------------------------ view
  App.register('timer', {
    show: function (el) {
      if (!V.el) { V.el = el; el.addEventListener('click', onClick); }
      el.classList.add('view--bleed');
      render();
      loop();
    },
    hide: function () { stopLoop(); },
    resume: function () { if (V.el) { if (V.ends) V.ends.textContent = endsText(); draw(); loop(); } }
  });

  App.on('second', function () {
    if (S.phase === 'running' && Date.now() >= S.end) complete(false);
    if (S.phase === 'idle') return;
    railUpdate();
    if (V.ends && App.current === 'timer') V.ends.textContent = endsText();
    // A child's timer on screen must not be swapped for Home by the idle timeout.
    if (App.current === 'timer' && App.mode === 'day' && App.resetIdle) App.resetIdle();
  });

  // ------------------------------------------------------------ boot: prefs + a run saved before a reload
  (function boot() {
    var p = load(PREFS_KEY);
    if (p) Object.keys(P).forEach(function (k) { if (p[k] !== undefined) P[k] = p[k]; });
    if (!CONFETTI[P.finishStyle]) P.finishStyle = 'party';
    if (!(P.seconds >= MIN_SECONDS)) P.seconds = 300;
    var s = load(STATE_KEY);
    if (s && (s.phase === 'running' || s.phase === 'paused') && s.duration > 0) {
      S.phase = s.phase; S.duration = s.duration; S.end = +s.end || 0; S.remaining = +s.remaining || 0;
      S.character = s.character || null; S.locked = !!s.locked;
    }
  })();
  App.on('ready', function () {
    railUpdate();
    if (S.phase === 'running') {
      var over = Date.now() - S.end;
      if (over >= 0) complete(over > 5 * 60 * 1000);
      else { arm(); music(true); }
    }
  });

  // Small API for the demo drawer and testing: App.timer.start(5) runs a five-second timer.
  App.timer = {
    start: function (sec, charId) { start(sec, charId); },
    pause: pause, resume: resume, stop: stop,
    state: function () { return { phase: S.phase, duration: S.duration, remainingMs: remainingMs(), character: S.character, locked: S.locked }; }
  };
})();
