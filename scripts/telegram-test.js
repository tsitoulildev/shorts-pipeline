require('dotenv').config();

// Sends ONE test message through the configured Telegram bot. Prints only ok/failure reasons,
// never the token or chat id.
const { status, sendTest, tokenFormatOk } = require('../utils/telegram-notifier');

async function main() {
  const state = status();
  if (!state.configured) {
    const missing = [!state.tokenSet && 'TELEGRAM_BOT_TOKEN', !state.chatIdSet && 'TELEGRAM_CHAT_ID'].filter(Boolean);
    console.error(`TELEGRAM_NOT_CONFIGURED: missing ${missing.join(', ')} in the environment/.env`);
    process.exitCode = 1;
    return;
  }
  if (!tokenFormatOk()) {
    console.error('TELEGRAM_TOKEN_FORMAT_WRONG: the token must look like 123456789:AAH... (digits, a colon, then 35 characters). Copy the whole token from @BotFather (/mybots > your bot > API Token), without "bot", quotes, spaces or <>.');
    process.exitCode = 1;
    return;
  }
  const result = await sendTest();
  if (result.sent) {
    console.log('TELEGRAM_TEST_OK: check your Telegram chat for the test message');
    return;
  }
  const hints = {
    telegram_http_401: 'the bot token is wrong or revoked',
    telegram_http_404: 'the token is not recognised: check it is the full token and nothing else',
    telegram_http_400: 'the chat id is wrong, or you have not sent the bot a message yet',
    telegram_http_403: 'the bot is blocked or cannot message this chat',
    telegram_unreachable: 'api.telegram.org could not be reached from this machine'
  };
  console.error(`TELEGRAM_TEST_FAILED: ${result.reason}${hints[result.reason] ? ` (${hints[result.reason]})` : ''}`);
  process.exitCode = 1;
}

main().catch(error => {
  console.error('TELEGRAM_TEST_FAILED:', String(error?.message || error).replace(/\d{6,}:[A-Za-z0-9_-]{20,}/g, '[redacted]'));
  process.exitCode = 1;
});
