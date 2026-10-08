// Deterministic stand-in "photographs" for tests: a seeded 12x12 random grid enlarged smoothly (soft blobs, like a photo at low resolution).
// Different seeds are far apart for the fingerprint, a rescaled copy is within a few bits, and nothing depends on the ffmpeg build
// (the ffmpeg test patterns and geq random() gave different pictures on different machines and made CI flaky).
const sharp = require('sharp');

function grid(seed) {
  let state = (seed * 2654435761 + 12345) >>> 0;
  const pixels = Buffer.alloc(12 * 12);
  for (let i = 0; i < pixels.length; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    pixels[i] = state >>> 24;
  }
  return pixels;
}

/** Writes a width x height PNG for `seed` and returns the file. */
async function softPhoto(file, width, height, seed) {
  await sharp(grid(seed), { raw: { width: 12, height: 12, channels: 1 } }).resize(width, height, { kernel: 'cubic', fit: 'fill' }).toColourspace('srgb').png().toFile(file);
  return file;
}

/** The same picture at another size (a second photograph of the same object). */
async function rescaledCopy(from, file, width, height) {
  await sharp(from).resize(width, height, { fit: 'fill' }).png().toFile(file);
  return file;
}

module.exports = { softPhoto, rescaledCopy };
