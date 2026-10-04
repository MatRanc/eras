# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Plain static HTML/CSS/JS in `src/`, no build step (same pattern as deformat). Deployed to GitHub Pages at eras.matranc.com via a GitHub Action. Serverless: all Last.fm calls happen in the browser.

## Users

Anyone with a Last.fm account who wants to see the shape of their listening history: which albums and artists defined which stretches of their life.

## Product Purpose

Eras Explorer turns a Last.fm scrobble history into a timeline of "eras": periods where an album or artist dominated listening. Example: The Life of Pablo at ~100 scrobbles/month Oct–Jan 2016, tapering to ~50, then spiking again in summer is one "Life of Pablo era". Success = a user enters their username and instantly recognises their own eras.

## Positioning

Not another top-charts list. Eras are auto-detected time segments, shown on a timeline with their monthly intensity, overlapping where eras overlapped.

## Capabilities and Constraints

- Enter any Last.fm username; switch between album eras and artist eras.
- User controls bucket length (month granularity and up) and detection sensitivity.
- Eras may overlap; the timeline stacks them.
- Last.fm API key ships in client JS (unavoidable browser-only); it is kept out of git and injected at deploy from a repo secret.
- Last.fm rate limits apply; past months are immutable and cacheable.

## Evidence on Hand

No sample data or screenshots yet. Do not fabricate user testimonials.

## Product Principles

1. The user's own history is the hero: album art and real numbers, no decoration standing in for data.
2. Era detection should feel right without tuning; controls exist for when it doesn't.
3. Fast on repeat visits: cache what can't change.
