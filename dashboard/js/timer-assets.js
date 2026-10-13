// Timer assets: the Final Timer app's characters, celebration frames, home tool art and sounds
// (served from public/timer/), plus a tiny HTMLAudioElement player for the music.
// Loaded before the timer and puzzle views; exposes window.TimerAssets. Nothing here ever throws.
(function () {
  'use strict';
  var BASE = '/timer/';

  // ------------------------------------------------------------ characters
  // Catalogue order from the app (Characters.all): every animal, then everything that goes.
  // The order is deliberate — children find a friend in the same place every time — so never sort it.
  var ANIMALS = ['cat', 'dog', 'rabbit', 'panda', 'lion', 'tiger', 'elephant', 'giraffe', 'monkey',
    'kangaroo', 'unicorn', 'penguin', 'dolphin', 'whale', 'shark', 'octopus', 'bee', 'butterfly',
    'ladybug', 'parrot', 'eagle'];
  var VEHICLES = ['fire_truck', 'police_car', 'ambulance', 'race_car', 'school_bus', 'bulldozer',
    'train_engine', 'scooter', 'balance_bike', 'helicopter', 'hot_air_balloon', 'sailboat', 'pirate_ship'];

  // "fire_truck" -> "Fire Truck" (Characters.displayName)
  function displayName(id) {
    return id.split('_').map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join(' ');
  }
  function character(id, category) {
    return {
      id: id,
      name: displayName(id),
      category: category,
      image: BASE + 'characters/' + id + '.webp',        // 600px, for the timer face
      thumb: BASE + 'characters/' + id + '_thumb.webp'   // 160px, for pickers and grids
    };
  }
  var characters = ANIMALS.map(function (id) { return character(id, 'animals'); })
    .concat(VEHICLES.map(function (id) { return character(id, 'vehicles'); }));
  var byId = {};
  characters.forEach(function (c) { byId[c.id] = c; });
  var DEFAULT_CHARACTER = 'unicorn';

  // ------------------------------------------------------------ art
  // Celebration frames: textured 600px squares the puzzle celebration sets the finished picture on
  // (PuzzleCelebrationView picks one at random, in this order).
  var FRAME_ORDER = ['peach', 'gold', 'yellow', 'blue'];
  var frames = {};
  FRAME_ORDER.forEach(function (f) { frames[f] = BASE + 'frames/' + f + '.webp'; });

  // Home screen tool cards (home_tool_*), 320px with transparency.
  var tools = {
    timer: BASE + 'tools/timer.webp',
    routines: BASE + 'tools/routines.webp',
    rewards: BASE + 'tools/rewards.webp',
    guide: BASE + 'tools/guide.webp'
  };

  // ------------------------------------------------------------ sounds
  // Music at the app's fixed low level. No finish chime: the frame finishes silently by choice.
  var MUSIC_VOLUME = 0.3;
  var sounds = {
    music: [
      { id: 'time_to_tidy_up', name: 'Time To Tidy Up', url: BASE + 'audio/time_to_tidy_up.mp3' },
      { id: 'waiting', name: 'Waiting', url: BASE + 'audio/waiting.mp3' }
    ]
  };
  var SFX = {};  // play(name) is a safe no-op for unknown names

  // ------------------------------------------------------------ mute (persisted)
  var MUTE_KEY = 'timer.muted';
  var muted = false;
  try { muted = window.localStorage.getItem(MUTE_KEY) === '1'; } catch (e) { muted = false; }

  // ------------------------------------------------------------ audio helpers
  // play() returns a promise in modern WebViews; autoplay policy can reject it until the first touch.
  function safePlay(a) {
    try {
      var p = a.play();
      if (p && typeof p.catch === 'function') p.catch(function () {});
      return true;
    } catch (e) { return false; }
  }
  function makeAudio(url, volume, loop) {
    try {
      var a = new Audio();
      a.preload = 'auto';
      a.loop = !!loop;
      a.volume = volume;
      a.src = url;
      return a;
    } catch (e) { return null; }
  }

  var sfx = {}; // name -> HTMLAudioElement, created on first use and reused
  function sfxAudio(name) {
    var def = SFX[name];
    if (!def) return null;
    if (!sfx[name]) sfx[name] = makeAudio(def.url, def.volume, false);
    return sfx[name];
  }

  // One-shot sound effect, e.g. play('finish'). Restarts if it is already playing.
  function play(name) {
    try {
      if (muted) return false;
      var a = sfxAudio(name);
      if (!a) return false;
      try { a.muted = false; a.pause(); a.currentTime = 0; } catch (e) { /* not loaded yet */ }
      return safePlay(a);
    } catch (e) { return false; }
  }

  // ------------------------------------------------------------ music (one looping track at a time)
  var music = null;      // the current HTMLAudioElement
  var musicId = null;    // the track that should be playing (kept while muted, so unmute resumes it)
  var fadeTimer = null;

  function track(id) {
    for (var i = 0; i < sounds.music.length; i++) if (sounds.music[i].id === id) return sounds.music[i];
    return null;
  }
  function clearFade() { if (fadeTimer) { clearInterval(fadeTimer); fadeTimer = null; } }
  function teardown() {
    clearFade();
    if (music) {
      try { music.pause(); music.removeAttribute('src'); music.load(); } catch (e) { /* ignore */ }
      music = null;
    }
  }

  // Start a looping track (defaults to the first). Replaces whatever is playing.
  function playMusic(id) {
    try {
      var t = track(id) || sounds.music[0];
      teardown();
      musicId = t.id;
      if (muted) return false;
      music = makeAudio(t.url, MUSIC_VOLUME, true);
      return music ? safePlay(music) : false;
    } catch (e) { return false; }
  }

  // Stop the music. Pass a duration in ms to fade out first (the app fades over 500 ms on finish).
  function stopMusic(fadeMs) {
    try {
      musicId = null;
      clearFade();
      if (!music || !fadeMs || music.paused) { teardown(); return; }
      var a = music, steps = Math.max(1, Math.round(fadeMs / 50)), step = a.volume / steps, n = 0;
      fadeTimer = setInterval(function () {
        n++;
        try { a.volume = Math.max(0, a.volume - step); } catch (e) { n = steps; }
        if (n >= steps) teardown();
      }, 50);
    } catch (e) { teardown(); }
  }

  function setMuted(on) {
    muted = !!on;
    try { window.localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch (e) { /* storage blocked */ }
    try {
      if (muted) {
        var keep = musicId;
        teardown();
        musicId = keep;
        Object.keys(sfx).forEach(function (k) { try { sfx[k].pause(); } catch (e) { /* ignore */ } });
      } else if (musicId && !music) {
        playMusic(musicId);
      }
    } catch (e) { /* ignore */ }
    try { if (window.App && App.emit) App.emit('timer:muted', muted); } catch (e) { /* ignore */ }
    return muted;
  }
  function isMuted() { return muted; }

  window.TimerAssets = {
    characters: characters,
    categories: { animals: ANIMALS.slice(), vehicles: VEHICLES.slice() },
    defaultCharacter: DEFAULT_CHARACTER,
    character: function (id) { return byId[id] || byId[DEFAULT_CHARACTER]; },
    frames: frames,
    frameOrder: FRAME_ORDER.slice(),
    tools: tools,
    sounds: sounds,
    play: play,
    playMusic: playMusic,
    stopMusic: stopMusic,
    setMuted: setMuted,
    isMuted: isMuted
  };
})();
