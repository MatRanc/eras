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

// Album titles carry edition suffixes: "Donda (Deluxe)", "Album [Remastered]", "Album - 2011
// Remaster". They are the same record, so their series are merged before detection; otherwise
// one album's plays are split between entries and the era it should form can disappear.
// Only edition words are stripped. Live, soundtrack, acoustic, instrumental, demo, commentary
// and EP releases are different records (and "Love Deluxe" is a real title), so they stay apart.
const EDITION = /\b(?:deluxe|remaster(?:ed|s)?|anniversary|expanded|special edition|collector[’']?s edition|bonus(?: tracks?| version)?|legacy edition|reissue|re-issue|definitive edition|limited edition|platinum edition|gold edition|international edition|japanese edition|japan edition|tour edition|standard edition|explicit|clean)\b/i;
const NOT_EDITION = /\b(?:live|soundtrack|acoustic|instrumental|demo|commentary|remix(?:es)?|karaoke|a cappella|ep|single)\b/i;
const TAIL_GROUP = /\s*[\(\[\{]([^\(\)\[\]\{\}]*)[\)\]\}]\s*$/;
const TAIL_DASH = /\s+[-–—]\s+(.+)$/;

function titleKey(title) {
  return title.normalize('NFKC').replace(/\s+/g, ' ').trim()
    .toLowerCase().replace(/[’']/g, "'");
}

// The title without its edition markers, used to recognise the same record.
function albumCore(title) {
  let t = title.normalize('NFKC').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 4; i++) {
    const g = t.match(TAIL_GROUP);
    if (g && EDITION.test(g[1]) && !NOT_EDITION.test(g[1])) { t = t.slice(0, g.index).trim(); continue; }
    const d = t.match(TAIL_DASH);
    if (d && EDITION.test(d[1]) && !NOT_EDITION.test(d[1])) { t = t.slice(0, d.index).trim(); continue; }
    break;
  }
  return titleKey(t);
}

// Series keys are artist + SEP + album. Fold editions of one record into one series,
// keeping the most-played plain title for display (or the most-played edition if every
// spelling carries a marker). Bucket totals are untouched.
function mergeAlbums(series) {
  const groups = new Map();
  for (const [key, counts] of series) {
    const at = key.indexOf(SEP);
    if (at < 0) continue;
    const artist = key.slice(0, at), album = key.slice(at + 1);
    const id = artist.toLowerCase() + SEP + albumCore(album);
    let g = groups.get(id);
    if (!g) groups.set(id, (g = { artist, counts: new Array(counts.length).fill(0), variants: new Map() }));
    for (let i = 0; i < counts.length; i++) g.counts[i] += counts[i];
    g.variants.set(album, (g.variants.get(album) || 0) + counts.reduce((a, b) => a + b, 0));
  }
  const out = new Map();
  for (const g of groups.values()) {
    let display = '', best = -1, plain = '', plainBest = -1;
    for (const [album, plays] of g.variants) {
      if (plays > best) { best = plays; display = album; }
      if (albumCore(album) === titleKey(album) && plays > plainBest) { plain = album; plainBest = plays; }
    }
    out.set(g.artist + SEP + (plain || display), g.counts);
  }
  return out;
}

// An era is a run of buckets where an entity clears both an absolute floor and a share
// of everything played that bucket. One quiet bucket inside a run doesn't break it,
// and the run widens to take in the ramp-up/taper (buckets at half the floor).
// With `lift`, the share bar is also lift× the entity's own long-run share: genres are a
// steady baseline, so their eras are the stretches well above it. That bar stops at 10 points
// over the usual share, or a genre that is most of someone's listening could never form an era.
// `ramp: false` skips the ramp, since a steady genre sits above half the floor almost everywhere.
// `gap` is how many quiet buckets a run survives, `minLen` the fewest buckets an era may span.
// `trim` cuts the ramp that faces a one-bucket comeback back to the hot run, so the quiet
// bucket between the two stays empty and month-mode comebacks read as separate phases.
function detectEras(series, totals, { share, floor, lift, ramp = true, gap: maxGap = 1, minLen = 1, trim = false }) {
  const eras = [];
  const all = totals.reduce((a, b) => a + b, 0) || 1;
  for (const [key, c] of series) {
    const n = c.length;
    const usual = c.reduce((a, b) => a + b, 0) / all;
    const bar = lift ? Math.max(share, Math.min(lift * usual, usual + 0.1)) : share;
    const hot = i => c[i] >= floor && c[i] >= bar * totals[i];
    // the hot run is kept beside the ramped one: a comeback cuts back to it
    const runs = [];
    let i = 0;
    while (i < n) {
      if (!hot(i)) { i++; continue; }
      let s = i, e = i, gap = 0;
      for (let j = i + 1; j < n; j++) {
        if (hot(j)) { e = j; gap = 0; } else if (++gap > maxGap) break;
      }
      const hotStart = i, hotEnd = e;
      if (ramp) {
        while (s > 0 && c[s - 1] >= floor / 2) s--;
        while (e < n - 1 && c[e + 1] >= floor / 2) e++;
      }
      const counts = c.slice(s, e + 1);
      const plays = counts.reduce((a, b) => a + b, 0);
      if (plays >= floor * 3 && counts.length >= minLen) {
        const pk = counts.indexOf(Math.max(...counts));
        runs.push({ hotStart, hotEnd, era: { key, start: s, end: e, counts, plays, peak: counts[pk], peakAt: s + pk } });
      }
      i = e + 1;
    }
    // Two runs of the same key one bucket apart are a comeback, not one long phase: cut the
    // ramp on each side that faces the gap back to its hot run, so the quiet bucket between
    // them stays empty and the two read as separate stretches. Only month buckets ask for
    // this; at coarser groupings the one gap is already wide enough. A side whose ramp is
    // what makes it an era (minLen, floor) is left alone rather than dropped.
    if (trim) {
      const cut = (e, start, end) => {
        const counts = c.slice(start, end + 1);
        const plays = counts.reduce((a, b) => a + b, 0);
        if (counts.length < minLen || plays < floor * 3) return;
        const pk = counts.indexOf(Math.max(...counts));
        Object.assign(e, { start, end, counts, plays, peak: counts[pk], peakAt: start + pk });
      };
      for (let k = 1; k < runs.length; k++) {
        const prev = runs[k - 1], r = runs[k];
        if (r.era.start !== prev.era.end + 2) continue; // more than one bucket: already apart
        cut(prev.era, prev.era.start, prev.hotEnd);
        cut(r.era, r.hotStart, r.era.end);
      }
    }
    eras.push(...runs.map(x => x.era));
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

if (typeof module !== 'undefined') module.exports = { SEP, buildSeries, detectEras, assignLanes, genreMonths, albumCore, mergeAlbums };
