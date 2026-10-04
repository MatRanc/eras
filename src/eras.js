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
function detectEras(series, totals, { share, floor }) {
  const eras = [];
  const hot = (c, i) => c[i] >= floor && c[i] >= share * totals[i];
  for (const [key, c] of series) {
    const n = c.length;
    let i = 0;
    while (i < n) {
      if (!hot(c, i)) { i++; continue; }
      let s = i, e = i, gap = 0;
      for (let j = i + 1; j < n; j++) {
        if (hot(c, j)) { e = j; gap = 0; } else if (++gap > 1) break;
      }
      while (s > 0 && c[s - 1] >= floor / 2) s--;
      while (e < n - 1 && c[e + 1] >= floor / 2) e++;
      const counts = c.slice(s, e + 1);
      const plays = counts.reduce((a, b) => a + b, 0);
      if (plays >= floor * 3) {
        const pk = counts.indexOf(Math.max(...counts));
        eras.push({ key, start: s, end: e, counts, plays, peak: counts[pk], peakAt: s + pk });
      }
      i = e + 1;
    }
  }
  return eras.sort((a, b) => b.plays - a.plays);
}

// Keep the N biggest eras per calendar year (by the year an era peaks), so long histories
// don't starve quiet years and short ones don't overflow. Expects eras sorted by plays, desc.
// Eras overlapping one in `keep` (same key) always stay: pass what a stricter level showed,
// so loosening sensitivity never hides an era.
function capPerYear(eras, N, B, base, keep = []) {
  const used = new Map();
  const kept = e => keep.some(f => f.key === e.key && f.start <= e.end && f.end >= e.start);
  return eras.filter(e => {
    const y = Math.floor((base + e.peakAt) * B / 12);
    const k = used.get(y) || 0;
    used.set(y, k + 1);
    return k < N || kept(e);
  });
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

if (typeof module !== 'undefined') module.exports = { SEP, buildSeries, detectEras, capPerYear, assignLanes };
