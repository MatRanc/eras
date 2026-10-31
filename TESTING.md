# Testing notes

## Last.fm users worth testing with

Real histories that show off (or break) era detection. Open any of them with
`http://localhost:8000/?user=<name>&mode=<album|artist|genre>&b=1&s=5`.

| User | History | Why it's useful |
|---|---|---|
| MatRanc | 2016–, 91k plays, hip hop → indie | Clear genre phases: cloud rap, ambient ×3, country, pop punk, a 2024–26 indie stretch |
| gulyas069 | German metalcore, 6 years | Neighbouring genres (metalcore, post-hardcore, deathcore, melodic hardcore) running at once in 2021 |
| c7po | | Hand-tested across modes |
| sterlingrey | | Hand-tested across modes |
| FlipperDolphinn | K-pop, 8 years | One genre is ~47% of everything: needs the cap on the genre bar, or the main phase splits into slivers |
| leonmasselink | Dutch, 2005–, 266k plays | Very long history: hits the 40-era cap, worst case for request counts |
| MoloT_xD | Russian rock/metal, 2014–, 550k plays | Power metal 2024–26; Cyrillic labels |
| redherring22 | Folk metal → indie | Long arc; Ween tagged "experimental" (one-artist eras) |
| katora- | Noise/grind, 4 years | Very niche genres that overlap (goregrind, gorenoise) |
| RPAppelket | Ukrainian pop/rock, 2020– | Genre mix barely moves; short history |
| Alpha_Stream | J-pop, 12k plays | Light listener; ~29% of plays have no genre (tagged only "japanese") |
| yguismo | Brazil, 12 years | 36,762 "pop" plays in Aug–Sep 2025, likely a scrobbling glitch that can fake an era |
| _fonts | Fake (`src/fake.js`, localhost only) | One era per alphabet (27, from Greek to Thaana): checks each fallback font's size and weight against League Gothic |

## Spotify import

The button under the username box takes Spotify's **Extended streaming history** ZIP
(Account → Privacy → Download your data; email, not instant). It is read in the page:
nothing is uploaded, and the raw rows are never cached.

What to check:

| Case | Expected |
|---|---|
| Song stream ≥ 30s | Counts once, credited to the album artist and album |
| Song stream < 30s | Ignored |
| Podcast, audiobook or video | Ignored (episode/audiobook fields, or a `Streaming_History_Video` file) |
| `ms_played` 42s with `skipped: true` | Still counts: without track duration the 30s rule is the only test |
| Single with no album name | Counts toward the artist, not the album chart |
| Non-ZIP or a partial download | Readable error; the previous view stays on screen |
| 10+ years, several audio files | Files read one at a time; progress names the file |

Genre mode still asks Last.fm for artist tags, so it needs the deployed API key. Album and
artist modes need no Last.fm account; cover art still comes from Last.fm, and falls back to a
palette colour if that request fails.

## Timeline range

The timeline runs from the first scrobble or song play to the last one, not from the
account's join date to today. An account that sat unused for years before its first
scrobble, or a history that stopped years ago, should not open or close with empty
months. `?_fonts` is registered 14 months before its first play, so a regression is
visible locally; `lastfm` stopped scrobbling in 2007.

One quiet bucket between two runs of the same album, artist or genre is merged into a
single era. Two or more quiet buckets still split it into separate eras.

## Last.fm request budget

Last.fm limits each visitor IP to 5 requests/s averaged over 5 minutes (~1,500 per
5 minutes). `call()` bursts at up to 10/s and backs off on error 29.

| Mode, first visit | Requests |
|---|---|
| Albums | 1 album chart per month of history |
| Artists | 1 artist chart + 1 album chart per month |
| Genres | Artists, plus 1 tag lookup per artist (top 90% of plays, max 400) |
| Any | Cover art: 1 per era shown (genre eras: up to 4, only for the era on screen) |

Charts for finished months, tags and art are cached in the visitor's browser with no
expiry, so a return visit only fetches the current month.

Worst case seen: a 24-year history is ~580 chart requests plus ≤400 tag requests,
about 1,000, under the 5-minute budget. MatRanc's first genre load (352 artists)
averaged ~2.3 requests/s.

The per-visitor limit isn't the risk; the shared API key is. Last.fm doesn't publish
a per-key limit, and a suspended key (error 26) takes the whole site down. Test with
a separate development key, and if traffic grows, a shared server-side tag cache
would remove most genre-mode requests (tags are the same for every visitor).

### Why a traffic spike is fine, and what isn't

Every request comes from the visitor's own browser, so each visitor has their own
5/s allowance: a thousand visitors at once are a thousand separate budgets. A backend
would put every request on one server IP and one budget, so keep it static.

More keys buy nothing: the limit is per IP, not per key, and rotating keys to get
around it is how keys get suspended. The key is also public (it ships in
`config.js`), so anyone can reuse it.

If the key gets suspended:

1. Create a spare key at https://www.last.fm/api/account/create (keep one ready).
2. Put it in the `LASTFM_API_KEY` repo secret.
3. Re-run the Deploy workflow (or push to `main`). The site shows a "key suspended"
   message until then.

If it ever needs more than the standard limit, Last.fm's terms allow higher limits
with their written consent: email them.
