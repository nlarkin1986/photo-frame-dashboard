// Ambient (idle photo frame) and Night (dim red clock) overlays.
(function () {
  'use strict';
  var D = window.DATA, $ = App.$;
  var amb = { show: null }, shiftTimer = null;

  function ambientInfo() {
    var n = App.now(), w = App.weatherNow(), next = App.nextEvent();
    return '<div class="amb-clock"><div class="amb-time num">' + App.fmt.time(n, false) + '</div>' +
      '<div class="amb-date">' + App.fmt.day(n) + ', ' + App.fmt.month(n) + ' ' + n.getDate() + '</div></div>' +
      '<div class="amb-right">' +
      '<div class="amb-wx">' + App.icon(w.cond, 44) + '<span class="num">' + w.temp + '°</span><small>' + w.summary + '</small></div>' +
      (next ? '<div class="amb-next" style="' + App.pstyle(App.evColor(next)) + '"><i></i>' + App.esc(next.title) + ' · ' + App.fmt.time(next.start) + '</div>' : '') +
      schedLine() + weekLine() +
      '<div class="amb-who">' + D.people.map(function (p) { return App.avatar(p, 34, p.home ? '' : 'avatar--away'); }).join('') + '</div>' +
      '</div>';
  }
  // "Lilly · next: Bath time" — one line for the kids on the picture schedule.
  function schedLine() {
    var d = App.schedule && App.schedule.data, U = App.schedUI;
    if (!U || !d || !d.kids || !d.kids.length || d.planned === false) return '';
    var parts = d.kids.slice(0, 3).map(function (k) {
      var n = U.nowInfo(k), c = n.now || n.next;
      if (!n.day || !n.total) return '';
      return '<span style="' + U.kidStyle(k) + '"><i></i>' + App.esc(k.name) + ' · ' + (c ? 'next: <b>' + App.esc(c.label || '') + '</b>' : '<b>all done</b>') + '</span>';
    }).filter(Boolean);
    return parts.length ? '<div class="amb-sched">' + parts.join('') + '</div>' : '';
  }
  // "To decide: Who picks up Lilly? · Today 10:55" — the next open (never private) decision.
  function weekLine() {
    var B = App.board, next = B && B.openDecisions()[0];
    if (!next) return '';
    var d = next.when && B.dateOf(next.when.date);
    var when = d ? App.fmt.rel(d) + (next.when.time ? ' ' + App.esc(next.when.time) : '') : '';
    return '<div class="amb-week"><i></i><span>To decide: <b>' + App.esc(next.title) + '</b>' + (when ? ' · ' + when : '') + '</span></div>';
  }
  function nightInfo() {
    var n = App.now(), tomorrow = App.addDays(n, n.getHours() < 6 ? 0 : 1);
    var first = App.timedOn(tomorrow)[0], w = App.weatherNow();
    return '<div class="nt-time num">' + App.fmt.time(n, false) + '</div>' +
      '<div class="nt-line">' + App.icon(w.cond, 26) + ' ' + w.temp + '° · ' + (first ? 'First up ' + App.fmt.rel(first.start).toLowerCase() + ': <b>' + App.esc(first.title) + '</b> ' + App.fmt.time(first.start) + ' · ' + (App.isFamily(first) ? 'Everyone' : first.people.map(function (id) { return App.esc(App.person(id).name); }).join(' + ')) : 'Nothing early tomorrow') + '</div>' +
      '<div class="nt-lock">' + App.icon('lock', 20) + ' House locked · alarm armed</div>';
  }

  function paint() {
    if (App.mode === 'ambient') $('#ambient .amb-info').innerHTML = ambientInfo();
    if (App.mode === 'night') $('#night .nt-inner').innerHTML = nightInfo();
  }

  // Nudge static content a few px every minute so nothing sits still for hours (image retention)
  function pixelShift() {
    var x = Math.round(Math.random() * 8 - 4), y = Math.round(Math.random() * 8 - 4);
    App.$$('.amb-info, .nt-inner').forEach(function (el) { el.style.transform = 'translate(' + x + 'px,' + y + 'px)'; });
  }

  App.on('ready', function () {
    $('#ambient').innerHTML = '<div class="amb-stage"></div><div class="amb-scrim"></div><div class="amb-info"></div>';
    $('#night').innerHTML = '<div class="nt-inner"></div>';
    amb.show = new App.Slideshow($('#ambient .amb-stage'), { layout: 'cover', captions: false, interval: 14000 });
    $('#ambient').addEventListener('click', function () { App.setMode('day'); App.go('home'); });
    $('#night').addEventListener('click', function () { App.setMode('nightdash'); });
  });

  App.on('mode', function (m) {
    clearInterval(shiftTimer);
    if (m === 'ambient') { amb.show.start(); paint(); shiftTimer = setInterval(pixelShift, 60000); }
    else amb.show.stop();
    if (m === 'night') { paint(); shiftTimer = setInterval(pixelShift, 60000); }
    App.resetIdle();
  });
  App.on('minute', paint);
  App.on('schedule', paint);
  App.on('schedule-tick', paint);
  App.on('board', paint);
  App.on('weather', paint);
})();
