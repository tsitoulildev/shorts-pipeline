// Uploads ONE finished Dark History sample (folder with short.mp4, thumbnail.jpg, report.md) as a scheduled YouTube video.
//   DARK_HISTORY_SAMPLE_UPLOAD=yes YOUTUBE_UPLOAD_ENABLED=true node scripts/dark-history-upload-sample.js <folder> <publishAt ISO, in the future>
// RUN ON THE VM (the YouTube login lives there). The report is the source of the title and of the description (attribution included, line breaks
// kept); the video stays private until publishAt. Same code path as the scheduler's upload: metadata validation, channel guard, file checks,
// thumbnail. Refuses to run without DARK_HISTORY_SAMPLE_UPLOAD=yes, and without a publishAt at least 30 minutes ahead.
const fs = require('fs');
const path = require('path');
require('dotenv').config();

function parseReport(text) {
  const title = (text.match(/^# (.+)$/m) || [])[1];
  const gate = (text.match(/^Gate: (\w+)/m) || [])[1];
  const description = (text.split(/^## Description\s*$/m)[1] || '').trim();
  return { title: title && title.trim(), gate, description };
}

async function main() {
  const [folder, publishAt] = process.argv.slice(2);
  if (process.env.DARK_HISTORY_SAMPLE_UPLOAD !== 'yes') { console.error('Set DARK_HISTORY_SAMPLE_UPLOAD=yes to run this.'); process.exit(2); }
  const when = new Date(publishAt);
  if (!folder || !(when.getTime() > Date.now() + 30 * 60000)) { console.error('Usage: <folder> <publishAt ISO at least 30 minutes ahead>'); process.exit(2); }
  const report = parseReport(fs.readFileSync(path.join(folder, 'report.md'), 'utf8'));
  if (report.gate !== 'PASSED' || !report.title || !/Wikimedia Commons/.test(report.description)) { console.error('The report does not show a passed gate with a title and an attribution.'); process.exit(3); }
  const { CredentialManager } = require('../utils/credential-manager');
  const { PublishingSchedulingAgent } = require('../agents/publishing-scheduling-agent');
  const credentials = new CredentialManager();
  const stubDb = { updateScheduleEntry: async () => {}, getLatestScheduleEntry: async () => null };
  const agent = new PublishingSchedulingAgent(stubDb, credentials);
  await agent.setupYouTubeAPI();
  const entry = {
    publishTime: when.toISOString(),
    metadata: {
      contentType: 'short',
      privacyStatus: 'public',
      containsSyntheticMedia: false,
      seo: { title: report.title, description: report.description, tags: ['dark history', 'true story', 'history mystery', 'unsolved history', 'shorts'] },
      video: { path: path.join(folder, 'short.mp4') },
      thumbnail: { path: path.join(folder, 'thumbnail.jpg') }
    }
  };
  const data = await agent.uploadToYouTube(entry);
  console.log(`UPLOADED ${data.id} scheduled for ${entry.publishTime}: ${report.title}`);
}

main().then(() => process.exit(0), error => { console.error(`UPLOAD FAILED: ${error.message}`); process.exit(1); });
