// Calibration of the picture-fit check with the REAL vision model (RUN ON THE VM, keys live in .env there):
//   node scripts/dark-history-fit-calibration.js [--rounds=3]
// Known cases from the Mary Celeste Short the owner reviewed (2026-10-07): beats whose picture does NOT show what the narration says
// (a lap desk under "built and launched as Amazon", a lap desk under "left Pier 50 with the crew", a waterspout under "pirates would
// have looted the ship, personal possessions were undisturbed") must be flagged; beats whose picture does (the ship, the judge named in
// the sentence, the writer named in the sentence) must not. Prints misses and false alarms per round; changes nothing.
require('dotenv').config();
const path = require('path');
const { AITextService } = require('../utils/ai-text-service');
const { imagesByTitle, downloadImage } = require('../utils/dark-history/commons');
const { checkImageFit, makeVisionJudge } = require('../utils/dark-history/image-fit');

const CASES = [
  { file: 'Mary Celeste as Amazon in 1861 (cropped).jpg', narration: 'A merchant brigantine was discovered adrift and deserted in the Atlantic Ocean on December 4, 1872.', fits: true },
  { file: 'Lap desk of Captain Benjamin Briggs from the Mary Celeste (PEM M6557) 02.jpg', narration: 'The ship was built in Spencers Island, Nova Scotia, and launched as Amazon in 1861.', fits: false },
  { file: 'Lap desk of Captain Benjamin Briggs from the Mary Celeste (PEM M6557) 01.jpg', narration: 'Mary Celeste left Pier 50 with the captain, his family, and seven crew members.', fits: false },
  { file: 'Sir James Cochrane 1841-1877.jpg', narration: 'A salvage court hearing began in Gibraltar on December 17, 1872, under Sir James Cochrane.', fits: true },
  { file: 'Trombe.jpg', narration: 'Charles Edey Fay observes that pirates would have looted the ship, but personal possessions were undisturbed.', fits: false },
  { file: 'Arthur Conan Doyle by Herbert Rose Barraud 1893.jpg', narration: 'The most influential retelling was a story in the January 1884 issue of the Cornhill Magazine by Arthur Conan Doyle.', fits: true }
];

async function main() {
  const rounds = Number((process.argv.find(a => a.startsWith('--rounds=')) || '--rounds=3').split('=')[1]);
  const llm = new AITextService({});
  const judge = makeVisionJudge(llm);
  const folder = path.join(require('os').tmpdir(), 'fit-calibration');
  const found = await imagesByTitle(CASES.map(c => `File:${c.file}`));
  const images = [];
  for (const c of CASES) {
    const candidate = found.find(x => x.title.replace(/_/g, ' ').replace(/^File:/, '') === c.file);
    if (!candidate) throw new Error(`missing ${c.file}`);
    images.push(await downloadImage(candidate, folder));
  }
  const story = { plan: { title: 'Mary Celeste', folder, beats: images.map(image => ({ images: [image] })) } };
  const script = { beats: CASES.map((c, i) => ({ narration: c.narration, images: [images[i]] })) };
  let missed = 0; let falseAlarms = 0; let total = 0;
  for (let round = 1; round <= rounds; round += 1) {
    const result = await checkImageFit({ script, story, judge });
    const flagged = new Set(result.issues.map(issue => Number((issue.match(/^beat (\d+)/) || [])[1])));
    CASES.forEach((c, i) => {
      total += 1;
      if (!c.fits && !flagged.has(i + 1)) { missed += 1; console.log(`round ${round}: MISSED mismatch at beat ${i + 1} (${c.file})`); }
      if (c.fits && flagged.has(i + 1)) { falseAlarms += 1; console.log(`round ${round}: FALSE ALARM at beat ${i + 1} (${c.file})`); }
    });
    console.log(`round ${round}: flagged beats ${[...flagged].join(', ') || 'none'}`);
  }
  console.log(`\nTOTAL over ${rounds} rounds: mismatches missed ${missed}, correct pictures flagged ${falseAlarms}, of ${total} beat checks`);
  process.exit(0);
}

main().catch(error => { console.error(error.message); process.exit(1); });
