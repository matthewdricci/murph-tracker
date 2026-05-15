# Murph Test 2026 — Segment Tracker

Live dashboard for Matt Ricci's Murph workout on **Saturday May 16, 2026**. This is a **rehearsal fork of [`ironhike-tracker`](https://github.com/matthewdricci/ironhike-tracker)** — same Shortcut → Sheet → CSV → Pages → push pipeline, applied to a Murph workout to validate the whole stack before IronHike Everest on June 4–7, 2026.

Project notes live in the Obsidian vault at `1 - Projects/2026 Murph Test/`.

## How it works

```
[iPhone Shortcut tap] → [Google Sheet row] → [published CSV] → [this static page]
```

22 taps total: mile-1 + 20 Cindy-style rounds (5 pull-ups / 10 push-ups / 15 squats) + mile-2.

## Setup (one time)

1. Create a Google Sheet `Murph Test 2026 — Laps` with `laps` and `config` tabs (schema in vault notes `Sheet schema.md`).
2. Publish both tabs to web as CSV. Copy the two URLs.
3. Edit `app.js` — replace `REPLACE_WITH_MURPH_LAPS_CSV_URL` and `REPLACE_WITH_MURPH_CONFIG_CSV_URL`.
4. Push to `matthewdricci/murph-tracker` repo, enable Pages from `main` root.
5. Build the "Log Murph Lap" Apple Shortcut following vault notes `Shortcut setup.md`.

## Push notifications

Reuses the IronHike Cloudflare Worker at `https://ironhike-push.beyond-the-hudson-918.workers.dev` — no separate deploy. The Worker's `/notify` endpoint accepts `title`, `body`, `url` from the JSON body, so the Murph Shortcut just sends Murph-flavored payload to the same endpoint with the same `NOTIFY_SECRET`.

Subscribers table is shared with IronHike. That means existing IronHike subscribers will also receive Murph push notifications — acceptable for the rehearsal, flagged in `Post-mortem.md`.

If the Worker source ever needs editing, it lives in `ironhike-tracker/push-worker/`, not here.

## Differences from ironhike-tracker

- 22 segments instead of 49 laps
- 90-min target window instead of 72-hour cutoff
- `elevation_ft_per_lap = 0` — elevation row hidden on dashboard
- `REST_MIN` lowered to 10, `DUP_SEC` lowered to 20 (Cindy rounds can be fast)
- Push title/body/tag and dashboard copy updated for Murph
- `push-worker/` and `sim/` directories removed (worker is reused; sim not needed for a 90-min rehearsal)

## Stack

Plain HTML/CSS/JS. Chart.js via CDN. No build step. Push backend reused from ironhike-tracker.
