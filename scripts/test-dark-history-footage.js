// Offline: Dark History footage rules, against responses recorded from the real Wikipedia/Commons APIs
// (re-record with: node scripts/dark-history-probe.js "Mary Celeste" --record).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fixtureHttp } = require('./dark-history-probe');
const { toCandidate } = require('../utils/dark-history/commons');
const { splitSections } = require('../utils/dark-history/wikipedia');
const { planFootage, assign } = require('../utils/dark-history/footage');
const { makeLlmJudge } = require('../utils/dark-history/relevance-judge');
const { attributionText } = require('../utils/dark-history/attribution');
const { licenseRank } = require('../utils/dark-history/commons');
const { sectionImagesFromHtml } = require('../utils/dark-history/wikipedia');
const { downloadImage } = require('../utils/dark-history/commons');

const page = (license, extra = {}, size = { width: 1600, height: 1200 }) => ({
  title: 'File:Test.jpg',
  imageinfo: [{ ...size, mime: 'image/jpeg', url: 'u', descriptionurl: 'd', extmetadata: { LicenseShortName: { value: license }, Artist: { value: extra.artist ?? '<b>A. Painter</b>' }, Restrictions: extra.restrictions ? { value: extra.restrictions } : undefined } }]
});

(async () => {
  // License is checked per file: only free licenses pass, with attribution data kept.
  assert.ok(toCandidate(page('Public domain')).candidate);
  assert.strictEqual(toCandidate(page('Public domain')).candidate.author, 'A. Painter');
  assert.ok(toCandidate(page('CC BY-SA 4.0')).candidate);
  assert.ok(toCandidate(page('CC0')).candidate);
  assert.match(toCandidate(page('CC BY-NC 4.0')).rejected, /license/);
  assert.match(toCandidate(page('CC BY-ND 2.0')).rejected, /license/);
  assert.match(toCandidate(page('Fair use')).rejected, /license/);
  assert.match(toCandidate(page('')).rejected, /license/);
  assert.match(toCandidate(page('CC BY 4.0', { artist: '' })).rejected, /author/);
  assert.match(toCandidate(page('Public domain', { restrictions: 'personality' })).rejected, /restrictions/);
  assert.match(toCandidate(page('Public domain', {}, { width: 640, height: 480 })).rejected, /too small/);

  // Wikipedia text is split into sections; reference-style sections are dropped, sub-sections fold into the parent.
  const sections = splitSections('Lead text.\n\n\n== Voyage ==\nSailed.\n\n=== Storm ===\nRain.\n\n== References ==\nCited.');
  assert.deepStrictEqual(sections.map(s => s.heading), ['Introduction', 'Voyage']);
  assert.match(sections[1].text, /Sailed\.\nRain\./);

  // Images the Wikipedia editors placed inside a section are mapped to that section (lead = Introduction).
  const html = '<p><img src="//thumb.wikimedia.org/wikipedia/commons/thumb/1/1f/Lead_pic.jpg/330px-Lead_pic.jpg"></p><div><h2 id="A">Voyage<span>[edit]</span></h2><img src="//upload.wikimedia.org/wikipedia/commons/9/92/Ship%20one.jpg"><h2>Notes</h2></div>';
  const mapped = sectionImagesFromHtml(html);
  assert.deepStrictEqual(mapped.get('Introduction'), ['File:Lead pic.jpg']);
  assert.deepStrictEqual(mapped.get('Voyage'), ['File:Ship one.jpg']);

  // Real recorded story, editor-placed images only (no judge): eligible, provenance on every image, no reuse.
  const plan = await planFootage('Mary Celeste', { http: fixtureHttp });
  assert.strictEqual(plan.eligible, true, plan.reason);
  assert.ok(plan.beats.length >= 4 && plan.beats.length <= 7);
  const titles = plan.beats.flatMap(b => b.images.map(i => i.title));
  assert.ok(plan.beats.every(b => b.images.length >= 1 && b.images.every(i => i.owned)), 'every beat needs editor-placed footage');
  assert.strictEqual(new Set(titles).size, titles.length, 'no image may be used twice');
  assert.ok(!titles.some(t => /Solar system|Earth-moon/.test(t)));
  for (const image of plan.beats.flatMap(b => b.images)) {
    assert.ok(image.license && image.descriptionUrl && /^https:\/\/(upload|thumb)\.wikimedia\.org\//.test(image.fileUrl), `provenance missing for ${image.title}`);
  }
  assert.strictEqual(plan.article.license, 'CC BY-SA 4.0');
  assert.strictEqual(plan.shareAlike, false);

  // Attribution for the description: Wikipedia text credit and author, license, URL for every image.
  const credit = attributionText(plan.article, plan.beats);
  assert.match(credit, /Wikipedia, "Mary Celeste".*CC BY-SA 4\.0/);
  for (const image of plan.beats.flatMap(b => b.images)) assert.ok(credit.includes(image.descriptionUrl) && credit.includes(image.license));

  // Footage first: no images at all means NOT eligible (no filler, no stand-ins).
  const noImages = { ...fixtureHttp, getJson: async (url, params) => (/commons/.test(url) || params.prop === 'imageinfo' ? { query: { pages: [] } } : fixtureHttp.getJson(url, params)) };
  const bare = await planFootage('Mary Celeste', { http: noImages });
  assert.strictEqual(bare.eligible, false);
  assert.match(bare.reason, /licensed footage/);

  // A stricter per-beat rule can make the same story ineligible.
  assert.strictEqual((await planFootage('Mary Celeste', { http: fixtureHttp, minPerBeat: 4 })).eligible, false);

  // The LLM judge fails closed and approves only what it lists.
  const cand = [{ title: 'A.jpg', description: 'a ship' }, { title: 'B.jpg', description: 'a map' }];
  const beat = { heading: 'x', text: 'the ship sailed' };
  assert.deepStrictEqual((await makeLlmJudge({ generateText: async () => '{"relevant":[1]}' })(beat, cand)).map(c => c.title), ['A.jpg']);
  assert.deepStrictEqual(await makeLlmJudge({ generateText: async () => { throw new Error('429'); } })(beat, cand), []);
  assert.deepStrictEqual(await makeLlmJudge({ generateText: async () => 'sure, all of them' })(beat, cand), []);

  // Search results (not placed by editors) need the judge: a judge that says no drops every such beat.
  const searchOnly = { ...fixtureHttp, getJson: async (url, params) => (params.action === 'parse' ? { parse: { text: '<p>none</p>' } } : fixtureHttp.getJson(url, params)) };
  const rejectAll = await planFootage('Mary Celeste', { http: searchOnly, judge: async () => [] });
  assert.strictEqual(rejectAll.eligible, false);
  const approveAll = await planFootage('Mary Celeste', { http: searchOnly, judge: async (_b, list) => list });
  assert.ok(approveAll.beats.every(b => b.images.every(i => i.owned === false)));
  assert.strictEqual(approveAll.beats.length === 0 || approveAll.beats.every(b => b.images.length >= 1), true);

  // License ranking: public domain / CC0 beat CC BY, which beats CC BY-SA, even with a lower relevance score.
  assert.deepStrictEqual(['Public domain', 'CC0', 'CC BY 4.0', 'CC BY-SA 4.0'].map(licenseRank), [0, 0, 1, 2]);
  const options = new Map([[0, [
    { c: { title: 'sa.jpg', license: 'CC BY-SA 4.0' }, owned: true, score: 9 },
    { c: { title: 'by.jpg', license: 'CC BY 4.0' }, owned: true, score: 8 },
    { c: { title: 'pd.jpg', license: 'Public domain' }, owned: false, score: 1 }
  ]]]);
  assert.strictEqual(assign(options, [{ index: 0 }], 1).get(0)[0].title, 'pd.jpg');
  options.get(0).pop();
  assert.strictEqual(assign(options, [{ index: 0 }], 1).get(0)[0].title, 'by.jpg');

  // A story whose only usable image for a beat is share-alike is flagged.
  const tunguska = await planFootage('Tunguska event', { http: fixtureHttp });
  assert.strictEqual(tunguska.eligible, true, tunguska.reason);
  assert.strictEqual(tunguska.shareAlike, true);

  // Download stores the file and a record with hash and source.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dh-'));
  const record = await downloadImage(plan.beats[0].images[0], dir, fixtureHttp);
  assert.ok(fs.existsSync(path.join(dir, record.file)));
  assert.strictEqual(record.sha256.length, 64);
  assert.strictEqual(record.license, plan.beats[0].images[0].license);
  fs.rmSync(dir, { recursive: true });

  console.log('dark-history footage tests passed');
})().catch(error => { console.error(error); process.exit(1); });
