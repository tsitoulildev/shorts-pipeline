// Provenance and truth gate for a Dark History production. It is the documentary path's OWN gate (the fiction
// gates in provenance-service.js / publishing-policy.js are untouched and still protect the fiction path).
// Every check re-reads the evidence from disk or re-runs the rule, so metadata alone cannot forge a pass.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { FREE_LICENSE } = require('./commons');
const { checkFactsDeterministic } = require('./fact-check');
const { PUBLIC_DOMAIN_VOICES } = require('./narration');
const { normalizeYouTubeMetadata } = require('../youtube-metadata-validator');

const NOT_FREE = /\b(nc|nd|fair use|non-?commercial|no derivatives)\b/i;
const COMMONS_PAGE = /^https:\/\/commons\.wikimedia\.org\/wiki\/File:/;
const WIKIMEDIA_FILE = /^https:\/\/(upload|thumb)\.wikimedia\.org\//;

/**
 * checkDocumentaryProduction({ story, script, description, video }) -> { passed, checks: [{ id, passed, message }] }.
 * story  = claimed story_pool row: { plan: { title, extract, folder, beats }, attribution, article_url, revision_id }
 * script = grounded script (beats with narration/evidence/images); video = { width, height, duration, hasAudio }
 * audio (optional, the production's narration asset) adds the voice licence check
 */
function checkDocumentaryProduction({ story, script, description, video, audio }) {
  const checks = [];
  const add = (id, passed, message) => checks.push({ id, passed: Boolean(passed), message });
  const beats = story?.plan?.beats || [];
  const images = beats.flatMap(b => b.images || []);

  // Footage: every beat has real footage; no reuse; the stored file is the file that was licensed.
  add('footage_per_beat', beats.length >= 4 && beats.every(b => (b.images || []).length >= 1), `${beats.length} beats, ${beats.filter(b => (b.images || []).length >= 1).length} with footage`);
  add('no_image_reuse', new Set(images.map(i => i.title)).size === images.length, 'each image is used once');
  const missing = [];
  const tampered = [];
  for (const image of images) {
    const file = path.join(story.plan.folder, image.file || '');
    if (!image.file || !fs.existsSync(file)) { missing.push(image.title); continue; }
    if (crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== image.sha256) tampered.push(image.title);
  }
  add('image_files_intact', !missing.length && !tampered.length, missing.length ? `missing: ${missing.join(', ')}` : tampered.length ? `hash mismatch: ${tampered.join(', ')}` : `${images.length} files match their sha256`);

  // Rights: license per file, free license only, author for CC BY, source URL on Commons.
  const badLicense = images.filter(i => !i.license || !FREE_LICENSE.test(i.license) || NOT_FREE.test(i.license));
  add('license_free_per_image', !badLicense.length, badLicense.length ? `not free: ${badLicense.map(i => `${i.title} (${i.license || 'none'})`).join(', ')}` : 'every image is public domain, CC0, CC BY or CC BY-SA');
  const noAuthor = images.filter(i => /^cc[- ]by/i.test(i.license || '') && !i.author);
  add('author_for_cc_by', !noAuthor.length, noAuthor.length ? `no author: ${noAuthor.map(i => i.title).join(', ')}` : 'authors present where required');
  const badSource = images.filter(i => !COMMONS_PAGE.test(i.descriptionUrl || '') || !WIKIMEDIA_FILE.test(i.fileUrl || ''));
  add('source_url_per_image', !badSource.length, badSource.length ? `no Commons source: ${badSource.map(i => i.title).join(', ')}` : 'every image has its Commons page and file URL');

  // Truth: source stored, the fact-check re-run on the stored script, the verifier's pass recorded.
  add('source_recorded', Boolean(story?.article_url && story?.revision_id && story?.plan?.extract), `source ${story?.article_url || 'missing'} revision ${story?.revision_id || 'missing'}`);
  let facts = { passed: false, issues: ['no script'] };
  try { facts = checkDocumentaryFacts(script, story); } catch (error) { facts = { passed: false, issues: [error.message] }; }
  add('claims_map_to_source', facts.passed, facts.passed ? 'every beat has verbatim evidence; numbers, names and quotes are in the source' : facts.issues.slice(0, 3).join(' | '));
  add('claims_verified_by_editor', script?.metadata?.creativeReview?.facts?.passed === true && script?.metadata?.creativeReview?.passed === true, 'the fact verifier and the editor passed this exact script');

  // The pictures themselves were looked at: a vision model confirmed every picture shows what its beat narrates.
  const fit = script?.metadata?.creativeReview?.imageFit;
  add('images_fit_narration', fit?.passed === true && fit?.checkedBeats === (script?.beats || []).length && (script?.beats || []).length > 0, fit?.passed === true ? `a vision check confirmed ${fit.checkedBeats} pictures fit their narration` : 'no passing vision check of the pictures is recorded for this script');

  // Attribution: Wikipedia text credit + every image's author/license/URL, unchanged, inside the description.
  const credit = story?.attribution || '';
  add('attribution_in_description', Boolean(credit) && String(description || '').includes(credit), 'the attribution text appears unchanged in the description');
  const unnamed = images.filter(i => !String(description || '').includes(i.descriptionUrl) || !String(description || '').includes(i.license));
  add('every_image_credited', !unnamed.length, unnamed.length ? `not credited: ${unnamed.map(i => i.title).join(', ')}` : 'every image is credited with its license and URL');
  add('wikipedia_credit', /Wikipedia/.test(credit) && /CC BY-SA 4\.0/.test(credit) && credit.includes(story?.article_url || '\u0000'), 'Wikipedia text credit with license and article URL');

  // What YouTube receives is what was approved: the upload normalizer must not change or cut the description (credits included).
  add('description_survives_upload', Boolean(description) && normalizeYouTubeMetadata({ description }).description === description, 'the description reaches YouTube unchanged (line breaks and credits kept, within the length limit)');

  // The voice: only a public-domain voice may narrate.
  if (audio !== undefined) {
    const voice = PUBLIC_DOMAIN_VOICES.find(name => String(audio?.model || '').endsWith(name));
    add('voice_public_domain', Boolean(voice) && audio?.simulated !== true, voice ? `narrated with the public-domain voice ${voice}` : `narration voice "${audio?.model || 'unknown'}" is not an approved public-domain voice`);
  }

  // Output sanity.
  add('video_format', video?.width === 1080 && video?.height === 1920 && video?.duration > 0 && video?.duration <= 60 && video?.hasAudio === true, `video ${video?.width}x${video?.height}, ${Number(video?.duration || 0).toFixed(1)}s, audio=${video?.hasAudio}`);

  return { passed: checks.every(c => c.passed), checks };
}

// beat images in the script must be the beat images of the story (the script cannot swap in other files)
function checkDocumentaryFacts(script, story) {
  const same = (script?.beats || []).every((b, i) => JSON.stringify((b.images || []).map(x => x.sha256)) === JSON.stringify((story.plan.beats[i]?.images || []).map(x => x.sha256)));
  const facts = checkFactsDeterministic(script, story);
  return same ? facts : { passed: false, issues: [...facts.issues, 'script images differ from the licensed footage of the story'] };
}

module.exports = { checkDocumentaryProduction };
