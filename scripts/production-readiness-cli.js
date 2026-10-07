require('dotenv').config();

const { Database } = require('../database/db');
const { CredentialManager } = require('../utils/credential-manager');
const { ProductionReadinessService } = require('../utils/production-readiness-service');

async function main() {
  const db = new Database();
  const credentials = new CredentialManager();

  await db.initialize();
  try {
    await credentials.loadCredentials();
    await credentials.loadTokens();

    const readiness = new ProductionReadinessService(db, credentials);
    const result = await readiness.run({
      includePaidMedia: false,
      includePaidVideo: false
    });

    console.log('\nProduction readiness');
    console.log('====================');
    for (const check of result.checks) {
      const mark = check.status === 'passed' ? 'PASS' : check.status.toUpperCase();
      console.log(`${mark.padEnd(8)} ${check.label}: ${check.message}`);
      if (check.remediation) console.log(`         -> ${check.remediation}`);
    }

    console.log(`\nOverall: ${result.status.toUpperCase()}`);
    if (result.blockingFailures.length) {
      console.log(`Blocking: ${result.blockingFailures.join(', ')}`);
      process.exitCode = 1;
    }
  } finally {
    await db.close();
  }
}

main().catch(error => {
  console.error(error?.stack || error?.message || error);
  process.exitCode = 1;
});
