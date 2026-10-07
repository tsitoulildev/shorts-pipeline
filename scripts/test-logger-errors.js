// The console line of logger.error must carry the error's reason, so `journalctl -u youtube-agent`
// shows WHY something failed (the per-agent log file alone was not enough on the VM).
const assert = require('node:assert/strict');
const { Logger } = require('../utils/logger');

const lines = [];
const original = console.log;
console.log = (...args) => { lines.push(args.join(' ')); };
try {
  const logger = new Logger('LoggerTest');
  logger.error('Failed to fetch YouTube trends:', new Error('Request had insufficient authentication scopes.'));
  logger.error('Plain failure without an error object');
  logger.error('String reason:', 'quota exceeded\nsecond line');
} finally {
  console.log = original;
}
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const strip = text => text.replace(ANSI, '');
assert.ok(strip(lines[0]).includes('Failed to fetch YouTube trends: Request had insufficient authentication scopes.'), 'error reason missing from the console line');
assert.ok(strip(lines.find(line => strip(line).includes('Plain failure'))).endsWith('Plain failure without an error object'));
assert.ok(lines.some(line => strip(line).includes('String reason: quota exceeded') && !strip(line).includes('second line')), 'only the first line of a reason is printed');
console.log('Logger errors: PASS');
