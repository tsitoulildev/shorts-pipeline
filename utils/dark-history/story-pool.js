// The story pool: researched stories with verified source text and downloaded, license-checked images,
// ready to be turned into a Short. Backed by one SQLite table (created on first use).
const crypto = require('crypto');

// Days of stories the pool should hold; DARK_HISTORY_POOL_HORIZON_DAYS overrides it (unset or invalid: 14).
const TARGET_DAYS = Number(process.env.DARK_HISTORY_POOL_HORIZON_DAYS) > 0 ? Number(process.env.DARK_HISTORY_POOL_HORIZON_DAYS) : 14;
// a story whose production failed this many times is rejected for good (with the last reason) instead of looping every tick
const MAX_ATTEMPTS = 3;

/** Days of content the ready stories cover at the given cadence (stories per week). */
const poolDays = (ready, perWeek) => (perWeek > 0 ? (ready * 7) / perWeek : Infinity);

/**
 * Cadence the pool can sustain: the full target while >= horizonDays are in stock, otherwise the ready
 * stories are spread over the horizon (never below 1/week while anything is ready, 0 when empty).
 */
function allowedCadencePerWeek(ready, perWeek, horizonDays = TARGET_DAYS) {
  if (ready <= 0) return 0;
  if (poolDays(ready, perWeek) >= horizonDays) return perWeek;
  return Math.max(1, Math.min(perWeek, Math.floor((ready * 7) / horizonDays)));
}

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

  async readyCount() {
    await this.ensure();
    return (await this.db.getRow("SELECT COUNT(*) AS n FROM story_pool WHERE status = 'ready'")).n;
  }

  /** Oldest ready story, atomically marked used. null when the pool is empty. */
  async claimNext() {
    await this.ensure();
    const row = await this.db.getRow("SELECT * FROM story_pool WHERE status = 'ready' ORDER BY attempts, created_at, rowid LIMIT 1");
    if (!row) return null;
    const { changes } = await this.db.executeQuery("UPDATE story_pool SET status = 'used', used_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'ready'", [row.id]);
    return changes ? { ...row, plan: JSON.parse(row.plan), share_alike: Boolean(row.share_alike) } : this.claimNext();
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
    const text = String(reason || '').replace(/\s+/g, ' ').slice(0, 300);
    await this.db.executeQuery('UPDATE story_pool SET status = ?, attempts = ?, reason = ?, used_at = NULL WHERE id = ?',
      [rejected ? 'rejected' : 'ready', attempts, rejected ? `production failed ${attempts} times, last: ${text}` : (text || null), id]);
    return { status: rejected ? 'rejected' : 'ready', attempts };
  }

  async status(perWeek) {
    const ready = await this.readyCount();
    const days = poolDays(ready, perWeek);
    return { ready, days, allowedPerWeek: allowedCadencePerWeek(ready, perWeek), low: days < TARGET_DAYS };
  }
}

module.exports = { StoryPool, poolDays, allowedCadencePerWeek, TARGET_DAYS, MAX_ATTEMPTS };
