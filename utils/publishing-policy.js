/**
 * Upload authorization policy.
 *
 * Four independent controls, never interchangeable:
 *   AUTONOMOUS_MODE        may the orchestrator run without continuous human interaction
 *   YOUTUBE_UPLOAD_ENABLED is uploading technically permitted (emergency kill switch)
 *   APPROVAL_REQUIRED      does every finished video need an individual human approval
 *   AUTOMATION_PAUSED      global operational pause for autonomous job execution
 *
 * Environment values are the operator's deployment decision and always win.
 * APPROVAL_REQUIRED and AUTOMATION_PAUSED fall back to the dashboard settings
 * (approval_required / automation_paused) when the environment does not set them.
 * This module never writes YOUTUBE_UPLOAD_ENABLED; it only records its state.
 */

const PUBLICATION_STATES = Object.freeze({
  NOT_READY: 'NOT_READY',
  READY_FOR_PUBLISH: 'READY_FOR_PUBLISH',
  UPLOAD_AUTHORIZED: 'UPLOAD_AUTHORIZED'
});

function envFlag(name) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return null;
  return /^(1|true|yes|on)$/i.test(String(raw).trim());
}

async function readSetting(db, key) {
  if (!db || typeof db.getSetting !== 'function') return null;
  try {
    const value = await db.getSetting(key);
    return value === undefined ? null : value;
  } catch (_error) {
    return null;
  }
}

async function resolveControlState(db) {
  const autonomousMode = envFlag('AUTONOMOUS_MODE') === true;
  const uploadEnabled = envFlag('YOUTUBE_UPLOAD_ENABLED') === true;

  const approvalEnv = envFlag('APPROVAL_REQUIRED');
  const approvalSetting = await readSetting(db, 'approval_required');
  // Fail safe: anything other than an explicit "false" requires human approval.
  const approvalRequired = approvalEnv !== null ? approvalEnv : String(approvalSetting) !== 'false';

  const pausedEnv = envFlag('AUTOMATION_PAUSED');
  const pausedSetting = await readSetting(db, 'automation_paused');
  const automationPaused = pausedEnv === true || String(pausedSetting) === 'true';

  const autonomousPublishing = autonomousMode && uploadEnabled && !approvalRequired && !automationPaused;
  return {
    autonomousMode,
    uploadEnabled,
    approvalRequired,
    automationPaused,
    mode: autonomousPublishing ? 'AUTONOMOUS_PRODUCTION' : 'TEST_DEVELOPMENT',
    uploadState: uploadEnabled ? 'UPLOAD_ENABLED' : 'UPLOAD_DISABLED',
    sources: {
      approvalRequired: approvalEnv !== null ? 'environment' : 'setting',
      automationPaused: pausedEnv === true ? 'environment' : 'setting'
    }
  };
}

/**
 * Policy state for a finished production.
 *   QA failed                                   -> NOT_READY
 *   QA passed, approval or upload still blocked -> READY_FOR_PUBLISH
 *   QA passed, no approval needed, uploads on   -> UPLOAD_AUTHORIZED (queued for upload)
 */
function publicationState({ qaPassed, humanApproved = false, control }) {
  if (!qaPassed) return PUBLICATION_STATES.NOT_READY;
  if (!control?.uploadEnabled) return PUBLICATION_STATES.READY_FOR_PUBLISH;
  if (control.approvalRequired && !humanApproved) return PUBLICATION_STATES.READY_FOR_PUBLISH;
  return PUBLICATION_STATES.UPLOAD_AUTHORIZED;
}

/**
 * Persist the upload authorization state and report whether it changed since the
 * last start. Changing YOUTUBE_UPLOAD_ENABLED is an operator authorization act, so
 * every transition is recorded with a timestamp; the value itself is never altered.
 */
async function recordUploadAuthorization(db, control, now = new Date()) {
  if (!db || typeof db.setSetting !== 'function') return { changed: false, previous: null };
  const current = control.uploadEnabled ? 'enabled' : 'disabled';
  let previous = null;
  try {
    const stored = await readSetting(db, 'upload_authorization_state');
    previous = stored ? JSON.parse(stored) : null;
  } catch (_error) {
    previous = null;
  }
  if (previous?.state === current) return { changed: false, previous, state: current };
  const record = {
    state: current,
    since: now.toISOString(),
    source: 'environment:YOUTUBE_UPLOAD_ENABLED',
    previousState: previous?.state || null,
    previousSince: previous?.since || null,
    autonomousMode: control.autonomousMode,
    approvalRequired: control.approvalRequired
  };
  await db.setSetting('upload_authorization_state', JSON.stringify(record));
  return { changed: true, previous, state: current, record };
}

module.exports = {
  PUBLICATION_STATES,
  envFlag,
  resolveControlState,
  publicationState,
  recordUploadAuthorization
};
