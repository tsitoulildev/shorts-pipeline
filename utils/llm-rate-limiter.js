// Per provider:model token budget over a rolling minute (free plans limit tokens per minute, not only requests: Groq gpt-oss-120b 8000 TPM,
// qwen3.8-27b 7000 input and 1000 output tokens per minute). In memory, like the cooldown tracker: a restart forgets the window.
const WINDOW_MS = 60 * 1000;

class RateLimiter {
  constructor(options = {}) {
    this.now = options.now || Date.now;
    this.events = new Map(); // key -> [{ at, input, output }]
  }

  _recent(key) {
    const cutoff = this.now() - WINDOW_MS;
    const list = (this.events.get(key) || []).filter(event => event.at > cutoff);
    this.events.set(key, list);
    return list;
  }

  // Milliseconds to wait until `need` ({ input, output }) fits inside `limits` ({ tpm, itpm, otpm }); 0 = now; Infinity = it can never fit.
  waitMs(key, limits, need) {
    if (!limits) return 0;
    const fits = (input, output) => (!limits.tpm || input + output + need.input + need.output <= limits.tpm)
      && (!limits.itpm || input + need.input <= limits.itpm)
      && (!limits.otpm || output + need.output <= limits.otpm);
    if (!fits(0, 0)) return Infinity;
    const events = this._recent(key);
    let input = events.reduce((sum, event) => sum + event.input, 0);
    let output = events.reduce((sum, event) => sum + event.output, 0);
    if (fits(input, output)) return 0;
    for (const event of events) { // oldest first: the window frees up as each one ages out
      input -= event.input;
      output -= event.output;
      if (fits(input, output)) return Math.max(0, event.at + WINDOW_MS - this.now()) + 250;
    }
    return WINDOW_MS;
  }

  record(key, usage) {
    this._recent(key).push({ at: this.now(), input: Number(usage.input) || 0, output: Number(usage.output) || 0 });
  }
}

module.exports = { RateLimiter, WINDOW_MS };
