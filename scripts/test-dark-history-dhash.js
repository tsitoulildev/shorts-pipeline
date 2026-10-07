// Near-duplicate pictures are found, unrelated ones are not, and a repeated beat falls (never a repeat on screen).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runFFmpeg, checkFFmpeg } = require('../utils/ffmpeg');
const { dhash, distance, pruneNearDuplicates } = require('../utils/dark-history/dhash');

(async () => {
  assert.ok(await checkFFmpeg());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dhash-'));
  const make = async (name, source, size) => { await runFFmpeg(['-y', '-f', 'lavfi', '-i', `${source}=s=${size},format=rgb24`, '-frames:v', '1', '-update', '1', path.join(dir, name)]); return name; };
  // the same scene at two sizes and recompressed (what two photographs of one desk look like to the hash) vs different scenes
  const a = await make('a.png', 'testsrc2', '1600x1067');
  const a2 = await make('a2.jpg', 'testsrc2', '1200x800');
  const b = await make('b.png', 'smptebars', '1500x1000');
  const c = await make('c.png', 'mandelbrot', '1280x960');
  const [ha, ha2, hb, hc] = await Promise.all([a, a2, b, c].map(name => dhash(path.join(dir, name))));
  assert.match(ha, /^[0-9a-f]{16}$/);
  assert.ok(distance(ha, ha2) <= 12, `same scene is a near-duplicate (${distance(ha, ha2)} bits)`);
  assert.ok(distance(ha, hb) > 12 && distance(ha, hc) > 12 && distance(hb, hc) > 12, 'different scenes are not');
  assert.strictEqual(distance(ha, ha), 0);

  const beats = [a, a2, b, c].map((file, i) => ({ heading: `Beat ${i + 1}`, images: [{ title: `Pic ${i + 1}`, file }] }));
  const { beats: kept, dropped } = await pruneNearDuplicates(beats, dir);
  assert.deepStrictEqual(kept.map(x => x.heading), ['Beat 1', 'Beat 3', 'Beat 4']);
  assert.deepStrictEqual(dropped, [{ heading: 'Beat 2', duplicateOf: 'Pic 1' }]);
  assert.ok(kept.every(x => x.images[0].dhash), 'the fingerprint is recorded on the kept pictures');
  assert.strictEqual(beats[0].images[0].dhash, undefined, 'the input is not modified');
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_error) { /* open handle on Windows */ }
  console.log('dark-history dhash tests passed');
})().catch(error => { console.error(error); process.exit(1); });
