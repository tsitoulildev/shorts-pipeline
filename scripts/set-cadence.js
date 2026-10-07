// Operator tool: sets ONLY cadence_per_week on the existing channel strategy. Touches nothing
// else (no upload flags, no approval, no status). Used by the Deploy workflow input.
//   node scripts/set-cadence.js 21
const MIN = 1;
const MAX = 35;

function parseCadence(value) {
  const text = String(value ?? '').trim();
  if (!/^\d{1,2}$/.test(text)) throw new Error(`cadence must be a whole number between ${MIN} and ${MAX}, got "${text}"`);
  const number = Number(text);
  if (number < MIN || number > MAX) throw new Error(`cadence must be between ${MIN} and ${MAX}, got ${number}`);
  return number;
}

async function main() {
  const cadence = parseCadence(process.argv[2]);
  const { Database } = require('../database/db');
  const db = new Database();
  await db.initialize();
  try {
    const current = await db.getChannelStrategy();
    if (!current) {
      console.log(`CADENCE_UNCHANGED: no channel strategy exists yet; the built-in default (channel identity target x 7) applies until one is saved`);
      return;
    }
    const before = Number(current.cadence_per_week);
    await db.executeQuery(
      "UPDATE channel_strategies SET cadence_per_week = ?, updated_at = datetime('now') WHERE id = 'default'",
      [cadence]
    );
    const after = Number((await db.getChannelStrategy()).cadence_per_week);
    if (after !== cadence) throw new Error(`cadence write did not stick (expected ${cadence}, read ${after})`);
    console.log(`CADENCE_SET: ${before}/week -> ${after}/week (about ${(after / 7).toFixed(1)} Shorts a day)`);
  } finally {
    await db.close();
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(`CADENCE_FAILED: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { parseCadence, MIN, MAX };
