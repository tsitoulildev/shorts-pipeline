// Wikimedia Commons search with a per-file license check (extmetadata) and download with a stored record.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { defaultHttp } = require('./http');

const API = 'https://commons.wikimedia.org/w/api.php';
const IMAGEINFO = {
  prop: 'imageinfo', iiprop: 'url|size|mime|extmetadata', iiurlwidth: 1280,
  iiextmetadatafilter: 'LicenseShortName|LicenseUrl|Artist|ImageDescription|Categories|Restrictions'
};
const FREE_LICENSE = /^(public domain|pd([- ]|$)|cc0|cc[- ]by([- ]sa)?[- ]\d)/i;
const NOT_FREE = /\b(nc|nd|fair use|non-?commercial|no derivatives)\b/i;
const JUNK_TITLE = /\b(logo|icon|signature|flag of|coat of arms|commons-|question book|wikidata|edit-clear)\b/i;

const stripHtml = html => String(html || '').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/\s+/g, ' ').trim();

/** One imageinfo page -> { candidate } or { rejected: reason }. Every file is license-checked here. */
function toCandidate(page) {
  const info = page.imageinfo?.[0];
  if (!info) return { rejected: 'no imageinfo' };
  const meta = info.extmetadata || {};
  const license = stripHtml(meta.LicenseShortName?.value);
  const author = stripHtml(meta.Artist?.value);
  const title = String(page.title).replace(/^File:/, '');
  if (!['image/jpeg', 'image/png'].includes(info.mime)) return { rejected: `mime ${info.mime}` };
  if (!license || !FREE_LICENSE.test(license) || NOT_FREE.test(license)) return { rejected: `license "${license || 'missing'}"` };
  if (/^cc[- ]by/i.test(license) && !author) return { rejected: 'CC BY without author' };
  if (meta.Restrictions?.value) return { rejected: `restrictions: ${meta.Restrictions.value}` };
  if (JUNK_TITLE.test(title)) return { rejected: 'junk title' };
  if (Math.min(info.width, info.height) < 600 || Math.max(info.width, info.height) < 1000) return { rejected: `too small ${info.width}x${info.height}` };
  const scaled = Boolean(info.thumburl);
  return {
    candidate: {
      title, descriptionUrl: info.descriptionurl, fileUrl: scaled ? info.thumburl : info.url,
      width: scaled ? info.thumbwidth : info.width, height: scaled ? info.thumbheight : info.height,
      mime: info.mime, license, licenseUrl: meta.LicenseUrl?.value || null, author: author || null,
      description: stripHtml(meta.ImageDescription?.value), categories: String(meta.Categories?.value || '').split('|')
    }
  };
}

const collect = pages => (pages || []).map(toCandidate).filter(r => r.candidate).map(r => r.candidate);

async function searchImages(query, { limit = 12 } = {}, http = defaultHttp) {
  const data = await http.getJson(API, { action: 'query', format: 'json', formatversion: 2, generator: 'search', gsrnamespace: 6, gsrsearch: query, gsrlimit: limit, ...IMAGEINFO });
  return collect(data?.query?.pages);
}

/** License-checked info for specific files (the images the Wikipedia article itself uses). */
async function imagesByTitle(fileTitles, http = defaultHttp) {
  const out = [];
  for (let i = 0; i < fileTitles.length; i += 20) {
    const data = await http.getJson(API, { action: 'query', format: 'json', formatversion: 2, titles: fileTitles.slice(i, i + 20).join('|'), ...IMAGEINFO });
    out.push(...collect(data?.query?.pages));
  }
  return out;
}

/** Downloads a candidate into dir and returns the record (source, author, license, sha256) the provenance gate will read. */
async function downloadImage(candidate, dir, http = defaultHttp) {
  const buffer = await http.getBuffer(candidate.fileUrl);
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const file = `${sha256.slice(0, 16)}${candidate.mime === 'image/png' ? '.png' : '.jpg'}`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), buffer);
  return { ...candidate, file, sha256, bytes: buffer.length, downloadedAt: new Date().toISOString() };
}

/** Lower is better: public domain / CC0 first, CC BY next, CC BY-SA (share-alike, legally grey for a video) only when nothing else covers a beat. */
const licenseRank = license => (/^cc[- ]by[- ]sa/i.test(license) ? 2 : /^cc[- ]by/i.test(license) ? 1 : 0);

module.exports = { licenseRank, searchImages, imagesByTitle, downloadImage, toCandidate, stripHtml, FREE_LICENSE };
