/**
 * Vercel serverless version of server.js.
 *
 * Reads are served from MongoDB (populated by scripts/migrate-to-mongo.js,
 * or automatically by /api/sync — see that file). This function itself never
 * writes to MongoDB; it is a pure read API, which is what makes it safe to
 * run as a stateless serverless function.
 *
 * Because of the catch-all filename ([...slug].js) + the rewrite in
 * vercel.json, this one function serves all of:
 *
 *   GET /                              -> usage
 *   GET /status                        -> record count + last sync time
 *   GET /anime                         -> summary list of every saved anime
 *   GET /anime/ani/:anilistId          -> complete anime record by AniList ID
 *   GET /anime/mal/:malId              -> complete anime record by MAL ID
 *   GET /anime/ani/episode/:anilistId  -> episode list + sub/dub availability
 *   GET /anime/mal/episode/:malId      -> episode list + sub/dub availability
 *
 * Same query params as before: ?episodes=false and ?pretty=1.
 */

const { getDb } = require('../lib/mongo');

const USAGE = {
  endpoints: {
    'GET /anime': 'summary list of all saved anime',
    'GET /status': 'record count + last sync time',
    'GET /anime/ani/:anilistId': 'complete anime record by AniList ID (?episodes=false to skip episode list)',
    'GET /anime/mal/:malId': 'complete anime record by MAL ID',
    'GET /anime/ani/episode/:anilistId': 'episode list + sub/dub availability by AniList ID',
    'GET /anime/mal/episode/:malId': 'episode list + sub/dub availability by MAL ID',
  },
  hint: 'Data is refreshed periodically by /api/sync (see vercel.json cron). This endpoint only reads.',
};

function send(res, status, body, pretty) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(status).send(JSON.stringify(body, null, pretty ? 2 : 0));
}

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

module.exports = async (req, res) => {
  const slug = Array.isArray(req.query.slug) ? req.query.slug : [];
  const pathname = '/' + slug.join('/');
  const pretty = req.query.pretty === '1';

  try {
    const db = await getDb();
    const collection = db.collection('anime');

    if (pathname === '/' || pathname === '') return send(res, 200, USAGE, true);

    if (pathname === '/status') {
      const meta = await db.collection('meta').findOne({ _id: 'sync' });
      const records = await collection.countDocuments();
      return send(res, 200, {
        records,
        lastSyncAt: meta?.lastSyncAt || null,
        lastSyncStats: meta?.lastSyncStats || null,
      }, true);
    }

    if (pathname === '/anime') {
      const docs = await collection.find({}, { projection: { episodes: 0 } }).toArray();
      return send(res, 200, { count: docs.length, anime: docs.map(summaryOf) }, pretty);
    }

    const episodeMatch = pathname.match(/^\/anime\/(ani|mal)\/episode\/(\d+)$/);
    const fullMatch = pathname.match(/^\/anime\/(ani|mal)\/(\d+)$/);

    if (episodeMatch || fullMatch) {
      const [, kind, id] = episodeMatch || fullMatch;
      const field = kind === 'ani' ? 'anilistId' : 'malId';
      const record = await collection.findOne({ [field]: Number(id) });

      if (!record) {
        return send(res, 404, { error: `No anime found for ${kind} id ${id}. It may not have been synced yet — try /api/sync.` }, pretty);
      }

      if (episodeMatch) return send(res, 200, episodePayload(record), pretty);

      const body = req.query.episodes === 'false' ? { ...record, episodes: undefined } : record;
      return send(res, 200, body, pretty);
    }

    return send(res, 404, { error: 'Unknown route', ...USAGE }, true);
  } catch (err) {
    return send(res, 500, { error: err.message }, pretty);
  }
};