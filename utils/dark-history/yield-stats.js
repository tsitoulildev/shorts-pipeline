// Real numbers for the Dark History yield: per day, per role (writer, verifier, judge, relevance) and model: successes and failures; and a histogram of
// the reasons a script was rejected. Stored in two small tables (created on first use) so a restart does not lose them.
// Roles are what the caller passes as `role` to AITextService.generateText; the vision judges report themselves.

/** One note of the creative review (or a job error) -> a short cause. */
function classifyNote(note) {
  const text = String(note || '');
  if (/amount "[^"]+" is not in its evidence/.test(text)) return 'number word not in evidence';
  if (/number "[^"]*" is not in its evidence/.test(text)) return 'number not in evidence';
  if (/evidence not found verbatim/.test(text)) return 'evidence not verbatim';
  if (/does not appear in the source|invented quotation/.test(text)) return 'name or quote not in source';
  if (/the source does not support/.test(text)) return 'sentence not supported';
  if (/picture does not show|the check gave no verdict/.test(text)) return 'picture does not fit';
  if (/at least 4 beats|only \d+ beats are narrated|script has \d+ beats/.test(text)) return 'too few beats narrated';
  if (/words for \d+ picture/.test(text)) return 'beat too long for its picture';
  if (/narration is \d+ words/.test(text)) return 'word count';
  if (/hook/.test(text)) return 'hook length';
  if (/semicolons|dashes/.test(text)) return 'semicolons or dashes';
  if (/plain ASCII/.test(text)) return 'not plain ASCII';
  if (/sentence\(s\) run past|too thin/.test(text)) return 'sentence or beat length';
  if (/only \d+ (distinct pictures|beats have a picture)/.test(text)) return 'story not eligible (pictures)';
  if (/cut off by the token/.test(text)) return 'reply cut off';
  if (/Unexpected end of JSON|no title\/beats|Unterminated|JSON/.test(text)) return 'unusable reply';
  if (/keeps one picture on screen/.test(text)) return 'image held too long';
  return 'other';
}

/** The causes of one failed job: every note of every attempt when there are some, else the error message. */
function causesOf(error) {
  const notes = [];
  // creative-review keeps its attempts in `reviewAttempts` (releaseAfterFailure overwrites `attempts` with the story's attempt count, a number)
  const attempts = Array.isArray(error?.reviewAttempts) ? error.reviewAttempts : (Array.isArray(error?.attempts) ? error.attempts : []);
  for (const attempt of attempts) for (const note of attempt.notes || []) notes.push(note);
  const causes = notes.length ? notes.flatMap(note => String(note).split('||')).map(classifyNote) : [classifyNote(error?.message)];
  return causes;
}

const today = () => new Date().toISOString().slice(0, 10);

class YieldStats {
  constructor(db) { this.db = db; this.ready = false; }

  async ensure() {
    if (this.ready) return;
    await this.db.executeQuery('CREATE TABLE IF NOT EXISTS dh_llm_stats (day TEXT, role TEXT, model TEXT, ok INTEGER DEFAULT 0, failed INTEGER DEFAULT 0, timeout INTEGER DEFAULT 0, empty INTEGER DEFAULT 0, rate_limited INTEGER DEFAULT 0, PRIMARY KEY (day, role, model))');
    await this.db.executeQuery('CREATE TABLE IF NOT EXISTS dh_rejections (day TEXT, cause TEXT, n INTEGER DEFAULT 0, PRIMARY KEY (day, cause))');
    await this.db.executeQuery('CREATE TABLE IF NOT EXISTS dh_hourly (hour TEXT PRIMARY KEY, attempts INTEGER, successes INTEGER, r429 INTEGER, calls TEXT, queue INTEGER, cap INTEGER, throttled INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP)');
    this.ready = true;
  }

  /** Today's LLM calls and rate limits (all roles), and the calls per provider: the baseline of a slot's 429 limiter and of the hourly row. */
  async totals() {
    await this.ensure();
    const rows = await this.db.getAllRows('SELECT model, SUM(ok + failed) AS calls, SUM(rate_limited) AS r429 FROM dh_llm_stats WHERE day = ? GROUP BY model', [today()]);
    const byProvider = {};
    for (const row of rows) { const provider = String(row.model).split(':')[0]; byProvider[provider] = (byProvider[provider] || 0) + Number(row.calls || 0); }
    return { calls: rows.reduce((n, r) => n + Number(r.calls || 0), 0), r429: rows.reduce((n, r) => n + Number(r.r429 || 0), 0), byProvider };
  }

  /** One row per hourly check: attempts, successes, rate limits and calls per provider since the check began, the queue length, the attempt cap used. */
  async hourly(row) {
    await this.ensure();
    await this.db.executeQuery('INSERT OR REPLACE INTO dh_hourly (hour, attempts, successes, r429, calls, queue, cap, throttled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [row.hour, row.attempts, row.successes, row.r429, JSON.stringify(row.calls || {}), row.queue, row.cap, row.throttled ? 1 : 0]);
  }

  /** event: { role, provider, model, outcome: 'ok' | 'timeout' | 'empty' | 'rate_limited' | 'failed' } */
  async llmEvent(event) {
    await this.ensure();
    const model = `${event.provider}:${event.model}`;
    const role = event.role || 'other';
    const set = event.outcome === 'ok' ? 'ok = ok + 1'
      : ['timeout', 'empty', 'rate_limited'].includes(event.outcome) ? `failed = failed + 1, ${event.outcome} = ${event.outcome} + 1` : 'failed = failed + 1';
    await this.db.executeQuery('INSERT OR IGNORE INTO dh_llm_stats (day, role, model) VALUES (?, ?, ?)', [today(), role, model]);
    await this.db.executeQuery(`UPDATE dh_llm_stats SET ${set} WHERE day = ? AND role = ? AND model = ?`, [today(), role, model]);
  }

  async jobFailure(error) {
    await this.ensure();
    for (const cause of causesOf(error)) {
      await this.db.executeQuery('INSERT OR IGNORE INTO dh_rejections (day, cause) VALUES (?, ?)', [today(), cause]);
      await this.db.executeQuery('UPDATE dh_rejections SET n = n + 1 WHERE day = ? AND cause = ?', [today(), cause]);
    }
  }

  /** Yield per day (jobs table) + the model table + the rejection histogram, for the last `days` days. */
  async report(days = 7) {
    await this.ensure();
    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const jobs = await this.db.getAllRows("SELECT substr(created_at,1,10) AS day, source, SUM(status = 'completed') AS completed, SUM(status = 'failed') AS failed, COUNT(*) AS jobs FROM generation_jobs WHERE style = 'documentary' AND substr(created_at,1,10) >= ? GROUP BY day, source ORDER BY day, source", [since]);
    const models = await this.db.getAllRows('SELECT day, role, model, ok, failed, timeout, empty, rate_limited FROM dh_llm_stats WHERE day >= ? ORDER BY day, role, ok DESC', [since]);
    const causes = await this.db.getAllRows('SELECT day, cause, n FROM dh_rejections WHERE day >= ? ORDER BY day, n DESC', [since]);
    const hourly = await this.db.getAllRows('SELECT hour, attempts, successes, r429, calls, queue, cap, throttled FROM dh_hourly WHERE hour >= ? ORDER BY hour', [new Date(Date.now() - days * 86400000).toISOString().slice(0, 13)]);
    return { since, jobs, models, causes, hourly };
  }
}

module.exports = { YieldStats, classifyNote, causesOf };
