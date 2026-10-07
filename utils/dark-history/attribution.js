// Attribution text for the video description: Wikipedia text (CC BY-SA 4.0) and every image (author, license, URL).
function attributionText(article, beats) {
  const images = beats.flatMap(b => b.images);
  const lines = [
    `Source text: Wikipedia, "${article.title}", ${article.url} (CC BY-SA 4.0).`,
    'Images (Wikimedia Commons):'
  ];
  images.forEach(i => lines.push(`- ${i.title.replace(/\.(jpe?g|png)$/i, '')}${i.author ? ` by ${i.author.length > 100 ? `${i.author.slice(0, 97)}...` : i.author}` : ''}, ${i.license}${i.licenseUrl ? ` (${i.licenseUrl})` : ''}, ${i.descriptionUrl}`));
  return lines.join('\n');
}

module.exports = { attributionText };
