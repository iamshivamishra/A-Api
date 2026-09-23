const { MongoClient } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB || 'anime_api';

if (!MONGODB_URI) {
  console.error('[mongo] MONGODB_URI is not set. Add it in your Vercel project env vars.');
}

let cached = global.__mongoClientPromise;

function getClientPromise() {
  if (!cached) {
    const client = new MongoClient(MONGODB_URI);
    cached = client.connect();
    global.__mongoClientPromise = cached;
  }
  return cached;
}

async function getDb() {
  const client = await getClientPromise();
  return client.db(MONGODB_DB);
}

module.exports = { getDb, getClientPromise, MONGODB_DB };