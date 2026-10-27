// The story pool: researched stories with verified source text and downloaded, license-checked images,
// ready to be turned into a Short. Backed by one SQLite table (created on first use).
const crypto = require('crypto');

// The pool is "low" (alert only, never a slower cadence) when fewer ready stories than this are left (about three days at 3 Shorts a day).
const LOW_READY = Number(process.env.DARK_HISTORY_POOL_LOW_READY) > 0 ? Number(process.env.DARK_HISTORY_POOL_LOW_READY) : 10;
// a story whose production failed this many times is rejected for good (with the last reason) instead of looping every tick
const MAX_ATTEMPTS = 3;
// after this many failures a story is parked ('quarantine') and only taken again when no fresh story is left and QUARANTINE_HOURS have passed
const QUARANTINE_AFTER = 2;
const QUARANTINE_HOURS = 24;

// Themes that were watched about 2.5 times as often as ships and polar trips (median 739 views for bog bodies, 278 ships, 154 polar; 3 weeks, small sample):
// bodies and remains, archaeological finds, unsolved or unexplained cases. Among stories with the SAME number of failed attempts such a story goes first, but
// never more than 2 of every 3 Shorts, so the channel keeps its variety. Picture and licence rules are not touched: only the order in the pool changes.
const PRIORITY_THEME = /\b(bog bod(?:y|ies)|mumm(?:y|ies)|skeleton\w*|human remains|bodies|corpse\w*|archaeolog\w*|excavat\w*|burial|tomb|artifact|artefact|unsolved|mystery|disappear\w*|vanish\w*|hoax|unidentified|unexplained)\b/i;
const themeOf = row => {
  let extract = '';
  try { extract = String(JSON.parse(row.plan || '{}').extract || '').slice(0, 700); } catch (_error) { extract = ''; }
  return PRIORITY_THEME.test(`${row.title || ''} ${extract}`);
};

/** Days of content the ready stories cover at the given cadence (stories per week). */
const poolDays = (ready, perWeek) => (perWeek > 0 ? (ready * 7) / perWeek : Infinity);

class StoryPool {
  constructor(db) { this.db = db; this.created = false; }

  async ensure() {
    if (this.created) return;
    await this.db.executeQuery(`CREATE TABLE IF NOT EXISTS story_pool (
      id TEXT PRIMARY KEY, title TEXT NOT NULL UNIQUE, status TEXT NOT NULL, article_url TEXT, revision_id INTEGER,
      plan TEXT, attribution TEXT, share_alike INTEGER DEFAULT 0, reason TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP, used_at TEXT, attempts INTEGER DEFAULT 0)`);
    // a table created before attempts existed
    const columns = await this.db.getAllRows('PRAGMA table_info(story_pool)');
    if (!columns.some(column => column.name === 'attempts')) await this.db.executeQuery('ALTER TABLE story_pool ADD COLUMN attempts INTEGER DEFAULT 0');
    this.created = true;
  }

  async knownTitles() {
    await this.ensure();
    return new Set((await this.db.getAllRows('SELECT title FROM story_pool')).map(r => r.title.toLowerCase()));
  }

  /** status: 'ready' (plan + images on disk) or 'rejected' (reason says why, so it is not retried). */
  async add({ title, status, articleUrl = null, revisionId = null, plan = null, attribution = null, shareAlike = false, reason = null }) {
    await this.ensure();
    const id = `story_${crypto.randomBytes(6).toString('hex')}`;
    await this.db.executeQuery(
      'INSERT OR REPLACE INTO story_pool (id, title, status, article_url, revision_id, plan, attribution, share_alike, reason) VALUES (?,?,?,?,?,?,?,?,?)',
      [id, title, status, articleUrl, revisionId, plan ? JSON.stringify(plan) : null, attribution, shareAlike ? 1 : 0, reason]
    );
    return id;
  }

  /** Ready stories that were never tried. */
  async untouchedCount() {
    await this.ensure();
    return (await this.db.getRow("SELECT COUNT(*) AS n FROM story_pool WHERE status = 'ready' AND COALESCE(attempts, 0) = 0")).n;
  }

  async readyCount() {
    await this.ensure();
    return (await this.db.getRow("SELECT COUNT(*) AS n FROM story_pool WHERE status = 'ready'")).n;
  }

  /**
   * The next story, atomically marked used: ready stories first (fewest failed attempts, richest material, oldest), then a quarantined story that has waited
   * QUARANTINE_HOURS. null when there is nothing to take.
   */
  async claimNext() {
    await this.ensure();
    let row;
    try {
      row = await this.db.getRow("SELECT * FROM story_pool WHERE status = 'ready' ORDER BY attempts, COALESCE(json_extract(plan, '$.richness'), 0) DESC, created_at, rowid LIMIT 1");
    } catch (_error) { // an SQLite without JSON1: the order without the richness
      row = await this.db.getRow("SELECT * FROM story_pool WHERE status = 'ready' ORDER BY attempts, created_at, rowid LIMIT 1");
    }
    if (row && !themeOf(row)) row = (await this.preferTheme(row)) || row;
    if (!row) row = await this.db.getRow("SELECT * FROM story_pool WHERE status = 'quarantine' AND used_at <= datetime('now', ?) ORDER BY attempts, used_at, rowid LIMIT 1", ['-' + QUARANTINE_HOURS + ' hours']);
    if (!row) return null;
    const { changes } = await this.db.executeQuery("UPDATE story_pool SET status = 'used', used_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('ready', 'quarantine')", [row.id]);
    return changes ? { ...row, plan: JSON.parse(row.plan), share_alike: Boolean(row.share_alike) } : this.claimNext();
  }

  /** The first story of the same attempt level that has a priority theme, unless 2 of the last 3 Shorts already had one (variety). null: keep \`row\`. */
  async preferTheme(row) {
    try {
      const recent = await this.db.getAllRows("SELECT title, plan FROM story_pool WHERE status = 'used' ORDER BY used_at DESC, rowid DESC LIMIT 3");
      if (recent.filter(themeOf).length >= 2) return null;
      const candidates = await this.db.getAllRows("SELECT * FROM story_pool WHERE status = 'ready' AND COALESCE(attempts, 0) = ? ORDER BY COALESCE(json_extract(plan, '$.richness'), 0) DESC, created_at, rowid LIMIT 60", [row.attempts || 0]);
      return candidates.find(themeOf) || null;
    } catch (_error) {
      return null;
    }
  }

  /**
   * A claimed story whose production failed goes back to 'ready' for the next tick, or becomes 'rejected' (with the reason)
   * once it has failed maxAttempts times. A failure that is not the story's fault (cancelled, restart) passes countAttempt: false.
   */
  async release(id, { reason = null, countAttempt = true, maxAttempts = MAX_ATTEMPTS } = {}) {
    await this.ensure();
    const row = await this.db.getRow('SELECT attempts FROM story_pool WHERE id = ?', [id]);
    if (!row) return null;
    const attempts = (row.attempts || 0) + (countAttempt ? 1 : 0);
    const rejected = attempts >= maxAttempts;
    const parked = !rejected && attempts >= QUARANTINE_AFTER;
    const text = String(reason || '').replace(/\s+/g, ' ').slice(0, 300);
    const status = rejected ? 'rejected' : parked ? 'quarantine' : 'ready';
    await this.db.executeQuery(`UPDATE story_pool SET status = ?, attempts = ?, reason = ?, used_at = ${parked ? 'CURRENT_TIMESTAMP' : 'NULL'} WHERE id = ?`,
      [status, attempts, rejected ? `production failed ${attempts} times, last: ${text}` : (text || null), id]);
    return { status, attempts };
  }

  async status(perWeek) {
    const ready = await this.readyCount();
    const days = poolDays(ready, perWeek);
    return { ready, days, low: ready < LOW_READY };
  }
}

module.exports = { StoryPool, poolDays, LOW_READY, MAX_ATTEMPTS, QUARANTINE_AFTER, QUARANTINE_HOURS };
