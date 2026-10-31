const API = 'https://ws.audioscrobbler.com/2.0/';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const FALLBACK = ['#1f5fbf', '#e2541f', '#d9a521', '#2e8b57', '#b8322e', '#7b5ea7'];
const MAX_ERAS = 40; // ponytail: hard cap keeps the timeline legible; make it a control if people ask
const $ = s => document.querySelector(s);
const el = {
  jacket: $('#jacket'), frame: $('#cover-frame'), title: $('#title'), sub: $('#sub'), facts: $('#facts'),
  form: $('#form'), user: $('#user'), go: $('#go'), bucket: $('#bucket'), sens: $('#sens'), sensOut: $('#sens-out'),
  status: $('#status'), progress: $('#progress'), timeline: $('#timeline'), side: $('#side'), list: $('#list'),
  spotify: $('#spotify'), spotifyFile: $('#spotify-file'),
};

const state = { user: null, months: [], run: 0, eras: [], sel: null, view: null, tags: new Map(), tagsUser: null, source: 'lastfm', playcount: 0 };

// ── storage (finished months never change, so cache them) ──
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem('eras1:' + k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem('eras1:' + k, JSON.stringify(v)); } catch { /* full or blocked: just refetch */ } },
};

// ── Last.fm ──
class ApiError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Last.fm's limit is per visitor IP: 5 requests/s averaged over 5 minutes. A full pull of
// a 24-year history is ~580 requests, so bursting at 10/s still averages under 2/s.
// ponytail: no long-window budget; add one if pulls ever exceed ~1500 requests.
let nextSlot = 0, gap = 100, onSlow = null;
async function throttle() {
  const now = Date.now(), at = Math.max(now, nextSlot);
  nextSlot = at + gap;
  await sleep(at - now);
}

async function call(method, params) {
  const fake = window.fakeLastfm?.(method, params); // localhost/?user=_fonts, see fake.js
  if (fake) return fake;
  const u = new URL(API);
  for (const [k, v] of Object.entries({ method, api_key: window.LASTFM_KEY, format: 'json', ...params })) u.searchParams.set(k, v);
  for (let i = 0; ; i++) {
    try {
      await throttle();
      const j = await (await fetch(u)).json();
      if (!j.error) { gap = Math.max(100, gap * 0.8); return j; } // recover speed as calls succeed
      if (j.error === 29) {
        // rate limited (Last.fm doesn't say whether by IP or by key): back off and say so
        gap = Math.min(gap * 2, 1600);
        state.slowed = true;
        onSlow?.();
      }
      if (![8, 11, 16, 29].includes(j.error) || i >= 5) throw new ApiError(j.error, j.message);
    } catch (e) {
      if (e instanceof ApiError || i >= 5) throw e;
    }
    await sleep(700 * 2 ** i);
  }
}

const slowNote = () => (state.slowed ? ' · Last.fm is rate-limiting requests, so this is going slower' : '');

// Map.groupBy, which iOS Safari only has from 17.4
function groupBy(items, key) {
  const m = new Map();
  for (const x of items) { const k = key(x); if (m.has(k)) m.get(k).push(x); else m.set(k, [x]); }
  return m;
}

async function pool(items, n, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (next < items.length) await fn(items[next++]); }));
}

// every UTC month from `from` to `to`, inclusive, in the shape the charts are keyed by
function monthsBetween(from, to) {
  const a = new Date(from * 1000), b = new Date(to * 1000);
  const out = [];
  const start = a.getUTCFullYear() * 12 + a.getUTCMonth();
  const end = b.getUTCFullYear() * 12 + b.getUTCMonth();
  for (let idx = start; idx <= end; idx++) {
    const y = Math.floor(idx / 12), m = idx % 12;
    out.push({ idx, y, m, from: Date.UTC(y, m, 1) / 1000, to: Date.UTC(y, m + 1, 1) / 1000 });
  }
  return out;
}

// The join date and today say nothing about the listening: an account can sit unused for years
// before the first scrobble, and a history can stop years before now. user.getweeklychartlist
// looks like the answer but isn't per user: every account gets the same global week calendar
// (2005 → this week), so it would still draw the empty years. user.getrecenttracks pages newest
// first, so its last page is the very first scrobble and its first page the last one: two
// requests give the real span, and any failure keeps the old registered → now range.
async function historySpan(user, info) {
  const now = Date.now() / 1000;
  const span = { first: +info.registered.unixtime, last: now };
  const total = +info.playcount;
  if (!(total > 0)) return span;
  try {
    // a now-playing track has no date, so ask for two and keep the newest dated one
    const dated = async params => [].concat((await call('user.getrecenttracks', { user, ...params })).recenttracks?.track || [])
      .filter(t => t?.date?.uts);
    const [oldest, newest] = await Promise.all([dated({ limit: 1, page: total }), dated({ limit: 2 })]);
    if (oldest[0]) span.first = +oldest[0].date.uts;
    if (newest[0]) span.last = +newest[0].date.uts;
  } catch { /* keep registered → now: a failed probe must not abort the pull */ }
  const first = Math.min(span.first, now);
  return { first, last: Math.min(Math.max(span.last, first), now) }; // clock skew can't invert the span
}

async function load(user) {
  const run = ++state.run;
  artStop(); // a new pull owns the progress bar, even if covers are still arriving
  const info = (await call('user.getinfo', { user })).user;
  if (run !== state.run) return;
  // tags are per artist, but the set fetched for one user includes artists outside the next
  // user's top 90%: keeping it made a history depend on the tab it was loaded after
  if (state.source !== 'lastfm' || state.user !== info.name) {
    state.tags.clear();
    state.tagsUser = null;
  }
  const { first, last } = await historySpan(info.name, info);
  if (run !== state.run) return;
  state.source = 'lastfm';
  state.user = info.name;
  state.playcount = +info.playcount;
  state.months = monthsBetween(first, last);
  state.sel = null;
  const keyOf = (mo, mode) => `${info.name.toLowerCase()}:${mo.y}-${mo.m}${mode === 'artist' ? ':ar' : ''}`;
  // cached months (both kinds) land immediately, so the timeline never blanks while the rest loads
  for (const mo of state.months) for (const mode of ['album', 'artist']) mo[mode] = store.get(keyOf(mo, mode)) || undefined;
  el.progress.hidden = false;
  state.slowed = false;
  const fresh = Date.now() / 1000 - 2 * 86400;
  const charts = async mode => {
    const tasks = state.months.filter(mo => !mo[mode]);
    let done = 0;
    el.progress.max = tasks.length;
    const tick = () => {
      el.progress.value = done;
      const mo = tasks.find(mo => !mo[mode]);
      say(mo ? `Reading ${info.name}'s ${mode}s · ${mo.y} · ${done} of ${tasks.length}` + slowNote() : '', state.slowed && 'warn');
      schedule();
    };
    onSlow = tick;
    tick();
    await pool(tasks, 5, async mo => {
      if (run !== state.run) return;
      const j = await call(`user.getweekly${mode}chart`, { user: info.name, from: mo.from, to: mo.to });
      const items = [].concat(j[`weekly${mode}chart`]?.[mode] || [])
        .filter(a => +a.playcount >= 2).slice(0, 150)
        .map(a => (mode === 'album' ? [a.name, a.artist['#text'], +a.playcount] : ['', a.name, +a.playcount]));
      if (mo.to < fresh) store.set(keyOf(mo, mode), items);
      if (run !== state.run) return;
      mo[mode] = items;
      done++;
      tick();
    });
  };
  // fetch in the order the view needs: artist charts (then genre tags) for artist and genre eras;
  // album charts always follow, for cover art and the plays line
  const mode = el.form.mode.value;
  if (mode !== 'album') await charts('artist');
  if (run !== state.run) return;
  if (mode === 'genre') await loadTags(run);
  if (run !== state.run) return;
  await charts('album');
  if (run !== state.run) return;
  finishLoad();
}

// shared last mile for both sources: detect, draw, report what was loaded.
// Covers are fetched after the charts, so the same bar picks up again with their own total.
function finishLoad() {
  el.progress.hidden = true;
  const plays = state.playcount.toLocaleString();
  const noun = state.source === 'spotify' ? 'Spotify plays' : 'scrobbles';
  state.summary = `${state.user} · ${plays} ${noun} since ${MONTHS[state.months[0].m]} ${state.months[0].y}`;
  say(state.summary);
  if (!artBar) { artBar = true; artTotal = artDone = 0; }
  compute();
  render();
  centerOn(state.eras[0], 'instant');
  if (!artWorkers && !artQueue.length) { artBar = false; artTotal = artDone = 0; el.progress.hidden = true; }
}

// ── genres ──
// An artist's genre is its highest Last.fm tag that is also a MusicBrainz genre, which drops
// tags like "seen live". Umbrella genres lose to a narrower tag with at least NARROW of the
// top genre's votes, or one "hip hop" era would cover a whole history; the vote bar keeps
// stray and joke tags (Justin Bieber's "black metal" sits at 58%) from winning.
const UMBRELLA = new Set(['hip hop', 'pop', 'rock', 'electronic', 'alternative rock', 'dance', 'metal', 'folk', 'jazz', 'soul', 'r&b', 'country', 'classical', 'punk', 'singer-songwriter', 'experimental', 'instrumental']);
const NARROW = 0.6;
let genreList = null;

// Last.fm spells some genres its own way ("Hip-Hop", "rnb", "kpop"); keep each genre's best vote count
const SPELLING = { rnb: 'r&b', kpop: 'k-pop', synthpop: 'synth-pop' };
function genresIn(raw, genres) {
  const t = [], seen = new Set();
  for (const [name, votes] of raw) {
    let g = name.toLowerCase();
    if (!genres.has(g)) g = SPELLING[g] || g.replace(/-/g, ' ');
    if (genres.has(g) && !seen.has(g)) { seen.add(g); t.push([g, votes]); }
  }
  return t.slice(0, 5);
}

async function loadTags(run) {
  artStop(); // tag lookups use the same bar; don't let late covers hide it
  genreList ||= fetch('genres.txt')
    .then(r => { if (!r.ok) throw new Error(`genres.txt: ${r.status}`); return r.text(); })
    .then(t => new Set(t.split('\n').filter(Boolean)), e => { genreList = null; throw e; });
  const genres = await genreList;
  // the artists behind 90% of plays, at most 400 (still 88–98% of plays): the long tail rarely
  // reaches an era, and each artist is a request
  const plays = new Map();
  for (const mo of state.months) for (const [, a, p] of mo.artist || []) plays.set(a, (plays.get(a) || 0) + p);
  const ranked = [...plays].sort((a, b) => b[1] - a[1]);
  const total = ranked.reduce((s, [, p]) => s + p, 0);
  let sum = 0;
  const top = ranked.filter(([, p]) => (sum += p) - p < total * 0.9).slice(0, 400).map(([a]) => a);
  // the cache holds Last.fm's raw top 10 tags, filtered on read, so changing the genre rules needs no reset
  // (only reading past tag 10 would)
  for (const a of top) if (!state.tags.has(a)) { const raw = store.get('tags3:' + a); if (raw) state.tags.set(a, genresIn(raw, genres)); }
  const todo = top.filter(a => !state.tags.has(a));
  if (!todo.length) return void (state.tagsUser = state.user);
  let done = 0;
  el.progress.max = todo.length;
  const t0 = Date.now();
  const tick = () => {
    el.progress.value = done;
    // ~3 artists a second in practice; measure once a few are in
    const min = Math.round((todo.length - done) * (done > 20 ? (Date.now() - t0) / done : 330) / 60000);
    say(`Sorting ${todo.length} artists into genres · ${min > 1 ? `about ${min} minutes` : 'about a minute'}, only the first time · ${done} done` + slowNote(), state.slowed && 'warn');
    schedule();
  };
  onSlow = tick;
  tick();
  await pool(todo, 5, async a => {
    if (run !== state.run) return;
    let raw;
    try {
      const j = await call('artist.gettoptags', { artist: a, autocorrect: 1 });
      raw = [].concat(j.toptags?.tag || []).slice(0, 10).map(x => [x.name, +x.count]);
    } catch (e) {
      // offline, rate-limited or a bad API key: stop, as the chart pull does
      if (!(e instanceof ApiError) || [10, 26, 29].includes(e.code)) throw e;
      raw = e.code === 6 ? [] : null; // 6: Last.fm doesn't know the artist. Any other error: skip them, retry next load
    }
    if (raw) {
      store.set('tags3:' + a, raw); // ponytail: cached forever, add an expiry if genres look stale
      state.tags.set(a, genresIn(raw, genres));
    }
    done++;
    tick();
  });
  if (run === state.run) state.tagsUser = state.user;
}

function genreOf(artist) {
  const t = state.tags.get(artist);
  if (!t?.length) return '';
  return (t.find(([g, v]) => !UMBRELLA.has(g) && v >= NARROW * t[0][1]) || t[0])[0];
}

// ── Spotify extended streaming history ──
// The export is a ZIP of JSON files, one row per stream. It is read here, in the browser:
// nothing is uploaded anywhere. A stream counts as a play at 30 seconds, close to Last.fm's
// rule, and podcasts, audiobooks and videos are ignored so only songs shape the eras.
// ponytail: whole files are parsed at once; stream the JSON if exports ever outgrow a desktop tab.
const PLAY_MS = 30000;
const decoder = new TextDecoder();

async function unzip(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const dv = new DataView(buf.buffer);
  let e = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { e = i; break; } // end of central directory
  }
  if (e < 0) throw new Error('That file isn’t a ZIP. Choose the .zip Spotify emailed you.');
  const count = dv.getUint16(e + 10, true), dir = dv.getUint32(e + 16, true);
  if (count === 0xffff || dir === 0xffffffff) throw new Error('That ZIP is too large for this browser to open. Try again on a desktop browser.');
  const entries = [];
  let o = dir;
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(o, true) !== 0x02014b50) break; // central directory header
    const method = dv.getUint16(o + 10, true);
    const csize = dv.getUint32(o + 20, true);
    const nlen = dv.getUint16(o + 28, true), elen = dv.getUint16(o + 30, true), clen = dv.getUint16(o + 32, true);
    const local = dv.getUint32(o + 42, true);
    const name = decoder.decode(buf.subarray(o + 46, o + 46 + nlen));
    if (/\.json$/i.test(name) && csize !== 0xffffffff) {
      const nl = dv.getUint16(local + 26, true), xl = dv.getUint16(local + 28, true);
      const start = local + 30 + nl + xl;
      entries.push({ name, method, raw: buf.subarray(start, start + csize) });
    }
    o += 46 + nlen + elen + clen;
  }
  return entries;
}

async function inflate(entry) {
  if (entry.method === 0) return entry.raw; // stored
  if (entry.method !== 8) throw new Error(`Couldn’t read ${entry.name}: unsupported compression.`);
  if (typeof DecompressionStream === 'undefined') throw new Error('This browser can’t unzip files. Try a recent Chrome, Safari or Firefox.');
  const stream = new Blob([entry.raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// one stream row → its month's artist and album tallies; false when it isn't a song play
function addSpotifyRow(r, acc) {
  // songs only: podcasts, audiobooks and videos carry episode/audiobook fields
  if (!r?.master_metadata_track_name || !r.master_metadata_album_artist_name) return false;
  if (r.episode_name || r.episode_show_name || r.spotify_episode_uri || r.audiobook_title || r.audiobook_chapter_title) return false;
  if (!(+r.ms_played >= PLAY_MS)) return false;
  const t = Date.parse(r.ts);
  if (Number.isNaN(t)) return false;
  const d = new Date(t), idx = d.getUTCFullYear() * 12 + d.getUTCMonth();
  let m = acc.months.get(idx);
  if (!m) acc.months.set(idx, m = { a: new Map(), b: new Map() });
  const artist = r.master_metadata_album_artist_name;
  m.a.set(artist, (m.a.get(artist) || 0) + 1);
  const album = r.master_metadata_album_album_name;
  if (album) m.b.set(artist + SEP + album, (m.b.get(artist + SEP + album) || 0) + 1);
  acc.plays++;
  if (!acc.user && r.username) acc.user = r.username;
  if (t / 1000 < acc.first) acc.first = t / 1000;
  if (t / 1000 > acc.last) acc.last = t / 1000;
  return true;
}

// rows → the same { idx, artist, album } shape the Last.fm charts produce.
// an export ends at its last play, not today: a 2019-only export shouldn't draw empty years after it
function spotifyMonths(acc) {
  const now = Date.now() / 1000;
  const first = Math.min(acc.first, now); // clock-skewed rows shouldn't blank the timeline
  const last = Math.min(Math.max(acc.last, first), now); // ...or run it into the future
  return monthsBetween(first, last).map(mo => {
    const m = acc.months.get(mo.idx);
    if (!m) return mo;
    mo.artist = [...m.a].filter(([, p]) => p >= 2).sort((x, y) => y[1] - x[1]).slice(0, 150).map(([a, p]) => ['', a, p]);
    mo.album = [...m.b].filter(([, p]) => p >= 2).sort((x, y) => y[1] - x[1]).slice(0, 150)
      .map(([k, p]) => { const i = k.indexOf(SEP); return [k.slice(i + 1), k.slice(0, i), p]; });
    return mo;
  });
}

async function loadSpotify(file) {
  const run = ++state.run;
  artStop();
  state.slowed = false;
  el.progress.hidden = false;
  el.progress.max = 1;
  el.progress.value = 0;
  say('Reading your Spotify export — this can take a while, especially for a long history. Leave this tab open; only song plays count.', 'warn');
  await new Promise(r => setTimeout(r, 0)); // let the notice paint before the first parse blocks

  const entries = await unzip(file);
  // song plays live in Streaming_History_Audio; video/podcast files are skipped outright
  const audio = entries.filter(x => /streaming.?history.?audio[_.-]/i.test(x.name));
  const list = audio.length ? audio : entries;
  if (!list.length) throw new Error('That ZIP has no JSON files in it.');

  const acc = { months: new Map(), plays: 0, user: '', first: Infinity, last: 0 };
  el.progress.max = list.length;
  let done = 0;
  for (const entry of list) {
    if (run !== state.run) return;
    say(`Reading ${entry.name} · ${done + 1} of ${list.length} — this can take a while.`, 'warn');
    await new Promise(r => setTimeout(r, 0));
    let rows;
    try {
      rows = JSON.parse(decoder.decode(await inflate(entry)).replace(/^\uFEFF/, ''));
    } catch (e) {
      if (run !== state.run) return;
      throw new Error(`Couldn’t read ${entry.name}. The download may be incomplete; try exporting again.`);
    }
    if (Array.isArray(rows)) for (const r of rows) addSpotifyRow(r, acc);
    done++;
    el.progress.value = done;
  }
  if (run !== state.run) return;
  if (!acc.plays) throw new Error('That ZIP had no song plays in it. Request “Extended streaming history” from Spotify, not “Account data”.');

  state.source = 'spotify';
  state.user = acc.user || 'Spotify';
  // a Spotify export keeps none of the previous Last.fm user's tag set for the same reason
  state.tags.clear();
  state.tagsUser = null;
  state.playcount = acc.plays;
  state.months = spotifyMonths(acc);
  state.sel = null;
  state.tagsUser = null;
  el.user.value = ''; // the username box is Last.fm's; the export names its own listener
  if (el.form.mode.value === 'genre') {
    try {
      await loadTags(run);
    } catch {
      if (run !== state.run) return;
      finishLoad();
      return say('Your Spotify data loaded, but Last.fm wouldn’t give genre tags right now. Try Genres again in a few minutes.', 'warn');
    }
  }
  if (run !== state.run) return;
  finishLoad();
}

// ── art + color ──
const art = new Map(); // key → {url, color} | 'pending'

async function fetchArt(era) {
  const cacheKey = 'img:' + era.albumKey;
  let a = store.get(cacheKey);
  if (!a) {
    let url = '';
    try {
      const j = await call('album.getinfo', { artist: era.artist, album: era.album, autocorrect: 1 });
      url = (j.album?.image || []).find(i => i.size === 'mega' || i.size === 'extralarge')?.['#text'] || '';
    } catch { /* missing album: fall through to a palette color */ }
    a = { url, color: url ? await coverColor(url) : null };
    store.set(cacheKey, a);
  }
  art.set(era.albumKey, a);
  schedule();
}

function coverColor(url) {
  return new Promise(res => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = c.height = 24;
        const x = c.getContext('2d', { willReadFrequently: true });
        x.drawImage(img, 0, 0, 24, 24);
        const d = x.getImageData(0, 0, 24, 24).data;
        // weight each hue by saturation*value, take the heaviest hue's average color
        const bins = Array.from({ length: 12 }, () => [0, 0, 0, 0]);
        for (let i = 0; i < d.length; i += 4) {
          const [h, s, v] = hsv(d[i], d[i + 1], d[i + 2]);
          const w = s * v * s;
          const b = bins[Math.floor(h * 12) % 12];
          b[0] += d[i] * w; b[1] += d[i + 1] * w; b[2] += d[i + 2] * w; b[3] += w;
        }
        const best = bins.reduce((a, b) => (b[3] > a[3] ? b : a));
        res(best[3] < 6 ? null : vivid(best[0] / best[3], best[1] / best[3], best[2] / best[3]));
      } catch { res(null); }
    };
    img.onerror = () => res(null);
    img.src = url;
  });
}

function hsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, max ? d / max : 0, max];
}

// Push the cover's hue into a flat, printable slab color: saturated, mid-light.
function vivid(r, g, b) {
  const [h, s, v] = hsv(r, g, b);
  return hex(h, Math.max(s, 0.55), Math.min(Math.max(v, 0.72), 0.92));
}

function hex(h, S, V) {
  const f = n => { const k = (n + h * 6) % 6; return V - V * S * Math.max(0, Math.min(k, 4 - k, 1)); };
  return '#' + [f(5), f(3), f(1)].map(c => Math.round(c * 255).toString(16).padStart(2, '0')).join('');
}

// Genre eras take their color from the genre, never from album art: a fixed hue per family
// (rap warm, electronic cool), nudged per genre so neighbours in a family still differ.
// First match wins, so "pop punk" is rock, "emo rap" is rap and "breakcore" isn't metal.
const FAMILIES = [
  [/breakcore|nightcore/, 205],
  [/metal|hardcore|core$|grind|djent|sludge|doom/, 0],
  [/hip hop|rap|trap|drill|grime|phonk|crunk|boom bap/, 24],
  [/rock|punk|emo|grunge|shoegaze|indie|alternative|post/, 45],
  [/folk|country|americana|bluegrass|singer/, 90],
  [/soul|r&b|jazz|blues|funk|gospel|disco|bossa|samba|reggae/, 150],
  [/electr|house|techno|ambient|idm|edm|trance|dub|drum and bass|synth|wave|garage|break|chiptune/, 205],
  [/classical|orchestra|soundtrack|opera|baroque|choral|minimal/, 262],
  [/pop/, 318],
];
function genreColor(g) {
  let h = 0;
  for (const ch of g) h = (h * 31 + ch.charCodeAt(0)) | 0;
  h >>>= 0; // unsigned: Math.abs(INT32_MIN) stays out of range
  const hue = FAMILIES.find(([re]) => re.test(g))?.[1] ?? h % 360;
  return hex((((hue + (h % 25) - 12) % 360) + 360) % 360 / 360, 0.62, 0.74 + (h >> 5) % 4 * 0.06);
}

function inkFor(hex) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => (c <= .03928 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.2 ? '#121110' : '#f1eadb';
}

function hashColor(s) {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return FALLBACK[Math.abs(h) % FALLBACK.length];
}

// ── compute ──
function settings() {
  const s = +el.sens.value; // 1 loose … 9 strict
  const mode = el.form.mode.value;
  // genres: an era is a stretch at 1.4× the genre's usual share. Strictness only asks for longer
  // eras (2 → 6 months) that ride out longer dips (2 → 4 months): moving the bar too would let
  // the loose end join eras the strict end keeps apart, since more months between them clear it.
  // Under three years there's no usual share to measure against, so only the share bar applies.
  if (mode === 'genre') {
    const B = +el.bucket.value;
    const lift = state.months.length < 36 ? 0 : 1.4;
    return { mode, B, share: 0.05, lift, ramp: false, perMonth: 4, quiet: Math.max(1, Math.round((1 + Math.floor((s + 2) / 3)) / B)), minLen: Math.ceil((2 + Math.floor(s / 2)) / B) };
  }
  return { mode, B: +el.bucket.value, share: (0.02 + (s - 1) * 0.015) * (mode === 'artist' ? 1.8 : 1), perMonth: 4 + s * 2.5 };
}

function compute() {
  if (!state.months.length) return;
  const { mode, B, share, lift, ramp, quiet, minLen, perMonth } = settings();
  const { series, totals, n, base } = buildSeries(mode === 'genre' ? genreMonths(state.months, genreOf) : state.months, B, mode === 'album' ? 'album' : 'artist');
  series.delete(''); // untagged artists' plays, kept only in the totals
  // month buckets trim the ramp at a one-month comeback; coarser buckets already read as gaps
  let eras = detectEras(series, totals, { share, lift, ramp, gap: quiet, minLen, floor: perMonth * B, trim: B === 1 });
  // album eras carry their own art; artist eras borrow the artist's biggest album inside the era,
  // genre eras show the biggest albums of the genre's top artists inside the era
  // album charts are always fetched, so they also drive the plays line: same shape in any mode
  const albumSeries = mode === 'album' ? { series, totals } : buildSeries(state.months, B, 'album');
  const albums = albumSeries.series;
  const sumIn = (c, e) => { let s = 0; for (let i = e.start; i <= e.end; i++) s += c[i]; return s; };
  const biggest = (map, e, ok) => {
    let best = 0, key;
    for (const [k, c] of map) {
      if (!ok(k)) continue;
      const sum = sumIn(c, e);
      if (sum > best) { best = sum; key = k; }
    }
    return key;
  };
  const albumOf = (artist, e) => { const k = biggest(albums, e, k => k.startsWith(artist + SEP)); return k && k.slice(artist.length + 1); };
  if (mode === 'genre') {
    // who played each era, biggest first. Eras one artist carries (≥85% of plays) only repeat
    // artist mode, so drop them. 80% was too eager: cloud rap 2021–22 was 80.3% Bladee but
    // Yung Lean, Ecco2K and Woesum were behind it, and it vanished from genre mode.
    // only months with artist charts, as genreMonths counts them (no estimate from album charts)
    const byGenre = groupBy(buildSeries(state.months.map(m => (m.artist ? m : { idx: m.idx })), B, 'artist').series, ([a]) => genreOf(a));
    eras = eras.map(e => ({
      ...e, artists: byGenre.get(e.key).map(([a, c]) => [a, sumIn(c, e)]).filter(([, p]) => p).sort((a, b) => b[1] - a[1]),
    })).filter(e => e.artists[0][1] < 0.85 * e.plays);
  }
  eras = eras.slice(0, MAX_ERAS);
  const all = totals.reduce((a, b) => a + b, 0);
  for (const e of eras) {
    e.share = e.plays / totals.slice(e.start, e.end + 1).reduce((a, b) => a + b, 0);
    if (mode === 'album') {
      [e.artist, e.album] = e.key.split(SEP);
      e.name = e.album; e.by = e.artist;
    } else if (mode === 'genre') {
      e.genre = true;
      e.name = e.key;
      e.artist = e.artists[0][0];
      e.by = e.artists.slice(0, 3).map(([a]) => a).join(', ') + (e.artists.length > 3 ? ` and\u00a0${e.artists.length - 3}\u00a0more` : '');
      // artists with no album chart in the era (only singles) have no cover: skip them, or their tile stays empty
      e.tiles = e.artists.slice(0, 8).map(([artist]) => { const album = albumOf(artist, e); return { artist, album, albumKey: artist + SEP + album }; })
        .filter(t => t.album).slice(0, 4);
      // how far above the genre's usual share the era ran; short histories have no usual share
      if (lift) e.lift = e.share / (series.get(e.key).reduce((a, b) => a + b, 0) / all);
    } else {
      e.name = e.artist = e.key;
      e.album = albumOf(e.artist, e);
      e.by = e.album ? `mostly ${e.album}` : '';
    }
    e.albumKey = e.artist + SEP + (e.album || '');
  }
  // a month whose album chart hasn't loaded (artist mode fetches it last, or the pull stopped) counts its artist chart
  const plays = mode !== 'album' && state.months.some(m => !m.album)
    ? buildSeries(state.months.map(m => (m.album ? m : { ...m, album: m.artist })), B, 'album').totals
    : albumSeries.totals;
  state.view = { B, n, base, totals, plays };
  state.eras = eras;
  // eras are rebuilt: find the selected one again, by start too, since a genre can have several eras
  const { key, start } = state.sel || {};
  if (state.sel && !eras.includes(state.sel)) state.sel = eras.find(e => e.key === key && e.start === start) || eras.find(e => e.key === key) || null;
  for (const e of eras) wantArt(e); // genre eras ask for their tiles' art only when shown
}

function wantArt(x) {
  if (!x.album || art.has(x.albumKey)) return;
  art.set(x.albumKey, 'pending');
  // counted: this job belongs to the batch the bar is showing. gen: the job predates a newer
  // load, so its late arrival must not move that load's bar.
  artQueue.push({ era: x, gen: artGen, counted: artBar });
  if (artBar) { artTotal++; artProgress(); }
  drainArt();
}

const artQueue = [];
let artWorkers = 0, artTotal = 0, artDone = 0, artBar = false, artGen = 0;

function artStop() { artGen++; artBar = false; artTotal = artDone = 0; }

// Only the batch that follows a load owns the bar: covers fetched later, when a genre era is
// shown, are one or two at a time and would make it flicker over the status line.
function artProgress() {
  if (!artBar || !artTotal) return;
  el.progress.hidden = false;
  el.progress.max = artTotal;
  el.progress.value = artDone;
  // keep the load summary visible and append the covers count; stop updating if an error
  // replaced it, so the error isn't overwritten by the next cover
  if (!state.summary) return;
  const ours = state.summary + ' · loading covers ';
  if (el.status.textContent === state.summary || el.status.textContent.startsWith(ours)) say(`${ours}${artDone} of ${artTotal}`);
}

function drainArt() {
  while (artWorkers < 3 && artQueue.length) {
    const job = artQueue.shift();
    artWorkers++;
    fetchArt(job.era).finally(() => {
      artWorkers--;
      if (artBar && job.counted && job.gen === artGen) {
        artDone++;
        if (!artQueue.length && !artWorkers) {
          artBar = false;
          artTotal = artDone = 0;
          el.progress.hidden = true;
          if (state.summary && el.status.textContent.startsWith(state.summary + ' · loading covers ')) say(state.summary);
        } else artProgress();
      }
      drainArt();
    });
  }
}

function colorOf(e) {
  if (e.genre) return genreColor(e.key);
  const a = art.get(e.albumKey);
  return (a && a.color) || hashColor(e.key);
}

// ── render ──
let pending = 0;
function schedule() {
  if (pending) return;
  pending = setTimeout(() => { pending = 0; compute(); render(); }, 120);
}

const monthLabel = idx => `${MONTHS[idx % 12]} ${Math.floor(idx / 12)}`;
function spanLabel(e, short) {
  const { B, base } = state.view;
  const a = (base + e.start) * B, b = (base + e.end) * B + B - 1;
  const fmt = i => (short ? `${MONTHS[i % 12]} ’${String(Math.floor(i / 12)).slice(2)}` : monthLabel(i));
  return a === b ? fmt(a) : `${fmt(a)} – ${fmt(b)}`;
}

function render() {
  const { eras, view } = state;
  if (!view) return;
  el.form.classList.add('loaded'); // view settings appear once there is something to view
  const LABEL = 22, BAND = 6, BARS = 46, AXIS = 48, LANE = LABEL + BAND + BARS, GAP = 14;
  const wrap = el.timeline.parentElement;
  const pad = getComputedStyle(wrap);
  // the right gutter is padding on .timeline, so it is part of the scrollable content
  const wrapW = wrap.clientWidth - parseFloat(pad.paddingLeft) - parseFloat(pad.paddingRight)
    - parseFloat(getComputedStyle(el.timeline).paddingRight);
  const minW = view.B === 1 ? 14 : 18, w = Math.min(120, Math.max(minW, wrapW / view.n));
  // labels sit above their slab and may run past it, so a lane reserves the label's width too,
  // sized at the narrowest bucket so lanes don't reshuffle when the window or zoom changes
  const labelOf = e => (e.name.length > 32 ? e.name.slice(0, 31) + '…' : e.name);
  const spans = eras.map(e => ({ e, start: e.start, end: Math.max(e.end, e.start + Math.ceil(labelWidth(labelOf(e)) / minW) - 1) }));
  // genre eras: one row per genre, so its comebacks line up and the rows read as taste shifting
  // (a comeback that starts under the previous era's label takes a second row)
  // ponytail: a comeback close behind its own label can collide with it; nudge labels if that shows up
  let nLanes;
  if (eras[0]?.genre) {
    const rows = [];
    for (const g of groupBy(spans, x => x.e.key).values()) {
      assignLanes(g);
      const sub = [];
      for (const x of g) (sub[x.lane] ||= []).push(x);
      for (const r of sub) rows.push({ g: r, start: Math.min(...r.map(x => x.start)), end: Math.max(...r.map(x => x.end)) });
    }
    nLanes = assignLanes(rows);
    for (const r of rows) for (const x of r.g) x.e.lane = r.lane;
  } else {
    nLanes = assignLanes(spans);
    for (const x of spans) x.e.lane = x.lane;
  }
  const W = Math.ceil(w * view.n), H = AXIS + Math.max(1, nLanes) * (LANE + GAP);
  const max = Math.max(1, ...eras.flatMap(e => e.counts));
  const esc = s => s.replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`);

  let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="group" aria-label="Eras timeline">`;
  // plays per month as a tint block behind the year numbers: a quiet stretch reads flat,
  // a busy one with no eras reads as listening that was spread out
  const base = AXIS - 8, top = Math.max(1, ...view.plays);
  let d = `M0 ${base}`;
  view.plays.forEach((t, b) => { d += `V${base - (t ? Math.max(1, (t / top) * 34) : 0)}H${(b + 1) * w}`; });
  svg += `<path class="vol" d="${d}V${base}Z"/><line class="tick year-line" x1="0" x2="${W}" y1="${base}" y2="${base}"/>`;
  svg += `<text class="vol-cap" x="6" y="12">Plays per ${{ 1: 'month', 2: '2 months', 3: 'quarter', 6: 'half year' }[view.B]}</text>`;
  const bucketLabel = b => { const i = (view.base + b) * view.B; return view.B === 1 ? monthLabel(i) : `${monthLabel(i)} – ${monthLabel(i + view.B - 1)}`; };
  view.plays.forEach((t, b) => { svg += `<rect x="${b * w}" y="${base - 34}" width="${w}" height="34" fill="transparent"><title>${bucketLabel(b)} · ${t.toLocaleString()} plays</title></rect>`; });
  for (let b = 0; b < view.n; b++) {
    const start = (view.base + b) * view.B;
    if (start % 12 < view.B) {
      const x = b * w;
      svg += `<line class="tick year-line" x1="${x}" x2="${x}" y1="${base}" y2="${H}"/>`;
      svg += `<text class="year" x="${x + 6}" y="${AXIS - 14}">${Math.floor((start + view.B - 1) / 12)}</text>`;
    }
  }
  eras.forEach((e, i) => {
    const color = colorOf(e);
    const x = e.start * w, y = AXIS + e.lane * (LANE + GAP), ww = (e.end - e.start + 1) * w;
    const label = labelOf(e), lang = langOf(label);
    svg += `<g class="slab${e === state.sel ? ' sel' : ''}" data-i="${i}" tabindex="0" role="button"
      aria-label="${esc(`${e.name}${e.genre ? '' : e.artist !== e.name ? ' by ' + e.artist : ''}, ${spanLabel(e)}, ${e.plays.toLocaleString()} plays`)}">
      <rect class="hit" x="${x}" y="${y}" width="${Math.max(ww, labelWidth(label))}" height="${LANE}" fill="transparent"/>
      <text class="label" x="${x}" y="${y + 16}"${lang ? ` lang="${lang}"` : ''}>${esc(label)}</text>
      <rect class="wash" x="${x}" y="${y + LABEL}" width="${ww}" height="${BAND + BARS}" fill="${color}"/>
      <rect class="band" x="${x}" y="${y + LABEL}" width="${ww}" height="${BAND}" fill="${color}"/>`;
    e.counts.forEach((c, k) => {
      const bh = Math.max(1, (c / max) * (BARS - 4));
      svg += `<rect x="${x + k * w + 1}" y="${y + LANE - bh}" width="${Math.max(1, w - 2)}" height="${bh}" fill="${color}"/>`;
    });
    svg += '</g>';
  });
  svg += '</svg>';
  el.timeline.innerHTML = svg;
  el.timeline.classList.toggle('dim', !!state.sel);

  // era index, chronological
  el.side.hidden = !eras.length;
  el.list.innerHTML = [...eras].sort((a, b) => a.start - b.start || b.plays - a.plays).map(e => `
    <li><button type="button" data-i="${eras.indexOf(e)}" aria-pressed="${e === state.sel}">
      <span class="sw" style="background:${colorOf(e)}"></span>
      <span class="when">${spanLabel(e, true)}</span>
      <span class="n">${esc(e.name)} <small>${esc(e.by)}</small></span>
      <span class="p">${e.plays.toLocaleString()}</span>
    </button></li>`).join('');

  if (!eras.length && el.progress.hidden && !el.status.classList.contains('error')) say(`No eras at this setting. Open Adjust and drag toward ${$('#sens-lo').textContent}.`);
  // a redraw (e.g. art arriving) keeps the hovered era in the header; eras are rebuilt, so match by key and start
  const h = hovered && eras.find(x => x.key === hovered.key && x.start === hovered.start);
  show(h || state.sel || eras[0]);
}

// Tag scripts whose uppercase depends on language: Greek drops its accents only when tagged Greek (else ΒΑΣ΄ΙΛΗΣ),
// and Georgian is left lowercase (style.css), since its capitals (Mtavruli) read as garbled in names
const langOf = s => /\p{Script=Greek}/u.test(s) ? 'el' : /\p{Script=Georgian}/u.test(s) ? 'ka' : '';
const setLang = (node, s, l = langOf(s)) => (l ? node.setAttribute('lang', l) : node.removeAttribute('lang'));

// A label's width plus a gap, measured in a hidden copy of the label style: per-character guesses
// miss fallback fonts (CJK runs about twice as wide as League Gothic caps) and labels collide
const widths = new Map();
let ruler;
function labelWidth(s) {
  if (!widths.has(s)) {
    if (!ruler) {
      document.body.insertAdjacentHTML('beforeend', '<svg aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden"><g class="slab"><text class="label"></text></g></svg>');
      ruler = document.body.lastElementChild.querySelector('text');
    }
    ruler.textContent = s;
    setLang(ruler, s);
    widths.set(s, ruler.getComputedTextLength() + 10);
  }
  return widths.get(s);
}
// widths taken before a font loaded are off. Google Fonts loads each alphabet (Cyrillic, CJK…) only
// when it first shows up, so re-measure after every font load, not just the first
document.fonts.addEventListener('loadingdone', () => { widths.clear(); schedule(); });

let shown = null, hovered = null;
function show(e) {
  el.jacket.classList.toggle('empty', !e);
  if (!e) return;
  const color = colorOf(e), a = art.get(e.albumKey);
  el.jacket.style.setProperty('--era', color);
  el.jacket.style.setProperty('--era-ink', inkFor(color));
  document.documentElement.style.setProperty('--era', color);
  document.documentElement.style.setProperty('--era-ink', inkFor(color));
  const mosaics = [...el.frame.querySelectorAll('.mosaic')];
  const imgs = [...el.frame.querySelectorAll(':scope > img')];
  const top = imgs[imgs.length - 1], url = a && a.url;
  if (e.genre) {
    // a genre era is about the genre, not one artist: show its top artists' covers, up to four.
    // The grid is laid out for every tile up front and each cover fades into its own tile as it
    // arrives, so the tiles never reshuffle. A new era's covers fade in as the old ones fade out, as
    // single covers do: stacked multiply-blended covers darken (and fading the grid breaks the blend)
    imgs.forEach(i => i.remove());
    e.tiles.forEach(wantArt);
    const key = e.tiles.map(t => t.albumKey).join('\n');
    let m = mosaics[mosaics.length - 1];
    if (m?.dataset.key !== key) {
      mosaics.slice(0, -1).forEach(x => x.remove()); // only ever stack two sets of covers
      const old = m;
      m = Object.assign(document.createElement('div'), { className: 'mosaic' });
      m.dataset.key = key;
      m.append(...e.tiles.map(() => Object.assign(new Image(), { alt: '' })));
      el.frame.append(m);
      const ready = e.tiles.map((t, i) => fillTile(m.children[i], art.get(t.albumKey)?.url));
      if (old) Promise.all(ready).then(() => {
        old.querySelectorAll('img').forEach(i => i.classList.remove('on'));
        setTimeout(() => old.remove(), 500);
      });
    } else e.tiles.forEach((t, i) => fillTile(m.children[i], art.get(t.albumKey)?.url));
  } else {
    mosaics.forEach(x => x.remove());
    if (!url) imgs.forEach(i => i.remove());
    else if (!top || top.dataset.src !== url) {
      // covers are multiply-blended, so stacked copies darken: only ever crossfade two
      imgs.slice(0, -1).forEach(i => i.remove());
      const next = new Image();
      next.alt = '';
      next.dataset.src = url;
      next.onload = () => {
        if (!next.isConnected) return;
        next.classList.add('on');
        top?.classList.remove('on');
        setTimeout(() => { if (next.isConnected) next.previousElementSibling?.remove(); }, 500);
      };
      next.src = url;
      el.frame.append(next);
    }
  }
  if (shown === e) return;
  shown = e;
  el.title.textContent = e.name;
  setLang(el.title, e.name);
  el.title.classList.toggle('long', e.name.length > 22);
  el.sub.textContent = !e.genre && e.artist !== e.name ? e.artist : e.by;
  el.facts.hidden = false;
  $('#f-ran').textContent = spanLabel(e);
  $('#f-plays').textContent = e.plays.toLocaleString();
  const pk = (state.view.base + e.peakAt) * state.view.B;
  $('#f-peak').textContent = `${state.view.B === 1 ? monthLabel(pk) : spanLabel({ start: e.peakAt, end: e.peakAt }, true)} · ${e.peak.toLocaleString()}`;
  // genre eras are built on lift, and a 7% share would read as a failure in a header about dominance
  $('#f-share-name').textContent = e.lift ? 'Vs. your usual' : 'Share of those months';
  $('#f-share').textContent = e.lift ? `${e.lift < 10 ? e.lift.toFixed(1) : Math.round(e.lift)}×` : `${Math.round(e.share * 100)}%`;
}

// set a mosaic tile's cover once and fade it in when decoded, so a cached cover doesn't flash blank
function fillTile(img, url) {
  if (!url || img.dataset.src) return;
  img.dataset.src = img.src = url;
  return img.decode().catch(() => {}).then(() => img.classList.add('on'));
}

function errorText(e, user) {
  const kept = state.months.some(m => m.album || m.artist) ? ' What loaded so far is saved, so pulling again picks up where it stopped.' : '';
  switch (e.code) {
    case 6: return `No Last.fm user called “${user}”. Check the spelling.`;
    case 17: return `${user} keeps their listening private on Last.fm.`;
    case 29: return `Last.fm is rate-limiting requests right now, either from your connection or for this site. Wait a few minutes, then pull again.${kept}`;
    case 26: return 'This site’s Last.fm API key has been suspended by Last.fm. It isn’t anything on your end; check back later.';
    case 10: return 'This site’s Last.fm API key isn’t valid. It isn’t anything on your end; check back later.';
    case 8: case 11: case 16: return `Last.fm is having trouble right now. Try again in a few minutes.${kept}`;
  }
  return e instanceof ApiError ? `Last.fm said: ${e.message}${kept}` : `Couldn’t reach Last.fm. Check your connection, or Last.fm may be rate-limiting; wait a few minutes and pull again.${kept}`;
}

function say(msg, kind) { // kind: 'warn' | 'error' | falsy
  el.status.textContent = msg;
  el.status.className = 'status' + (kind ? ' ' + kind : '');
}

// ── wiring ──
const eraAt = t => { const n = t.closest('[data-i]'); return n ? state.eras[+n.dataset.i] : null; };
for (const root of [el.timeline, el.list]) {
  root.addEventListener('pointerover', ev => { const e = eraAt(ev.target); if (e) show(hovered = e); });
  root.addEventListener('focusin', ev => { const e = eraAt(ev.target); if (e) show(hovered = e); });
  root.addEventListener('focusout', () => { hovered = null; });
  root.addEventListener('pointerleave', () => { hovered = null; show(state.sel || state.eras[0]); });
  root.addEventListener('click', ev => select(eraAt(ev.target)));
  root.addEventListener('keydown', ev => { if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.matches('.slab')) { ev.preventDefault(); select(eraAt(ev.target)); } });
}
function select(e) {
  if (!e) return;
  state.sel = state.sel === e ? null : e;
  shown = null;
  render();
  if (state.sel) {
    centerOn(e, 'smooth');
  }
}

function centerOn(e, behavior) {
  const g = e && el.timeline.querySelector(`.slab[data-i="${state.eras.indexOf(e)}"]`);
  if (!g) return;
  const wrap = el.timeline.parentElement, b = g.getBBox();
  wrap.scrollTo({ left: b.x + b.width / 2 - wrap.clientWidth / 2, behavior });
}

function syncURL() {
  // a Spotify view has no Last.fm user to put in the URL, so the link just keeps the view settings
  const p = new URLSearchParams({ mode: el.form.mode.value, b: el.bucket.value, s: el.sens.value });
  const user = el.user.value.trim();
  if (user) p.set('user', user);
  history.replaceState(null, '', '?' + p);
}

const sensWords = ['', 'loosest', 'looser', 'loose', 'relaxed', 'balanced', 'firm', 'strict', 'stricter', 'strictest'];
// in genre mode the slider mostly sets how long an era must run, so it says that
function showSens() {
  const genre = el.form.mode.value === 'genre';
  const v = genre ? `≥ ${settings().minLen * +el.bucket.value} months` : sensWords[el.sens.value];
  el.sensOut.textContent = v;
  el.sens.setAttribute('aria-valuetext', v);
  $('#sens-name').textContent = genre ? 'Era length' : 'Sensitivity';
  $('#sens-lo').textContent = genre ? 'Short bursts' : 'More eras';
  $('#sens-hi').textContent = genre ? 'Long phases' : 'Fewer eras';
}
function controlsChanged() {
  showSens();
  if (state.user) { syncURL(); schedule(); }
}
el.form.addEventListener('input', ev => {
  if (ev.target === el.user) return;
  controlsChanged();
  // artist and genre eras need artist charts (genres also need tags): re-run the load;
  // cached months and tags return instantly, only the gap is fetched
  const want = ev.target.name === 'mode' && ev.target.value;
  if ((want === 'artist' || want === 'genre') && state.months.some(m => !m.artist)) el.form.requestSubmit();
  else if (want === 'genre' && state.tagsUser !== state.user) el.form.requestSubmit();
});
window.addEventListener('resize', () => schedule());

const adjustBtn = $('#adjust .toggle');
adjustBtn.addEventListener('click', () => adjustBtn.setAttribute('aria-expanded', adjustBtn.getAttribute('aria-expanded') !== 'true'));

let submits = 0;
el.form.addEventListener('submit', async ev => {
  ev.preventDefault();
  const user = el.user.value.trim();
  syncURL();
  // an uploaded Spotify export is already in memory: controls only need a redraw, and genre
  // mode may still need its Last.fm tags
  if (state.source === 'spotify' && !user) {
    if (el.form.mode.value === 'genre' && state.tagsUser !== state.user) {
      const mine = ++submits, run = ++state.run;
      el.go.disabled = true;
      try {
        await loadTags(run);
        if (run === state.run) finishLoad();
      } catch {
        if (run === state.run) {
          el.progress.hidden = true;
          say('Last.fm wouldn’t give genre tags right now. Try Genres again in a few minutes.', 'error');
        }
      } finally {
        if (mine === submits) el.go.disabled = false;
      }
      return;
    }
    finishLoad();
    return;
  }
  if (!user) return say('Enter a Last.fm username, or upload a Spotify export.', 'warn');
  if (!window.LASTFM_KEY) return say('No Last.fm API key configured (src/config.js).', 'error');
  gtag('event', 'pull_history', { mode: el.form.mode.value }); // no username: GA forbids personal info
  const mine = ++submits;
  el.go.disabled = true;
  el.go.textContent = 'Finding…';
  el.form.setAttribute('aria-busy', 'true');
  say(`Looking up ${user}…`);
  try {
    await load(user);
  } catch (e) {
    state.run++; // stop the other workers; what loaded stays on screen and in the cache
    el.progress.hidden = true;
    say(errorText(e, user), 'error');
  } finally {
    if (mine !== submits) return; // a newer submit (e.g. switching to Artists) owns the busy state now
    el.go.disabled = false;
    el.go.textContent = 'Find eras';
    el.form.removeAttribute('aria-busy');
  }
});

// Spotify export: a local file, parsed in the page, never uploaded
el.spotify.addEventListener('click', () => el.spotifyFile.click());
el.spotifyFile.addEventListener('change', async () => {
  const file = el.spotifyFile.files?.[0];
  el.spotifyFile.value = ''; // picking the same file again should still fire
  if (!file) return;
  const mine = ++submits;
  el.go.disabled = true;
  el.go.textContent = 'Reading…';
  el.form.setAttribute('aria-busy', 'true');
  try {
    await loadSpotify(file);
  } catch (e) {
    state.run++;
    el.progress.hidden = true;
    say(e.message || 'Couldn’t read that ZIP.', 'error');
  } finally {
    if (mine === submits) {
      el.go.disabled = false;
      el.go.textContent = 'Find eras';
      el.form.removeAttribute('aria-busy');
    }
  }
});

// boot from URL
const q = new URLSearchParams(location.search);
if (['artist', 'genre'].includes(q.get('mode'))) el.form.mode.value = q.get('mode');
if (q.get('b')) el.bucket.value = q.get('b');
if (q.get('s')) el.sens.value = q.get('s');
showSens();
el.jacket.classList.add('empty');
if (q.get('user')) { el.user.value = q.get('user'); el.form.requestSubmit(); }
