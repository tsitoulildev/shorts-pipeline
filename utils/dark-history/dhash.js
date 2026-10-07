// Near-duplicate pictures: a 64-bit difference hash (9x8 grayscale, each pixel compared with its right neighbour). Two photographs of
// the same object or the same newspaper page land within a few bits of each other; unrelated pictures are about 32 bits apart.
const fs = require('fs');
const path = require('path');

const NEAR_DUPLICATE_BITS = 12;

async function dhash(file) {
  const sharp = require('sharp');
  const { data } = await sharp(fs.readFileSync(file)).grayscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  let bits = '';
  for (let y = 0; y < 8; y += 1) for (let x = 0; x < 8; x += 1) bits += data[y * 9 + x] > data[y * 9 + x + 1] ? '1' : '0';
  return BigInt(`0b${bits}`).toString(16).padStart(16, '0');
}

function distance(a, b) {
  let diff = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let count = 0;
  while (diff) { count += Number(diff & 1n); diff >>= 1n; }
  return count;
}

/** Adds image.dhash (from the file in `folder`) where it is missing. */
async function ensureHashes(beats, folder) {
  for (const beat of beats) for (const image of beat.images || []) if (!image.dhash) image.dhash = await dhash(path.join(folder, image.file));
  return beats;
}

/**
 * Beats in order; a beat whose picture is a near-duplicate of a picture already kept is dropped (it falls, it is never filled with a
 * repeat). Returns { beats, dropped: [{ heading, duplicateOf }] } and leaves the input untouched.
 */
async function pruneNearDuplicates(beats, folder, threshold = NEAR_DUPLICATE_BITS) {
  const copy = beats.map(beat => ({ ...beat, images: (beat.images || []).map(image => ({ ...image })) }));
  await ensureHashes(copy, folder);
  const kept = [];
  const dropped = [];
  for (const beat of copy) {
    let twin = null;
    for (const image of beat.images) for (const earlier of kept.flatMap(item => item.images)) if (!twin && distance(image.dhash, earlier.dhash) <= threshold) twin = earlier.title;
    if (twin) dropped.push({ heading: beat.heading, duplicateOf: twin });
    else kept.push(beat);
  }
  return { beats: kept, dropped };
}

module.exports = { dhash, distance, ensureHashes, pruneNearDuplicates, NEAR_DUPLICATE_BITS };
