# anime-api

Complete anime database with **sub + dub** episode tracking and **next sub/dub release** times, built from three sources and served over a small REST API. Zero npm dependencies — needs Node 18+ (built-in `fetch`).

**It runs itself.** Start the server once and leave it running:

```
cd anime-api
npm start        # http://localhost:3000 (override with PORT=xxxx)
```

- On the very first boot (or whenever `data/` is empty) it builds the whole database, then starts serving.
- While running it **re-syncs automatically** every `AUTO_UPDATE_MINUTES` (default: 60), so latest episodes, next sub/dub releases and metadata stay current.
- If you hit an ID that **isn't saved yet** (any AniList or MAL ID, airing or not), it is fetched on demand from AniList + ani.zip, saved to the database, and served. On-demand records are kept and refreshed across syncs.
- `npm run sync` still exists if you ever want to rebuild manually (add `--force` to bypass the response cache).

## Sources

| Source | What it provides |
|---|---|
| [AnimeSchedule API v3](https://animeschedule.net/api/v3/documentation) | sub + dub timetables (what's airing this week), per-show details, MAL/AniList IDs |
| [AniList GraphQL](https://docs.anilist.co/) | full metadata: titles, synopsis, cover/banner, genres, status, `nextAiringEpisode` |
| [ani.zip mappings](https://api.ani.zip/) | per-episode data: titles, overview, thumbnail, air date, rating |

## Setup

1. Your AnimeSchedule token goes in `.env` (already included):
   ```
   ANIMESCHEDULE_TOKEN=your_token
   AUTO_UPDATE_MINUTES=60      # how often the DB re-syncs itself
   CACHE_TTL_HOURS=1           # how long raw API responses are reused
   REFRESH_STALE_HOURS=24      # re-fetch non-airing records when older than this
   ```
2. `npm start` — that's it. First boot takes ~1 minute to build the database (85+ shows).

## Endpoints

| Endpoint | Returns |
|---|---|
| `GET /anime` | summary list of all saved anime |
| `GET /status` | sync state (last run, next run, record count) |
| `GET /anime/ani/:anilistId` | complete anime record by AniList ID |
| `GET /anime/mal/:malId` | complete anime record by MAL ID |
| `GET /anime/ani/episode/:anilistId` | episode list + sub/dub availability by AniList ID |
| `GET /anime/mal/episode/:malId` | episode list + sub/dub availability by MAL ID |

Extras: `?episodes=false` on the full-record endpoints drops the episode array, `?pretty=1` pretty-prints the JSON. Unknown but valid IDs are fetched on demand instead of returning 404 (404 only happens when the ID doesn't exist at all).

## Example record

```jsonc
{
  "anilistId": 185542,
  "malId": 60522,
  "titles": { "romaji": "...", "english": "Skeleton Knight in Another World II", "native": "..." },
  "anilist": { /* full AniList metadata: cover, synopsis, genres, status, ... */ },
  "schedule": { /* AnimeSchedule: season, genres, studios, streams, weekly slots, delays */ },
  "sub": {
    "available": true,
    "totalEpisodes": 12,
    "latestEpisode": { "number": 11, "airedAt": "2026-09-14T13:00:00Z" },
    "nextRelease":   { "episode": 12, "at": "2026-09-21T13:00:00Z", "estimated": false },
    "weeklySlot": "Monday 13:00 UTC"
  },
  "dub": {
    "available": true,
    "totalEpisodes": 12,
    "latestEpisode": { "number": 11, "airedAt": "2026-09-14T13:00:00Z" },
    "nextRelease":   { "episode": 12, "at": "2026-09-21T13:00:00Z", "estimated": true },
    "weeklySlot": "Monday 13:00 UTC"
  },
  "episodes": [
    {
      "number": 1,
      "title": "God of Thunder",
      "overview": "...",
      "image": "https://...",
      "airDate": "2026-07-25T14:00:00Z",
      "subbed": true,
      "dubbed": true
    }
  ],
  "episodeCount": 12
}
```

- `nextRelease.estimated: true` means the exact date isn't scheduled yet — it was projected one week forward from the last aired episode (weekly cadence).
- `dub.available: false` when the show has no dub currently airing (dub fields are then `null`).
- `subbed` / `dubbed` per episode = whether that track has aired up to that episode number.

## Data layout

```
data/
├── index.json          # anilistId / malId -> record file
├── unmapped.json       # timetable shows without an AniList ID (can't be served)
└── anime/
    └── <anilistId>.json   # one merged record per show
```

## Known limits

- The periodic sync covers the **currently-airing** shows on the AnimeSchedule sub + dub timetables (~85 shows). Any other anime enters the database on demand when you request it (with AniList metadata + full episode data, but no dub/schedule tracking).
- Next **sub** release comes from AniList's `nextAiringEpisode` (authoritative, even for delayed shows); next **dub** release comes from the dub timetable, with a +7-day estimate when the exact date isn't scheduled yet.
- A show whose dub already finished (or hasn't started) won't appear in the dub timetable, so it's marked `dub.available: false` — AnimeSchedule only tracks dubs airing this week.
