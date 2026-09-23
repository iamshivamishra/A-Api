#!/usr/bin/env node
/**
 * Zero-dependency API server over the database built by scripts/sync.js.
 *
 * It runs itself - start it once and leave it:
 *   - On boot it syncs immediately (if data/ is empty this builds the whole database first).
 *   - It re-syncs every AUTO_UPDATE_MINUTES (default 60) so episodes, next releases
 *     and metadata stay current.
 *   - If you request an anime that isn't saved yet (any AniList or MAL ID), it is
 *     fetched on demand from AniList + ani.zip, saved, and then served.
 *
 *   GET /anime                        -> summary list of every saved anime
 *   GET /status                       -> sync state (last run, next run, record count)
 *   GET /anime/ani/:anilistId         -> complete anime record by AniList ID
 *   GET /anime/mal/:malId             -> complete anime record by MAL ID
 *   GET /anime/ani/episode/:anilistId -> episode list + sub/dub availability by AniList ID
 *   GET /anime/mal/episode/:malId     -> episode list + sub/dub availability by MAL ID
 *
 * The full-record endpoints accept ?episodes=false to leave out the episode array,
 * and ?pretty=1 for human-readable JSON.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const { runSync, ensureAnime, readIndexSafe, REFRESH_STALE_MS } = require('./scripts/sync.js');

const PORT = Number(process.env.PORT || 3000);
const AUTO_UPDATE_MS = (Number(process.env.AUTO_UPDATE_MINUTES) || 60) * 60 * 1000;
const DATA_DIR = path.join(__dirname, 'data');
const INDEX_FILE = path.join(DATA_DIR, 'index.json');

const USAGE = {
  endpoints: {
    'GET /anime': 'summary list of all saved anime',
    'GET /status': 'sync state (last run, next run, record count)',
    'GET /anime/ani/:anilistId': 'complete anime record by AniList ID (?episodes=false to skip episode list)',
    'GET /anime/mal/:malId': 'complete anime record by MAL ID',
    'GET /anime/ani/episode/:anilistId': 'episode list + sub/dub availability by AniList ID',
    'GET /anime/mal/episode/:malId': 'episode list + sub/dub availability by MAL ID',
  },
  hint: 'Unknown IDs are fetched on demand and saved automatically.',
};

// ---------------------------------------------------------------------------
// Sync lifecycle
// ---------------------------------------------------------------------------

const state = {
  ready: fs.existsSync(INDEX_FILE),
  syncing: false,
  lastSyncAt: null,
  lastSyncError: null,
  lastSyncStats: null,
};

async function syncOnce() {
  if (state.syncing) return;
  state.syncing = true;
  try {
    state.lastSyncStats = await runSync();
    state.lastSyncAt = new Date().toISOString();
    state.lastSyncError = null;
    state.ready = true;
  } catch (err) {
    state.lastSyncError = err.message;
    console.error('[server] sync failed:', err.message);
  } finally {
    state.syncing = false;
  }
}

function send(res, status, body, pretty) {
  const json = JSON.stringify(body, null, pretty ? 2 : 0);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(json);
}

function loadRecord(file) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'anime', file), 'utf-8'));
}

/** Tolerant variant: returns null for missing/corrupt files (e.g. stale index entries). */
function loadRecordSafe(file) {
  try {
    return loadRecord(file);
  } catch {
    return null;
  }
}

function resolveFile(index, kind, id) {
  const map = kind === 'ani' ? index.byAnilistId : index.byMalId;
  return map[String(id)] || null;
}

/** Episode-focused payload: tracks + episodes, without the heavy AniList metadata. */
function episodePayload(record) {
  return {
    anilistId: record.anilistId,
    malId: record.malId,
    titles: record.titles,
    episodeCount: record.episodeCount,
    sub: record.sub,
    dub: record.dub,
    episodes: record.episodes,
    updatedAt: record.updatedAt,
  };
}

function summaryOf(record) {
  return {
    anilistId: record.anilistId,
    malId: record.malId,
    titles: record.titles,
    status: record.schedule?.status || record.anilist?.status || null,
    episodeCount: record.episodeCount,
    sub: { available: record.sub.available, latestEpisode: record.sub.latestEpisode, nextRelease: record.sub.nextRelease },
    dub: { available: record.dub.available, latestEpisode: record.dub.latestEpisode, nextRelease: record.dub.nextRelease },
    coverImage: record.anilist?.coverImage?.large || null,
  };
}

/** Serves a record, kicking off a background refresh when it has gone stale. */
function serveRecord(res, record, query, pretty) {
  if (Date.now() - new Date(record.updatedAt).getTime() > REFRESH_STALE_MS) {
    ensureAnime({ anilistId: record.anilistId, force: true }).catch(() => {});
  }
  const body = query.get('episodes') === 'false' ? { ...record, episodes: undefined } : record;
  return send(res, 200, body, pretty);
}

/**
 * Finds a record by kind+id; on a miss (including stale index entries), fetches it
 * on demand and saves it. Returns null when nothing has it.
 */
async function findOrFetch(kind, id) {
  const index = readIndexSafe();
  const file = resolveFile(index, kind, id);
  if (file) {
    const record = loadRecordSafe(file);
    if (record) return record;
  }

  const opts = kind === 'ani' ? { anilistId: Number(id) } : { malId: Number(id) };
  const ensured = await ensureAnime(opts);
  return ensured?.record || null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  const pretty = url.searchParams.get('pretty') === '1';

  try {
    if (pathname === '/' || pathname === '') return send(res, 200, USAGE, true);

    if (pathname === '/status') {
      return send(res, 200, {
        ready: state.ready,
        syncing: state.syncing,
        lastSyncAt: state.lastSyncAt,
        lastSyncError: state.lastSyncError,
        lastSyncStats: state.lastSyncStats,
        autoUpdateMinutes: AUTO_UPDATE_MS / 60000,
        nextSyncIn: state.syncing ? 0 : Math.max(0, Math.ceil((state.lastSyncAt ? new Date(state.lastSyncAt).getTime() + AUTO_UPDATE_MS - Date.now() : 0) / 1000)),
        records: state.ready ? readIndexSafe().count : 0,
      }, true);
    }

    if (pathname === '/anime') {
      const index = readIndexSafe();
      const list = Object.values(index.byAnilistId)
        .map((f) => loadRecordSafe(f))
        .filter(Boolean)
        .map(summaryOf);
      return send(res, 200, { count: list.length, anime: list }, pretty);
    }

    // /anime/<ani|mal>/episode/<id> must match before /anime/<ani|mal>/<id>
    const episodeMatch = pathname.match(/^\/anime\/(ani|mal)\/episode\/(\d+)$/);
    const fullMatch = pathname.match(/^\/anime\/(ani|mal)\/(\d+)$/);

    if (episodeMatch) {
      const record = await findOrFetch(episodeMatch[1], episodeMatch[2]);
      if (!record) {
        return send(res, 404, { error: `No anime found for ${episodeMatch[1]} id ${episodeMatch[2]} (not in the database and not resolvable via AniList/ani.zip)` }, pretty);
      }
      return send(res, 200, episodePayload(record), pretty);
    }

    if (fullMatch) {
      const record = await findOrFetch(fullMatch[1], fullMatch[2]);
      if (!record) {
        return send(res, 404, { error: `No anime found for ${fullMatch[1]} id ${fullMatch[2]} (not in the database and not resolvable via AniList/ani.zip)` }, pretty);
      }
      return serveRecord(res, record, url.searchParams, pretty);
    }

    return send(res, 404, { error: 'Unknown route', ...USAGE }, true);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return send(res, 503, { error: 'Database not built yet - the first sync is running, try again shortly.' }, true);
    }
    return send(res, 500, { error: err.message }, pretty);
  }
});

server.listen(PORT, () => {
  console.log(`[server] anime-api listening on http://localhost:${PORT}`);
  console.log(`[server] auto-update every ${AUTO_UPDATE_MS / 60000} min`);
  if (!state.ready) console.log('[server] database is empty - building it now (first sync)...');
  syncOnce(); // refresh immediately on boot, then keep it fresh on a timer
  setInterval(syncOnce, AUTO_UPDATE_MS);
});
