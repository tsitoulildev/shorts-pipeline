// Real SQLite: the backup is a consistent, verified snapshot, rotated, and the age helper works.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3');
const { Database } = require('../database/db');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbbackup-'));
  const db = new Database();
  db.dbPath = path.join(dir, 'youtube_automation.db');
  db.db = new sqlite3.Database(db.dbPath);
  await db.executeQuery('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  await db.executeQuery("INSERT INTO t (v) VALUES ('one'), ('two')");

  assert.strictEqual(await db.latestBackupAgeMs(), null, 'no snapshot yet');
  const first = await db.backup({ keep: 2 });
  assert.ok(fs.existsSync(first), 'snapshot file exists');
  assert.ok(first.includes(`${path.sep}backups${path.sep}`), 'snapshots live in data/backups');

  const copy = new sqlite3.Database(first, sqlite3.OPEN_READONLY);
  const rows = await new Promise((res, rej) => copy.all('SELECT v FROM t ORDER BY id', (e, r) => (e ? rej(e) : res(r))));
  copy.close();
  assert.deepStrictEqual(rows.map(r => r.v), ['one', 'two'], 'snapshot has the data');

  await new Promise(r => setTimeout(r, 15));
  await db.backup({ keep: 2 });
  await new Promise(r => setTimeout(r, 15));
  const third = await db.backup({ keep: 2 });
  const names = fs.readdirSync(db.backupDirectory()).sort();
  assert.strictEqual(names.length, 2, 'only the newest 2 snapshots are kept');
  assert.ok(!fs.existsSync(first), 'the oldest snapshot was pruned');
  assert.ok(names.includes(path.basename(third)));
  assert.ok(!names.some(n => n.endsWith('.partial')), 'no partial files left');
  const age = await db.latestBackupAgeMs();
  assert.ok(age >= 0 && age < 60000, 'age of newest snapshot is known');

  // A failing backup leaves nothing half-written.
  const broken = new Database();
  broken.dbPath = db.dbPath;
  broken.db = { run: (q, p, cb) => cb(new Error('disk full')) };
  await assert.rejects(() => broken.backup(), /disk full/);
  assert.ok(!fs.readdirSync(db.backupDirectory()).some(n => n.endsWith('.partial')));

  db.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('DB backup: PASS');
})().catch(e => { console.error(e); process.exit(1); });
