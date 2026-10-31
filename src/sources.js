// Source adapters that are pure: no DOM, no network. Loaded by the page and by test.js.
// The Last.fm history span and the Spotify export parse live here so the page and the tests
// run the same code. `historySpan` takes the API caller as an argument for the same reason.

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
async function historySpan(info, call) {
  const now = Date.now() / 1000;
  const span = { first: +info.registered.unixtime, last: now };
  const total = +info.playcount;
  if (!(total > 0)) return span;
  try {
    // a now-playing track has no date, so ask for two and keep the newest dated one
    const dated = async params => [].concat((await call('user.getrecenttracks', { user: info.name, ...params })).recenttracks?.track || [])
      .filter(t => t?.date?.uts);
    const [oldest, newest] = await Promise.all([dated({ limit: 1, page: total }), dated({ limit: 2 })]);
    if (oldest[0]) span.first = +oldest[0].date.uts;
    if (newest[0]) span.last = +newest[0].date.uts;
  } catch { /* keep registered → now: a failed probe must not abort the pull */ }
  const first = Math.min(span.first, now);
  return { first, last: Math.min(Math.max(span.last, first), now) }; // clock skew can't invert the span
}

// ── Spotify extended streaming history ──
// The export is a ZIP of JSON files, one row per stream. It is read in the page:
// nothing is uploaded anywhere. A stream counts as a play at 30 seconds, close to Last.fm's
// rule, and podcasts, audiobooks and videos are ignored so only songs shape the eras.
const PLAY_MS = 30000;
const ALBUM_SEP = '\u001f'; // internal only: keeps album keys out of the page's artist/album shapes

// one stream row → the key that says "this is the same play". Multi-device playback can log
// the same stream twice: identical timestamp, track and played length are one play. The key
// keeps the track name and artist as well as the URI, because a URI can be missing or (in
// malformed exports) shared by unrelated tracks.
function streamKey(r) {
  return [r.ts, r.spotify_track_uri || '', +r.ms_played,
    r.master_metadata_track_name, r.master_metadata_album_artist_name].join('\u001f');
}

// one stream row → its month's artist and album tallies; false when it isn't a song play.
// `seen` is the caller's per-file set, or null to count every row.
function addSpotifyRow(r, acc, seen) {
  // songs only: podcasts, audiobooks and videos carry episode/audiobook fields
  if (!r?.master_metadata_track_name || !r.master_metadata_album_artist_name) return false;
  if (r.episode_name || r.episode_show_name || r.spotify_episode_uri || r.audiobook_title || r.audiobook_chapter_title) return false;
  if (!(+r.ms_played >= PLAY_MS)) return false;
  const t = Date.parse(r.ts);
  if (Number.isNaN(t)) return false;
  if (seen) {
    const key = streamKey(r);
    if (seen.has(key)) return false;
    seen.add(key);
  }
  const d = new Date(t), idx = d.getUTCFullYear() * 12 + d.getUTCMonth();
  let m = acc.months.get(idx);
  if (!m) acc.months.set(idx, m = { a: new Map(), b: new Map() });
  const artist = r.master_metadata_album_artist_name;
  m.a.set(artist, (m.a.get(artist) || 0) + 1);
  const album = r.master_metadata_album_album_name;
  if (album) m.b.set(artist + ALBUM_SEP + album, (m.b.get(artist + ALBUM_SEP + album) || 0) + 1);
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
  const first = Math.min(acc.first, now); // a clock-skewed row shouldn't blank the timeline
  const last = Math.min(Math.max(acc.last, first), now); // ...or run it into the future
  return monthsBetween(first, last).map(mo => {
    const m = acc.months.get(mo.idx);
    if (!m) { mo.artist = []; mo.album = []; return mo; }
    mo.artist = [...m.a].filter(([, p]) => p >= 2).sort((x, y) => y[1] - x[1]).slice(0, 150).map(([a, p]) => ['', a, p]);
    mo.album = [...m.b].filter(([, p]) => p >= 2).sort((x, y) => y[1] - x[1]).slice(0, 150)
      .map(([k, p]) => { const i = k.indexOf(ALBUM_SEP); return [k.slice(i + 1), k.slice(0, i), p]; });
    return mo;
  });
}

if (typeof module !== 'undefined') module.exports = { monthsBetween, historySpan, PLAY_MS, streamKey, addSpotifyRow, spotifyMonths };
