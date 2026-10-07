require('dotenv').config();

const { Database } = require('../database/db');
const { CredentialManager } = require('../utils/credential-manager');
const { ProductionReadinessService } = require('../utils/production-readiness-service');

function flags(argv) {
  const values = new Set(argv.slice(2));
  return {
    paidImage: values.has('--paid-image'),
    paidVideo: values.has('--paid-video'),
    youtube: values.has('--youtube')
  };
}

function sanitizeCheck(check) {
  const details = { ...(check.details || {}) };
  delete details.taskId;
  delete details.channelId;
  return {
    id: check.id,
    label: check.label,
    blocking: check.blocking,
    status: check.status,
    message: check.message,
    remediation: check.remediation || null,
    details
  };
}

async function main() {
  const options = flags(process.argv);
  const db = new Database();
  const credentials = new CredentialManager();

  await credentials.initialize();
  await db.initialize();

  const probes = {};
  if (!options.youtube) {
    probes.youtube = async () => ({
      status: 'skipped',
      message: 'YouTube access probe skipped by default. Pass --youtube to verify read-only channel access.',
      remediation: 'Run npm run readiness:live -- --youtube when you are ready to test OAuth access.'
    });
  }

  const service = new ProductionReadinessService(db, credentials, { probes });
  try {
    const result = await service.run({
      includePaidMedia: options.paidImage,
      includePaidVideo: options.paidVideo
    });

    const safe = {
      generatedAt: new Date().toISOString(),
      mode: 'live-provider-smoke-no-upload',
      flags: {
        paidImage: options.paidImage,
        paidVideo: options.paidVideo,
        youtubeReadOnly: options.youtube
      },
      status: result.status,
      blockingFailures: result.blockingFailures,
      checks: result.checks.map(sanitizeCheck),
      guarantees: {
        uploadsAttempted: false,
        publishingAttempted: false,
        secretsPrinted: false,
        youtubeProbeReadOnly: options.youtube
      }
    };

    process.stdout.write(JSON.stringify(safe, null, 2) + '\n');
    if (result.status === 'failed') process.exitCode = 2;
  } finally {
    await db.close().catch(() => {});
  }
}

main().catch(error => {
  console.error('Live provider smoke test failed:', String(error?.message || error));
  process.exitCode = 1;
});
