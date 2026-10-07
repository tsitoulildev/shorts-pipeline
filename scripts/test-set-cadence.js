const assert = require('assert');
const { parseCadence } = require('./set-cadence');

assert.strictEqual(parseCadence('21'), 21);
assert.strictEqual(parseCadence(' 3 '), 3);
assert.strictEqual(parseCadence(35), 35);
for (const bad of ['', '0', '36', '-1', '2.5', 'abc', '1e1', '21; rm -rf /', '$(id)', undefined, null]) {
  assert.throws(() => parseCadence(bad), /cadence must be/, `must reject ${String(bad)}`);
}
console.log('Set cadence tests passed');
