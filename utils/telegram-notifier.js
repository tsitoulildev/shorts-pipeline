/**
 * Free Telegram alerts (Bot API sendMessage). Credentials come only from the
 * environment (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID), are never logged, never
 * stored and never put in a message. A failed alert never blocks production.
 */
const defaultHttp = { post: (...args) => require('axios').post(...args) };

const IMPORTANT_TYPES = new Set([
  'upload_published', 'upload_blocked', 'upload_failed', 'upload_outcome_unknown',
  'automation_paused', 'automation_resumed', 'upload_authorization_changed', 'auth_required',
  'generation_failure', 'autonomous_run_failure', 'autonomous_run_paused',
  'content_rejected', 'review_required', 'production_stalled', 'automation_failure', 'story_pool_low', 'documentary_failure'
]);
const ICONS = { success: '✅', error: '🛑', warning: '⚠️', info: 'ℹ️' };
const MAX_LENGTH = 3500;

function isConfigured(env = process.env) {
  return Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID);
}

/** Removes anything that looks like a credential before a message leaves the box. */
function redact(text) {
  return String(text ?? '')
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, '[redacted]')
    .replace(/\bya29\.[A-Za-z0-9._-]+/g, '[redacted]')
    .replace(/\b(AIza[0-9A-Za-z_-]{20,}|sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,})\b/g, '[redacted]')
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1[redacted]');
}

function shouldSend(notification, env = process.env) {
  if (!notification || !isConfigured(env)) return false;
  if (String(env.TELEGRAM_NOTIFY_ALL || '').toLowerCase() === 'true') return true;
  return IMPORTANT_TYPES.has(notification.type) || notification.level === 'error';
}

function formatMessage(notification) {
  const icon = ICONS[notification.level] || ICONS.info;
  const lines = [`${icon} ${notification.title || notification.type || 'Notification'}`];
  if (notification.message) lines.push(String(notification.message));
  const data = notification.data || {};
  if (data.youtubeUrl) lines.push(String(data.youtubeUrl));
  if (Array.isArray(data.blockingFailures) && data.blockingFailures.length) lines.push(`Gates: ${data.blockingFailures.join(', ')}`);
  return redact(lines.join('\n')).slice(0, MAX_LENGTH);
}

async function sendTelegram(notification, options = {}) {
  const env = options.env || process.env;
  if (!shouldSend(notification, env)) return { sent: false, reason: 'skipped' };
  const http = options.httpClient || defaultHttp;
  try {
    await http.post(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: env.TELEGRAM_CHAT_ID,
      text: formatMessage(notification),
      disable_web_page_preview: true
    }, { timeout: Number(env.TELEGRAM_TIMEOUT_MS || 5000) });
    return { sent: true };
  } catch (error) {
    // The error text can contain the request URL (and so the token): report only the status.
    const status = error?.response?.status;
    return { sent: false, reason: status ? `telegram_http_${status}` : 'telegram_unreachable' };
  }
}

/** Secret-free view for readiness reports: only whether each variable is set. */
/** A BotFather token is "<digits>:<35+ url-safe chars>"; a pasted fragment, URL or placeholder is not. */
function tokenFormatOk(env = process.env) {
  return /^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(String(env.TELEGRAM_BOT_TOKEN || ''));
}

function status(env = process.env) {
  const tokenSet = Boolean(env.TELEGRAM_BOT_TOKEN);
  const chatIdSet = Boolean(env.TELEGRAM_CHAT_ID);
  return { configured: tokenSet && chatIdSet, tokenSet, chatIdSet, tokenFormatOk: tokenFormatOk(env), notifyAll: String(env.TELEGRAM_NOTIFY_ALL || '').toLowerCase() === 'true' };
}

/** One real message to prove the bot token and chat id work (ignores the importance filter). */
async function sendTest(options = {}) {
  const env = { ...(options.env || process.env), TELEGRAM_NOTIFY_ALL: 'true' };
  if (!isConfigured(env)) return { sent: false, reason: 'not_configured' };
  return sendTelegram({
    type: 'telegram_test',
    level: 'info',
    title: 'Shorts Pipeline: Telegram test',
    message: 'The alert channel works. Real alerts (published, blocked, failed uploads, pauses) will arrive here.'
  }, { env, httpClient: options.httpClient });
}

module.exports = { isConfigured, shouldSend, formatMessage, redact, sendTelegram, status, sendTest, tokenFormatOk, IMPORTANT_TYPES };
