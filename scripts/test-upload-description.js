// The YouTube metadata normalizer must keep the line breaks of the description: the Dark History attribution
// (Wikipedia credit + one line per image with its license and URL) is a multi-line text, and gluing the lines
// together breaks the URLs and the credits. Control characters other than the line break are still removed.
const assert = require('assert');
const { normalizeYouTubeMetadata, validateYouTubeMetadata } = require('../utils/youtube-metadata-validator');
const { attributionText } = require('../utils/dark-history/attribution');

const article = { title: 'Mary Celeste', url: 'https://en.wikipedia.org/wiki/Mary_Celeste' };
const image = (n, author) => ({ title: `Image ${n}.jpg`, author, license: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0', descriptionUrl: `https://commons.wikimedia.org/wiki/File:Image_${n}.jpg` });
const longAuthor = `Photographer ${'with a very long credit line '.repeat(6)}and an editor`;
assert.ok(longAuthor.length > 100);

const credit = attributionText(article, [{ images: [image(1, 'Ann Author'), image(2, longAuthor)] }]);
const description = `The ship was found empty.\n\nA true story.\n\n${credit}\n\n#Shorts`;
const sent = normalizeYouTubeMetadata({ title: 'The Ship Found Empty', description, tags: ['a', 'b', 'c'] }).description;

assert.strictEqual(sent, description, 'the description sent to YouTube must be byte-for-byte the description that was approved');
assert.ok(sent.includes(credit), 'the attribution text must survive unchanged (line breaks included)');
assert.ok(sent.includes(longAuthor), 'an author credit must never be shortened');
assert.ok(!/\.\.\./.test(sent), 'no credit may be cut with an ellipsis');

// CRLF is normalized to LF; other control characters are still removed.
assert.strictEqual(normalizeYouTubeMetadata({ title: 't', description: 'a\r\nb\u0000c\u0007d\te' }).description, 'a\nbcde');

// The 5,000 character limit is still enforced by the normalizer (cut at the limit), never silently rewriting shorter text.
assert.strictEqual(normalizeYouTubeMetadata({ title: 't', description: 'x'.repeat(6000) }).description.length, 5000);
assert.strictEqual(validateYouTubeMetadata({ title: 't', description, tags: ['a', 'b', 'c'] }).valid, true);

console.log('upload description keeps line breaks and full credits: OK');
