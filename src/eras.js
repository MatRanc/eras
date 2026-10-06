// Pure era logic: no DOM, no network. Loaded by the page and by test.js.

const SEP = '␟';

// months: [{idx: y*12+m, album: [[album, artist, plays], ...], artist: [['', artist, plays], ...]}]
// (either list may be undefined while loading). Until a month's artist chart arrives,
// artist mode estimates it by summing that month's album chart.
// B: months per bucket. Buckets are calendar-aligned (B=3 → quarters).
function buildSeries(months, B, mode) {
  const base = Math.floor(months[0].idx / B);
  const n = Math.floor(months[months.length - 1].idx / B) - base + 1;
  const totals = new Array(n).fill(0);
  const series = new Map();
  for (const mo of months) {
    const items = mo[mode] || (mode === 'artist' && mo.album);
    if (!items) continue;
    const b = Math.floor(mo.idx / B) - base;
    for (const [album, artist, p] of items) {
      const k = mode === 'album' ? artist + SEP + album : artist;
      let s = series.get(k);
      if (!s) series.set(k, (s = new Array(n).fill(0)));
      s[b] += p;
      totals[b] += p;
    }
  }
  return { series, totals, n, base };
}

// An era is a run of buckets where an entity clears both an absolute floor and a share
// of everything played that bucket. One quiet bucket inside a run doesn't break it,
// and the run widens to take in the ramp-up/taper (buckets at half the floor).
// With `lift`, the share bar is also lift× the entity's own long-run share: genres are a
// steady baseline, so their eras are the stretches well above it. That bar stops at 10 points
// over the usual share, or a genre that is most of someone's listening could never form an era.
// `ramp: false` skips the ramp, since a steady genre sits above half the floor almost everywhere.
// `gap` is how many quiet buckets a run survives, `minLen` the fewest buckets an era may span.
function detectEras(series, totals, { share, floor, lift, ramp = true, gap: maxGap = 1, minLen = 1 }) {
  const eras = [];
  const all = totals.reduce((a, b) => a + b, 0) || 1;
  for (const [key, c] of series) {
    const n = c.length;
    const usual = c.reduce((a, b) => a + b, 0) / all;
    const bar = lift ? Math.max(share, Math.min(lift * usual, usual + 0.1)) : share;
    const hot = i => c[i] >= floor && c[i] >= bar * totals[i];
    let i = 0;
    while (i < n) {
      if (!hot(i)) { i++; continue; }
      let s = i, e = i, gap = 0;
      for (let j = i + 1; j < n; j++) {
        if (hot(j)) { e = j; gap = 0; } else if (++gap > maxGap) break;
      }
      if (ramp) {
        while (s > 0 && c[s - 1] >= floor / 2) s--;
        while (e < n - 1 && c[e + 1] >= floor / 2) e++;
      }
      const counts = c.slice(s, e + 1);
      const plays = counts.reduce((a, b) => a + b, 0);
      if (plays >= floor * 3 && counts.length >= minLen) {
        const pk = counts.indexOf(Math.max(...counts));
        eras.push({ key, start: s, end: e, counts, plays, peak: counts[pk], peakAt: s + pk });
      }
      i = e + 1;
    }
  }
  return eras.sort((a, b) => b.plays - a.plays);
}

// Greedy interval packing; keeps one empty bucket between slabs in a lane.
function assignLanes(eras) {
  const ends = [];
  for (const e of [...eras].sort((a, b) => a.start - b.start)) {
    let l = ends.findIndex(x => x < e.start);
    if (l < 0) { l = ends.length; ends.push(0); }
    ends[l] = e.end + 1;
    e.lane = l;
  }
  return ends.length;
}

// Artist charts → genre charts. genreOf(artist) returns a genre, or '' for untagged artists:
// their plays still count toward each bucket's total, so drop the '' series before detecting.
function genreMonths(months, genreOf) {
  return months.map(mo => {
    if (!mo.artist) return { idx: mo.idx };
    const sums = new Map();
    for (const [, a, p] of mo.artist) { const g = genreOf(a); sums.set(g, (sums.get(g) || 0) + p); }
    return { idx: mo.idx, artist: [...sums].map(([g, p]) => ['', g, p]) };
  });
}

if (typeof module !== 'undefined') module.exports = { SEP, buildSeries, detectEras, assignLanes, genreMonths };
