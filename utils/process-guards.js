/**
 * Process-level safety net for the long-running service.
 *
 *  - unhandledRejection / uncaughtException: the process state can no longer be trusted, so
 *    log it, send ONE best-effort alert (Telegram, bounded wait) and exit(1). systemd's
 *    Restart=on-failure brings the service back and the pipeline resumes from its checkpoint.
 *  - SIGTERM / SIGINT (systemctl restart, deploy, Ctrl+C): stop new scheduled work, close the
 *    HTTP server and exit(0) within a short grace period. No alert: this is routine.
 * Nothing here ever sets or reads upload flags, credentials or secrets.
 */
const { sendTelegram } = require('./telegram-notifier');

const ALERT_WAIT_MS = 4000;
const SHUTDOWN_GRACE_MS = 10000;

function describe(reason) {
  const text = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
  return text.replace(/\s+/g, ' ').slice(0, 300);
}

function installProcessGuards({
  proc = process,
  logger = console,
  notify = sendTelegram,
  stopScheduler = async () => {},
  closeServer = async () => {},
  exit = code => proc.exit(code),
  alertWaitMs = ALERT_WAIT_MS,
  graceMs = SHUTDOWN_GRACE_MS,
} = {}) {
  let crashing = false;
  let stopping = false;

  const timeout = (ms) => new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });

  async function crash(kind, reason) {
    if (crashing) return;
    crashing = true;
    const message = describe(reason);
    try { logger.error(`FATAL ${kind}: ${message}`); } catch { /* logging must not block the exit */ }
    try {
      await Promise.race([
        notify({
          type: 'service_crash',
          level: 'error',
          title: 'Shorts Pipeline: service crashed, restarting',
          message: `${kind}: ${message}`
        }),
        timeout(alertWaitMs)
      ]);
    } catch { /* an alert failure never blocks the restart */ }
    exit(1);
  }

  async function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    try { logger.info(`${signal} received: stopping scheduled work and closing the server`); } catch { /* ignore */ }
    try {
      await Promise.race([
        (async () => { await stopScheduler(); await closeServer(); })(),
        timeout(graceMs)
      ]);
    } catch (error) {
      try { logger.warn(`Graceful shutdown step failed: ${describe(error)}`); } catch { /* ignore */ }
    }
    exit(0);
  }

  const handlers = {
    unhandledRejection: reason => crash('unhandledRejection', reason),
    uncaughtException: error => crash('uncaughtException', error),
    SIGTERM: () => shutdown('SIGTERM'),
    SIGINT: () => shutdown('SIGINT'),
  };
  for (const [event, handler] of Object.entries(handlers)) proc.on(event, handler);

  return () => {
    for (const [event, handler] of Object.entries(handlers)) proc.removeListener(event, handler);
  };
}

module.exports = { installProcessGuards, describe };
