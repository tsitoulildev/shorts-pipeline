// HTML contact sheet: every beat of every sampled story with its image(s), license, author and where the image came
// from, plus the passages that were dropped and why. Open the file in a browser; images load from Wikimedia.
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const BADGE = { 'editor-placed': 'placed by Wikipedia editors', 'LLM-approved': 'approved by the LLM judge' };

function unusedBlock(unused) {
  if (!unused || (!unused.items.length && !unused.ignoredIcons)) return '';
  return `<details class="unused"><summary>${unused.items.length} other image(s) were available but not used${unused.ignoredIcons ? ` (+${unused.ignoredIcons} icons/vector files ignored)` : ''}</summary><ul>${unused.items.map(i => `<li><strong>${esc(i.title)}</strong>: ${esc(i.reason)}</li>`).join('')}</ul></details>`;
}

function beatCard(beat, index) {
  const images = beat.images.map(image => `
    <figure>
      <a href="${esc(image.descriptionUrl)}" target="_blank" rel="noopener"><img src="${esc(image.fileUrl)}" alt="${esc(image.title)}" loading="lazy"></a>
      <figcaption><strong>${esc(image.title)}</strong><br>
        <span class="lic lic-${/sa/i.test(image.license) ? 'sa' : /by/i.test(image.license) ? 'by' : 'pd'}">${esc(image.license)}</span>
        <span class="src">${esc(BADGE[image.source] || image.source)}</span><br>
        <small>${esc(image.author || 'author not stated')}</small>
        ${image.confidence === 'low' ? `<div class="low">LOW CONFIDENCE<ul>${(image.confidenceNotes || []).map(n => `<li>${esc(n)}</li>`).join('')}</ul></div>` : image.confidence === 'high' ? '<div class="high">good fit</div>' : ''}</figcaption>
    </figure>`).join('');
  return `<section class="beat"><h3>Beat ${index + 1}: ${esc(beat.heading)}</h3><p class="text">${esc(String(beat.text || '').slice(0, 260))}...</p><div class="images">${images}</div>${unusedBlock(beat.unused)}</section>`;
}

function storyBlock(result) {
  const dropped = (result.diagnostics || []).filter(d => !result.beats.some(b => b.heading === d.heading));
  return `
  <article>
    <h2>${esc(result.title)} <span class="${result.withJudge.eligible ? 'ok' : 'bad'}">${result.withJudge.eligible ? 'eligible' : 'NOT eligible'}</span></h2>
    <p class="meta">${esc(result.withJudge.reason)} | share-alike used: ${result.withJudge.shareAlike ? 'yes' : 'no'} | editor-placed only: ${result.editorPlacedOnly.eligible ? 'eligible' : 'not eligible'}</p>
    ${result.beats.map(beatCard).join('')}
    ${dropped.length ? `<details><summary>${dropped.length} passage(s) left out (no relevant licensed image)</summary><ul>${dropped.map(d => `<li><strong>${esc(d.heading)}</strong>: editor-placed ${d.ownedTitles.length}, screened ${d.screened.length}, approved ${d.approved.length}${d.screened.length ? ` (rejected: ${esc(d.screened.filter(t => !d.approved.includes(t)).join('; ') || 'none')})` : ''}</li>`).join('')}</ul></details>` : ''}
  </article>`;
}

function contactSheetHtml(results) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dark History contact sheet</title>
<style>
  body{font:15px/1.45 system-ui,sans-serif;margin:0;padding:24px;background:#14161a;color:#e8e8ea}
  h1{margin:0 0 4px} h2{margin:32px 0 4px} h3{margin:18px 0 4px;font-size:16px}
  .ok{color:#6fd08c;font-size:14px} .bad{color:#ff7a7a;font-size:14px}
  .meta,.text{color:#a9acb4;margin:2px 0} .text{max-width:80ch}
  .images{display:flex;flex-wrap:wrap;gap:12px;margin-top:8px}
  figure{margin:0;width:300px;background:#1d2026;border-radius:8px;overflow:hidden}
  img{display:block;width:100%;height:200px;object-fit:contain;background:#000}
  figcaption{padding:8px 10px;font-size:13px}
  .lic{padding:1px 6px;border-radius:4px;font-weight:600} .lic-pd{background:#1f5c36} .lic-by{background:#6b5a14} .lic-sa{background:#7a2f2f}
  .src{color:#a9acb4;margin-left:6px} small{color:#a9acb4}
  details{margin-top:12px;color:#a9acb4}
  .low{margin-top:6px;padding:4px 6px;border-radius:4px;background:#5a2a14;color:#ffd2b8;font-weight:600}
  .low ul{margin:2px 0 0 16px;padding:0;font-weight:400} .high{margin-top:6px;color:#6fd08c}
</style></head><body>
<h1>Dark History contact sheet</h1>
<p class="meta">Generated ${esc(new Date().toISOString())}. Check by eye: does every image fit what its beat says? Green = public domain/CC0, yellow = CC BY, red = CC BY-SA (share-alike, used only when nothing else covers the beat).</p>
${results.map(storyBlock).join('\n')}
</body></html>`;
}

module.exports = { contactSheetHtml };
