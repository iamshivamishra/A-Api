#!/usr/bin/env node
/**
 * One-time (or repeatable) import of the local JSON database (data/anime/*.json)
 * into MongoDB.
 *
 * Usage:
 *   node scripts/migrate-to-mongo.js
 *
 * Config (env vars, can also go in .env):
 *   MONGODB_URI  - connection string (default: mongodb://localhost:27017)
 *   MONGODB_DB   - database name   (default: anime_api)
 *
 * Safe to re-run: each record is upserted by its anilistId, so running this
 * again after `npm run sync` just refreshes MongoDB with the latest data.
 */

const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');

// --- load .env manually (project has zero dependencies otherwise) ---------
function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnv();

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const MONGODB_DB = process.env.MONGODB_DB || 'anime_api';
const DATA_DIR = path.join(__dirname, '..', 'data');
const ANIME_DIR = path.join(DATA_DIR, 'anime');

async function main() {
  if (!fs.existsSync(ANIME_DIR)) {
    console.error(`No data found at ${ANIME_DIR}. Run "npm run sync" first.`);
    process.exit(1);
  }

  const files = fs.readdirSync(ANIME_DIR).filter((f) => f.endsWith('.json'));
  console.log(`Found ${files.length} anime records to import.`);

  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  console.log(`Connected to MongoDB at ${MONGODB_URI}`);

  const db = client.db(MONGODB_DB);
  const collection = db.collection('anime');

  // Useful lookups later on
  await collection.createIndex({ anilistId: 1 }, { unique: true });
  await collection.createIndex({ malId: 1 });

  let imported = 0;
  let failed = 0;

  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(ANIME_DIR, file), 'utf-8');
      const record = JSON.parse(raw);

      if (record.anilistId == null) {
        console.warn(`  skip ${file}: no anilistId`);
        continue;
      }

      await collection.updateOne(
        { anilistId: record.anilistId },
        { $set: record },
        { upsert: true }
      );
      imported++;
    } catch (err) {
      failed++;
      console.error(`  failed ${file}: ${err.message}`);
    }
  }

  console.log(`\nDone. Imported/updated: ${imported}, failed: ${failed}, total in DB: ${await collection.countDocuments()}`);

  await client.close();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});