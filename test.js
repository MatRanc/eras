// node test.js
const assert = require('assert');
const { SEP, buildSeries, detectEras, assignLanes, genreMonths } = require('./src/eras.js');

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

// The bar stops 10 points over the usual share: a genre at 75% overall can still run at 90%+.
const main = new Map([['k-pop', [70, 70, 95, 95, 95, 70, 70, 70]]]), hundred = new Array(8).fill(100);
assert.deepStrictEqual(detectEras(main, hundred, { share: 0.05, floor: 4, lift: 1.4, ramp: false }).map(e => [e.start, e.end]), [[2, 4]]);
// lift 0 (short histories): the plain share bar, still without the ramp
assert.deepStrictEqual(detectEras(main, hundred, { share: 0.05, floor: 4, lift: 0, ramp: false }).map(e => [e.start, e.end]), [[0, 7]]);

console.log('ok');
