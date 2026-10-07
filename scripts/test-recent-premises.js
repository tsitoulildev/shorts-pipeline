// Offline: the planner remembers premises from history, failed ideas and recent operator plans.
const assert = require('assert');
const { ContentStrategyAgent } = require('../agents/content-strategy-agent');

(async () => {
  const agent = Object.create(ContentStrategyAgent.prototype);
  agent.logger = { info() {}, warn() {}, error() {} };
  const daysAgo = days => new Date(Date.now() - days * 86400000).toISOString().replace('T', ' ').slice(0, 19);

  // content_history rows have publish_date, not createdAt (the old code dropped every one of them).
  agent.historicalPerformance = [
    { topic: 'A woman tests her smoke detector at three in the morning', publish_date: daysAgo(3) },
    { topic: 'Very old premise', publish_date: daysAgo(400) },
    { topic: 'A row without any date', publish_date: null }
  ];
  let topics = agent.getRecentTopics();
  assert.ok(topics.includes('A woman tests her smoke detector at three in the morning'), 'recent history row is remembered');
  assert.ok(!topics.includes('Very old premise'), 'rows older than 90 days are forgotten');
  assert.ok(topics.includes('A row without any date'), 'a row without a usable date is kept');

  // Failed ideas and operator plans count too.
  agent.db = {
    getAllRows: async sql => {
      if (sql.includes('FROM content_strategies')) return [{ topic: 'Strategy premise' }];
      if (sql.includes('FROM content_ideas')) return [{ topic: 'A failed idea about a digital clock' }, { topic: 'Strategy premise' }];
      if (sql.includes('FROM operator_runs')) return [{ plan: JSON.stringify([{ topic: 'Planned mirror premise' }]) }, { plan: 'not json' }];
      return [];
    }
  };
  const loaded = await agent.loadRecentPremises();
  assert.deepStrictEqual(loaded.sort(), ['A failed idea about a digital clock', 'Planned mirror premise', 'Strategy premise']);
  topics = agent.getRecentTopics();
  for (const expected of ['A failed idea about a digital clock', 'Planned mirror premise', 'A woman tests her smoke detector at three in the morning']) {
    assert.ok(topics.includes(expected), `${expected} is remembered`);
  }

  // A broken table never stops planning.
  agent.db = { getAllRows: async () => { throw new Error('no such table'); } };
  assert.deepStrictEqual(await agent.loadRecentPremises(), []);
  console.log('Recent premises: PASS');
})().catch(error => { console.error(error); process.exit(1); });
