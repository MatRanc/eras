---
version: 1
slug: "src-index-html"
primary_target: "src/index.html"
related_targets: []
---

# Surface: Eras timeline (src/index.html)

Mode: Operate. User enters a Last.fm username, sees auto-detected album/artist eras on a timeline, tweaks bucket length + sensitivity, inspects an era.

## Direction contract
Seed: 6d0084db (assigned)

THESIS: Your listening history set as a run of Blue Note record jackets. Each era is a flat colored slab cut from its own album cover. Refuses the default: a neutral stats dashboard with a bar chart and rounded cards.

OWN-WORLD: Near-black ink ground with off-white type. Each era takes its color from its cover art: a flat field, no gradients or glass. Huge condensed caps for names and years, tabular figures for counts. Hard edges, zero radius, offset asymmetric blocks, duotone album art.

STORY: Name in → years ruled across → eras drop in as slabs; the biggest era leads the jacket header.

FIRST VIEWPORT: Empty state is a jacket: monumental "ERAS" plus the username field as the only control. Loaded: the top era is the headline (cover duotone + giant title + plays/dates), with the timeline below.

SIGNATURE: Hovering or focusing a slab recolors the header jacket to that era. Monthly bars sit inside each slab and their height carries plays on one fixed scale.

RAISES: fixed magnitude scale shared across all slabs (from star atlas); overlapping eras stack in lanes and are never hidden (from exposure record); on mobile the timeline scrolls horizontally while the header stays as the single focus (from airport).
