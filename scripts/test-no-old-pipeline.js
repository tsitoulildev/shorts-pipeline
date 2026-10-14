// The old stickman / fiction pipeline is gone and nothing needs it: (1) the removed modules do not exist and nothing in the repository names them, (2) every relative
// require resolves to a file, (3) the service has no old entry point, (4) a real Dark History production (script gates, narration, render, documentary gate) runs in a
// process in which requiring any of the removed modules throws.
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const REMOVED = [
  'agents/content-strategy-agent', 'agents/script-writer-agent', 'agents/thumbnail-designer-agent', 'agents/seo-optimizer-agent', 'agents/production-management-agent',
  'utils/stickman-scene', 'utils/stickman-animation', 'utils/visual-variety', 'utils/scene-repair-service', 'utils/autonomous-channel-operator',
  'utils/generation-recovery-service', 'utils/ai-video-generator', 'utils/media-generation-service', 'utils/video-providers', 'utils/audio-mix',
  'config/horror-stickman-niche', 'config/channel-identity'
];

const files = [];
const walk = dir => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'data', 'logs', 'fixtures'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full); else if (/\.(js|json|sh|yml)$/.test(entry.name)) files.push(full);
  }
};
walk(root);
const rel = file => path.relative(root, file).split(path.sep).join('/');

// 1. the files are gone, and no source names them (this test itself is the one place that lists them)
for (const name of REMOVED) {
  assert.ok(!fs.existsSync(path.join(root, name + '.js')) && !fs.existsSync(path.join(root, name + '.json')), `${name} must stay deleted`);
}
for (const file of files) {
  if (rel(file) === 'scripts/test-no-old-pipeline.js') continue;
  const text = fs.readFileSync(file, 'utf8');
  for (const name of REMOVED) assert.ok(!text.includes(name), `${rel(file)} still names the removed module ${name}`);
}

// 2. every relative require resolves
for (const file of files.filter(f => f.endsWith('.js'))) {
  const text = fs.readFileSync(file, 'utf8');
  for (const match of text.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
    const target = path.resolve(path.dirname(file), match[1]);
    const found = [target, target + '.js', target + '.json', path.join(target, 'index.js')].some(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
    assert.ok(found, `${rel(file)} requires ${match[1]}, which does not exist`);
  }
}

// 3. the service has one production path
const { YouTubeAutomationAgent } = require('../index');
for (const old of ['generateContent', 'generateReviewedScript', 'resumeInterruptedAutonomousWork', 'runGenerationStage', 'summarizeAgentHandoff', 'logCapabilitySummary']) {
  assert.equal(typeof YouTubeAutomationAgent.prototype[old], 'undefined', `${old} must not exist`);
}
for (const kept of ['startDocumentaryJob', 'generateDocumentaryContent', 'queueScheduledContent', 'startGenerationJob', 'verifyBeforeUpload']) {
  assert.equal(typeof YouTubeAutomationAgent.prototype[kept], 'function', `${kept} must exist`);
}
assert.deepEqual(Object.keys(require('../package.json').dependencies).filter(name => ['playwright', 'replicate'].includes(name)), [], 'the dependencies of the old renderers are gone');

// 4. a real production without any of them: the preload makes a require of a removed module throw
const guard = path.join(require('os').tmpdir(), `block-old-modules-${process.pid}.js`);
fs.writeFileSync(guard, `const Module = require('module'); const load = Module._load; const removed = ${JSON.stringify(REMOVED.map(name => name.split('/').pop()))};
Module._load = function (request, ...rest) { if (removed.some(name => String(request).includes(name))) throw new Error('the removed module was required: ' + request); return load.call(this, request, ...rest); };\n`);
try {
  const run = spawnSync(process.execPath, ['-r', guard, path.join(__dirname, 'test-dark-history-production.js')], { cwd: root, encoding: 'utf8', timeout: 280000 });
  assert.equal(run.status, 0, `the Dark History production test failed without the old modules:\n${String(run.stdout).slice(-600)}\n${String(run.stderr).slice(-600)}`);
  assert.match(run.stdout, /dark-history production tests passed/);
} finally {
  fs.rmSync(guard, { force: true });
}
console.log('no old pipeline: ok');
process.exit(0);
