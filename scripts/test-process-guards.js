// Offline: crash alert + clean exit, graceful SIGTERM, no alert on routine stop, no double handling.
const assert = require('assert');
const { EventEmitter } = require('events');
const { installProcessGuards, describe } = require('../utils/process-guards');

const quiet = { error() {}, info() {}, warn() {} };

function harness(overrides = {}) {
  const proc = new EventEmitter();
  const exits = [];
  const alerts = [];
  const steps = [];
  const uninstall = installProcessGuards({
    proc,
    logger: quiet,
    exit: code => exits.push(code),
    notify: async notification => { alerts.push(notification); },
    stopScheduler: async () => { steps.push('scheduler'); },
    closeServer: async () => { steps.push('server'); },
    alertWaitMs: 50,
    graceMs: 50,
    ...overrides,
  });
  return { proc, exits, alerts, steps, uninstall };
}

const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  // Unhandled rejection: one error alert (token-free text), then exit(1).
  let h = harness();
  h.proc.emit('unhandledRejection', new Error(`boom ${['1234567890', 'A'.repeat(35)].join(':')}`));
  h.proc.emit('uncaughtException', new Error('second error while crashing'));
  await tick();
  assert.deepStrictEqual(h.exits, [1], 'exits once with code 1');
  assert.strictEqual(h.alerts.length, 1, 'only one alert per crash');
  assert.strictEqual(h.alerts[0].level, 'error');
  assert.strictEqual(h.alerts[0].type, 'service_crash');

  // A hanging or failing alert never blocks the exit.
  h = harness({ notify: () => new Promise(() => {}) });
  h.proc.emit('uncaughtException', new Error('x'));
  await tick(120);
  assert.deepStrictEqual(h.exits, [1]);
  h = harness({ notify: async () => { throw new Error('telegram down'); } });
  h.proc.emit('unhandledRejection', 'plain string reason');
  await tick();
  assert.deepStrictEqual(h.exits, [1]);

  // SIGTERM: scheduler stopped, server closed, exit 0, no alert; repeated signals are ignored.
  h = harness();
  h.proc.emit('SIGTERM');
  h.proc.emit('SIGINT');
  await tick();
  assert.deepStrictEqual(h.steps, ['scheduler', 'server']);
  assert.deepStrictEqual(h.exits, [0]);
  assert.strictEqual(h.alerts.length, 0, 'a routine stop must not alert');

  // A stuck shutdown step is cut off by the grace period.
  h = harness({ stopScheduler: () => new Promise(() => {}) });
  h.proc.emit('SIGTERM');
  await tick(150);
  assert.deepStrictEqual(h.exits, [0]);

  // Uninstall removes every listener it added.
  h = harness();
  h.uninstall();
  for (const event of ['unhandledRejection', 'uncaughtException', 'SIGTERM', 'SIGINT']) assert.strictEqual(h.proc.listenerCount(event), 0);

  assert.ok(!describe(new Error('a\nb\n'.repeat(500))).includes('\n') && describe('x'.repeat(1000)).length <= 300);
  console.log('Process guards tests passed');
})().catch(error => { console.error(error); process.exit(1); });
