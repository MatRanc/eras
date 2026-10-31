// node test.js
const assert = require('assert');
const { SEP, buildSeries, detectEras, assignLanes, genreMonths, albumCore, mergeAlbums, dropSingleArtist } = require('./src/eras.js');
const { monthsBetween, historySpan, streamKey, addSpotifyRow, spotifyMonths } = require('./src/sources.js');

// The Life of Pablo shape: big Oct–Jan, dip to 50 Mar–May, back up Jun–Jul, then gone.
const pablo = [0, 0, 100, 110, 120, 100, 4, 50, 50, 50, 100, 100, 0, 0];
const months = pablo.map((p, i) => ({
  idx: 2015 * 12 + 7 + i, // Aug 2015 onward
  album: [['The Life of Pablo', 'Kanye West', p], ['Filler', 'Someone', 200]],
  artist: [['', 'Kanye West', p + 30], ['', 'Someone', 200]],
}));

const { series, totals } = buildSeries(months, 1, 'album');
const eras = detectEras(series, totals, { share: 0.06, floor: 12 });
const tlop = eras.filter(e => e.key === 'Kanye West' + SEP + 'The Life of Pablo');
assert.strictEqual(tlop.length, 1, 'one-month dip should not split the era');
assert.deepStrictEqual([tlop[0].start, tlop[0].end], [2, 11]);
assert.strictEqual(tlop[0].peak, 120);

// Quarters: buckets are calendar aligned (Aug–Sep 2015 is the tail of Q3).
assert.strictEqual(buildSeries(months, 3, 'album').n, 5);

// Artist mode reads the artist charts.
assert.strictEqual(buildSeries(months, 1, 'artist').series.get('Kanye West')[4], 150);

// Quick pull: no artist charts, so artist mode falls back to summing albums.
const quick = months.map(({ idx, album }) => ({ idx, album }));
assert.strictEqual(buildSeries(quick, 1, 'artist').series.get('Kanye West')[4], 120);

// Overlaps go to separate lanes; gaps reuse a lane.
const ls = [{ start: 0, end: 5 }, { start: 3, end: 8 }, { start: 7, end: 9 }];
assert.strictEqual(assignLanes(ls), 2);
assert.deepStrictEqual(ls.map(e => e.lane), [0, 1, 0]);

// Genres: a steady genre is no era; one running at 2× its usual share is.
const steady = [50, 50, 50, 50, 50, 50, 50, 50, 50, 50];
const burst = [2, 2, 2, 2, 60, 70, 60, 2, 2, 2];
const gm = genreMonths(steady.map((p, i) => ({
  idx: 2020 * 12 + i,
  artist: [['', 'A', p], ['', 'B', burst[i]], ['', 'Untagged', 40]],
})), a => ({ A: 'rock', B: 'shoegaze' })[a] || '');
const g = buildSeries(gm, 1, 'artist');
assert.strictEqual(g.totals[0], 92, 'untagged plays still count toward the total');
g.series.delete('');
const ge = detectEras(g.series, g.totals, { share: 0.05, floor: 10, lift: 2, ramp: false });
assert.deepStrictEqual(ge.map(e => [e.key, e.start, e.end]), [['shoegaze', 4, 6]]);

// gap: a run rides out that many quiet buckets; minLen: shorter eras are dropped
const dips = new Map([['x', [20, 0, 0, 20, 20, 0, 0, 0, 20, 0]]]), flat = new Array(10).fill(100);
assert.deepStrictEqual(detectEras(dips, flat, { share: 0.1, floor: 10, lift: 1, ramp: false, gap: 2 }).map(e => [e.start, e.end]), [[0, 4]]);
assert.deepStrictEqual(detectEras(dips, flat, { share: 0.1, floor: 10, lift: 1, ramp: false, gap: 2, minLen: 6 }), []);

// trim: a one-bucket comeback stays two eras, and the ramp facing the gap is cut to the hot
// run (here the second run's ramp head at 4 goes, leaving months 3-4 empty)
const flat7 = new Array(7).fill(100), comebackOpts = { share: 0.1, floor: 10, ramp: true, trim: true };
const comeback = detectEras(new Map([['x', [20, 20, 20, 0, 6, 20, 20]]]), flat7, comebackOpts);
assert.deepStrictEqual(comeback.map(e => [e.start, e.end]).sort((a, b) => a[0] - b[0]), [[0, 2], [5, 6]]);

// both sides trim: the first run's ramp tail and the second's ramp head go, widening the gap
const both = detectEras(new Map([['x', [20, 20, 20, 6, 0, 7, 20, 20]]]), new Array(8).fill(100), comebackOpts);
assert.deepStrictEqual(both.map(e => [e.start, e.end]).sort((a, b) => a[0] - b[0]), [[0, 2], [6, 7]]);
assert.deepStrictEqual(both.map(e => e.plays).sort((a, b) => a - b), [40, 60], 'trimmed plays are recomputed');

// a cut that would drop the era below minLen is skipped, so the ramp stays
const keep = detectEras(new Map([['x', [20, 20, 6, 0, 7, 20, 20]]]), flat7, { ...comebackOpts, minLen: 3 });
assert.deepStrictEqual(keep.map(e => [e.start, e.end]).sort((a, b) => a[0] - b[0]), [[0, 2], [4, 6]]);

// two buckets apart is untouched: no trim, no merge
const distant = detectEras(new Map([['x', [20, 20, 20, 0, 0, 20, 20]]]), flat7, comebackOpts);
assert.deepStrictEqual(distant.map(e => [e.start, e.end]).sort((a, b) => a[0] - b[0]), [[0, 2], [5, 6]]);

// without trim (coarser buckets) the ramp stays, so the same comeback keeps its ramp head
const coarse = detectEras(new Map([['x', [20, 20, 20, 0, 6, 20, 20]]]), flat7, { ...comebackOpts, trim: false });
assert.deepStrictEqual(coarse.map(e => [e.start, e.end]).sort((a, b) => a[0] - b[0]), [[0, 2], [4, 6]]);

// a chain of close comebacks trims each run where it faces a gap
const chain = detectEras(new Map([['x', [20, 20, 6, 0, 7, 20, 20, 6, 0, 7, 20, 20]]]), new Array(12).fill(100), comebackOpts);
assert.deepStrictEqual(chain.map(e => [e.start, e.end]).sort((a, b) => a[0] - b[0]), [[0, 1], [5, 6], [10, 11]]);

// The bar stops 10 points over the usual share: a genre at 75% overall can still run at 90%+.
const main = new Map([['k-pop', [70, 70, 95, 95, 95, 70, 70, 70]]]), hundred = new Array(8).fill(100);
assert.deepStrictEqual(detectEras(main, hundred, { share: 0.05, floor: 4, lift: 1.4, ramp: false }).map(e => [e.start, e.end]), [[2, 4]]);
// lift 0 (short histories): the plain share bar, still without the ramp
assert.deepStrictEqual(detectEras(main, hundred, { share: 0.05, floor: 4, lift: 0, ramp: false }).map(e => [e.start, e.end]), [[0, 7]]);

// Albums: edition markers are stripped so one record is not split between several entries.
assert.strictEqual(albumCore('Donda (Deluxe)'), 'donda');
assert.strictEqual(albumCore('DONDA (Deluxe Edition) [Explicit]'), 'donda');
assert.strictEqual(albumCore('Selected Ambient Works Volume II (Expanded Edition)'), 'selected ambient works volume ii');
assert.strictEqual(albumCore('Album – 2011 Remaster'), 'album');
assert.strictEqual(albumCore('Album (Collector’s Edition)'), 'album');
assert.strictEqual(albumCore('Album (Bonus Track Version)'), 'album');
// releases that are genuinely different records keep their suffix
assert.strictEqual(albumCore('Love Deluxe'), 'love deluxe');
assert.strictEqual(albumCore('Album (Live)'), 'album (live)');
assert.strictEqual(albumCore('Album (Original Motion Picture Soundtrack)'), 'album (original motion picture soundtrack)');
assert.strictEqual(albumCore('Album - EP'), 'album - ep');
assert.strictEqual(albumCore("Album (Taylor's Version)"), "album (taylor's version)");

// Editions merge, plain and live do not; the plain title wins even when the deluxe played more.
const editions = new Map([
  ['Kanye West' + SEP + 'Donda', [30, 20, 0]],
  ['Kanye West' + SEP + 'Donda (Deluxe)', [0, 25, 10]],
  ['Kanye West' + SEP + 'Donda (Live)', [5, 0, 0]],
]);
const mergedEditions = mergeAlbums(editions);
assert.deepStrictEqual([...mergedEditions.keys()], ['Kanye West' + SEP + 'Donda', 'Kanye West' + SEP + 'Donda (Live)']);
assert.deepStrictEqual(mergedEditions.get('Kanye West' + SEP + 'Donda'), [30, 45, 10]);
const deluxeHeavy = new Map([['A' + SEP + 'Album', [1, 0]], ['A' + SEP + 'Album (Deluxe)', [0, 10]]]);
assert.deepStrictEqual([...mergeAlbums(deluxeHeavy).keys()], ['A' + SEP + 'Album']);
// spelling-only differences merge too
const cases = new Map([['A' + SEP + 'Album', [1, 0]], ['A' + SEP + 'ALBUM', [0, 2]]]);
assert.deepStrictEqual([...mergeAlbums(cases).values()], [[1, 2]]);

// Two editions each under the floor still form one era once summed (the NAV shape).
const fillers = Array.from({ length: 11 }, (_, i) => ['Filler ' + i, 'Other', 8]);
const split = [0, 1, 2].map(i => ({
  idx: 2026 * 12 + i,
  album: [['OMW2 REXDALE', 'NAV', 6], ['OMW2 REXDALE (DELUXE)', 'NAV', 6], ...fillers],
}));
const splitSeries = buildSeries(split, 1, 'album');
const splitOpts = { share: 0.1, floor: 10, ramp: false };
assert.strictEqual(detectEras(splitSeries.series, splitSeries.totals, splitOpts).length, 0, 'each edition alone stays under the floor');
const navEras = detectEras(mergeAlbums(splitSeries.series), splitSeries.totals, splitOpts);
assert.deepStrictEqual(navEras.map(e => [e.key, e.start, e.end, e.plays]), [['NAV' + SEP + 'OMW2 REXDALE', 0, 2, 36]]);

// Genre mode drops an era one artist owns: an artist at 85% or more of an era's plays is
// artist mode again, one at 80% still has a second artist behind it.
const genreEras = [
  { plays: 100, artists: [['A', 80], ['B', 20]] },
  { plays: 100, artists: [['A', 90], ['B', 10]] },
  { plays: 100, artists: [['A', 85]] },
];
assert.deepStrictEqual(dropSingleArtist(genreEras).map(e => e.artists[0][1]), [80]);

// Months: inclusive UTC calendar months in the shape the charts are keyed by.
const span = monthsBetween(Date.UTC(2023, 11, 31) / 1000, Date.UTC(2024, 1, 1) / 1000);
assert.deepStrictEqual(span.map(m => [m.y, m.m]), [[2023, 11], [2024, 0], [2024, 1]]);
assert.deepStrictEqual(span.map(m => m.idx), [2023 * 12 + 11, 2024 * 12, 2024 * 12 + 1]);
assert.strictEqual(span[0].from, Date.UTC(2023, 11, 1) / 1000);
assert.strictEqual(monthsBetween(Date.UTC(2024, 4, 9) / 1000, Date.UTC(2024, 4, 20) / 1000).length, 1);

// Spotify rows: a play is a song stream of 30s or more; podcasts, audiobooks and broken rows
// are ignored. A skipped 42s stream still counts: without a track duration, 30s is the rule.
const play = (o = {}) => ({
  ts: '2024-01-01T12:00:00Z', username: 'spot', platform: 'iOS', ms_played: 200000,
  master_metadata_track_name: 'A', master_metadata_album_artist_name: 'X',
  master_metadata_album_album_name: 'XA', spotify_track_uri: 'spotify:track:a', ...o,
});
const tally = rows => {
  const acc = { months: new Map(), plays: 0, user: '', first: Infinity, last: 0 };
  const seen = new Set();
  for (const r of rows) addSpotifyRow(r, acc, seen);
  return acc;
};
assert.strictEqual(tally([play({ ms_played: 29999 })]).plays, 0);
assert.strictEqual(tally([play({ ms_played: 30000 })]).plays, 1);
assert.strictEqual(tally([play({ skipped: true, ms_played: 42000 })]).plays, 1);
assert.strictEqual(tally([play({ episode_name: 'Ep 1' })]).plays, 0);
assert.strictEqual(tally([play({ audiobook_title: 'Book' })]).plays, 0);
assert.strictEqual(tally([play({ master_metadata_track_name: null })]).plays, 0);
assert.strictEqual(tally([play({ ts: 'not a date' })]).plays, 0);

// A single with no album counts toward the artist, not the album chart.
const single = tally([play({ master_metadata_album_album_name: null })]);
assert.strictEqual(single.plays, 1);
assert.deepStrictEqual([...single.months.get(2024 * 12).a], [['X', 1]]);
assert.strictEqual(single.months.get(2024 * 12).b.size, 0);
assert.strictEqual(single.user, 'spot');

// The same stream logged twice counts once; a different track, artist or length is a real
// second play. Malformed exports share one fake URI, so the track keeps those rows apart.
assert.strictEqual(tally([play(), play()]).plays, 1);
assert.strictEqual(tally([play(), play({ master_metadata_track_name: 'B' })]).plays, 2);
assert.strictEqual(tally([play(), play({ master_metadata_album_artist_name: 'Y' })]).plays, 2);
assert.strictEqual(tally([play(), play({ ms_played: 210000 })]).plays, 2);
assert.strictEqual(tally([play(), play({ master_metadata_track_name: 'B' }), play({ master_metadata_track_name: 'C' })]).plays, 3);
assert.strictEqual(streamKey(play()), streamKey(play()));
assert.notStrictEqual(streamKey(play()), streamKey(play({ ms_played: 210000 })));

// An export spans its own first and last play, not today.
const old = tally([
  play({ ts: '2019-01-05T12:00:00Z' }),
  play({ ts: '2019-03-05T12:00:00Z', master_metadata_track_name: 'B' }),
  play({ ts: '2019-12-31T23:00:00Z', master_metadata_track_name: 'C' }),
]);
const oldMonths = spotifyMonths(old);
assert.strictEqual(oldMonths.length, 12);
assert.deepStrictEqual([oldMonths[0].idx, oldMonths[11].idx], [2019 * 12, 2019 * 12 + 11]);
// artists need two plays to chart; albums come back as [album, artist, plays]
const two = tally([play(), play({ ts: '2024-01-02T12:00:00Z' })]);
const twoMonths = spotifyMonths(two);
assert.deepStrictEqual(twoMonths[0].artist, [['', 'X', 2]]);
assert.deepStrictEqual(twoMonths[0].album, [['XA', 'X', 2]]);
// a row in the future can't run the timeline past this month
const future = spotifyMonths(tally([play({ ts: '2999-01-01T00:00:00Z' })]));
const nowDate = new Date();
assert.deepStrictEqual([future.length, future[0].y, future[0].m], [1, nowDate.getUTCFullYear(), nowDate.getUTCMonth()]);

// Last.fm history span: the last recent-tracks page holds the first scrobble and page 1 the
// last one. An undated now-playing row is skipped, and a failed probe keeps its fallback.
const dated = uts => ({ recenttracks: { track: [{ date: { uts: String(uts) } }] } });
const listener = { name: 'listener', playcount: '7', registered: { unixtime: '1000' } };
const newer = { recenttracks: { track: [{ name: 'Now playing' }, { date: { uts: '1900' } }] } };
const asked = [];
(async () => {
  const call = async (method, p) => {
    asked.push([method, p.user, p.limit, p.page]);
    return p.limit === 1 ? dated(1500) : newer;
  };
  assert.deepStrictEqual(await historySpan(listener, call).then(s => [s.first, s.last]), [1500, 1900]);
  const pages = asked.map(([, u, limit, page]) => [u, limit, page ?? 1]).sort((a, b) => b[2] - a[2]);
  assert.deepStrictEqual(pages, [['listener', 1, 7], ['listener', 2, 1]]);

  // an empty last page falls back to the join date; the newest scrobble still lands
  const empty = async (method, p) => (p.limit === 1 ? { recenttracks: { track: [] } } : dated(1900));
  assert.deepStrictEqual(await historySpan(listener, empty).then(s => [s.first, s.last]), [1000, 1900]);

  // a failed probe must not abort: registered → now
  const boom = async () => { throw new Error('error 29'); };
  const fallback = await historySpan(listener, boom);
  assert.strictEqual(fallback.first, 1000);
  assert.ok(Math.abs(fallback.last - Date.now() / 1000) < 5, 'failed probe ends at now');

  // clock skew can't invert the span: the last play is never before the first
  const inverted = async (method, p) => dated(p.limit === 1 ? 1900 : 1500);
  assert.deepStrictEqual(await historySpan(listener, inverted).then(s => [s.first, s.last]), [1900, 1900]);

  // an empty account makes no probe at all
  let probes = 0;
  const none = await historySpan({ ...listener, playcount: '0' }, async () => { probes++; });
  assert.strictEqual(probes, 0);
  assert.strictEqual(none.first, 1000);

  console.log('ok');
})().catch(e => { console.error(e); process.exit(1); });
