/**
 * Triggers a full refresh: fetches AnimeSchedule + AniList + ani.zip (writing
 * to /tmp, the only writable path in a serverless function), then imports the
 * result into MongoDB.
 *
 * Call this:
 *   - Automatically, on the schedule set in vercel.json (Vercel Cron).
 *   - Manually, by visiting /api/sync?key=YOUR_SYNC_SECRET
 *
 * SYNC_SECRET (set it in Vercel's env vars) stops random visitors from
 * triggering syncs, which are slow and hit third-party rate limits. Vercel
 * Cron calls this without the key, so we also allow the special header Vercel
 * Cron sends.
 */

process.env.DATA_DIR = process.env.DATA_DIR || '/tmp/data';

const { runSync } = require('../scripts/sync.js');
const { importAll } = require('../scripts/migrate-to-mongo.js');
const { getDb } = require('../lib/mongo');

module.exports = async (req, res) => {
  const isVercelCron = req.headers['x-vercel-cron'] != null;
  const hasValidKey = process.env.SYNC_SECRET && req.query.key === process.env.SYNC_SECRET;

  if (!isVercelCron && !hasValidKey) {
    res.status(401).json({ error: 'Unauthorized. Pass ?key=SYNC_SECRET (set that env var in Vercel) or trigger via Vercel Cron.' });
    return;
  }

  try {
    const stats = await runSync();
    const db = await getDb();
    const importResult = await importAll(db);

    await db.collection('meta').updateOne(
      { _id: 'sync' },
      { $set: { lastSyncAt: new Date().toISOString(), lastSyncStats: stats, lastImport: importResult } },
      { upsert: true }
    );

    res.status(200).json({ ok: true, sync: stats, mongoImport: importResult });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
};