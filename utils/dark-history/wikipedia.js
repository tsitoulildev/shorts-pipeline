// Fetches the source text of a story from English Wikipedia (text is CC BY-SA 4.0).
const { defaultHttp } = require('./http');

const API = 'https://en.wikipedia.org/w/api.php';
const SKIP_SECTIONS = /^(see also|references|notes|further reading|external links|bibliography|works cited|sources|footnotes|citations|in popular culture|popular culture|in fiction|in media|in literature|legacy|cultural impact|commemorat)/i;

/** Splits an explaintext extract ("== Heading ==") into { heading, text }; the lead is "Introduction". Sub-sections fold into their parent. */
function splitSections(extract) {
  const parts = String(extract || '').split(/^[ \t]*(={2,})[ \t]*(.+?)[ \t]*\1[ \t]*$/m);
  const sections = [{ heading: 'Introduction', text: (parts[0] || '').trim() }];
  for (let i = 1; i < parts.length; i += 3) {
    const text = (parts[i + 2] || '').trim();
    if (parts[i].length > 2) sections[sections.length - 1].text += `\n${text}`;
    else sections.push({ heading: parts[i + 1], text });
  }
  return sections.filter(s => s.text && !SKIP_SECTIONS.test(s.heading));
}

async function fetchArticle(title, http = defaultHttp) {
  const data = await http.getJson(API, {
    action: 'query', format: 'json', formatversion: 2, redirects: 1, titles: title,
    prop: 'extracts|info|revisions|images|categories', explaintext: 1, exsectionformat: 'wiki',
    inprop: 'url', rvprop: 'ids', imlimit: 100, cllimit: 100
  });
  const page = data?.query?.pages?.[0];
  if (!page || page.missing || !page.extract) throw new Error(`Wikipedia: no article text for "${title}"`);
  return {
    title: page.title,
    url: page.fullurl,
    revisionId: page.revisions?.[0]?.revid,
    license: 'CC BY-SA 4.0',
    extract: page.extract,
    sections: splitSections(page.extract),
    imageTitles: (page.images || []).map(i => i.title),
    categories: (page.categories || []).map(c => c.title)
  };
}

const COMMONS_IMG = /(?:upload|thumb)\.wikimedia\.org\/wikipedia\/commons\/(?:thumb\/)?[0-9a-f]\/[0-9a-f]{2}\/([^/"'?\s]+)/g;

/** Maps each top-level section heading ("Introduction" = lead) to the Commons files the editors placed inside it. */
function sectionImagesFromHtml(html) {
  const out = new Map();
  const parts = String(html || '').split(/<h2\b/i);
  parts.forEach((part, i) => {
    let heading = 'Introduction';
    let body = part;
    if (i > 0) {
      const end = part.search(/<\/h2>/i);
      heading = part.slice(0, end).replace(/<[^>]*>/g, '').replace(/^[^>]*>/, '').replace(/\[edit\]/g, '').trim();
      body = part.slice(end);
    }
    const files = [...body.matchAll(COMMONS_IMG)].map(m => `File:${decodeURIComponent(m[1]).replace(/_/g, ' ')}`);
    out.set(heading, [...new Set(files)]);
  });
  return out;
}

async function fetchSectionImages(title, http = defaultHttp) {
  const data = await http.getJson(API, { action: 'parse', format: 'json', formatversion: 2, redirects: 1, page: title, prop: 'text', disableeditsection: 1, disablelimitreport: 1 });
  return sectionImagesFromHtml(data?.parse?.text);
}

module.exports = { fetchArticle, fetchSectionImages, sectionImagesFromHtml, splitSections };
