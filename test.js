// node test.js
const assert = require('assert');
const { SEP, buildSeries, detectEras, capPerYear, assignLanes } = require('./src/eras.js');

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

// Per-year cap: a busy year can't crowd out a quiet one. base 2010*12, monthly buckets.
const yr = [[0, 90], [1, 80], [2, 70], [13, 10]].map(([peakAt, plays]) => ({ peakAt, plays }));
assert.deepStrictEqual(capPerYear(yr, 2, 1, 2010 * 12).map(e => e.plays), [90, 80, 10]);

// Overlaps go to separate lanes; gaps reuse a lane.
const ls = [{ start: 0, end: 5 }, { start: 3, end: 8 }, { start: 7, end: 9 }];
assert.strictEqual(assignLanes(ls), 2);
assert.deepStrictEqual(ls.map(e => e.lane), [0, 1, 0]);

console.log('ok');
