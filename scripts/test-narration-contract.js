const assert = require('assert');
const { ProductionManagementAgent } = require('../agents/production-management-agent');

async function main() {
  const agent = Object.create(ProductionManagementAgent.prototype);
  agent.logger = { info() {}, warn() {}, error() {} };

  // The hook is narrated once even when the writer repeats it as the first words of beat 1.
  const hook = "The kettle wasn't whistling at midnight. It was whispering.";
  const repeated = {
    hook: { text: hook },
    mainContent: { sections: [
      { content: [`${hook} I watched the pale steam curl upward.`] },
      { content: ['The burner glowed dead black.'] }
    ] }
  };
  const spoken = agent.formatScriptForTTS(repeated);
  assert.strictEqual(spoken.split(hook).length - 1, 1, 'hook must be spoken exactly once');
  assert(spoken.includes('I watched the pale steam curl upward.'), 'beat 1 body must stay');

  const plain = {
    hook: { text: 'Something waited in the hall.' },
    mainContent: { sections: [{ content: ['The door was open.'] }] }
  };
  assert.strictEqual(agent.formatScriptForTTS(plain), 'Something waited in the hall.\n\nThe door was open.');

  // A narration too long to speed up safely fails fast instead of being rendered and rejected later.
  await assert.rejects(
    () => agent.normalizeHorrorNarrationDuration('/nonexistent.mp3', 62.3),
    error => error.code === 'NARRATION_RUNTIME_CONTRACT'
  );
  assert.strictEqual(await agent.normalizeHorrorNarrationDuration('/nonexistent.mp3', 40), 40);

  console.log('Narration contract: PASS');
}

main().catch(error => { console.error(error); process.exit(1); });
