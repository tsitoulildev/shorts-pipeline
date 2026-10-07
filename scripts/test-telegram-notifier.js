const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { isConfigured, shouldSend, formatMessage, redact, sendTelegram, status, sendTest, tokenFormatOk } = require('../utils/telegram-notifier');

const TOKEN = ['1234567890', 'A'.repeat(35)].join(':') // built at run time: no token-shaped literal in the source;
const env = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '42' };

(async () => {
  assert.strictEqual(isConfigured({}), false);
  assert.strictEqual(isConfigured(env), true);

  // Not configured: nothing is sent, nothing throws.
  let calls = 0;
  const counting = { post: async () => { calls += 1; } };
  assert.strictEqual((await sendTelegram({ type: 'upload_published' }, { env: {}, httpClient: counting })).sent, false);
  assert.strictEqual(calls, 0);

  // Important events go out; noise does not.
  assert.strictEqual(shouldSend({ type: 'upload_published', level: 'success' }, env), true);
  assert.strictEqual(shouldSend({ type: 'upload_blocked', level: 'warning' }, env), true);
  assert.strictEqual(shouldSend({ type: 'automation_paused', level: 'warning' }, env), true);
  assert.strictEqual(shouldSend({ type: 'content_approved', level: 'info' }, env), false);
  assert.strictEqual(shouldSend({ type: 'anything', level: 'error' }, env), true);
  assert.strictEqual(shouldSend({ type: 'content_approved', level: 'info' }, { ...env, TELEGRAM_NOTIFY_ALL: 'true' }), true);

  // Request shape.
  let seen;
  const ok = { post: async (url, body, opts) => { seen = { url, body, opts }; } };
  const result = await sendTelegram({ type: 'upload_published', level: 'success', title: 'Short published', message: 'live', data: { youtubeUrl: 'https://www.youtube.com/watch?v=abc' } }, { env, httpClient: ok });
  assert.strictEqual(result.sent, true);
  assert.strictEqual(seen.url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
  assert.strictEqual(seen.body.chat_id, '42');
  assert(seen.body.text.includes('Short published') && seen.body.text.includes('watch?v=abc'));
  assert(seen.opts.timeout > 0);

  // Secrets never appear in the message, and a failing send leaks nothing.
  const text = formatMessage({ type: 'x', level: 'error', title: 'Fail', message: `token ${TOKEN} Bearer abcdefghijklmnop1234 key AIzaSyA1234567890123456789012` });
  assert(!text.includes(TOKEN) && !text.includes('abcdefghijklmnop1234') && !text.includes('AIzaSy'), text);
  assert.strictEqual(redact(null), '');
  const failing = { post: async () => { const e = new Error(`failed https://api.telegram.org/bot${TOKEN}/sendMessage`); e.response = { status: 401 }; throw e; } };
  const failed = await sendTelegram({ type: 'upload_failed', level: 'error' }, { env, httpClient: failing });
  assert.deepStrictEqual(failed, { sent: false, reason: 'telegram_http_401' });
  assert(!JSON.stringify(failed).includes(TOKEN));
  const offline = { post: async () => { throw new Error(`ENOTFOUND ${TOKEN}`); } };
  assert.strictEqual((await sendTelegram({ type: 'upload_failed', level: 'error' }, { env, httpClient: offline })).reason, 'telegram_unreachable');

  // Long messages are bounded.
  assert(formatMessage({ title: 't', message: 'x'.repeat(10000) }).length <= 3500);

  // Static hygiene: no token-looking literal anywhere in tracked source, and wiring exists.
  const root = path.join(__dirname, '..');
  const read = file => fs.readFileSync(path.join(root, file), 'utf8');
  assert(/sendTelegram/.test(read('utils/operator-service.js')), 'notify must call sendTelegram');
  const publishing = read('agents/publishing-scheduling-agent.js');
  for (const type of ['upload_published', 'upload_blocked', 'upload_failed', 'upload_outcome_unknown']) assert(publishing.includes(type), `missing ${type}`);
  assert(read('index.js').includes("type: 'automation_paused'") && read('index.js').includes("type: 'automation_resumed'"));
  for (const file of ['utils/telegram-notifier.js', 'agents/publishing-scheduling-agent.js', 'index.js', '.env.example']) {
    assert(!/\b\d{8,}:[A-Za-z0-9_-]{30,}\b/.test(read(file)), `token-like literal in ${file}`);
  }
  assert(!/logger\.\w+\([^)]*TELEGRAM_BOT_TOKEN/.test(read('utils/telegram-notifier.js')));

  // Readiness view exposes only booleans, never the values.
  assert.deepStrictEqual(status({}), { configured: false, tokenSet: false, chatIdSet: false, tokenFormatOk: false, notifyAll: false });
  assert.deepStrictEqual(status({ TELEGRAM_BOT_TOKEN: TOKEN }), { configured: false, tokenSet: true, chatIdSet: false, tokenFormatOk: true, notifyAll: false });
  assert(!JSON.stringify(status(env)).includes(TOKEN));

  // sendTest bypasses the importance filter, reports failures by status only, and is silent without config.
  assert.strictEqual((await sendTest({ env: {}, httpClient: counting })).reason, 'not_configured');
  assert.strictEqual(calls, 0);
  const sentBodies = [];
  const okHttp = { post: async (url, body) => { sentBodies.push(body); } };
  assert.deepStrictEqual(await sendTest({ env, httpClient: okHttp }), { sent: true });
  assert(/Telegram test/.test(sentBodies[0].text) && !sentBodies[0].text.includes(TOKEN));
  const unauthorized = { post: async () => { const e = new Error(`bad ${TOKEN}`); e.response = { status: 401 }; throw e; } };
  assert.deepStrictEqual(await sendTest({ env, httpClient: unauthorized }), { sent: false, reason: 'telegram_http_401' });

  // Token format: the full BotFather token passes; fragments, placeholders, URLs and prefixed values do not.
  assert.strictEqual(tokenFormatOk(env), true);
  for (const bad of ['', '<token>', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', `bot${TOKEN}`, `https://api.telegram.org/bot${TOKEN}`, ` ${TOKEN}`, `"${TOKEN}"`]) {
    assert.strictEqual(tokenFormatOk({ TELEGRAM_BOT_TOKEN: bad }), false, `must reject ${bad.slice(0, 12)}`);
  }
  console.log('Telegram notifier tests passed');
})().catch(error => { console.error(error); process.exit(1); });
