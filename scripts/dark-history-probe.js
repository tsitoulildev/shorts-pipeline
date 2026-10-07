// Live check: node scripts/dark-history-probe.js "Mary Celeste" [--no-llm] [--html] [--record]
// --html writes a contact sheet (data/dark-history-reports/contact-<title>.html) you can open in a browser.
// Prints whether the story has licensed footage for every beat. --record saves the HTTP responses as test fixtures.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { defaultHttp } = require('../utils/dark-history/http');
const { planFootage } = require('../utils/dark-history/footage');
const { makeLlmJudge } = require('../utils/dark-history/relevance-judge');
const { attributionText } = require('../utils/dark-history/attribution');
const { contactSheetHtml } = require('../utils/dark-history/contact-sheet');

const FIXTURES = path.join(__dirname, 'fixtures', 'dark-history');
const key = (url, params) => crypto.createHash('sha1').update(JSON.stringify([url, params || null])).digest('hex');

/** Recorded-fixture client: same interface as the live one, reads <sha1>.json from scripts/fixtures/dark-history. */
const fixtureHttp = {
  async getJson(url, params) {
    const file = path.join(FIXTURES, `${key(url, params)}.json`);
    // searches that were never recorded (judge-path queries) behave as "no results"
    if (!fs.existsSync(file) && params?.generator === 'search') return { query: { pages: [] } };
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  },
  async getBuffer(url) { return Buffer.from(String(url)); }
};

const recordingHttp = {
  async getJson(url, params) {
    const data = await defaultHttp.getJson(url, params);
    fs.mkdirSync(FIXTURES, { recursive: true });
    fs.writeFileSync(path.join(FIXTURES, `${key(url, params)}.json`), JSON.stringify(data));
    return data;
  },
  getBuffer: url => defaultHttp.getBuffer(url)
};

async function main() {
  const title = process.argv[2] || 'Mary Celeste';
  let judge = null;
  if (!process.argv.includes('--no-llm')) {
    require('dotenv').config();
    const { AITextService } = require('../utils/ai-text-service');
    judge = makeLlmJudge(new AITextService({}));
  }
  const plan = await planFootage(title, { http: process.argv.includes('--record') ? recordingHttp : defaultHttp, judge });
  console.log(`${plan.article.title}: eligible=${plan.eligible} (${plan.reason}); shareAlike=${plan.shareAlike}`);
  for (const beat of plan.beats) {
    console.log(`- ${beat.heading}: ${beat.images.map(i => `${i.title} [${i.license}${i.owned ? ', placed by Wikipedia editors' : ', LLM-approved'}]`).join('; ') || 'NO FOOTAGE'}`);
  }
  if (process.argv.includes('--html')) {
    const result = {
      title: plan.article.title, editorPlacedOnly: { eligible: plan.eligible }, withJudge: { eligible: plan.eligible, reason: plan.reason, shareAlike: plan.shareAlike },
      beats: plan.beats.map(b => ({ heading: b.heading, text: b.text, unused: b.unused, images: b.images.map(i => ({ ...i, source: i.owned ? 'editor-placed' : 'LLM-approved' })) })), diagnostics: plan.diagnostics
    };
    const dir = path.join(__dirname, '..', 'data', 'dark-history-reports');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `contact-${plan.article.title.replace(/[^a-z0-9]+/gi, '_')}.html`);
    fs.writeFileSync(file, contactSheetHtml([result]));
    console.log(`Contact sheet: ${file}`);
  }
  if (plan.eligible) console.log(`
Description credit:
${attributionText(plan.article, plan.beats)}`);
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exit(1); });
module.exports = { fixtureHttp };