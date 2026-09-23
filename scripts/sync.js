#!/usr/bin/env node
/**
 * Anime database builder + on-demand fetcher.
 *
 * Two ways to use it:
 *   CLI:   node scripts/sync.js          (or `npm run sync`, add --force to ignore cache)
 *   Module: const { runSync, ensureAnime } = require('./scripts/sync.js')
 *
 * runSync()      - full pipeline: AnimeSchedule sub+dub timetables -> per-show details
 *                  (MAL/AniList IDs) -> AniList metadata (batched) -> ani.zip episodes ->
 *                  one merged record per show under data/anime/. On-demand records that
 *                  were fetched outside the timetables are preserved, and stale ones
 *                  are re-fetched here too.
 *
 * ensureAnime()  - fetch a single anime by anilistId or malId, even if it is not on
 *                  the timetables (AniList + ani.zip), and save it. Concurrent calls
 *                  for the same show are de-duplicated.
 *
 * Raw API responses are cached on disk (CACHE_TTL_HOURS), so interrupted runs resume
 * where they stopped and re-runs are cheap.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const ANIME_DIR = path.join(DATA_DIR, 'anime');
const ROUTE_CACHE_DIR = path.join(DATA_DIR, 'cache', 'routes');
const ANILIST_CACHE_DIR = path.join(DATA_DIR, 'cache', 'anilist');
const ANIZIP_CACHE_DIR = path.join(DATA_DIR, 'cache', 'anizip');

const AS_BASE = 'https://animeschedule.net/api/v3';
const ANIZIP_URL = 'https://api.ani.zip/mappings';
const ANILIST_URL = 'https://graphql.anilist.co';
const ANILIST_BATCH_SIZE = 50;

// How long raw API responses are reused. Also: how old a non-timetable record may get
// before it is refreshed again, and how many of those are refreshed per sync cycle.
const CACHE_TTL_MS = (Number(process.env.CACHE_TTL_HOURS) || 1) * 60 * 60 * 1000;
const REFRESH_STALE_MS = (Number(process.env.REFRESH_STALE_HOURS) || 24) * 60 * 60 * 1000;
const MAX_STALE_REFRESH_PER_CYCLE = 20;

const ZERO_DATE_PREFIX = '0001-01-01'; // AnimeSchedule uses this for "no date"
const DAY_MS = 24 * 60 * 60 * 1000;

// Set by runSync({ force }) - makes the CLI --force flag bypass the response cache.
let forceCacheBypass = false;

// ---------------------------------------------------------------------------
// Env + small utilities
// ---------------------------------------------------------------------------

/** Loads .env into process.env without overriding real env vars. */
function loadEnvFile() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnvFile();

function readToken() {
  if (process.env.ANIMESCHEDULE_TOKEN) return process.env.ANIMESCHEDULE_TOKEN.trim();
  throw new Error('Missing ANIMESCHEDULE_TOKEN - put it in anime-api/.env or export it as an env var.');
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isRealDate = (iso) => !!iso && !String(iso).startsWith(ZERO_DATE_PREFIX);
const toDate = (iso) => (isRealDate(iso) ? new Date(iso) : null);
const addDays = (iso, days) => new Date(new Date(iso).getTime() + days * DAY_MS).toISOString();

/** GET/POST JSON with retries; handles 429 by honouring Retry-After. */
async function fetchJson(url, options = {}, label = url) {
  const attempts = options.retries || 3;
  delete options.retries;
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, options);
      if (res.status === 429) {
        const waitSec = Number(res.headers.get('retry-after')) || 15;
        console.log(`\n  rate limited on ${label}, waiting ${waitSec}s...`);
        await delay(waitSec * 1000);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastError = err;
      if (attempt < attempts) await delay(1000 * attempt);
    }
  }
  throw new Error(`${label} failed after ${attempts} attempts: ${lastError.message}`);
}

/**
 * Cache read. Returns the cached value (which may be `null` for a known miss),
 * or undefined when nothing usable is cached.
 */
function cacheGet(file) {
  if (forceCacheBypass) return undefined;
  try {
    if (Date.now() - fs.statSync(file).mtimeMs > CACHE_TTL_MS) return undefined;
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return undefined;
  }
}

function cacheSet(dir, name, data) {
  const file = path.join(dir, `${name}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data ?? null), 'utf-8');
}

/** AnimeSchedule stores website links as bare URLs, e.g. "anilist.co/anime/185542/Some-Slug". */
function extractIdFromUrl(url, hostPattern) {
  if (!url) return null;
  const match = String(url).match(hostPattern);
  return match ? Number(match[1]) : null;
}

function indexBy(list, key) {
  const out = {};
  for (const item of list) if (item[key]) out[item[key]] = item;
  return out;
}

/** "Monday 13:00 UTC" from the weekly air datetime AnimeSchedule exposes per track. */
function weeklySlot(iso) {
  const date = toDate(iso);
  if (!date) return null;
  const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  return `${weekdays[date.getUTCDay()]} ${hh}:${mm} UTC`;
}

// ---------------------------------------------------------------------------
// data/ index (anilistId / malId -> record file)
// ---------------------------------------------------------------------------

function readIndexSafe() {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'index.json'), 'utf-8'));
  } catch {
    return { generatedAt: null, count: 0, byAnilistId: {}, byMalId: {} };
  }
}

function writeIndex(index) {
  index.count = Object.keys(index.byAnilistId).length;
  index.generatedAt = new Date().toISOString();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'index.json'), JSON.stringify(index, null, 2), 'utf-8');
}

function loadRecordSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ANIME_DIR, file), 'utf-8'));
  } catch {
    return null;
  }
}

/** Saves a record file and registers it in the index (byAnilistId + byMalId). */
function saveRecord(record) {
  fs.mkdirSync(ANIME_DIR, { recursive: true });
  const file = `${record.anilistId}.json`;
  fs.writeFileSync(path.join(ANIME_DIR, file), JSON.stringify(record, null, 2), 'utf-8');

  const index = readIndexSafe();
  index.byAnilistId[String(record.anilistId)] = file;
  if (record.malId) index.byMalId[String(record.malId)] = file;
  writeIndex(index);
  return file;
}

// ---------------------------------------------------------------------------
// AnimeSchedule
// ---------------------------------------------------------------------------

async function fetchTimetable(type, headers) {
  const data = await fetchJson(`${AS_BASE}/timetables/${type}`, { headers }, `timetable/${type}`);
  return Array.isArray(data) ? data : data.anime || data.data || [];
}

async function fetchRouteDetails(route, headers) {
  const cached = cacheGet(path.join(ROUTE_CACHE_DIR, `${route}.json`));
  if (cached !== undefined) return { detail: cached.detail ?? null, fromCache: true };
  try {
    const detail = await fetchJson(`${AS_BASE}/anime/${route}`, { headers }, `details/${route}`);
    cacheSet(ROUTE_CACHE_DIR, route, { detail });
    return { detail, fromCache: false };
  } catch (err) {
    console.log(`  ! failed to fetch details for ${route}: ${err.message}`);
    return { detail: null, fromCache: false };
  }
}

// ---------------------------------------------------------------------------
// AniList GraphQL
// ---------------------------------------------------------------------------

const MEDIA_FIELDS = `
  id
  idMal
  title { romaji english native }
  synonyms
  coverImage { extraLarge large color }
  bannerImage
  description
  format
  status
  episodes
  duration
  season
  seasonYear
  startDate { year month day }
  endDate { year month day }
  genres
  averageScore
  meanScore
  popularity
  favourites
  source
  countryOfOrigin
  isAdult
  nextAiringEpisode { episode airingAt timeUntilAiring }
  studios(isMain: true) { nodes { name } }
  externalLinks { site url }
  trailer { id site }
`;

const ANILIST_BATCH_QUERY = `query ($ids: [Int]) { Page(perPage: 50) { media(id_in: $ids, type: ANIME, sort: ID) { ${MEDIA_FIELDS} } } }`;
const ANILIST_BY_ID_QUERY = `query ($id: Int) { Media(id: $id, type: ANIME) { ${MEDIA_FIELDS} } }`;
const ANILIST_BY_MAL_QUERY = `query ($idMal: Int) { Media(idMal: $idMal, type: ANIME) { ${MEDIA_FIELDS} } }`;

async function anilistQuery(query, variables, label) {
  const body = await fetchJson(
    ANILIST_URL,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query, variables }),
      retries: 5,
    },
    label
  );
  if (body.errors?.length) {
    // "Not Found" means the ID simply doesn't exist - anything else is worth logging.
    if (body.errors.some((e) => e.status !== 404)) {
      console.log(`  ! AniList error (${label}): ${body.errors.map((e) => e.message).join('; ')}`);
    }
    return null;
  }
  return body.data?.Media ?? body.data?.Page?.media ?? null;
}

async function fetchAnilistBatch(ids) {
  // 50 joined IDs blow past the 255-char filename limit, so hash the cache key.
  const cacheKey = 'batch-' + crypto.createHash('sha1').update(ids.join('_')).digest('hex');
  const cached = cacheGet(path.join(ANILIST_CACHE_DIR, `${cacheKey}.json`));
  if (cached !== undefined) return cached || [];

  const media = await anilistQuery(ANILIST_BATCH_QUERY, { ids }, `anilist batch (${ids.length} ids)`) || [];
  cacheSet(ANILIST_CACHE_DIR, cacheKey, media);
  return media;
}

async function fetchAnilistMedia(anilistId) {
  const cached = cacheGet(path.join(ANILIST_CACHE_DIR, `media-${anilistId}.json`));
  if (cached !== undefined) return cached;
  const media = await anilistQuery(ANILIST_BY_ID_QUERY, { id: anilistId }, `anilist ${anilistId}`);
  cacheSet(ANILIST_CACHE_DIR, `media-${anilistId}`, media);
  return media;
}

async function fetchAnilistMediaByMal(malId) {
  const cached = cacheGet(path.join(ANILIST_CACHE_DIR, `bymal-${malId}.json`));
  if (cached !== undefined) return cached;
  const media = await anilistQuery(ANILIST_BY_MAL_QUERY, { idMal: malId }, `anilist mal ${malId}`);
  cacheSet(ANILIST_CACHE_DIR, `bymal-${malId}`, media);
  return media;
}

// ---------------------------------------------------------------------------
// ani.zip
// ---------------------------------------------------------------------------

async function fetchAnizip(anilistId) {
  const cached = cacheGet(path.join(ANIZIP_CACHE_DIR, `${anilistId}.json`));
  if (cached !== undefined) return cached;
  try {
    const data = await fetchJson(`${ANIZIP_URL}?anilist_id=${anilistId}`, { retries: 3 }, `ani.zip ${anilistId}`);
    const value = data && Object.keys(data).length ? data : null;
    cacheSet(ANIZIP_CACHE_DIR, String(anilistId), value);
    return value;
  } catch {
    console.log(`  ! ani.zip has no mapping for anilist ${anilistId}`);
    cacheSet(ANIZIP_CACHE_DIR, String(anilistId), null);
    return null;
  }
}

async function fetchAnizipByMal(malId) {
  try {
    const data = await fetchJson(`${ANIZIP_URL}?mal_id=${malId}`, { retries: 2 }, `ani.zip mal ${malId}`);
    return data && Object.keys(data).length ? data : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Merge logic
// ---------------------------------------------------------------------------

/** Picks the entry with the higher episode number; keeps airedAt when the winner has it. */
function pickLatest(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  if (b.number > a.number) return { number: b.number, airedAt: b.airedAt || null };
  return { number: a.number, airedAt: a.airedAt || null };
}

function buildTrack(ttEntry, anilist, status, weeklyTimeIso, delayedUntilIso) {
  const track = {
    available: false,
    totalEpisodes: null,
    latestEpisode: null, // { number, airedAt }
    nextRelease: null,   // { episode, at, estimated }
    weeklySlot: weeklySlot(weeklyTimeIso),
  };
  let nextSource = null; // where nextRelease came from - only timetable dates need delay correction

  // Timetable covers the current week: "aired" = this week's episode already aired,
  // "unaired" = this week's episode is upcoming.
  if (ttEntry) {
    track.available = true;
    if (ttEntry.airingStatus === 'aired') {
      track.latestEpisode = pickLatest(track.latestEpisode, { number: ttEntry.episodeNumber, airedAt: ttEntry.episodeDate });
      if (status === 'Ongoing' && ttEntry.episodeDate) {
        track.nextRelease = { episode: ttEntry.episodeNumber + 1, at: addDays(ttEntry.episodeDate, 7), estimated: true };
        nextSource = 'timetable';
      }
    } else {
      track.nextRelease = { episode: ttEntry.episodeNumber, at: ttEntry.episodeDate, estimated: false };
      nextSource = 'timetable';
      if (ttEntry.episodeNumber > 1) {
        track.latestEpisode = { number: ttEntry.episodeNumber - 1, airedAt: null };
      }
    }
  }

  // AniList is the authoritative source for the next SUB episode. A tie still goes
  // to AniList: delayed shows keep their pre-delay date in the AnimeSchedule
  // timetable, while AniList carries the corrected one.
  if (anilist?.nextAiringEpisode) {
    const nae = anilist.nextAiringEpisode;
    track.available = true;
    track.latestEpisode = pickLatest(track.latestEpisode, { number: nae.episode - 1, airedAt: null });
    const at = new Date(nae.airingAt * 1000).toISOString();
    if (!track.nextRelease || nae.episode >= track.nextRelease.episode) {
      track.nextRelease = { episode: nae.episode, at, estimated: false };
      nextSource = 'anilist';
    }
  }

  // Delayed show with a timetable-sourced date: push it to the resumption date.
  const delayedUntil = toDate(delayedUntilIso);
  if (
    track.nextRelease &&
    nextSource === 'timetable' &&
    delayedUntil &&
    delayedUntil.getTime() > new Date(track.nextRelease.at).getTime()
  ) {
    track.nextRelease.at = delayedUntil.toISOString();
    track.nextRelease.estimated = true;
  }

  if (track.latestEpisode && track.latestEpisode.number < 1) track.latestEpisode = null;
  return track;
}

function buildEpisodes(anizip, latestSubNum, latestDubNum) {
  if (!anizip?.episodes) return [];
  const entries = Object.entries(anizip.episodes);
  entries.sort((a, b) => (Number(a[0]) || Infinity) - (Number(b[0]) || Infinity));

  return entries.map(([key, ep]) => {
    const n = Number(key);
    const isNumeric = Number.isFinite(n);
    return {
      number: isNumeric ? n : key,
      title: ep.title?.en || ep.title?.['x-jat'] || ep.title?.ja || null,
      titles: ep.title || null,
      overview: ep.overview || null,
      image: ep.image || null,
      airDate: ep.airDateUtc || ep.airdate || ep.airDate || null,
      runtime: ep.runtime || ep.length || null,
      rating: ep.rating ?? null,
      absoluteEpisodeNumber: ep.absoluteEpisodeNumber ?? null,
      // Per-track availability: an episode is watchable in a track once that track has aired it.
      subbed: isNumeric ? (latestSubNum == null || n <= latestSubNum) : null,
      dubbed: isNumeric ? (latestDubNum != null && n <= latestDubNum) : null,
    };
  });
}

function latestFromEpisodes(episodes) {
  const now = Date.now();
  let latest = null;
  for (const ep of episodes) {
    // Only numbered episodes count as "latest" - specials (S1, SP1, ...) sort after
    // the regular run and would otherwise masquerade as the newest episode.
    if (!Number.isFinite(Number(ep.number))) continue;
    const t = ep.airDate ? new Date(ep.airDate).getTime() : NaN;
    if (Number.isFinite(t) && t <= now) latest = ep.number;
  }
  return latest;
}

function buildRecord({ route, subTt, dubTt, detail, anilist, anizip }) {
  const anilistId =
    extractIdFromUrl(detail?.websites?.aniList, /anilist\.co\/anime\/(\d+)/) || anizip?.mappings?.anilist_id || null;
  const malId =
    extractIdFromUrl(detail?.websites?.mal, /myanimelist\.net\/anime\/(\d+)/) || anizip?.mappings?.mal_id || anilist?.idMal || null;

  const status = detail?.status || anilist?.status || null;
  const totalEpisodes = anizip?.episodeCount ?? detail?.episodes ?? anilist?.episodes ?? null;

  const sub = buildTrack(subTt, anilist, status, detail?.subTime, detail?.subDelayedUntil);
  const dub = buildTrack(dubTt, null, status, detail?.dubTime, detail?.dubDelayedUntil);
  sub.totalEpisodes = totalEpisodes;
  dub.totalEpisodes = totalEpisodes;

  const episodes = buildEpisodes(anizip, sub.latestEpisode?.number ?? null, dub.latestEpisode?.number ?? null);

  // Show missing from the sub timetable but with aired ani.zip entries - recover the latest sub number.
  if (!sub.latestEpisode) {
    const recovered = latestFromEpisodes(episodes);
    if (recovered != null) sub.latestEpisode = { number: recovered, airedAt: null };
  }

  // Backfill airedAt from ani.zip air dates when the timetable didn't provide it.
  const nowMs = Date.now();
  for (const track of [sub, dub]) {
    if (!track.latestEpisode || track.latestEpisode.airedAt) continue;
    const ep = episodes.find((e) => Number(e.number) === Number(track.latestEpisode.number));
    if (ep?.airDate && new Date(ep.airDate).getTime() <= nowMs) track.latestEpisode.airedAt = ep.airDate;
  }

  return {
    anilistId,
    malId,
    route: route || null,
    titles: {
      romaji: anilist?.title?.romaji || detail?.names?.romaji || subTt?.romaji || anizip?.titles?.en || route || null,
      english: anilist?.title?.english || detail?.names?.english || subTt?.english || anizip?.titles?.en || null,
      native: anilist?.title?.native || detail?.names?.native || subTt?.native || anizip?.titles?.ja || null,
    },
    anilist: anilist || null,
    schedule: detail
      ? {
          status: detail.status,
          season: detail.season || null,
          genres: (detail.genres || []).map((g) => g.name),
          studios: (detail.studios || []).map((s) => s.name),
          mediaTypes: (detail.mediaTypes || []).map((m) => m.name),
          lengthMin: detail.lengthMin ?? null,
          description: detail.description || null,
          streams: subTt?.streams || dubTt?.streams || [],
          subTime: isRealDate(detail.subTime) ? detail.subTime : null,
          dubTime: isRealDate(detail.dubTime) ? detail.dubTime : null,
          subDelayedUntil: isRealDate(detail.subDelayedUntil) ? detail.subDelayedUntil : null,
          dubDelayedUntil: isRealDate(detail.dubDelayedUntil) ? detail.dubDelayedUntil : null,
        }
      : null,
    sub,
    dub,
    episodes,
    // Numbered episodes only - specials stay in the episode list but don't inflate the count.
    episodeCount: episodes.filter((e) => Number.isFinite(Number(e.number))).length || totalEpisodes,
    updatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// On-demand fetch for a single anime (any AniList/MAL ID, airing or not)
// ---------------------------------------------------------------------------

const inflight = new Map();

async function ensureAnimeInner({ anilistId = null, malId = null, force = false } = {}) {
  anilistId = anilistId ? Number(anilistId) : null;
  malId = malId ? Number(malId) : null;

  const index = readIndexSafe();
  const file =
    (anilistId && index.byAnilistId[String(anilistId)]) || (malId && index.byMalId[String(malId)]) || null;
  const existing = file ? loadRecordSafe(file) : null;

  if (existing) {
    anilistId = anilistId || existing.anilistId;
    malId = malId || existing.malId || null;
    if (!force && Date.now() - new Date(existing.updatedAt).getTime() < REFRESH_STALE_MS) {
      return { record: existing, fetched: false };
    }
  }

  // MAL ID only: resolve it to an AniList ID (AniList first, ani.zip as fallback).
  if (!anilistId && malId) {
    let media = await fetchAnilistMediaByMal(malId);
    if (!media) {
      const anizipMal = await fetchAnizipByMal(malId);
      const id = anizipMal?.mappings?.anilist_id;
      if (id) media = await fetchAnilistMedia(id);
    }
    if (media?.id) anilistId = media.id;
  }
  if (!anilistId) return null;

  const media = await fetchAnilistMedia(anilistId);
  const anizip = await fetchAnizip(anilistId);
  if (!media && !anizip) return null;

  const record = buildRecord({
    route: existing?.route || null,
    subTt: null,
    dubTt: null,
    detail: null,
    anilist: media,
    anizip,
  });
  record.anilistId = record.anilistId || anilistId;
  record.malId = record.malId || malId || null;

  // Keep schedule/dub info captured by an earlier sync if this show has since
  // left the timetables (the on-demand path can't see them).
  if (existing) {
    if (existing.schedule && !record.schedule) record.schedule = existing.schedule;
    if (existing.dub?.available && !record.dub.available) record.dub = existing.dub;
  }

  saveRecord(record);
  return { record, fetched: true };
}

/** De-duplicates concurrent on-demand fetches for the same show. */
function ensureAnime(opts = {}) {
  const key = opts.anilistId ? `ani:${Number(opts.anilistId)}` : `mal:${Number(opts.malId)}`;
  if (inflight.has(key)) return inflight.get(key);
  const job = ensureAnimeInner(opts).finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

// ---------------------------------------------------------------------------
// Full sync pipeline
// ---------------------------------------------------------------------------

async function runSync({ force = false } = {}) {
  const startedAt = Date.now();
  forceCacheBypass = !!force;
  const token = readToken();
  const asHeaders = { Authorization: `Bearer ${token}`, Accept: 'application/json' };

  for (const dir of [ANIME_DIR, ROUTE_CACHE_DIR, ANILIST_CACHE_DIR, ANIZIP_CACHE_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // 1) Timetables - the current week of sub + dub airings.
  console.log('[sync] Fetching AnimeSchedule timetables (sub + dub)...');
  const [subTt, dubTt] = await Promise.all([
    fetchTimetable('sub', asHeaders),
    fetchTimetable('dub', asHeaders),
  ]);
  const subByRoute = indexBy(subTt, 'route');
  const dubByRoute = indexBy(dubTt, 'route');
  const routes = [...new Set([...Object.keys(subByRoute), ...Object.keys(dubByRoute)])];
  console.log(`[sync] ${subTt.length} sub entries + ${dubTt.length} dub entries -> ${routes.length} unique shows`);

  // 2) Per-show details (only place MAL/AniList IDs live, inside websites URLs).
  const details = {};
  for (let i = 0; i < routes.length; i++) {
    const route = routes[i];
    const { detail, fromCache } = await fetchRouteDetails(route, asHeaders);
    details[route] = detail;
    if (!fromCache) await delay(350); // rate-limit courtesy on actual network fetches
  }
  console.log(`[sync] Fetched/refreshed ${routes.length} show details`);

  // 3) Resolve IDs; shows without an AniList ID can't be keyed for the API.
  const anilistIdByRoute = {};
  const malIdByRoute = {};
  const unmapped = [];
  for (const route of routes) {
    const detail = details[route];
    const ani = extractIdFromUrl(detail?.websites?.aniList, /anilist\.co\/anime\/(\d+)/);
    const mal = extractIdFromUrl(detail?.websites?.mal, /myanimelist\.net\/anime\/(\d+)/);
    if (ani) {
      anilistIdByRoute[route] = ani;
      malIdByRoute[route] = mal;
    } else {
      unmapped.push({
        route,
        title: detail?.names?.english || detail?.names?.romaji || route,
        hasSub: !!subByRoute[route],
        hasDub: !!dubByRoute[route],
      });
    }
  }
  const uniqueAnilistIds = [...new Set(Object.values(anilistIdByRoute))];
  console.log(`[sync] ${uniqueAnilistIds.length} shows mapped to AniList IDs (${unmapped.length} unmapped)`);

  // 4) AniList metadata, 50 IDs per request.
  const anilistById = {};
  for (let i = 0; i < uniqueAnilistIds.length; i += ANILIST_BATCH_SIZE) {
    const chunk = uniqueAnilistIds.slice(i, i + ANILIST_BATCH_SIZE);
    const media = await fetchAnilistBatch(chunk);
    for (const m of media) anilistById[m.id] = m;
    if (i + ANILIST_BATCH_SIZE < uniqueAnilistIds.length) await delay(2000);
  }
  console.log(`[sync] AniList metadata ready for ${Object.keys(anilistById).length} shows`);

  // 5) Per-episode data from ani.zip.
  const anizipById = {};
  for (let i = 0; i < uniqueAnilistIds.length; i++) {
    const id = uniqueAnilistIds[i];
    anizipById[id] = await fetchAnizip(id);
    await delay(400);
  }
  console.log(`[sync] ani.zip episode data ready`);

  // 6) Merge everything into one record per show.
  const index = { generatedAt: null, count: 0, byAnilistId: {}, byMalId: {} };
  let written = 0;

  for (const route of Object.keys(anilistIdByRoute)) {
    const anilistId = anilistIdByRoute[route];
    if (index.byAnilistId[String(anilistId)]) continue; // two routes resolving to one show

    const record = buildRecord({
      route,
      subTt: subByRoute[route],
      dubTt: dubByRoute[route],
      detail: details[route],
      anilist: anilistById[anilistId] || null,
      anizip: anizipById[anilistId] || null,
    });
    if (!record.malId && malIdByRoute[route]) record.malId = malIdByRoute[route];

    const file = `${anilistId}.json`;
    fs.writeFileSync(path.join(ANIME_DIR, file), JSON.stringify(record, null, 2), 'utf-8');
    index.byAnilistId[String(anilistId)] = file;
    if (record.malId) index.byMalId[String(record.malId)] = file;
    written++;
  }

  // 7) Carry over on-demand records (shows not on the timetables) and refresh stale ones.
  const oldIndex = readIndexSafe();
  const staleCandidates = [];
  for (const [id, file] of Object.entries(oldIndex.byAnilistId || {})) {
    if (index.byAnilistId[id]) continue;
    const record = loadRecordSafe(file);
    if (!record) continue;
    index.byAnilistId[id] = file;
    if (record.malId) index.byMalId[String(record.malId)] = file;
    if (Date.now() - new Date(record.updatedAt).getTime() > REFRESH_STALE_MS) staleCandidates.push(record);
  }
  writeIndex(index);

  fs.writeFileSync(
    path.join(DATA_DIR, 'unmapped.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), shows: unmapped }, null, 2),
    'utf-8'
  );

  let refreshed = 0;
  for (const record of staleCandidates.slice(0, MAX_STALE_REFRESH_PER_CYCLE)) {
    try {
      await ensureAnime({ anilistId: record.anilistId, force: true });
      refreshed++;
      await delay(800);
    } catch (err) {
      console.log(`[sync] refresh failed for anilist ${record.anilistId}: ${err.message}`);
    }
  }

  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  const stats = {
    seconds: Number(seconds),
    timetableRecords: written,
    refreshedStale: refreshed,
    unmapped: unmapped.length,
    totalRecords: index.count,
  };
  console.log(`[sync] Done in ${seconds}s:`, JSON.stringify(stats));
  return stats;
}

// CLI entry point - when required as a module (server.js) nothing runs automatically.
if (require.main === module) {
  runSync({ force: process.argv.includes('--force') })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Sync failed:', err);
      process.exit(1);
    });
}

module.exports = { runSync, ensureAnime, readIndexSafe, REFRESH_STALE_MS };
